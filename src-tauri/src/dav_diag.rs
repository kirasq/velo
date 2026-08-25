//! CalDAV / WebDAV connectivity diagnostics and structured error handling.
//!
//! `dav_request` (in `commands.rs`) performs the actual proxied HTTP request and
//! returns a [`DavError`] (serialized to JSON) on failure, with configurable
//! retry + exponential backoff.
//!
//! `dav_diagnose` runs a staged probe — DNS → TCP → TLS → HTTP — and reports a
//! [`DavDiagnosis`] describing exactly where the chain broke (so the UI can tell
//! the user "DNS failed", "TLS certificate rejected", "server refused", etc.).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::net::{TcpStream, lookup_host};
use tokio_native_tls::TlsConnector as TokioTlsConnector;

/// Coarse classification of a CalDAV/WebDAV request failure.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub enum DavFailureKind {
    /// Hostname could not be resolved.
    Dns,
    /// TCP connection to host:port was refused / reset / unreachable.
    Tcp,
    /// TLS handshake failed (certificate error, host mismatch, expired, etc.).
    Tls,
    /// The request exceeded the timeout (DNS, connect, or TLS handshake).
    Timeout,
    /// Server answered with 4xx (auth/permission/path) or 5xx.
    ServerRejected,
    /// Lower-level HTTP error not covered above.
    Http,
    /// The URL/method was malformed or the scheme is unsupported.
    InvalidUrl,
    /// Could not be classified.
    Unknown,
}

/// Structured, serializable error returned by `dav_request`.
///
/// `dav_request` serializes this into a JSON string and returns it as the
/// command error; on the JS side `davFetch.toErrorMessage` parses it back into
/// `{ kind, message, retryable, retryAfterMs }`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DavError {
    pub kind: DavFailureKind,
    pub message: String,
    pub url: String,
    /// Whether retrying (possibly on a different network) is likely to help.
    pub retryable: bool,
    /// Suggested wait before retrying, in milliseconds (None = not retryable).
    pub retry_after_ms: Option<u64>,
}

impl DavError {
    /// Build a [`DavError`] with sensible retryability defaults per [`DavFailureKind`].
    pub fn new(kind: DavFailureKind, message: impl Into<String>, url: &str) -> Self {
        let retryable = matches!(
            kind,
            DavFailureKind::Dns
                | DavFailureKind::Tcp
                | DavFailureKind::Timeout
                | DavFailureKind::Http
                | DavFailureKind::Unknown
        );
        // 5xx server errors are worth retrying; 4xx (auth/path) are not. The
        // transport-error path cannot see the status, so it stays non-retryable.
        let retry_after_ms = if retryable { Some(500) } else { None };
        DavError {
            kind,
            message: message.into(),
            url: url.to_string(),
            retryable,
            retry_after_ms,
        }
    }

    /// Serialize to a JSON string for Tauri's string-error channel.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| self.message.clone())
    }
}

