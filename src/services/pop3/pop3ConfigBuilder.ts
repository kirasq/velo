import type { DbAccount } from "../db/accounts";
import type { Pop3Config } from "./types";

/** Map DB-stored security value to config type (same as IMAP builder). */
function mapSecurity(security: string | null | undefined): "tls" | "starttls" | "none" {
  if (!security) return "tls";
  const lower = security.toLowerCase();
  if (lower === "ssl" || lower === "tls") return "tls";
  if (lower === "starttls") return "starttls";
  if (lower === "none") return "none";
  return "tls";
}

/**
 * Build a Pop3Config from a DbAccount's POP3 fields.
 * Assumes imap_password (reused as the POP3 password column) is already decrypted.
 */
export function buildPop3Config(account: DbAccount): Pop3Config {
  if (!account.pop3_host) {
    throw new Error(`Account ${account.id} has no POP3 host configured`);
  }

  return {
    host: account.pop3_host,
    port: account.pop3_port ?? 995,
    security: mapSecurity(account.pop3_security),
    username: account.imap_username || account.email,
    // POP3 reuses the imap_password column for credential storage.
    password: account.imap_password ?? "",
    accept_invalid_certs: !!account.accept_invalid_certs,
    // Default to 0 (never delete from server, store everything locally).
    // A non-zero value issues DELE on the server for messages older than the
    // retention window AND skips storing them locally — which silently drops
    // mail from the inbox. Keeping the default at 0 is the safe choice; users
    // can opt into server deletion from settings if they truly want it.
    retention_days: account.pop3_retention_days ?? 0,
  };
}
