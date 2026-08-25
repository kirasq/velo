/**
 * Generic factory for creating singleton-cached AI provider clients.
 * Handles client caching, invalidation on key change, and cleanup.
 */
export function createProviderFactory<TClient>(
  createClient: (apiKey: string, extra?: string) => TClient,
): {
  getClient: (apiKey: string, extra?: string) => TClient;
  clear: () => void;
} {
  let instance: TClient | null = null;
  let cachedKey: string | null = null;

  return {
    getClient(apiKey: string, extra?: string): TClient {
      const key = `${apiKey}|${extra ?? ""}`;
      if (!instance || cachedKey !== key) {
        instance = createClient(apiKey, extra);
        cachedKey = key;
      }
      return instance;
    },
    clear() {
      instance = null;
      cachedKey = null;
    },
  };
}