/// Configurable retry parameters for `dav_request`.
#[derive(Deserialize, Clone, Debug)]
pub struct DavRetry {
    /// Extra attempts after the first (0 = no retry). Default 2.
    #[serde(default)]
    pub max_retries: Option<u32>,
    /// Base delay before the first retry, in ms. Default 500.
    #[serde(default)]
    pub base_delay_ms: Option<u64>,
    /// Exponential backoff multiplier. Default 2.0 (min 1.0).
    #[serde(default)]
    pub backoff_factor: Option<f64>,
    /// Per-attempt request timeout, in seconds. Default 30.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

impl Default for DavRetry {
    fn default() -> Self {
        DavRetry {
            max_retries: Some(2),
            base_delay_ms: Some(500),
            backoff_factor: Some(2.0),
            timeout_secs: Some(30),
        }
    }
}

impl DavRetry {
    pub fn max_retries(&self) -> u32 {
        self.max_retries.unwrap_or(2)
    }
    pub fn base_delay_ms(&self) -> u64 {
        self.base_delay_ms.unwrap_or(500)
    }
    pub fn backoff_factor(&self) -> f64 {
        self.backoff_factor.unwrap_or(2.0).max(1.0)
    }
    pub fn timeout_secs(&self) -> u64 {
        self.timeout_secs.unwrap_or(30)
    }
}

/// ---- Staged diagnosis result structs ----

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StageResult {
    /// true if the stage completed successfully.
    pub ok: bool,
    /// Human-readable detail / error message.
    pub detail: String,
    /// Stage duration in milliseconds.
    pub duration_ms: u64,
    /// Resolved IP:port list (DNS stage only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved: Option<Vec<String>>,
    /// Failure category (only when ok == false).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<DavFailureKind>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TlsResult {
    pub ok: bool,
    pub detail: String,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cert_presented: Option<bool>,
    /// Timeout vs handshake/cert error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<DavFailureKind>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HttpResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_snippet: Option<String>,
    pub duration_ms: u64,
    /// Set when the HTTP stage itself failed (transport error).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<DavFailureKind>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DavDiagnosis {
    pub url: String,
    /// "ok" if the HTTP stage got a response, otherwise "failed".
    pub overall: String,
    pub dns: StageResult,
    pub tcp: StageResult,
    pub tls: TlsResult,
    pub http: HttpResult,
}

/// ---- Shared HTTP core ----

fn build_redirect_policy(redirect: &str) -> reqwest::redirect::Policy {
    match redirect {
        "manual" | "error" => reqwest::redirect::Policy::none(),
        _ => reqwest::redirect::Policy::default(),
    }
}

pub struct RawOutcome {
    pub status: u16,
    pub status_text: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// Perform a single HTTP request via `reqwest` and return the raw outcome.
/// Any transport failure is mapped to a classified [`DavError`].
pub async fn raw_http(
    url: &str,
    method: &str,
    headers: &Option<HashMap<String, String>>,
    body: &Option<String>,
    timeout_secs: u64,
    redirect: &str,
) -> Result<RawOutcome, DavError> {
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| {
        DavError::new(DavFailureKind::InvalidUrl, format!("Invalid HTTP method: {e}"), url)
    })?;

    let client = reqwest::Client::builder()
        .redirect(build_redirect_policy(redirect))
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| {
            DavError::new(DavFailureKind::InvalidUrl, format!("Client build error: {e}"), url)
        })?;

    let mut builder = client.request(method, url);
    if let Some(h) = headers {
        for (k, v) in h {
            builder = builder.header(k, v);
        }
    }
    if let Some(b) = body {
        builder = builder.body(b.clone());
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| classify_transport_error(url, e))?;

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
    let body_text = resp.text().await.unwrap_or_default();

    Ok(RawOutcome {
        status,
        status_text,
        url: final_url,
        headers: headers_map,
        body: body_text,
    })
}

fn chain_text(err: &reqwest::Error) -> String {
    let mut parts = Vec::new();
    let mut cur: Option<&dyn std::error::Error> = Some(err);
    while let Some(e) = cur {
        parts.push(e.to_string());
        cur = e.source();
    }
    parts.join(" | ")
}

fn is_tls_error(chain: &str) -> bool {
    let lower = chain.to_lowercase();
    lower.contains("certificate")
        || lower.contains("ssl")
        || lower.contains("tls")
        || lower.contains("handshake")
        || lower.contains("x509")
        || lower.contains("identity")
        || lower.contains("self signed")
        || lower.contains("expired")
        || lower.contains("unknown ca")
        || lower.contains("verify failed")
}

/// Map a `reqwest` transport error to a classified [`DavError`].
fn classify_transport_error(url: &str, err: reqwest::Error) -> DavError {
    let msg = err.to_string();
    let chain = chain_text(&err);

    let kind = if err.is_timeout() {
        DavFailureKind::Timeout
    } else if err.is_connect() {
        // reqwest folds DNS + TCP connect errors into `is_connect()`; the staged
        // `dav_diagnose` command pinpoints which one. Default to Tcp here.
        DavFailureKind::Tcp
    } else if is_tls_error(&chain) {
        DavFailureKind::Tls
    } else if err.is_status() {
        DavFailureKind::ServerRejected
    } else if err.is_request() {
        DavFailureKind::InvalidUrl
    } else {
        DavFailureKind::Unknown
    };

    let detail = match kind {
        DavFailureKind::Timeout => format!("Request timed out: {msg}"),
        DavFailureKind::Tls => format!("TLS handshake failed: {chain}"),
        DavFailureKind::ServerRejected => format!("Server returned an error status: {msg}"),
        DavFailureKind::InvalidUrl => format!("Invalid request: {msg}"),
        _ => format!("Request failed: {msg}"),
    };

    DavError::new(kind, detail, url)
}

