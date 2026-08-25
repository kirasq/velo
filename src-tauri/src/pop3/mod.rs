pub mod client;
pub mod types;

use std::collections::HashSet;

use client::Pop3Client;
use types::{Pop3Config, Pop3MessageMeta, Pop3SyncResult};

/// Known UIDLs on the client already (from previous syncs).
/// Anything in this set is skipped during download. Returns the messages that
/// were newly downloaded, plus which server messages exceeded retention and
/// were marked for DELE.
///
/// Retention policy (per user decision: "keep N days then auto-delete"):
///   - retention_days == 0  → never delete from server
///   - otherwise            → delete messages whose Date header is older than
///                            N days. POP3 has no server-side folder state, so
///                            deletion is the only server-mutating action we do.
pub async fn sync(
    config: &Pop3Config,
    known_uidls: HashSet<String>,
    now_ts: i64,
) -> Result<Pop3SyncResult, String> {
    let mut client = Pop3Client::connect(config).await?;

    let (total_count, _) = client.stat().await?;
    let mut metas: Vec<Pop3MessageMeta> = client.uidl_all().await?;
    let sizes = client.list_all().await?;
    for m in metas.iter_mut() {
        m.size = *sizes.get(&m.msg_number).unwrap_or(&0);
    }

    let retention_secs = (config.retention_days as i64) * 86400;
    let mut new_messages = Vec::new();
    let mut deleted_uidls: Vec<String> = Vec::new();
    let mut new_count: u32 = 0;

    for meta in &metas {
        // Skip already-known messages
        if known_uidls.contains(&meta.uidl) {
            continue;
        }

        // Retention check (only if retention enabled)
        if config.retention_days > 0 {
            // We need the Date to decide; fetch + parse first, then decide.
            let raw = client.retr(meta.msg_number).await?;
            match client::parse_message(&meta.uidl, &raw, &config.attachment_dir) {
                Ok(msg) => {
                    let age = now_ts - msg.date;
                    if age > retention_secs && msg.date > 0 {
                        // Too old → delete on server, do NOT store locally.
                        if let Err(e) = client.dele(meta.msg_number).await {
                            log::warn!("POP3 DELE failed for {}: {e}", meta.msg_number);
                        } else {
                            deleted_uidls.push(meta.uidl.clone());
                        }
                        continue;
                    }
                    new_count += 1;
                    new_messages.push(msg);
                }
                Err(e) => {
                    log::warn!("POP3 parse failed for {}: {e}", meta.msg_number);
                }
            }
        } else {
            // No retention → just download + store
            let raw = client.retr(meta.msg_number).await?;
            if let Ok(msg) = client::parse_message(&meta.uidl, &raw, &config.attachment_dir) {
                new_count += 1;
                new_messages.push(msg);
            }
        }
    }

    client.quit().await;

    Ok(Pop3SyncResult {
        messages: new_messages,
        total_count,
        new_count,
        deleted_uidls,
    })
}
