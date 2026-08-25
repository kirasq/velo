import { invoke } from "@tauri-apps/api/core";

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

  const res = await invoke<{
    status: number;
    statusText: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  }>("dav_request", {
    url,
    method,
    headers,
    body: body ?? null,
    redirect,
  });

  const status = res.status;
  const ok = status >= 200 && status < 300;

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
