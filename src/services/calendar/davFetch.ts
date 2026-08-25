import { invoke } from "@tauri-apps/api/core";

// ---- Structured CalDAV error / diagnosis types (mirror of Rust `dav_diag`) ----

export type DavFailureKind =
  | "dns"
  | "tcp"
  | "tls"
  | "timeout"
  | "server-rejected"
  | "http"
  | "invalid-url"
  | "unknown";

export interface DavErrorShape {
  kind: DavFailureKind;
  message: string;
  url: string;
  retryable: boolean;
  retryAfterMs: number | null;
}

export interface DavStageResult {
  ok: boolean;
  detail: string;
  durationMs: number;
  resolved?: string[];
  errorKind?: DavFailureKind;
}

export interface DavTlsResult {
  ok: boolean;
  detail: string;
  durationMs: number;
  certPresented?: boolean | null;
  errorKind?: DavFailureKind;
}

export interface DavHttpResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  bodySnippet?: string;
  durationMs: number;
  errorKind?: DavFailureKind;
}

export interface DavDiagnosisShape {
  url: string;
  overall: "ok" | "failed";
  dns: DavStageResult;
  tcp: DavStageResult;
  tls: DavTlsResult;
  http: DavHttpResult;
}

/** Parse a structured `DavError` JSON string (as returned by `dav_request`). */
export function parseDavError(raw: string): DavErrorShape | null {
  const s = raw.trim();
  if (!s.startsWith("{")) return null;
  try {
    const obj = JSON.parse(s) as DavErrorShape;
    if (obj && typeof obj.kind === "string" && typeof obj.message === "string") {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run a staged connectivity diagnosis (DNS → TCP → TLS → HTTP) against a URL.
 * Always succeeds with a `DavDiagnosisShape` describing where the chain broke.
 */
export async function davDiagnose(req: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeoutSecs?: number;
  dnsTimeoutMs?: number;
  tcpTimeoutMs?: number;
  tlsTimeoutMs?: number;
}): Promise<DavDiagnosisShape> {
  return invoke<DavDiagnosisShape>("dav_diagnose", { req });
}

/** Build a one-line human summary from a diagnosis (for error panels). */
export function summarizeDiagnosis(dx: DavDiagnosisShape): string {
  if (dx.overall === "ok") {
    return `connected (${dx.http.status ?? "?"} ${dx.http.statusText ?? ""})`;
  }
  const parts: string[] = [];
  if (!dx.dns.ok) parts.push(`DNS: ${dx.dns.detail}`);
  if (!dx.tcp.ok && dx.tcp.detail !== "skipped (previous stage failed)")
    parts.push(`TCP: ${dx.tcp.detail}`);
  if (!dx.tls.ok && dx.tls.detail.startsWith("TLS")) parts.push(`TLS: ${dx.tls.detail}`);
  if (!dx.http.ok && dx.http.errorKind) {
    const s = dx.http.status ? ` (${dx.http.status})` : "";
    parts.push(`HTTP${s}: ${dx.http.errorKind}`);
  }
  if (parts.length === 0) parts.push("unknown failure");
  return parts.join("; ");
}

/**
 * A drop-in `fetch` replacement for CalDAV traffic.
 *
 * The Tauri WebView runs with origin `tauri://localhost`. Corporate CalDAV
 * servers (e.g. the isoftstone Nextcloud) never send
 * `Access-Control-Allow-Origin: tauri://localhost`, so any direct `fetch` from
 * the renderer is blocked by the browser's CORS policy. This shim forwards the
 * request to a Rust-side `dav_request` command (which uses `reqwest` and is not
 * subject to CORS), then rebuilds a standard `Response`-like object that
 * `tsdav` expects (`status`, `statusText`, `ok`, `url`, `headers.get`, `text`,
 * `json`).
 */
export async function davFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ResponseLike> {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : (input as Request).url;

  const method = init?.method ?? "GET";

  const headers: Record<string, string> = {};
  const rawHeaders = init?.headers;
  if (rawHeaders) {
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(rawHeaders)) {
      rawHeaders.forEach(([key, value]) => {
        headers[key] = value;
      });
    } else {
      Object.assign(headers, rawHeaders);
    }
  }

  const body = init?.body != null ? String(init.body) : undefined;
  const redirect =
    init?.redirect === "manual"
      ? "manual"
      : init?.redirect === "error"
        ? "error"
        : "follow";

  let res: {
    status: number;
    statusText: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  try {
    res = await invoke<{
      status: number;
      statusText: string;
      url: string;
      headers: Record<string, string>;
      body: string;
    }>("dav_request", {
      // Tauri v2 wraps a struct command arg under its parameter name.
      req: {
        url,
        method,
        headers,
        body: body ?? null,
        redirect,
      },
    });
  } catch (e) {
    const msg = toErrorMessage(e);
    console.error("[davFetch] dav_request invoke failed:", msg, e);
    throw new Error(`[dav_request] ${msg}`);
  }

  const status = res.status;
  const ok = status >= 200 && status < 300;

  // Diagnostics: surface the raw server response so CalDAV failures are
  // debuggable from the dev console instead of collapsing into "Connection failed".
  const contentType = res.headers["content-type"] ?? res.headers["Content-Type"] ?? "";
  if (!ok || !contentType.includes("xml")) {
    console.debug(
      `[davFetch] ${method} ${url} → ${status} ${res.statusText}` +
        ` ct=${contentType || "(none)"}` +
        ` body=${res.body.slice(0, 300)}${res.body.length > 300 ? "…" : ""}`,
    );
  }

  return {
    url: res.url,
    status,
    statusText: res.statusText,
    ok,
    headers: new Headers(res.headers),
    async text() {
      return res.body;
    },
    async json() {
      return JSON.parse(res.body);
    },
    async arrayBuffer() {
      return new TextEncoder().encode(res.body).buffer;
    },
  };
}

export interface ResponseLike {
  url: string;
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Extract a human-readable message from a Tauri invoke rejection.
 * Tauri v2 may reject with a string, an InvokeError object, or a plain object,
 * so normalize all of those into a single string. Structured `DavError` JSON
 * (from `dav_request`) is decoded into a `[kind] message` form. */
function toErrorMessage(e: unknown): string {
  if (typeof e === "string") {
    const parsed = parseDavError(e);
    return parsed ? `[${parsed.kind}] ${parsed.message}` : e;
  }
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message.length > 0) {
      const parsed = parseDavError(obj.message);
      return parsed ? `[${parsed.kind}] ${parsed.message}` : obj.message;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}
