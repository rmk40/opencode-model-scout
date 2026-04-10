import type { ProviderProbe, ProbeContext } from "./types";
import { probeOmlx } from "./omlx";
import { probeOllama } from "./ollama";
import { probeVllm } from "./vllm";
import { probeTgi } from "./tgi";
import { probeSglang } from "./sglang";
import { probeLmstudio } from "./lmstudio";
import { probeKoboldcpp } from "./koboldcpp";
import { fingerprint, PROBE_MAP } from "./fingerprint";
import type { DetectedServer, ProbeKey } from "./fingerprint";

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
  vllm: probeVllm,
  tgi: probeTgi,
  sglang: probeSglang,
  lmstudio: probeLmstudio,
  koboldcpp: probeKoboldcpp,
};

/**
 * Get the probe function for a provider type.
 * Returns undefined if the type is not recognized.
 */
export function getProbe(type: string | undefined): ProviderProbe | undefined {
  if (!type) return undefined;
  return PROBES[type];
}

/** Result of resolving a probe, including optional auto-detection info. */
export interface ResolvedProbe {
  probe: ProviderProbe | undefined;
  detectedServer?: DetectedServer;
}

/**
 * Resolve a probe by type. Supports:
 * - Explicit probe names (e.g., "omlx", "ollama")
 * - "auto" — fingerprint the server and map to a probe
 * - undefined — return no probe
 */
export async function resolveProbe(
  type: string | undefined,
  baseURL: string,
  apiKey?: string,
  context?: ProbeContext,
): Promise<ResolvedProbe> {
  if (!type) return { probe: undefined };
  if (type === "auto") {
    const detected = await fingerprint(
      baseURL,
      apiKey,
      context?.modelsResponse,
    );
    if (!detected) return { probe: undefined };
    const probeKey = PROBE_MAP[detected];
    return { probe: PROBES[probeKey], detectedServer: detected };
  }
  return { probe: PROBES[type] };
}

export type {
  ProviderProbe,
  ProbeResult,
  ProbeModelMeta,
  ProbeContext,
  OpenAIModelEntry,
} from "./types";
export type { DetectedServer, ProbeKey } from "./fingerprint";
