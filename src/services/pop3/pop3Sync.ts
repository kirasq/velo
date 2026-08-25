import type { ParsedMessage } from "../gmail/messageParser";
import type { Pop3Config, Pop3Message, Pop3SyncResult } from "./types";
import { pop3Sync as pop3SyncInvoke } from "./tauriCommands";
import { buildPop3Config } from "./pop3ConfigBuilder";
import { getAccount } from "../db/accounts";
import { upsertMessage } from "../db/messages";
import { upsertAttachment } from "../db/attachments";
import { persistInviteFromRawIcs } from "../calendar/inviteExtractor";
import { upsertThread, setThreadLabels } from "../db/threads";
import { withTransaction } from "../db/connection";
import { appDataDir } from "@tauri-apps/api/path";

// velo uses RFC-style label IDs stored as plain strings.
const LABEL_INBOX = "INBOX";
const LABEL_UNREAD = "UNREAD";
const LABEL_STARRED = "STARRED";

/**
 * Local label IDs for a POP3 message.
 *
 * POP3 has no server-side folders/labels — everything is local:
 *   - INBOX always applied (POP3 only sees the inbox).
 *   - UNREAD reflects the local is_read flag.
 *   - STARRED reflects the local is_starred flag.
 * User smart-labels / filters run later in the pipeline (same as IMAP).
 */
function localLabelIds(isRead: boolean, isStarred: boolean): string[] {
  const labels = [LABEL_INBOX];
  if (!isRead) labels.push(LABEL_UNREAD);
  if (isStarred) labels.push(LABEL_STARRED);
  return labels;
}

/**
 * Convert a Rust Pop3Message into a ParsedMessage with a stable local id.
 * Local id format: `pop3-${accountId}-${base64url(uidl)}`.
 *
 * POP3 delivers everything as "unread" on first download; reads are tracked
 * purely in the local DB (the markRead action updates the row, never server).
 */
function pop3MessageToParsed(
  msg: Pop3Message,
  accountId: string,
): { parsed: ParsedMessage; localId: string } {
  const uidlB64 = encodeBase64Url(msg.uidl);
  const localId = `pop3-${accountId}-${uidlB64}`;
  const dateMs = msg.date > 0 ? msg.date * 1000 : Date.now();

  const isRead = false;
  const isStarred = false;

  const attachments = msg.attachments.map((att, idx) => {
    // Deterministic id (uidl-scoped) so re-sync does not duplicate rows.
    const attKey = att.content_id ?? att.filename ?? String(idx);
    const attId = `${localId}_${attKey}`;
    return {
      filename: att.filename,
      mimeType: att.mime_type,
      size: att.size,
      gmailAttachmentId: attId,
      contentId: normalizeCid(att.content_id),
      contentLocation: att.content_location ?? null,
      isInline: att.is_inline,
      isCalendarInvite: att.is_calendar_invite ?? false,
      calendarData: att.calendar_data ?? null,
      localPath: att.local_path ?? null,
    };
  });

  const parsed: ParsedMessage = {
    id: localId,
    threadId: "",
    fromAddress: msg.from_address,
    fromName: msg.from_name,
    toAddresses: msg.to_addresses,
    ccAddresses: msg.cc_addresses,
    bccAddresses: msg.bcc_addresses,
    replyTo: msg.reply_to,
    subject: msg.subject,
    snippet: msg.snippet ?? (msg.body_text ? msg.body_text.slice(0, 200) : ""),
    date: dateMs,
    isRead,
    isStarred,
    bodyHtml: msg.body_html,
    bodyText: msg.body_text,
    rawSize: msg.raw_size,
    internalDate: dateMs,
    labelIds: localLabelIds(isRead, isStarred),
    hasAttachments: attachments.length > 0,
    attachments,
    listUnsubscribe: msg.list_unsubscribe,
    listUnsubscribePost: msg.list_unsubscribe_post,
    authResults: msg.auth_results,
  };

  return { parsed, localId };
}

/**
 * Build a synthetic thread id from the RFC-2822 message-id so replies group
 * together even without server-side threading.
 */
function threadIdForMessage(rfcMessageId: string, accountId: string): string {
  return `thread-${accountId}-${encodeBase64Url(rfcMessageId)}`;
}

/**
 * Full POP3 sync: connect via Rust, download new messages, store locally.
 *
 * @param knownUidls UIDLs already stored locally (for dedupe).
 * @param nowTsSeconds current unix timestamp in SECONDS (Rust compares against
 *              message Date which is in seconds).
 */
