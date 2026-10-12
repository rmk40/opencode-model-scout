import type { ProviderProbe, ProbeContext } from "./types";
import { probeOmlx } from "./omlx";
import { probeOllama } from "./ollama";
import { probeVllm } from "./vllm";
import { probeTgi } from "./tgi";
import { probeSglang } from "./sglang";
import { probeLmstudio } from "./lmstudio";
import { probeKoboldcpp } from "./koboldcpp";
import { probeActualyze } from "./actualyze";
import { fingerprint, PROBE_MAP } from "./fingerprint";
import type { DetectedServer } from "./fingerprint";
import { PROBE_ID_ALIASES } from "../constants";

/**
 * Registry of provider-specific metadata probes.
 *
 * Activated via `settings.probe` on an OpenCode 2 provider:
 *
 * ```json
 * {
 *   "providers": {
 *     "my-omlx": {
 *       "package": "aisdk:@ai-sdk/openai-compatible",
 *       "settings": {
 *         "baseURL": "http://localhost:8000/v1",
 *         "probe": "omlx"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * Deprecated IDs in `PROBE_ID_ALIASES` (for example `atlas`) resolve to
 * their current probe.
 */
const PROBES = {
  actualyze: probeActualyze,
  omlx: probeOmlx,
  ollama: probeOllama,
  vllm: probeVllm,
  tgi: probeTgi,
  sglang: probeSglang,
  lmstudio: probeLmstudio,
  koboldcpp: probeKoboldcpp,
} as const satisfies Record<string, ProviderProbe>;

/** Probe key derived from the registry — stays in sync automatically. */
export type ProbeKey = keyof typeof PROBES;

/** Result of resolving a probe, including optional auto-detection info. */
export interface ResolvedProbe {
  probe: ProviderProbe | undefined;
  /** Canonical registry key of `probe` (aliases already resolved). */
  key?: ProbeKey;
  detectedServer?: DetectedServer;
}

function isProbeKey(value: string): value is ProbeKey {
  return Object.hasOwn(PROBES, value);
}

/**
 * Map a configured probe ID to its canonical registry key. Resolves
 * deprecated aliases; returns undefined for `auto` and unknown IDs.
 */
export function canonicalProbeKey(
  type: string | undefined,
): ProbeKey | undefined {
  if (!type) return undefined;
  const id = Object.hasOwn(PROBE_ID_ALIASES, type)
    ? PROBE_ID_ALIASES[type]
    : type;
  return isProbeKey(id) ? id : undefined;
}

/**
 * Resolve a probe by type. Supports:
 * - Explicit probe names (e.g., "omlx", "ollama") and deprecated aliases
 *   (e.g., "atlas" → "actualyze")
 * - "auto" — fingerprint the server and map to a probe
 * - undefined — return no probe
 */
export async function resolveProbe(
  type: string | undefined,
  baseURL: string,
  apiKey?: string,
  context?: ProbeContext,
  signal?: AbortSignal,
): Promise<ResolvedProbe> {
  if (!type) return { probe: undefined };
  if (type === "auto") {
    const detected = await fingerprint(
      baseURL,
      apiKey,
      context?.modelsResponse,
      signal,
      context?.headers,
    );
    if (!detected) return { probe: undefined };
    const probeKey = PROBE_MAP[detected];
    return {
      probe: PROBES[probeKey],
      key: probeKey,
      detectedServer: detected,
    };
  }
  const key = canonicalProbeKey(type);
  return key ? { probe: PROBES[key], key } : { probe: undefined };
}

export type {
  ProviderProbe,
  ProbeResult,
  ProbeModelMeta,
  ProbeModelCost,
  ProbeInputModality,
  ProbeContext,
  OpenAIModelEntry,
} from "./types";
export type { DetectedServer } from "./fingerprint";