// ---- Staged diagnosis helpers ----

fn now_ms(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

fn skipped_stage() -> StageResult {
    StageResult {
        ok: false,
        detail: "skipped (previous stage failed)".to_string(),
        duration_ms: 0,
        resolved: None,
        error_kind: None,
    }
}

/// Extract `(host, port, is_https)` from a URL without pulling in a URL crate.
/// Sufficient for diagnostic purposes; bracketed IPv6 host falls back to the
/// scheme default port.
fn parse_target(url: &str) -> Option<(String, u16, bool)> {
    let (scheme, rest) = url.split_once("://")?;
    let is_https = scheme.eq_ignore_ascii_case("https");
    let default_port: u16 = if is_https {
        443
    } else if scheme.eq_ignore_ascii_case("http") {
        80
    } else {
        return None;
    };

    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    // strip userinfo (user:pass@host)
    let authority = authority.rsplit_once('@').map(|(_, a)| a).unwrap_or(authority);

    let (host, port) = if let Some((h, p)) = authority.rsplit_once(':') {
        if h.starts_with('[') {
            // IPv6 literal like [::1]:8443 — keep as-is, use default scheme port.
            (authority.to_string(), default_port)
        } else {
            let port = p.parse::<u16>().unwrap_or(default_port);
            (h.to_string(), port)
        }
    } else {
        (authority.to_string(), default_port)
    };

    if host.is_empty() {
        return None;
    }
    Some((host, port, is_https))
}

#[derive(Deserialize)]
pub struct DavDiagnoseRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub timeout_secs: Option<u64>,
    pub dns_timeout_ms: Option<u64>,
    pub tcp_timeout_ms: Option<u64>,
    pub tls_timeout_ms: Option<u64>,
}

