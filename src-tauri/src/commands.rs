use crate::imap::client as imap_client;
use crate::imap::types::{
    DeltaCheckRequest, DeltaCheckResult, ImapConfig, ImapFetchResult, ImapFolder,
    ImapFolderSearchResult, ImapFolderStatus, ImapFolderSyncResult, ImapMessage,
};
use crate::pop3::client as pop3_client;
use crate::pop3::types::{Pop3Config, Pop3SyncResult};
use crate::smtp::client as smtp_client;
use crate::smtp::types::{SmtpConfig, SmtpSendResult};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::time::Duration;

// ---------- IMAP commands ----------

#[tauri::command]
pub async fn imap_test_connection(config: ImapConfig) -> Result<String, String> {
    imap_client::test_connection(&config).await
}

#[tauri::command]
pub async fn imap_list_folders(config: ImapConfig) -> Result<Vec<ImapFolder>, String> {
    let mut session = imap_client::connect(&config).await?;
    let folders = imap_client::list_folders(&mut session).await?;
    let _ = session.logout().await;
    Ok(folders)
}

#[tauri::command]
pub async fn imap_fetch_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
) -> Result<ImapFetchResult, String> {
    if uids.is_empty() {
        return Err("No UIDs provided".to_string());
    }

    // Build a UID set string like "1,5,10,20"
    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let mut session = imap_client::connect(&config).await?;
    let result = imap_client::fetch_messages(&mut session, &folder, &uid_set).await;
    let _ = session.logout().await;

    match result {
        Ok(r) => Ok(r),
        Err(e) if e.starts_with("ASYNC_IMAP_EMPTY:") => {
            // async-imap can't parse this server's responses — use raw TCP fallback
            log::info!("Falling back to raw TCP fetch for folder {folder}");
            imap_client::raw_fetch_messages(&config, &folder, &uid_set).await
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn imap_fetch_new_uids(
    config: ImapConfig,
    folder: String,
    since_uid: u32,
) -> Result<Vec<u32>, String> {
    let mut session = imap_client::connect(&config).await?;
    let uids = imap_client::fetch_new_uids(&mut session, &folder, since_uid).await?;
    let _ = session.logout().await;
    Ok(uids)
}

#[tauri::command]
pub async fn imap_search_all_uids(
    config: ImapConfig,
    folder: String,
) -> Result<Vec<u32>, String> {
    let mut session = imap_client::connect(&config).await?;
    let uids = imap_client::search_all_uids(&mut session, &folder).await?;
    let _ = session.logout().await;
    Ok(uids)
}

#[tauri::command]
pub async fn imap_fetch_message_body(
    config: ImapConfig,
    folder: String,
    uid: u32,
) -> Result<ImapMessage, String> {
    let mut session = imap_client::connect(&config).await?;
    let message = imap_client::fetch_message_body(&mut session, &folder, uid).await?;
    let _ = session.logout().await;
    Ok(message)
}

#[tauri::command]
pub async fn imap_fetch_raw_message(
    config: ImapConfig,
    folder: String,
    uid: u32,
) -> Result<String, String> {
    let mut session = imap_client::connect(&config).await?;
    let raw = imap_client::fetch_raw_message(&mut session, &folder, uid).await?;
    let _ = session.logout().await;
    Ok(raw)
}

#[tauri::command]
pub async fn imap_set_flags(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    flags: Vec<String>,
    add: bool,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    let mut session = imap_client::connect(&config).await?;

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let flag_op = if add { "+FLAGS" } else { "-FLAGS" };

    // Format flags like "(\Seen \Flagged)"
    let flags_str = format!(
        "({})",
        flags
            .iter()
            .map(|f| {
                // Ensure flags have the backslash prefix if they're standard flags
                if f.starts_with('\\') {
                    f.clone()
                } else {
                    format!("\\{f}")
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    );

    imap_client::set_flags(&mut session, &folder, &uid_set, flag_op, &flags_str).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn imap_move_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    destination: String,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    let mut session = imap_client::connect(&config).await?;

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    imap_client::move_messages(&mut session, &folder, &uid_set, &destination).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn imap_delete_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    let mut session = imap_client::connect(&config).await?;

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    imap_client::delete_messages(&mut session, &folder, &uid_set).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn imap_get_folder_status(
    config: ImapConfig,
    folder: String,
) -> Result<ImapFolderStatus, String> {
    let mut session = imap_client::connect(&config).await?;
    let status = imap_client::get_folder_status(&mut session, &folder).await?;
    let _ = session.logout().await;
    Ok(status)
}

#[tauri::command]
pub async fn imap_fetch_attachment(
    config: ImapConfig,
    folder: String,
    uid: u32,
    part_id: String,
) -> Result<String, String> {
    let mut session = imap_client::connect(&config).await?;
    let data = imap_client::fetch_attachment(&mut session, &folder, uid, &part_id).await?;
    let _ = session.logout().await;
    Ok(data)
}

#[tauri::command]
pub async fn imap_append_message(
    config: ImapConfig,
    folder: String,
    flags: Option<String>,
    raw_message: String,
) -> Result<(), String> {
    let mut session = imap_client::connect(&config).await?;

    // raw_message is base64url-encoded; decode it
    let raw_bytes = base64url_decode(&raw_message)?;

    let flags_ref = flags.as_deref();
    imap_client::append_message(&mut session, &folder, flags_ref, &raw_bytes).await?;
    let _ = session.logout().await;
    Ok(())
}

fn base64url_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    engine
        .decode(input)
        .map_err(|e| format!("base64url decode failed: {e}"))
}

#[tauri::command]
pub async fn imap_search_folder(
    config: ImapConfig,
    folder: String,
    since_date: Option<String>,
) -> Result<ImapFolderSearchResult, String> {
    let mut session = imap_client::connect(&config).await?;
    let result = imap_client::search_folder(&mut session, &folder, since_date).await;
    let _ = session.logout().await;
    result
}

#[tauri::command]
pub async fn imap_sync_folder(
    config: ImapConfig,
    folder: String,
    batch_size: u32,
    since_date: Option<String>,
) -> Result<ImapFolderSyncResult, String> {
    let mut session = imap_client::connect(&config).await?;
    let result = imap_client::sync_folder(&mut session, &folder, batch_size, since_date).await;
    let _ = session.logout().await;
    result
}

#[tauri::command]
pub async fn imap_raw_fetch_diagnostic(
    config: ImapConfig,
    folder: String,
    uid_range: String,
) -> Result<String, String> {
    imap_client::raw_fetch_diagnostic(&config, &folder, &uid_range).await
}

#[tauri::command]
pub async fn imap_delta_check(
    config: ImapConfig,
    folders: Vec<DeltaCheckRequest>,
) -> Result<Vec<DeltaCheckResult>, String> {
    let mut session = imap_client::connect(&config).await?;
    let results = imap_client::delta_check_folders(&mut session, &folders).await?;
    let _ = session.logout().await;
    Ok(results)
}

// ---------- SMTP commands ----------

#[tauri::command]
pub async fn smtp_send_email(
    config: SmtpConfig,
    raw_email: String,
) -> Result<SmtpSendResult, String> {
    smtp_client::send_raw_email(&config, &raw_email).await
}

#[tauri::command]
pub async fn smtp_test_connection(config: SmtpConfig) -> Result<SmtpSendResult, String> {
    smtp_client::test_connection(&config).await
}

// ---------- POP3 commands ----------

#[tauri::command]
pub async fn pop3_test_connection(config: Pop3Config) -> Result<String, String> {
    pop3_client::Pop3Client::test_connection(&config).await
}

#[tauri::command]
pub async fn pop3_sync(
    config: Pop3Config,
    known_uidls: Vec<String>,
    now_ts: i64,
) -> Result<Pop3SyncResult, String> {
    use std::collections::HashSet;
    let known: HashSet<String> = known_uidls.into_iter().collect();
    crate::pop3::sync(&config, known, now_ts).await
}

// ---------- OpenAI (proxy via Rust to bypass WebView CORS/CSP) ----------

#[tauri::command]
pub async fn openai_chat(
    base_url: String,
    api_key: String,
    model: String,
    system_prompt: String,
    user_content: String,
    max_tokens: u32,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Client error: {e}"))?;

    let base = base_url.trim_end_matches('/');
    let url = format!("{base}/chat/completions");

    let body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_content }
        ]
    });

    let resp = client
        .post(&url)
        .bearer_auth(&api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Connection error: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Read error: {e}"))?;

    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }

    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Parse error: {e} (body: {text})"))?;

    let content = parsed["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    Ok(content)
}

#[tauri::command]
pub async fn openai_test(
    base_url: String,
    api_key: String,
    model: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Client error: {e}"))?;

    let base = base_url.trim_end_matches('/');
    let url = format!("{base}/chat/completions");

    let body = json!({
        "model": model,
        "max_tokens": 5,
        "messages": [{ "role": "user", "content": "Say hi" }]
    });

    let resp = client
        .post(&url)
        .bearer_auth(&api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Connection error: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Read error: {e}"))?;

    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }

    Ok("Connected".to_string())
}

// ---------- CalDAV HTTP proxy (bypasses WebView CORS) ----------

/// A generic HTTP request performed from the Rust side so that CalDAV traffic
/// (which corporate servers will not serve to the `tauri://localhost` WebView
/// origin) is not blocked by browser CORS policy.
#[derive(Deserialize)]
pub struct DavRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    /// "follow" (default) | "manual" | "error"
    pub redirect: Option<String>,
}

#[derive(Serialize)]
pub struct DavResponse {
    pub status: u16,
    pub status_text: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[tauri::command]
pub async fn dav_request(req: DavRequest) -> Result<DavResponse, String> {
    // Only allow http(s) to avoid unexpected local scheme fetches.
    if !req.url.starts_with("https://") && !req.url.starts_with("http://") {
        return Err(format!("Unsupported URL scheme: {}", req.url));
    }

    let method = req
        .method
        .unwrap_or_else(|| "GET".to_string());
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("Invalid HTTP method: {e}"))?;

    let policy = match req.redirect.as_deref() {
        Some("manual") => reqwest::redirect::Policy::none(),
        Some("error") => reqwest::redirect::Policy::none(),
        _ => reqwest::redirect::Policy::default(),
    };

    let client = reqwest::Client::builder()
        .redirect(policy)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Client error: {e}"))?;

    let mut builder = client.request(method, &req.url);

    if let Some(headers) = req.headers {
        for (k, v) in headers {
            builder = builder.header(&k, &v);
        }
    }
    if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = resp.status().as_u16();
    let status_text = resp
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    let final_url = resp.url().to_string();

    let mut headers_map = HashMap::new();
    for (k, v) in resp.headers().iter() {
        headers_map.insert(k.as_str().to_string(), v.to_str().unwrap_or("").to_string());
    }

    let body = resp.text().await.unwrap_or_default();

    Ok(DavResponse {
        status,
        status_text,
        url: final_url,
        headers: headers_map,
        body,
    })
}
