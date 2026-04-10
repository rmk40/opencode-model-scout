import type { ProviderProbe } from "./types";
import { probeOmlx } from "./omlx";
import { probeOllama } from "./ollama";

/**
 * Registry of provider-specific metadata probes.
 *
 * Activated via the `"probe"` field inside a provider's `options` in opencode.json:
 *
 * ```json
 * {
 *   "provider": {
 *     "my-omlx": {
 *       "npm": "@ai-sdk/openai-compatible",
 *       "options": {
 *         "baseURL": "http://localhost:8000/v1",
 *         "probe": "omlx"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * The field MUST be inside `options` (not at the provider top level) because
 * opencode's `Config.Provider` schema uses `.strict()` and rejects unknown
 * top-level fields, while `options` uses `.catchall(z.any())`.
 */
const PROBES: Record<string, ProviderProbe> = {
  omlx: probeOmlx,
  ollama: probeOllama,
};

/**
 * Get the probe function for a provider type.
 * Returns undefined if the type is not recognized.
 */
export function getProbe(type: string | undefined): ProviderProbe | undefined {
  if (!type) return undefined;
  return PROBES[type];
}

export type { ProviderProbe, ProbeResult, ProbeModelMeta } from "./types";
