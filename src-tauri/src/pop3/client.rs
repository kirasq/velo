use mail_parser::{Address, MessageParser, MimeHeaders};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_native_tls::TlsStream;

use super::types::*;

// ---------- Timeout constants ----------
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const POP3_CMD_TIMEOUT: Duration = Duration::from_secs(30);
const POP3_RETR_TIMEOUT: Duration = Duration::from_secs(120);
const OVERALL_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

// ---------- Stream wrapper ----------
enum Pop3Stream {
    Tls(TlsStream<TcpStream>),
    Plain(TcpStream),
}

impl AsyncRead for Pop3Stream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            Pop3Stream::Tls(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            Pop3Stream::Plain(s) => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Pop3Stream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Pop3Stream::Tls(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            Pop3Stream::Plain(s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            Pop3Stream::Tls(s) => std::pin::Pin::new(s).poll_flush(cx),
            Pop3Stream::Plain(s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            Pop3Stream::Tls(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            Pop3Stream::Plain(s) => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

fn build_tls_connector(accept_invalid_certs: bool) -> Result<native_tls::TlsConnector, String> {
    let mut builder = native_tls::TlsConnector::builder();
    if accept_invalid_certs {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    builder
        .build()
        .map_err(|e| format!("Failed to create TLS connector: {e}"))
}

fn configure_tcp_socket(stream: &TcpStream) {
    if let Err(e) = stream.set_nodelay(true) {
        log::warn!("Failed to set TCP_NODELAY: {e}");
    }
    let sock_ref = socket2::SockRef::from(stream);
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(60))
        .with_interval(Duration::from_secs(60));
    if let Err(e) = sock_ref.set_tcp_keepalive(&keepalive) {
        log::warn!("Failed to set TCP keepalive: {e}");
    }
}

/// A minimal POP3 client connection. Holds a single buffered stream; POP3 is
/// strictly half-duplex (one command → one response) so a single stream
/// shared for reads and writes is sufficient (no split needed).
pub struct Pop3Client {
    reader: BufReader<Pop3Stream>,
    apop_timestamp: Option<String>,
}

impl Pop3Client {
    pub async fn connect(config: &Pop3Config) -> Result<Self, String> {
        tokio::time::timeout(OVERALL_CONNECT_TIMEOUT, Self::connect_inner(config))
            .await
            .map_err(|_| {
                format!(
                    "POP3 connection to {}:{} timed out after {}s — check server settings or network",
                    config.host, config.port, OVERALL_CONNECT_TIMEOUT.as_secs()
                )
            })?
    }

    async fn connect_inner(config: &Pop3Config) -> Result<Self, String> {
        if config.security == "tls" {
            let tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect((config.host.as_str(), config.port)))
                .await
                .map_err(|_| format!("TCP connect to {}:{} timed out", config.host, config.port))?
                .map_err(|e| format!("TCP connect failed: {e}"))?;
            configure_tcp_socket(&tcp);
            let connector = build_tls_connector(config.accept_invalid_certs)?;
            let tls_connector = tokio_native_tls::TlsConnector::from(connector);
            let tls = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, tls_connector.connect(config.host.as_str(), tcp))
                .await
                .map_err(|_| "TLS handshake timed out".to_string())?
                .map_err(|e| format!("TLS handshake failed: {e}"))?;
            let mut reader = BufReader::new(Pop3Stream::Tls(tls));
            let greeting = read_line(&mut reader).await?;
            if !greeting.starts_with("+OK") {
                return Err(format!("POP3 greeting error: {greeting}"));
            }
            let apop_timestamp = extract_apop_timestamp(&greeting);
            let mut client = Pop3Client {
                reader,
                apop_timestamp,
            };
            client.authenticate(config).await?;
            Ok(client)
        } else {
            // plain or starttls: read greeting over plaintext first
            let tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect((config.host.as_str(), config.port)))
                .await
                .map_err(|_| format!("TCP connect to {}:{} timed out", config.host, config.port))?
                .map_err(|e| format!("TCP connect failed: {e}"))?;
            configure_tcp_socket(&tcp);
            let mut reader = BufReader::new(Pop3Stream::Plain(tcp));
            let greeting = read_line(&mut reader).await?;
            if !greeting.starts_with("+OK") {
                return Err(format!("POP3 greeting error: {greeting}"));
            }
            let apop_timestamp = extract_apop_timestamp(&greeting);

            if config.security == "starttls" {
                write_line(reader.get_mut(), "STLS").await?;
                let resp = read_line(&mut reader).await?;
                if !resp.starts_with("+OK") {
                    return Err(format!("STLS not supported: {resp}"));
                }
                let plain = match reader.into_inner() {
                    Pop3Stream::Plain(s) => s,
                    _ => return Err("unexpected TLS before STLS".to_string()),
                };
                let connector = build_tls_connector(config.accept_invalid_certs)?;
                let tls_connector = tokio_native_tls::TlsConnector::from(connector);
                let tls = tls_connector
                    .connect(config.host.as_str(), plain)
                    .await
                    .map_err(|e| format!("STLS handshake failed: {e}"))?;
                reader = BufReader::new(Pop3Stream::Tls(tls));
            }

            let mut client = Pop3Client {
                reader,
                apop_timestamp,
            };
            client.authenticate(config).await?;
            Ok(client)
        }
    }

    async fn authenticate(&mut self, config: &Pop3Config) -> Result<(), String> {
        if let Some(ts) = &self.apop_timestamp {
            let digest = md5_hex(&format!("{ts}{}", config.password));
            let cmd = format!("APOP {} {}", config.username, digest);
            self.command(&cmd).await?;
            return Ok(());
        }
        self.command(&format!("USER {}", config.username)).await?;
        self.command(&format!("PASS {}", config.password)).await?;
        Ok(())
    }

    async fn command(&mut self, cmd: &str) -> Result<String, String> {
        write_line(self.reader.get_mut(), cmd).await?;
        let resp = tokio::time::timeout(POP3_CMD_TIMEOUT, read_line(&mut self.reader))
            .await
            .map_err(|_| format!("POP3 command timed out: {cmd}"))?
            .map_err(|e| format!("POP3 read error: {e}"))?;
        if !resp.starts_with("+OK") {
            return Err(format!("POP3 error on '{cmd}': {resp}"));
        }
        Ok(resp)
    }

    pub async fn stat(&mut self) -> Result<(u32, u32), String> {
        let resp = self.command("STAT").await?;
        let parts: Vec<&str> = resp.split_whitespace().collect();
        if parts.len() < 3 {
            return Err(format!("Malformed STAT response: {resp}"));
        }
        let count = parts[1].parse::<u32>().map_err(|_| format!("Bad STAT count: {}", parts[1]))?;
        let size = parts[2].parse::<u32>().map_err(|_| format!("Bad STAT size: {}", parts[2]))?;
        Ok((count, size))
    }

    pub async fn uidl_all(&mut self) -> Result<Vec<Pop3MessageMeta>, String> {
        write_line(self.reader.get_mut(), "UIDL").await?;
        let first = tokio::time::timeout(POP3_CMD_TIMEOUT, read_line(&mut self.reader))
            .await
            .map_err(|_| "UIDL timed out".to_string())?
            .map_err(|e| format!("UIDL read error: {e}"))?;
        if !first.starts_with("+OK") {
            return Err(format!("UIDL error: {first}"));
        }
        let mut metas = Vec::new();
        loop {
            let line = tokio::time::timeout(POP3_CMD_TIMEOUT, read_line(&mut self.reader))
                .await
                .map_err(|_| "UIDL body timed out".to_string())?
                .map_err(|e| format!("UIDL body read error: {e}"))?;
            if line == "." {
                break;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                let num = parts[0].parse::<u32>().unwrap_or(0);
                let uidl = parts[1].to_string();
                metas.push(Pop3MessageMeta {
                    msg_number: num,
                    uidl,
                    size: 0,
                });
            }
        }
        Ok(metas)
    }

    pub async fn list_all(&mut self) -> Result<std::collections::HashMap<u32, u32>, String> {
        write_line(self.reader.get_mut(), "LIST").await?;
        let first = tokio::time::timeout(POP3_CMD_TIMEOUT, read_line(&mut self.reader))
            .await
            .map_err(|_| "LIST timed out".to_string())?
            .map_err(|e| format!("LIST read error: {e}"))?;
        if !first.starts_with("+OK") {
            return Err(format!("LIST error: {first}"));
        }
        let mut sizes = std::collections::HashMap::new();
        loop {
            let line = tokio::time::timeout(POP3_CMD_TIMEOUT, read_line(&mut self.reader))
                .await
                .map_err(|_| "LIST body timed out".to_string())?
                .map_err(|e| format!("LIST body read error: {e}"))?;
            if line == "." {
                break;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                if let (Ok(n), Ok(s)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                    sizes.insert(n, s);
                }
            }
        }
        Ok(sizes)
    }

    pub async fn retr(&mut self, msg_number: u32) -> Result<Vec<u8>, String> {
        write_line(self.reader.get_mut(), &format!("RETR {msg_number}")).await?;
        let first = tokio::time::timeout(POP3_RETR_TIMEOUT, read_line(&mut self.reader))
            .await
            .map_err(|_| format!("RETR {msg_number} timed out"))?
            .map_err(|e| format!("RETR read error: {e}"))?;
        if !first.starts_with("+OK") {
            return Err(format!("RETR error: {first}"));
        }
        let mut raw: Vec<u8> = Vec::new();
        loop {
            let line = tokio::time::timeout(POP3_RETR_TIMEOUT, read_raw_line(&mut self.reader))
                .await
                .map_err(|_| "RETR body timed out".to_string())?
                .map_err(|e| format!("RETR body read error: {e}"))?;
            if line == b".\r\n" || line == b".\n" {
                break;
            }
            let unstuffed = if line.first() == Some(&b'.') {
                &line[1..]
            } else {
                &line[..]
            };
            raw.extend_from_slice(unstuffed);
        }
        Ok(raw)
    }

    pub async fn dele(&mut self, msg_number: u32) -> Result<(), String> {
        self.command(&format!("DELE {msg_number}")).await?;
        Ok(())
    }

    pub async fn noop(&mut self) -> Result<(), String> {
        self.command("NOOP").await?;
        Ok(())
    }

    pub async fn quit(&mut self) {
        let _ = self.command("QUIT").await;
        let _ = self.reader.get_mut().shutdown().await;
    }

    pub async fn test_connection(config: &Pop3Config) -> Result<String, String> {
        let mut client = Self::connect(config).await?;
        let (count, _size) = client.stat().await?;
        client.quit().await;
        Ok(format!("Connected successfully. Mailbox has {count} message(s)."))
    }
}

// ---------- helpers ----------

fn extract_apop_timestamp(greeting: &str) -> Option<String> {
    let start = greeting.find('<')?;
    let end = greeting.find('>')?;
    if end > start {
        Some(greeting[start + 1..end].to_string())
    } else {
        None
    }
}

/// RFC 1321 MD5 (used for APOP). Self-contained, no external crate.
fn md5_hex(input: &str) -> String {
    let digest = md5::compute(input.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

mod md5 {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc4ac5665, 0xf4292244, 0x432aff97,
        0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1, 0x6fa87e4f,
        0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453,
    ];

    pub fn compute(input: &[u8]) -> [u8; 16] {
        let mut a0: u32 = 0x67452301;
        let mut b0: u32 = 0xefcdab89;
        let mut c0: u32 = 0x98badcfe;
        let mut d0: u32 = 0x10325476;

        let mut msg = input.to_vec();
        let orig_len_bits = (input.len() as u64).wrapping_mul(8);
        msg.push(0x80);
        while msg.len() % 64 != 56 {
            msg.push(0);
        }
        msg.extend_from_slice(&orig_len_bits.to_le_bytes());

        for chunk in msg.chunks(64) {
            let mut m = [0u32; 16];
            for i in 0..16 {
                m[i] = u32::from_le_bytes([
                    chunk[i * 4],
                    chunk[i * 4 + 1],
                    chunk[i * 4 + 2],
                    chunk[i * 4 + 3],
                ]);
            }
            let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
            for i in 0..64 {
                let (f, g) = match i {
                    0..=15 => ((b & c) | ((!b) & d), i),
                    16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                    32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                    _ => (c ^ (b | (!d)), (7 * i) % 16),
                };
                let f = f
                    .wrapping_add(a)
                    .wrapping_add(K[i])
                    .wrapping_add(m[g]);
                a = d;
                d = c;
                c = b;
                b = b.wrapping_add(f.rotate_left(S[i]));
            }
            a0 = a0.wrapping_add(a);
            b0 = b0.wrapping_add(b);
            c0 = c0.wrapping_add(c);
            d0 = d0.wrapping_add(d);
        }

        let mut out = [0u8; 16];
        out[0..4].copy_from_slice(&a0.to_le_bytes());
        out[4..8].copy_from_slice(&b0.to_le_bytes());
        out[8..12].copy_from_slice(&c0.to_le_bytes());
        out[12..16].copy_from_slice(&d0.to_le_bytes());
        out
    }
}

async fn write_line(stream: &mut Pop3Stream, line: &str) -> Result<(), String> {
    stream
        .write_all(format!("{line}\r\n").as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    stream.flush().await.map_err(|e| format!("flush: {e}"))
}

async fn read_line<R>(reader: &mut BufReader<R>) -> Result<String, String>
where
    R: AsyncRead + Unpin,
{
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("read_line: {e}"))?;
    let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
    Ok(trimmed.to_string())
}

async fn read_raw_line<R>(reader: &mut BufReader<R>) -> Result<Vec<u8>, String>
where
    R: AsyncRead + Unpin,
{
    let mut buf: Vec<u8> = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = reader
            .read(&mut byte)
            .await
            .map_err(|e| format!("read_raw_line: {e}"))?;
        if n == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.len() >= 2 && buf[buf.len() - 2] == b'\r' && buf[buf.len() - 1] == b'\n' {
            break;
        }
    }
    Ok(buf)
}

// ---------- message parsing ----------
pub fn parse_message(uidl: &str, raw: &[u8]) -> Result<Pop3Message, String> {
    let parsed = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| "Failed to parse message".to_string())?;

    let from_address = parsed
        .from()
        .and_then(|a| a.as_list())
        .and_then(|list| list.first())
        .and_then(|f| f.address())
        .map(|s| s.to_string());
    let from_name = parsed
        .from()
        .and_then(|a| a.as_list())
        .and_then(|list| list.first())
        .and_then(|f| f.name())
        .map(|s| s.to_string());

    let to_addresses = join_addresses(parsed.to());
    let cc_addresses = join_addresses(parsed.cc());
    let bcc_addresses = join_addresses(parsed.bcc());
    let reply_to = join_addresses(parsed.reply_to());

    let subject = parsed.subject().map(|s| s.to_string());
    let date = parsed.date().map(|d| d.to_timestamp()).unwrap_or(0);

    let message_id = parsed.message_id().map(|s| s.to_string());
    let in_reply_to = opt_header_str(&parsed.in_reply_to());
    let references = opt_header_str(&parsed.references());

    let body_html = parsed.body_html(0).map(|s| s.to_string());
    let body_text = parsed.body_text(0).map(|s| s.to_string());

    let snippet = body_text
        .as_ref()
        .or(body_html.as_ref())
        .map(|b| {
            b.replace('\n', " ")
                .replace('\r', " ")
                .trim()
                .chars()
                .take(200)
                .collect::<String>()
        });

    let raw_str = String::from_utf8_lossy(raw);
    let list_unsubscribe = extract_header(&raw_str, "list-unsubscribe");
    let list_unsubscribe_post = extract_header(&raw_str, "list-unsubscribe-post");
    let auth_results = extract_header(&raw_str, "authentication-results");

    let mut attachments = Vec::new();
    for att in parsed.attachments() {
        let filename = att
            .attachment_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "attachment".to_string());
        let mime_type = att
            .content_type()
            .map(|c| {
                let sub = c.subtype().unwrap_or("");
                if sub.is_empty() {
                    c.ctype().to_string()
                } else {
                    format!("{}/{}", c.ctype(), sub)
                }
            })
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let size = att.raw_len() as u32;
        let content_id = att.content_id().map(|s| s.to_string());
        let is_inline = att
            .content_disposition()
            .map_or(false, |d| d.ctype().eq_ignore_ascii_case("inline"));
        attachments.push(Pop3Attachment {
            filename,
            mime_type,
            size,
            content_id,
            is_inline,
        });
    }

    Ok(Pop3Message {
        uidl: uidl.to_string(),
        message_id,
        in_reply_to,
        references,
        from_address,
        from_name,
        to_addresses,
        cc_addresses,
        bcc_addresses,
        reply_to,
        subject,
        date,
        body_html,
        body_text,
        snippet,
        raw_size: raw.len() as u32,
        list_unsubscribe,
        list_unsubscribe_post,
        auth_results,
        attachments,
    })
}

fn join_addresses(addrs: Option<&Address>) -> Option<String> {
    let list = addrs?.as_list()?;
    let v: Vec<String> = list
        .iter()
        .filter_map(|a| a.address())
        .map(|s| s.to_string())
        .collect();
    if v.is_empty() {
        None
    } else {
        Some(v.join(","))
    }
}

fn opt_header_str(h: &mail_parser::HeaderValue) -> Option<String> {
    h.as_text().map(|s| s.to_string())
}

fn extract_header(raw: &str, name: &str) -> Option<String> {
    let key = format!("{}:", name.to_lowercase());
    if let Some(idx) = raw.to_lowercase().find(&key) {
        let rest = &raw[idx + key.len()..];
        let end = rest.find("\r\n").unwrap_or(rest.len());
        let val = rest[..end].trim().to_string();
        if val.is_empty() {
            None
        } else {
            Some(val)
        }
    } else {
        None
    }
}
