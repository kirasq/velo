import type { ParsedMessage } from "../gmail/messageParser";
import type { Pop3Config, Pop3Message, Pop3SyncResult } from "./types";
import { pop3Sync as pop3SyncInvoke } from "./tauriCommands";
import { buildPop3Config } from "./pop3ConfigBuilder";
import { getAccount } from "../db/accounts";
import { upsertMessage } from "../db/messages";
import { upsertThread, setThreadLabels } from "../db/threads";
import { withTransaction } from "../db/connection";

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

  const attachments = msg.attachments.map((att) => ({
    filename: att.filename,
    mimeType: att.mime_type,
    size: att.size,
    gmailAttachmentId: crypto.randomUUID(),
    contentId: att.content_id,
    isInline: att.is_inline,
  }));

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
): Promise<Pop3SyncResult> {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  const config: Pop3Config = buildPop3Config(account);

  onProgress?.("download", 0, 1);
  const result = await pop3SyncInvoke(config, knownUidls, nowTsSeconds);
  onProgress?.("download", 1, 1);

  if (result.messages.length === 0) {
    return result;
  }

  await withTransaction(async () => {
    for (let i = 0; i < result.messages.length; i++) {
      const rustMsg = result.messages[i]!;
      const { parsed, localId } = pop3MessageToParsed(rustMsg, accountId);
      const rfcMessageId =
        rustMsg.message_id ?? `pop3-synth-${encodeBase64Url(rustMsg.uidl)}`;
      const threadId = threadIdForMessage(rfcMessageId, accountId);

      parsed.threadId = threadId;

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

      onProgress?.("store", i + 1, result.messages.length);
    }
  });

  return result;
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
