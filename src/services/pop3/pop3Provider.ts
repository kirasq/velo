import type { EmailProvider, EmailFolder, SyncResult } from "../email/types";
import type { ParsedMessage } from "../gmail/messageParser";
import { buildPop3Config } from "./pop3ConfigBuilder";
import { pop3TestConnection, smtpSendEmail, buildSmtpConfig, type SmtpConfig } from "./tauriCommands";
import { pop3InitialSync } from "./pop3Sync";
import { getAccount, type DbAccount } from "../db/accounts";
import { getDb } from "../db/connection";
import { setThreadLabels } from "../db/threads";

const LABEL_INBOX = "INBOX";
const LABEL_UNREAD = "UNREAD";
const LABEL_STARRED = "STARRED";
const LABEL_ARCHIVE = "ARCHIVE";
const LABEL_TRASH = "TRASH";
const LABEL_SPAM = "SPAM";

/**
 * EmailProvider adapter for POP3 accounts.
 *
 * POP3 semantic constraints (RFC 1939):
 *   - Only the INBOX is visible; no server-side folders or labels.
 *   - No server-side read/starred state. We track those locally.
 *   - Sending always goes through SMTP (reused from the IMAP command set).
 *   - Deletion on the server is destructive and irreversible — we only ever
 *     issue DELE via the retention policy (see Rust pop3_sync), never on
 *     user-driven "delete" (that is a local-only action here).
 */
export class Pop3Provider implements EmailProvider {
  readonly accountId: string;
  readonly type = "pop3" as const;

  private _pop3Config: ReturnType<typeof buildPop3Config> | null = null;
  private _smtpConfig: SmtpConfig | null = null;

  constructor(accountId: string) {
    this.accountId = accountId;
  }

  private async getAccount(): Promise<DbAccount> {
    const account = await getAccount(this.accountId);
    if (!account) throw new Error(`Account ${this.accountId} not found`);
    return account;
  }

  private async getPop3Config() {
    if (!this._pop3Config) {
      this._pop3Config = buildPop3Config(await this.getAccount());
    }
    return this._pop3Config;
  }

  private async getSmtpConfig(): Promise<SmtpConfig> {
    if (!this._smtpConfig) {
      const account = await this.getAccount();
      this._smtpConfig = buildSmtpConfig(account);
    }
    return this._smtpConfig;
  }

  /** Invalidate cached config (e.g. after credential change). */
  clearConfigCache(): void {
    this._pop3Config = null;
    this._smtpConfig = null;
  }

  // ---- Folder operations ----
  // POP3 has no folders. We expose a single synthetic INBOX so the UI and
  // label pipeline behave uniformly across providers.
  async listFolders(): Promise<EmailFolder[]> {
    return [
      {
        id: LABEL_INBOX,
        name: "Inbox",
        path: "INBOX",
        type: "system",
        specialUse: "\\Inbox",
        delimiter: "/",
        messageCount: 0,
        unreadCount: 0,
      },
    ];
  }

  async createFolder(_name: string, _parentPath?: string): Promise<EmailFolder> {
    throw new Error("POP3 does not support server-side folders.");
  }
  async deleteFolder(_path: string): Promise<void> {
    throw new Error("POP3 does not support server-side folders.");
  }
  async renameFolder(_path: string, _newName: string): Promise<void> {
    throw new Error("POP3 does not support server-side folders.");
  }

  // ---- Sync operations ----
  async initialSync(
    daysBack: number,
    onProgress?: (phase: string, current: number, total: number) => void,
  ): Promise<SyncResult> {
    const knownUidls = await this.getKnownUidls();
    const nowTs = Math.floor(Date.now() / 1000);

    const cutoff =
      daysBack > 0
        ? Math.floor(Date.now() / 1000) - daysBack * 86400
        : 0;

    // The Rust side already dedupes via knownUidls and enforces retention.
    // daysBack is used only as a soft hint; POP3 servers don't support
    // date-range queries, so we rely on retention + dedupe.
    void cutoff;

    const result = await pop3InitialSync(
      this.accountId,
      knownUidls,
      nowTs,
      onProgress,
    );

    return {
      messages: [],
      folderStatus: {
        uidvalidity: 0,
        lastUid: result.total_count,
      },
    };
  }

  async deltaSync(_syncToken: string): Promise<SyncResult> {
    // POP3 has no incremental token; just re-run initialSync-style pull.
    return this.initialSync(0);
  }