export async function pop3InitialSync(
  accountId: string,
  knownUidls: string[],
  nowTsSeconds: number,
  onProgress?: (phase: string, current: number, total: number) => void,
): Promise<{ result: Pop3SyncResult; stored: ParsedMessage[] }> {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  const config: Pop3Config = buildPop3Config(account);
  // JS computes the app-data dir and hands it to Rust so attachments can be
  // written to disk (POP3 has no server-side attachment fetch like IMAP).
  config.attachment_dir = await appDataDir();

  const stored: ParsedMessage[] = [];
  onProgress?.("download", 0, 1);
  const result = await pop3SyncInvoke(config, knownUidls, nowTsSeconds);
  onProgress?.("download", 1, 1);

  if (result.messages.length === 0) {
    return { result, stored };
  }

  await withTransaction(async () => {
    for (let i = 0; i < result.messages.length; i++) {
      const rustMsg = result.messages[i]!;
      const { parsed, localId } = pop3MessageToParsed(rustMsg, accountId);
      const rfcMessageId =
        rustMsg.message_id ?? `pop3-synth-${encodeBase64Url(rustMsg.uidl)}`;
      const threadId = threadIdForMessage(rfcMessageId, accountId);

      parsed.threadId = threadId;

      // Isolate each message's writes. A single contended/failed write must NOT
      // abort the whole batch — previously one SQLITE_BUSY timeout rolled back
      // every message (and attachment), leaving the DB empty so inline images
      // could never resolve. Now a bad message is skipped while the rest land.
      try {
        // Insert the thread BEFORE the message. The messages table has a foreign
        // key (account_id, thread_id) -> threads, and SQLite enforces immediate
        // (non-deferred) FK checks. Inserting a message that references a not-yet
        // existing thread fails with SQLITE_CONSTRAINT_FOREIGNKEY.
        await upsertThread({
          id: threadId,
          accountId,
          subject: parsed.subject ?? "(no subject)",
          snippet: parsed.snippet,
          lastMessageAt: parsed.date,
          messageCount: 1,
          isRead: parsed.isRead,
          isStarred: parsed.isStarred,
          isImportant: false,
          hasAttachments: parsed.hasAttachments,
        });

        await setThreadLabels(accountId, threadId, parsed.labelIds);

        await upsertMessage({
          id: localId,
          accountId,
          threadId,
          fromAddress: parsed.fromAddress,
          fromName: parsed.fromName,
          toAddresses: parsed.toAddresses,
          ccAddresses: parsed.ccAddresses,
          bccAddresses: parsed.bccAddresses,
          replyTo: parsed.replyTo,
          subject: parsed.subject,
          snippet: parsed.snippet,
          date: parsed.date,
          isRead: parsed.isRead,
          isStarred: parsed.isStarred,
          bodyHtml: parsed.bodyHtml,
          bodyText: parsed.bodyText,
          rawSize: parsed.rawSize,
          internalDate: parsed.internalDate,
          listUnsubscribe: parsed.listUnsubscribe,
          listUnsubscribePost: parsed.listUnsubscribePost,
          authResults: parsed.authResults,
          messageIdHeader: rustMsg.message_id,
          referencesHeader: rustMsg.references,
          inReplyToHeader: rustMsg.in_reply_to,
          pop3Uidl: rustMsg.uidl,
        });

        // Persist attachments (including local_path written by Rust during sync).
        for (const att of parsed.attachments) {
          try {
            await upsertAttachment({
              id: att.gmailAttachmentId,
              messageId: localId,
              accountId,
              filename: att.filename,
              mimeType: att.mimeType,
              size: att.size,
              gmailAttachmentId: att.gmailAttachmentId,
              contentId: att.contentId,
              contentLocation: att.contentLocation,
              isInline: att.isInline,
              isCalendarInvite: att.isCalendarInvite,
              localPath: att.localPath,
            });
            if (att.isCalendarInvite && att.calendarData) {
              try {
                await persistInviteFromRawIcs({
                  accountId,
                  messageId: localId,
                  threadId,
                  rawIcs: att.calendarData,
                });
              } catch (e) {
                console.error("Failed to persist calendar invite (pop3)", localId, e);
              }
            }
          } catch (e) {
            console.error("Failed to persist POP3 attachment", att.filename, e);
          }
        }

        // Only surface messages that actually persisted, so the UI state stays
        // consistent with the DB (no phantom rows that vanish on reload).
        stored.push(parsed);
        onProgress?.("store", i + 1, result.messages.length);
      } catch (e) {
        console.error(
          `[pop3] skipped message ${localId} (persist failed):`,
          e,
        );
      }
    }
  });

  console.log(
    `[pop3] sync complete: downloaded=${result.messages.length} stored=${stored.length}`,
  );
  return { result, stored };
}

// ---------- base64url helper ----------
function encodeBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Normalize a Content-ID so it matches the `cid:` references found in HTML
 * bodies. Strips the optional `cid:` scheme and surrounding `<>` brackets and
 * trims whitespace. Mail parsers often return `<abc@xyz>` or `cid:abc@xyz`,
 * while EmailRenderer's regex extracts `abc@xyz`, so we must store the same
 * normalized form for inline images to resolve.
 */
function normalizeCid(cid: string | null | undefined): string | null {
  if (!cid) return null;
  let s = cid.trim();
  if (s.toLowerCase().startsWith("cid:")) s = s.slice(4);
  s = s.replace(/^[<>]+|[<>]+$/g, "").trim();
  return s || null;
}
