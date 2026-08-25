import { invoke } from "@tauri-apps/api/core";
import type { Pop3Config, Pop3SyncResult } from "./types";
import {
  smtpSendEmail,
  smtpTestConnection,
  type SmtpConfig,
  type SmtpSendResult,
} from "../imap/tauriCommands";
import { buildSmtpConfig } from "../imap/imapConfigBuilder";

export async function pop3TestConnection(
  config: Pop3Config,
): Promise<string> {
  return invoke<string>("pop3_test_connection", { config });
}

export async function pop3Sync(
  config: Pop3Config,
  knownUidls: string[],
  nowTs: number,
): Promise<Pop3SyncResult> {
  return invoke<Pop3SyncResult>("pop3_sync", {
    config,
    knownUidls,
    nowTs,
  });
}

// Re-export SMTP commands so the POP3 provider can send via the same path.
export {
  smtpSendEmail,
  smtpTestConnection,
  buildSmtpConfig,
  type SmtpConfig,
  type SmtpSendResult,
};
