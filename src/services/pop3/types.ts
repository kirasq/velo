// POP3 config types mirroring the Rust `Pop3Config` struct.
export interface Pop3Config {
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  username: string;
  password: string;
  accept_invalid_certs: boolean;
  /** Days to keep messages on the server before DELE. 0 = keep forever. */
  retention_days: number;
  /** AppData directory; Rust writes attachment files under it. JS-provided. */
  attachment_dir?: string;
}

export interface Pop3Attachment {
  filename: string;
  mime_type: string;
  size: number;
  content_id: string | null;
  /** Content-Location header value (bare URI/token) for inline image refs. */
  content_location?: string | null;
  is_inline: boolean;
  /** True when this part is a calendar invitation (text/calendar / .ics). */
  is_calendar_invite?: boolean;
  /** Decoded text/calendar payload (ICS text), when is_calendar_invite. */
  calendar_data?: string | null;
  /** Absolute path on disk where the decoded bytes are stored (POP3 only). */
  local_path?: string | null;
}

export interface Pop3MessageMeta {
  msg_number: number;
  uidl: string;
  size: number;
}

export interface Pop3Message {
  uidl: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  reply_to: string | null;
  subject: string | null;
  date: number;
  body_html: string | null;
  body_text: string | null;
  snippet: string | null;
  raw_size: number;
  list_unsubscribe: string | null;
  list_unsubscribe_post: string | null;
  auth_results: string | null;
  attachments: Pop3Attachment[];
}

export interface Pop3SyncResult {
  messages: Pop3Message[];
  total_count: number;
  new_count: number;
  deleted_uidls: string[];
}
