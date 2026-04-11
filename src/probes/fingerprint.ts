import { LOG_PREFIX } from "../constants";
import type { OpenAIModelEntry } from "./types";
import { buildHeaders, probeFetch } from "./util";

export type DetectedServer =
  | "ollama"
  | "llamacpp"
  | "omlx"
  | "lmstudio"
  | "tgi"
  | "sglang"
  | "vllm"
  | "koboldcpp";

export type ProbeKey =
  | "ollama"
  | "omlx"
  | "lmstudio"
  | "tgi"
  | "sglang"
  | "vllm"
  | "koboldcpp";

export const PROBE_MAP: Record<DetectedServer, ProbeKey> = {
  ollama: "ollama",
  llamacpp: "ollama",
  omlx: "omlx",
  lmstudio: "lmstudio",
  tgi: "tgi",
  sglang: "sglang",
  vllm: "vllm",
  koboldcpp: "koboldcpp",
};

/** owned_by values that uniquely identify a server. */
const OWNED_BY_MAP: Record<string, DetectedServer> = {
  omlx: "omlx",
  vllm: "vllm",
  sglang: "sglang",
  llamacpp: "llamacpp",
  koboldcpp: "koboldcpp",
  library: "ollama",
};

/**
 * Auto-detect the server behind an OpenAI-compatible endpoint.
 *
 * Uses a tiered approach:
 * - Tier 1: Inspect owned_by and non-standard fields from modelsResponse (free, no HTTP)
 * - Tier 2: Probe server-specific endpoints (sequential, with timeout)
 * - Tier 3: Low-confidence checks (log suggestion only, return undefined)
 *
 * Never throws — returns undefined if detection fails.
 */
export async function fingerprint(
  baseURL: string,
  apiKey?: string,
  modelsResponse?: OpenAIModelEntry[],
  signal?: AbortSignal,
): Promise<DetectedServer | undefined> {
  try {
    // ── Tier 1 — owned_by check (free, no HTTP) ──────────────────────

    if (modelsResponse && modelsResponse.length > 0) {
      // Check owned_by first — most reliable Tier 1 signal
      const ownedByValues = new Set(
        modelsResponse
          .map((m) => m.owned_by)
          .filter((v): v is string => v !== undefined),
      );

      // If all models agree on owned_by, use it
      if (ownedByValues.size === 1) {
        const ownedBy = [...ownedByValues][0];
        const detected = OWNED_BY_MAP[ownedBy];
        if (detected) {
          return detected;
        }
      }
      // If mixed values → inconclusive, fall through

      // Check non-standard fields as tiebreaker: aliases, tags, or status → llamacpp
      const hasLlamacppFields = modelsResponse.some(
        (m) =>
          m.aliases !== undefined ||
          m.tags !== undefined ||
          m.status !== undefined,
      );
      if (hasLlamacppFields) {
        return "llamacpp";
      }
    }

    // Check abort after Tier 1
    if (signal?.aborted) return undefined;

    // ── Tier 2 — endpoint probes (sequential, global 2s timeout) ─────

    const headers = buildHeaders(apiKey);
    const globalController = new AbortController();
    const globalTimeout = setTimeout(() => globalController.abort(), 2000);

    const combinedSignal = signal
      ? AbortSignal.any([signal, globalController.signal])
      : globalController.signal;

    try {
      // Step 1: GET /info → TGI
      try {
        const res = await probeFetch(`${baseURL}/info`, {
          headers,
          signal: combinedSignal,
          timeoutMs: 1000,
        });
        if (res?.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          if (typeof data.router === "string") {
            return "tgi";
          }
        }
      } catch {
        // json parse failure — continue
      }

      // Step 2: GET /api/v1/models → LM Studio
      if (combinedSignal.aborted) return undefined;
      try {
        const res = await probeFetch(`${baseURL}/api/v1/models`, {
          headers,
          signal: combinedSignal,
          timeoutMs: 1000,
        });
        if (res?.ok) {
          const data = await res.json();
          if (
            Array.isArray(data) &&
            data.length > 0 &&
            typeof (data[0] as Record<string, unknown>).key === "string" &&
            typeof (data[0] as Record<string, unknown>).type === "string"
          ) {
            return "lmstudio";
          }
        }
      } catch {
        // json parse failure — continue
      }

      // ── Tier 3 — low confidence (suggest only, return undefined) ───
      if (combinedSignal.aborted) return undefined;

      // Step 3: GET / → Ollama banner
      try {
        const res = await probeFetch(`${baseURL}/`, {
          headers,
          signal: combinedSignal,
          timeoutMs: 1000,
        });
        if (res?.ok) {
          const body = await res.text();
          if (body.includes("Ollama is running")) {
            console.warn(
              `${LOG_PREFIX} Auto-detect: server looks like Ollama. Set "probe": "ollama" in your provider options to enable enrichment.`,
            );
            return undefined;
          }
        }
      } catch {
        // json/text parse failure — continue
      }

      // Step 4: GET /api/tags → Ollama tags endpoint
      if (combinedSignal.aborted) return undefined;
      try {
        const res = await probeFetch(`${baseURL}/api/tags`, {
          headers,
          signal: combinedSignal,
          timeoutMs: 1000,
        });
        if (res?.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          if (
            Array.isArray(data.models) &&
            data.models.length > 0 &&
            typeof (data.models[0] as Record<string, unknown>).name === "string"
          ) {
            console.warn(
              `${LOG_PREFIX} Auto-detect: server looks like Ollama. Set "probe": "ollama" in your provider options to enable enrichment.`,
            );
            return undefined;
          }
        }
      } catch {
        // json parse failure — continue
      }
    } finally {
      clearTimeout(globalTimeout);
    }

    // Nothing matched
    console.warn(
      `${LOG_PREFIX} Auto-detect: could not identify server at ${baseURL}`,
    );
    return undefined;
  } catch {
    // Outer safety net — fingerprint must never throw
    return undefined;
  }
}