  // ---- Message operations ----
  async fetchMessage(messageId: string): Promise<ParsedMessage> {
    const db = await getDb();
    const rows = await db.select<{
      id: string;
      thread_id: string;
      from_address: string | null;
      from_name: string | null;
      to_addresses: string | null;
      cc_addresses: string | null;
      bcc_addresses: string | null;
      reply_to: string | null;
      subject: string | null;
      snippet: string | null;
      date: number;
      is_read: number;
      is_starred: number;
      body_html: string | null;
      body_text: string | null;
      raw_size: number | null;
      internal_date: number | null;
      list_unsubscribe: string | null;
      list_unsubscribe_post: string | null;
      auth_results: string | null;
    }[]>("SELECT * FROM messages WHERE account_id = $1 AND id = $2", [
      this.accountId,
      messageId,
    ]);

    const row = rows[0];
    if (!row) throw new Error(`Message ${messageId} not found`);

    // Attachments metadata (velo stores attachment bytes on disk via local_path,
    // not in the DB — we surface metadata only here).
    const atts = await db.select<{
      id: string;
      filename: string;
      mime_type: string;
      size: number;
      content_id: string | null;
      is_inline: number;
    }[]>("SELECT id, filename, mime_type, size, content_id, is_inline FROM attachments WHERE message_id = $1", [messageId]);

    return {
      id: row.id,
      threadId: row.thread_id,
      fromAddress: row.from_address,
      fromName: row.from_name,
      toAddresses: row.to_addresses,
      ccAddresses: row.cc_addresses,
      bccAddresses: row.bcc_addresses,
      replyTo: row.reply_to,
      subject: row.subject,
      snippet: row.snippet ?? "",
      date: row.date,
      isRead: !!row.is_read,
      isStarred: !!row.is_starred,
      bodyHtml: row.body_html,
      bodyText: row.body_text,
      rawSize: row.raw_size ?? 0,
      internalDate: row.internal_date ?? row.date,
      labelIds: [LABEL_INBOX],
      hasAttachments: atts.length > 0,
      attachments: atts.map((a) => ({
        filename: a.filename,
        mimeType: a.mime_type,
        size: a.size,
        gmailAttachmentId: a.id,
        contentId: a.content_id,
        isInline: !!a.is_inline,
      })),
      listUnsubscribe: row.list_unsubscribe,
      listUnsubscribePost: row.list_unsubscribe_post,
      authResults: row.auth_results,
    };
  }

