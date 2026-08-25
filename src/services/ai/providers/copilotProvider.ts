import OpenAI from "openai";
import type { AiProviderClient, AiCompletionRequest } from "../types";
import { createProviderFactory } from "../providerFactory";

const factory = createProviderFactory(
  (apiKey) =>
    new OpenAI({
      apiKey,
      baseURL: "https://models.github.ai/inference",
      defaultHeaders: { "X-GitHub-Api-Version": "2022-11-28" },
      dangerouslyAllowBrowser: true,
    }),
);

export function createCopilotProvider(apiKey: string, model: string): AiProviderClient {
  const client = factory.getClient(apiKey);

  return {
    async complete(req: AiCompletionRequest): Promise<string> {
      const response = await client.chat.completions.create({
        model,
        max_tokens: req.maxTokens ?? 1024,
        messages: [
          { role: "system", content: req.systemPrompt },
          { role: "user", content: req.userContent },
        ],
      });

      return response.choices[0]?.message?.content ?? "";
    },

    async testConnection(): Promise<{ ok: boolean; message?: string }> {
      try {
        await client.chat.completions.create({
          model,
          max_tokens: 10,
          messages: [{ role: "user", content: "Say hi" }],
        });
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      }
    },
  };
}

export function clearCopilotProvider(): void {
  factory.clear();
}
