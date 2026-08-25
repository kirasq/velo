import { invoke } from "@tauri-apps/api/core";
import type { AiProviderClient, AiCompletionRequest } from "../types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function createOpenAIProvider(apiKey: string, model: string, baseURL?: string): AiProviderClient {
  const baseUrl = (baseURL ?? DEFAULT_BASE_URL).trim();

  return {
    async complete(req: AiCompletionRequest): Promise<string> {
      return await invoke<string>("openai_chat", {
        baseUrl,
        apiKey,
        model,
        systemPrompt: req.systemPrompt,
        userContent: req.userContent,
        maxTokens: req.maxTokens ?? 1024,
      });
    },

    async testConnection(): Promise<{ ok: boolean; message?: string }> {
      try {
        await invoke("openai_test", { baseUrl, apiKey, model });
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      }
    },
  };
}

export function clearOpenAIProvider(): void {
  // Backend proxy commands are stateless — no client cache to clear.
}
