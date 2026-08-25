import { useRef, useCallback, useLayoutEffect, useMemo, useState, useEffect } from "react";
import { ImageOff } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { stripRemoteImages, hasBlockedImages } from "@/utils/imageBlocker";
import { addToAllowlist } from "@/services/db/imageAllowlist";
import { escapeHtml, sanitizeHtml } from "@/utils/sanitize";
import { useUIStore } from "@/stores/uiStore";
import type { DbAttachment } from "@/services/db/attachments";

/** 1x1 transparent GIF — neutral fallback for unresolved inline images. */
const INLINE_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Normalize a reference token (cid: or Content-Location) for map lookup. */
function normalizeRef(ref: string): string {
  let s = ref.trim();
  if (s.toLowerCase().startsWith("cid:")) s = s.slice(4);
  s = s.replace(/^[<>]+|[<>]+$/g, "").trim();
  return s;
}

interface EmailRendererProps {
  html: string | null;
  text: string | null;
  blockImages?: boolean;
  senderAddress?: string | null;
  accountId?: string | null;
  senderAllowlisted?: boolean;
  messageId?: string | null;
  inlineAttachments?: DbAttachment[];
}

export function EmailRenderer({
  html,
  text,
  blockImages = false,
  senderAddress,
  accountId,
  senderAllowlisted = false,
  messageId,
  inlineAttachments,
}: EmailRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number>(0);
  const [overrideShow, setOverrideShow] = useState(false);
  const [resolvedRefs, setResolvedRefs] = useState<Map<string, string>>(new Map());

  const theme = useUIStore((s) => s.theme);
  const isDark = theme === "dark"
    || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  const shouldBlock = blockImages && !senderAllowlisted && !overrideShow;

  // Resolve inline attachment references (cid: AND Content-Location/bare-token)
  // to data URIs by fetching attachment bytes from the local cache.
  useEffect(() => {
    if (!accountId || !messageId || !inlineAttachments?.length) return;

    const refs = inlineAttachments.filter(
      (a) => a.gmail_attachment_id && (a.content_id || a.content_location || a.filename),
    );
    if (refs.length === 0) return;

    let cancelled = false;

    (async () => {
      try {
        const { getEmailProvider } = await import("@/services/email/providerFactory");
        const provider = await getEmailProvider(accountId);
        const resolved = new Map<string, string>();

        await Promise.all(
          refs.map(async (att) => {
            try {
              const response = await provider.fetchAttachment(
                messageId,
                att.gmail_attachment_id!,
              );
              const base64 = response.data.replace(/-/g, "+").replace(/_/g, "/");
              const dataUri = `data:${att.mime_type ?? "image/png"};base64,${base64}`;
              if (att.content_id) resolved.set(normalizeRef(att.content_id), dataUri);
              if (att.content_location) resolved.set(normalizeRef(att.content_location), dataUri);
              if (att.filename) resolved.set(att.filename, dataUri);
            } catch {
              // Skip individual failures — unresolved refs fall back to placeholder
            }
          }),
        );

        if (!cancelled && resolved.size > 0) {
          setResolvedRefs(resolved);
        }
      } catch {
        // Non-critical — images just won't render
      }
    })();

    return () => { cancelled = true; };
  }, [accountId, messageId, inlineAttachments]);

  // Sanitize once — reused by both content and blocked-image check
  const sanitizedBody = useMemo(() => {
    if (!html) return null;
    return sanitizeHtml(html);
  }, [html]);

  const isPlainText = !sanitizedBody;

  const bodyHtml = useMemo(() => {
    let body = sanitizedBody
      ?? `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(text ?? "")}</pre>`;

    if (shouldBlock && sanitizedBody) {
      body = stripRemoteImages(body);
    }

    // Replace cid: references with resolved data URIs
    if (resolvedRefs.size > 0) {
      body = body.replace(
        /\bcid:([^"'\s<>)]+)/gi,
        (match, cidRef: string) => resolvedRefs.get(normalizeRef(cidRef)) ?? match,
      );

      // Resolve (or neutralize) bare/relative inline image references that the
      // email used instead of cid: (commonly Content-Location hashes). These
      // otherwise resolve against the iframe origin and 404 / "unsupported URL".
      body = body.replace(
        /(<img\b[^>]*?\ssrc\s*=\s*)(["'])(.*?)\2/gi,
        (full, pre: string, q: string, src: string) => {
          const t = src.trim();
          if (/^(https?:|data:|blob:|mailto:|cid:|#)/i.test(t)) return full;
          if (t.includes("/")) return full; // base-relative remote; leave as-is
          const dataUri = resolvedRefs.get(normalizeRef(t));
          if (dataUri) return `${pre}${q}${dataUri}${q}`;
          // Unresolved inline/relative image → neutral 1x1 placeholder to avoid
          // 404 / unsupported-URL console errors.
          return `${pre}${q}${INLINE_PLACEHOLDER}${q}`;
        },
      );
    }

    return body;
  }, [sanitizedBody, text, shouldBlock, resolvedRefs]);

  const blocked = useMemo(() => {
    if (!shouldBlock || !sanitizedBody) return false;
    return hasBlockedImages(stripRemoteImages(sanitizedBody));
  }, [shouldBlock, sanitizedBody]);

  // Write content directly into iframe document — synchronous, no srcDoc async parsing
  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    observerRef.current?.disconnect();

    const doc = iframe.contentDocument;
    if (!doc) return;

    doc.open();
    // Plain text: blend with app theme (dark text on light bg, light text on dark bg)
    // HTML emails: always render on a light background since senders design for white/light
    const plainTextDark = isDark && isPlainText;
    const htmlDark = isDark && !isPlainText;
    doc.write(`<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: ${plainTextDark ? "#e5e7eb" : "#1f2937"};
      background: ${htmlDark ? "#f8f9fa" : "transparent"};
      word-wrap: break-word;
      overflow-wrap: break-word;
      overflow: hidden;
    }
    img { max-width: 100%; height: auto; }
    a { color: ${plainTextDark ? "#60a5fa" : "#3b82f6"}; }
    blockquote {
      border-left: 3px solid ${plainTextDark ? "#4b5563" : "#d1d5db"};
      margin: 8px 0;
      padding: 4px 12px;
      color: ${plainTextDark ? "#9ca3af" : "#6b7280"};
    }
    pre { overflow-x: auto; }
    table { max-width: 100%; }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`);
    doc.close();

    // Calculate and set height synchronously before paint
    const applyHeight = () => {
      if (!doc.body) return;
      const h = doc.body.scrollHeight;
      if (h > 0) {
        iframe.style.height = h + "px";
      }
    };
    applyHeight();

    // Watch for dynamic changes (images loading, etc.) — batched with rAF
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(applyHeight);
    });
    resizeObserver.observe(doc.body);
    observerRef.current = resizeObserver;

    // Open links in external browser via Tauri opener
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a");
      if (anchor?.href) {
        e.preventDefault();
        openUrl(anchor.href).catch((err) => {
          console.error("Failed to open link:", err);
        });
      }
    };
    doc.addEventListener("click", handleClick);

    return () => {
      doc.removeEventListener("click", handleClick);
      observerRef.current?.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, [bodyHtml, isDark, isPlainText]);

  const handleLoadImages = useCallback(() => {
    setOverrideShow(true);
  }, []);

  const handleAlwaysLoad = useCallback(async () => {
    if (accountId && senderAddress) {
      await addToAllowlist(accountId, senderAddress);
    }
    setOverrideShow(true);
  }, [accountId, senderAddress]);

  return (
    <div>
      {blocked && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 text-xs bg-bg-tertiary rounded-md border border-border-secondary">
          <ImageOff size={14} className="text-text-tertiary shrink-0" />
          <span className="text-text-secondary">
            Images hidden to protect your privacy.
          </span>
          <button
            onClick={handleLoadImages}
            className="text-accent hover:text-accent-hover font-medium"
          >
            Load images
          </button>
          {senderAddress && accountId && (
            <button
              onClick={handleAlwaysLoad}
              className="text-accent hover:text-accent-hover font-medium"
            >
              Always load from sender
            </button>
          )}
        </div>
      )}
      <iframe
        ref={iframeRef}
        sandbox="allow-same-origin"
        className={`w-full border-0 ${isDark && !isPlainText ? "rounded-md" : ""}`}
        style={{ overflow: "hidden" }}
        title="Email content"
      />
    </div>
  );
}