#[tauri::command]
pub async fn dav_diagnose(req: DavDiagnoseRequest) -> Result<DavDiagnosis, String> {
    let url = req.url.clone();

    let (host, port, is_https) = match parse_target(&url) {
        Some(t) => t,
        None => {
            let diag = DavDiagnosis {
                url: url.clone(),
                overall: "failed".to_string(),
                dns: StageResult {
                    ok: false,
                    detail: format!("Cannot parse URL: {url}"),
                    duration_ms: 0,
                    resolved: None,
                    error_kind: Some(DavFailureKind::InvalidUrl),
                },
                tcp: skipped_stage(),
                tls: TlsResult {
                    ok: false,
                    detail: "skipped".to_string(),
                    duration_ms: 0,
                    cert_presented: None,
                    error_kind: None,
                },
                http: HttpResult {
                    ok: false,
                    status: None,
                    status_text: None,
                    headers: None,
                    body_snippet: None,
                    duration_ms: 0,
                    error_kind: None,
                },
            };
            return Ok(diag);
        }
    };

    let dns_timeout = Duration::from_millis(req.dns_timeout_ms.unwrap_or(8000));
    let tcp_timeout = Duration::from_millis(req.tcp_timeout_ms.unwrap_or(8000));
    let tls_timeout = Duration::from_millis(req.tls_timeout_ms.unwrap_or(10000));
    let http_timeout = req.timeout_secs.unwrap_or(30);

    // ---- DNS ----
    let dns_start = Instant::now();
    let dns = match tokio::time::timeout(dns_timeout, lookup_host((host.as_str(), port))).await {
        Ok(Ok(addrs)) => {
            let list: Vec<String> = addrs.into_iter().map(|a| a.to_string()).collect();
            StageResult {
                ok: true,
                detail: format!("Resolved {} address(es)", list.len()),
                duration_ms: now_ms(dns_start),
                resolved: Some(list),
                error_kind: None,
            }
        }
        Ok(Err(e)) => StageResult {
            ok: false,
            detail: format!("DNS resolution failed: {e}"),
            duration_ms: now_ms(dns_start),
            resolved: None,
            error_kind: Some(DavFailureKind::Dns),
        },
        Err(_) => StageResult {
            ok: false,
            detail: format!("DNS resolution timed out after {}ms", dns_timeout.as_millis()),
            duration_ms: now_ms(dns_start),
            resolved: None,
            error_kind: Some(DavFailureKind::Timeout),
        },
    };

    // ---- TCP ----
    let tcp = if dns.ok {
        let tcp_start = Instant::now();
        match tokio::time::timeout(tcp_timeout, TcpStream::connect((host.as_str(), port))).await {
            Ok(Ok(_stream)) => StageResult {
                ok: true,
                detail: format!("TCP connection to {host}:{port} succeeded"),
                duration_ms: now_ms(tcp_start),
                resolved: None,
                error_kind: None,
            },
            Ok(Err(e)) => StageResult {
                ok: false,
                detail: format!("TCP connection failed: {e}"),
                duration_ms: now_ms(tcp_start),
                resolved: None,
                error_kind: Some(DavFailureKind::Tcp),
            },
            Err(_) => StageResult {
                ok: false,
                detail: format!("TCP connection timed out after {}ms", tcp_timeout.as_millis()),
                duration_ms: now_ms(tcp_start),
                resolved: None,
                error_kind: Some(DavFailureKind::Timeout),
            },
        }
    } else {
        skipped_stage()
    };

    // ---- TLS ----
    let tls = if is_https && tcp.ok {
        let tls_start = Instant::now();
        match tokio::time::timeout(tls_timeout, async {
            let stream = TcpStream::connect((host.as_str(), port)).await?;
            let connector = TokioTlsConnector::from(
                native_tls::TlsConnector::new()
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?,
            );
            connector
                .connect(host.as_str(), stream)
                .await
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            Ok::<_, std::io::Error>(())
        })
        .await
        {
            Ok(Ok(())) => TlsResult {
                ok: true,
                detail: "TLS handshake succeeded".to_string(),
                duration_ms: now_ms(tls_start),
                cert_presented: None,
                error_kind: None,
            },
            Ok(Err(e)) => {
                let kind = if e.kind() == std::io::ErrorKind::TimedOut {
                    DavFailureKind::Timeout
                } else {
                    DavFailureKind::Tls
                };
                TlsResult {
                    ok: false,
                    detail: format!("TLS handshake failed: {e}"),
                    duration_ms: now_ms(tls_start),
                    cert_presented: None,
                    error_kind: Some(kind),
                }
            }
            Err(_) => TlsResult {
                ok: false,
                detail: format!("TLS handshake timed out after {}ms", tls_timeout.as_millis()),
                duration_ms: now_ms(tls_start),
                cert_presented: None,
                error_kind: Some(DavFailureKind::Timeout),
            },
        }
    } else if is_https {
        TlsResult {
            ok: false,
            detail: "skipped (TCP stage failed)".to_string(),
            duration_ms: 0,
            cert_presented: None,
            error_kind: None,
        }
    } else {
        TlsResult {
            ok: true,
            detail: "not HTTPS — skipped".to_string(),
            duration_ms: 0,
            cert_presented: None,
            error_kind: None,
        }
    };

    // ---- HTTP ----
    let http = if tcp.ok {
        let http_start = Instant::now();
        let method = req.method.clone().unwrap_or_else(|| "OPTIONS".to_string());
        match raw_http(&url, &method, &req.headers, &None, http_timeout, "follow").await {
            Ok(o) => {
                let snippet = if o.body.len() > 500 {
                    format!("{}…", &o.body[..500])
                } else {
                    o.body.clone()
                };
                let status_kind = if o.status >= 400 {
                    Some(DavFailureKind::ServerRejected)
                } else {
                    None
                };
                HttpResult {
                    ok: true,
                    status: Some(o.status),
                    status_text: Some(o.status_text),
                    headers: Some(o.headers),
                    body_snippet: Some(snippet),
                    duration_ms: now_ms(http_start),
                    error_kind: status_kind,
                }
            }
            Err(e) => HttpResult {
                ok: false,
                status: None,
                status_text: None,
                headers: None,
                body_snippet: None,
                duration_ms: now_ms(http_start),
                error_kind: Some(e.kind),
            },
        }
    } else {
        HttpResult {
            ok: false,
            status: None,
            status_text: None,
            headers: None,
            body_snippet: None,
            duration_ms: 0,
            error_kind: None,
        }
    };

    let overall = if http.ok {
        "ok".to_string()
    } else {
        "failed".to_string()
    };

    Ok(DavDiagnosis {
        url,
        overall,
        dns,
        tcp,
        tls,
        http,
    })
}
