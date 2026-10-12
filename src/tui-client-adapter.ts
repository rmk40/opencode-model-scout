import { createServerKey, normalizeServerBaseUrl } from "./catalog-snapshot";

/** Runtime-only shape verified against the pinned generated SDK client. */
interface PinnedHeyApiClient {
  getConfig: () => { baseUrl?: unknown };
}

interface PinnedOpencodeClientInternal {
  client: PinnedHeyApiClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Isolate the one pinned-SDK internal needed for cross-realm correlation.
 * The generated JS assigns `client` as an own property even though its
 * TypeScript declaration is protected. Any shape drift degrades to host-only.
 */
export function serverBaseUrlFromPinnedClient(
  value: unknown,
): string | undefined {
  try {
    if (!isRecord(value) || !Object.hasOwn(value, "client")) return undefined;
    const internal = value as unknown as PinnedOpencodeClientInternal;
    if (
      !isRecord(internal.client) ||
      typeof internal.client.getConfig !== "function"
    )
      return undefined;
    return normalizeServerBaseUrl(internal.client.getConfig().baseUrl);
  } catch {
    return undefined;
  }
}

export function serverKeyFromPinnedClient(value: unknown): string | undefined {
  const baseUrl = serverBaseUrlFromPinnedClient(value);
  return baseUrl ? createServerKey(baseUrl) : undefined;
}