  async fetchAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: string; size: number }> {
    const db = await getDb();
    const rows = await db.select<{ local_path: string | null; size: number }[]>(
      "SELECT local_path, size FROM attachments WHERE message_id = $1 AND id = $2",
      [messageId, attachmentId],
    );
    const row = rows[0];
    if (!row || row.local_path == null) {
      throw new Error("Attachment not cached locally");
    }
    // Read the attachment bytes from disk and base64-encode for the caller.
    const fs = await import("@tauri-apps/plugin-fs");
    const buf = await fs.readFile(row.local_path);
    let binary = "";
    for (const b of buf) binary += String.fromCharCode(b);
    return { data: btoa(binary), size: row.size };
  }

  async fetchRawMessage(messageId: string): Promise<string> {
    const db = await getDb();
    const rows = await db.select<{ raw_data: string | null }[]>(
      "SELECT raw_data FROM messages WHERE account_id = $1 AND id = $2",
      [this.accountId, messageId],
    );
    const row = rows[0];
    if (!row || row.raw_data == null) {
      throw new Error("Raw message not stored locally");
    }
    return row.raw_data;
  }

  // ---- Local-only actions ----
  // POP3 has no server-side state for these; all of them mutate the local DB.

  async archive(_threadId: string, messageIds: string[]): Promise<void> {
    // Local archive = remove INBOX label, add ARCHIVE label.
    await this.relabelMessages(messageIds, [LABEL_INBOX], [LABEL_ARCHIVE]);
  }

  async trash(_threadId: string, messageIds: string[]): Promise<void> {
    await this.relabelMessages(messageIds, [LABEL_INBOX], [LABEL_TRASH]);
  }

  async permanentDelete(_threadId: string, messageIds: string[]): Promise<void> {
    const db = await getDb();
    for (const id of messageIds) {
      await db.execute(
        "DELETE FROM messages WHERE account_id = $1 AND id = $2",
        [this.accountId, id],
      );
      await db.execute(
        "DELETE FROM attachments WHERE message_id = $1",
        [id],
      );
    }
  }

  async markRead(
    _threadId: string,
    messageIds: string[],
    read: boolean,
  ): Promise<void> {
    const db = await getDb();
    for (const id of messageIds) {
      await db.execute(
        "UPDATE messages SET is_read = $1, updated_at = unixepoch() WHERE account_id = $2 AND id = $3",
        [read ? 1 : 0, this.accountId, id],
      );
    }
    // Update thread-level read state + labels
    await this.updateThreadReadState(messageIds, read);
    if (read) {
      await this.relabelMessages(messageIds, [LABEL_UNREAD], []);
    } else {
      await this.relabelMessages(messageIds, [], [LABEL_UNREAD]);
    }
  }

  async star(
    _threadId: string,
    messageIds: string[],
    starred: boolean,
  ): Promise<void> {
    const db = await getDb();
    for (const id of messageIds) {
      await db.execute(
        "UPDATE messages SET is_starred = $1, updated_at = unixepoch() WHERE account_id = $2 AND id = $3",
        [starred ? 1 : 0, this.accountId, id],
      );
    }
    if (starred) {
      await this.relabelMessages(messageIds, [], [LABEL_STARRED]);
    } else {
      await this.relabelMessages(messageIds, [LABEL_STARRED], []);
    }
  }

  async spam(
    _threadId: string,
    messageIds: string[],
    isSpam: boolean,
  ): Promise<void> {
    await this.relabelMessages(
      messageIds,
      [LABEL_INBOX],
      [isSpam ? LABEL_SPAM : LABEL_INBOX],
    );
  }

  async moveToFolder(
    _threadId: string,
    _messageIds: string[],
    _folderPath: string,
  ): Promise<void> {
    throw new Error("POP3 does not support server-side folders.");
  }

  async addLabel(_threadId: string, labelId: string): Promise<void> {
    // Labels are local-only for POP3; caller passes message ids via other paths.
    // We treat addLabel as a no-op here to keep the interface uniform; actual
    // label changes go through relabelMessages (used by smart-label pipeline).
    void labelId;
  }

  async removeLabel(_threadId: string, _labelId: string): Promise<void> {
    // See addLabel note.
  }

  // ---- Send/Draft operations ----
  async sendMessage(
    rawBase64Url: string,
    _threadId?: string,
  ): Promise<{ id: string }> {
    const smtpConfig = await this.getSmtpConfig();
    const result = await smtpSendEmail(smtpConfig, rawBase64Url);
    if (!result.success) {
      throw new Error(result.message);
    }
    return { id: crypto.randomUUID() };
  }

  async createDraft(
    _rawBase64Url: string,
    _threadId?: string,
  ): Promise<{ draftId: string }> {
    throw new Error("Drafts are not yet implemented for POP3 accounts.");
  }
  async updateDraft(
    _draftId: string,
    _rawBase64Url: string,
    _threadId?: string,
  ): Promise<{ draftId: string }> {
    throw new Error("Drafts are not yet implemented for POP3 accounts.");
  }
  async deleteDraft(_draftId: string): Promise<void> {
    throw new Error("Drafts are not yet implemented for POP3 accounts.");
  }

  // ---- Connection ----
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const config = await this.getPop3Config();
      const msg = await pop3TestConnection(config);
      return { success: true, message: msg };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getProfile(): Promise<{ email: string; name?: string }> {
    const account = await this.getAccount();
    return { email: account.email, name: account.display_name ?? undefined };
  }

  // ---- Internals ----
  private async getKnownUidls(): Promise<string[]> {
    const db = await getDb();
    const rows = await db.select<{ pop3_uidl: string }[]>(
      "SELECT pop3_uidl FROM messages WHERE account_id = $1 AND pop3_uidl IS NOT NULL",
      [this.accountId],
    );
    return rows.map((r) => r.pop3_uidl);
  }

  private async relabelMessages(
    messageIds: string[],
    remove: string[],
    add: string[],
  ): Promise<void> {
    const db = await getDb();
    for (const id of messageIds) {
      const threadRows = await db.select<{ thread_id: string }[]>(
        "SELECT thread_id FROM messages WHERE account_id = $1 AND id = $2",
        [this.accountId, id],
      );
      const threadId = threadRows[0]?.thread_id;
      if (!threadId) continue;

      const existing = await db.select<{ label_id: string }[]>(
        "SELECT label_id FROM thread_labels WHERE account_id = $1 AND thread_id = $2",
        [this.accountId, threadId],
      );
      const labelSet = new Set(existing.map((r) => r.label_id));
      for (const r of remove) labelSet.delete(r);
      for (const a of add) labelSet.add(a);

      await setThreadLabels(this.accountId, threadId, [...labelSet]);
    }
  }

  private async updateThreadReadState(
    messageIds: string[],
    read: boolean,
  ): Promise<void> {
    const db = await getDb();
    for (const id of messageIds) {
      const threadRows = await db.select<{ thread_id: string }[]>(
        "SELECT thread_id FROM messages WHERE account_id = $1 AND id = $2",
        [this.accountId, id],
      );
      const threadId = threadRows[0]?.thread_id;
      if (!threadId) continue;
      await db.execute(
        "UPDATE threads SET is_read = $1, updated_at = unixepoch() WHERE account_id = $2 AND id = $3",
        [read ? 1 : 0, this.accountId, threadId],
      );
    }
  }
}
