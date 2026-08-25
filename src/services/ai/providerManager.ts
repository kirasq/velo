import { getSetting, getSecureSetting } from "@/services/db/settings";
import { AiError } from "./errors";
import type { AiProvider, AiProviderClient } from "./types";
import { DEFAULT_MODELS, MODEL_SETTINGS } from "./types";
import { createClaudeProvider, clearClaudeProvider } from "./providers/claudeProvider";
import { createOpenAIProvider, clearOpenAIProvider } from "./providers/openaiProvider";
import { createGeminiProvider, clearGeminiProvider } from "./providers/geminiProvider";
import { createOllamaProvider, clearOllamaProvider } from "./providers/ollamaProvider";
import { createCopilotProvider, clearCopilotProvider } from "./providers/copilotProvider";

const API_KEY_SETTINGS: Record<Exclude<AiProvider, "ollama">, string> = {
  claude: "claude_api_key",
  openai: "openai_api_key",
  gemini: "gemini_api_key",
  copilot: "copilot_api_key",
};

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

let cachedProvider: { name: AiProvider; key: string; client: AiProviderClient } | null = null;

export async function getActiveProviderName(): Promise<AiProvider> {
  const setting = await getSetting("ai_provider");
  if (setting === "openai" || setting === "gemini" || setting === "ollama" || setting === "copilot") return setting;
  return "claude";
}

export async function getActiveProvider(): Promise<AiProviderClient> {
  const providerName = await getActiveProviderName();

  if (providerName === "ollama") {
    const serverUrl = (await getSetting("ollama_server_url")) ?? "http://localhost:11434";
    const model = (await getSetting("ollama_model")) ?? "llama3.2";
    const cacheKey = `${serverUrl}|${model}`;

    if (cachedProvider && cachedProvider.name === "ollama" && cachedProvider.key === cacheKey) {
      return cachedProvider.client;
    }

    const client = createOllamaProvider(serverUrl, model);
    cachedProvider = { name: "ollama", key: cacheKey, client };
    return client;
  }

  const keySetting = API_KEY_SETTINGS[providerName];
  const apiKey = await getSecureSetting(keySetting);

  if (!apiKey) {
    throw new AiError("NOT_CONFIGURED", `${providerName} API key not configured`);
  }

  const model = (await getSetting(MODEL_SETTINGS[providerName])) ?? DEFAULT_MODELS[providerName];

  if (cachedProvider && cachedProvider.name === providerName && cachedProvider.key === `${apiKey}|${model}`) {
    return cachedProvider.client;
  }

  let client: AiProviderClient;
  switch (providerName) {
    case "claude":
      client = createClaudeProvider(apiKey, model);
      break;
    case "openai": {
      const baseUrl = (await getSetting("openai_base_url")) ?? OPENAI_DEFAULT_BASE_URL;
      client = createOpenAIProvider(apiKey, model, baseUrl);
      cachedProvider = { name: providerName, key: `${apiKey}|${model}|${baseUrl}`, client };
      return client;
    }
    case "gemini":
      client = createGeminiProvider(apiKey, model);
      break;
    case "copilot":
      client = createCopilotProvider(apiKey, model);
      break;
  }

  cachedProvider = { name: providerName, key: `${apiKey}|${model}`, client };
  return client;
}

export async function isAiAvailable(): Promise<boolean> {
  try {
    const enabled = await getSetting("ai_enabled");
    if (enabled === "false") return false;
    const providerName = await getActiveProviderName();

    if (providerName === "ollama") {
      const serverUrl = await getSetting("ollama_server_url");
      return !!serverUrl;
    }

    const keySetting = API_KEY_SETTINGS[providerName];
    const key = await getSecureSetting(keySetting);
    return !!key;
  } catch {
    return false;
  }
}

export function clearProviderClients(): void {
  cachedProvider = null;
  clearClaudeProvider();
  clearOpenAIProvider();
  clearGeminiProvider();
  clearOllamaProvider();
  clearCopilotProvider();
}
