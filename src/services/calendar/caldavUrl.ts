/**
 * Normalize a user-entered CalDAV server URL so that tsdav receives a valid URL.
 *
 * Common user inputs like "imail.example.com:443" lack a scheme, which causes
 * tsdav's .well-known/caldav discovery to throw:
 *   "/.well-known/caldav" cannot be parsed as a URL
 *
 * Rules:
 * - Trim whitespace
 * - Preserve existing http:// or https:// schemes
 * - Prepend https:// when no scheme is present
 * - Return null for empty/invalid input
 */
export function normalizeCalDavUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Already has a scheme
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // Protocol-relative URL (e.g. //example.com/)
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }

  // Default to HTTPS for bare host:port/path inputs
  return `https://${trimmed}`;
}

/**
 * Best-effort validation: a normalized URL must have a host.
 * Returns null if parsing fails.
 */
export function parseCalDavHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}
