use serde::{Deserialize, Serialize};

/// POP3 account configuration passed from the TypeScript layer.
///
/// Mirrors the shape of `ImapConfig` so the UI/builder code can stay uniform.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pop3Config {
    pub host: String,
    pub port: u16,
    /// "tls" (direct SSL on connect), "starttls" (STLS upgrade), or "none"
    pub security: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub accept_invalid_certs: bool,
    /// Days to keep messages on the server before issuing DELE.
    /// 0 means "never delete from server" (keep forever).
    #[serde(default)]
    pub retention_days: u32,
    /// Base directory (AppData) under which attachment files are written.
    /// JS passes the Tauri app-data dir; Rust writes
    /// `<attachment_dir>/velo-attachments/<uidl>/<filename>` for each attachment.
    #[serde(default)]
    pub attachment_dir: String,
}

/// A single message enumerated by UIDL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pop3MessageMeta {
    /// 1-based ordinal position in the mailbox (POP3 MSG numbers)
    pub msg_number: u32,
    /// Unique-ID string from the UIDL command — stable across sessions,
    /// used as the client-side dedupe key.
    pub uidl: String,
    /// Octet size reported by the LIST command.
    pub size: u32,
}

/// Result of a full POP3 sync pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pop3SyncResult {
    /// Messages downloaded and parsed this pass.
    pub messages: Vec<Pop3Message>,
    /// Total messages reported by STAT.
    pub total_count: u32,
    /// Number of new messages actually stored (after dedupe).
    pub new_count: u32,
    /// UIDLs that were deleted on the server because they exceeded retention.
    pub deleted_uidls: Vec<String>,
}

/// A downloaded + parsed POP3 message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pop3Message {
    pub uidl: String,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub from_address: Option<String>,
    pub from_name: Option<String>,
    pub to_addresses: Option<String>,
    pub cc_addresses: Option<String>,
    pub bcc_addresses: Option<String>,
    pub reply_to: Option<String>,
    pub subject: Option<String>,
    pub date: i64,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub snippet: Option<String>,
    pub raw_size: u32,
    pub list_unsubscribe: Option<String>,
    pub list_unsubscribe_post: Option<String>,
    pub auth_results: Option<String>,
    pub attachments: Vec<Pop3Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pop3Attachment {
    pub filename: String,
    pub mime_type: String,
    pub size: u32,
    pub content_id: Option<String>,
    pub is_inline: bool,
    /// Absolute path on disk where the decoded attachment bytes are stored.
    /// `None` when disk persistence failed or attachments are not saved locally.
    pub local_path: Option<String>,
}
