import type { ProbeModelMeta, OpenAIModelEntry } from "./probes/types";
import { resolveProbe } from "./probes/index";
import type { ProbeContext, DetectedServer } from "./probes/index";
import { extractModelOwner, formatModelName } from "./format";
import { LOG_PREFIX } from "./constants";
import { findMatch, type ModelsDevMeta } from "./models-dev";
import { buildHeaders, probeFetch } from "./probes/util";

/** Flattened model entry from the provider list response (re-export for callers). */
export type { ModelsDevMeta } from "./models-dev";

/** Snapshot of what was discovered for a single provider. */
export interface DiscoverySnapshot {
  provider: string;
  probeType: string | undefined;
  baseURL: string;
  models: Record<string, Record<string, unknown>>;
  detectedServer?: DetectedServer;
}

/** Shape of the OpenAI /v1/models response body. */
interface OpenAIModelsResponse {
  object: string;
  data: OpenAIModelEntry[];
}

/** Module-level store of discovery results, reset on each run. */
let discoveryStore: DiscoverySnapshot[] = [];

/** Get the current discovery store (read-only). */
export function getDiscoveryStore(): readonly DiscoverySnapshot[] {
  return discoveryStore;
}

/**
 * Strip trailing slash and trailing /v1 from a URL.
 * E.g. "http://localhost:8000/v1/" → "http://localhost:8000"
 */
function normalizeBaseURL(url: string): string {
  let normalized = url.replace(/\/+$/, "");
  if (normalized.endsWith("/v1")) {
    normalized = normalized.slice(0, -3);
  }
  return normalized;
}

/**
 * Fetch the list of models from a provider's /v1/models endpoint.
 * Also serves as a health check — returns empty array on any failure.
 */
async function fetchModels(
  baseURL: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<OpenAIModelEntry[]> {
  try {
    const headers = buildHeaders(apiKey);
    const res = await probeFetch(`${baseURL}/v1/models`, {
      headers,
      signal,
      timeoutMs: 3000,
    });
    if (!res) return [];
    if (!res.ok) return [];
    const data = (await res.json()) as OpenAIModelsResponse;
    return Array.isArray(data.data) ? data.data : [];
  } catch {
    return [];
  }
}

/**
 * Check if a provider config is eligible for model discovery.
 * Returns true if:
 * - npm is "@ai-sdk/openai-compatible" (standard OpenAI-compatible SDK), OR
 * - options.baseURL contains "/v1" (likely OpenAI-compatible even with other npm packages)
 */
function canDiscover(provider: Record<string, unknown>): boolean {
  if (provider.npm === "@ai-sdk/openai-compatible") return true;

  const options = provider.options as Record<string, unknown> | undefined;
  if (options?.baseURL && typeof options.baseURL === "string") {
    return options.baseURL.includes("/v1");
  }

  return false;
}

/** Known LLM model name patterns for keyword-based categorization. */
const LLM_KEYWORDS = [
  "llama",
  "qwen",
  "gemma",
  "mistral",
  "phi",
  "gpt",
  "claude",
  "deepseek",
  "codestral",
  "starcoder",
  "coder",
  "chat",
  "instruct",
  "wizard",
  "falcon",
  "yi",
  "internlm",
  "glm",
  "command",
  "solar",
  "hermes",
  "vicuna",
  "orca",
  "zephyr",
  "neural",
  "tinyllama",
];

/**
 * Categorize a model by its ID using keyword matching.
 * Returns "embedding", "chat", or "unknown".
 */
function categorizeModel(id: string): "embedding" | "chat" | "unknown" {
  const lower = id.toLowerCase();
  if (lower.includes("embedding") || lower.includes("embed")) {
    return "embedding";
  }
  for (const keyword of LLM_KEYWORDS) {
    if (lower.includes(keyword)) return "chat";
  }
  return "unknown";
}

/**
 * Enrich a model config object with metadata from a probe.
 */
function applyProbeMeta(
  model: Record<string, unknown>,
  meta: ProbeModelMeta,
): void {
  // Limits — only set if not already present
  if (
    !model.limit &&
    (meta.context !== undefined || meta.maxTokens !== undefined)
  ) {
    model.limit = {
      context: meta.context ?? 0,
      output: meta.maxTokens ?? 0,
    };
  }

  // Modalities — probe is more accurate than keyword guess, always override for discovered models
  if (meta.vision || meta.modelType === "vlm") {
    model.modalities = { input: ["text", "image"], output: ["text"] };
    model.attachment = true;
  } else if (meta.modelType === "llm") {
    model.modalities = { input: ["text"], output: ["text"] };
  } else if (meta.modelType === "embedding") {
    // Probe confirms this is an embedding model — clear any chat modalities
    // that keyword categorization may have set (output:["embedding"] is invalid
    // in opencode, so we remove modalities entirely)
    delete model.modalities;
    delete model.attachment;
    // Mark as probe-confirmed embedding so fallback enrichment skips modalities
    model._probeEmbedding = true;
  }

  // Capability flags — only set if not already present on model
  if (meta.toolCall !== undefined && model.tool_call === undefined)
    model.tool_call = meta.toolCall;
  if (meta.reasoning !== undefined && model.reasoning === undefined)
    model.reasoning = meta.reasoning;
  if (meta.temperature !== undefined && model.temperature === undefined)
    model.temperature = meta.temperature;
  if (meta.family && !model.family) model.family = meta.family;

  // Probe-specific metadata (for display in /modelscout)
  if (meta.parameterSize) model.parameterSize = meta.parameterSize;
  if (meta.quantization) model.quantization = meta.quantization;
  if (meta.sizeBytes !== undefined) model.sizeBytes = meta.sizeBytes;
}

/**
 * Apply models.dev metadata as a fallback enrichment source.
 * Only sets fields that are not already present on the model.
 * Respects probe authority: if a probe confirmed the model as embedding,
 * modalities and attachment are not re-added.
 */
function applyModelsDevMeta(
  model: Record<string, unknown>,
  meta: ModelsDevMeta,
): void {
  const isProbeEmbedding = model._probeEmbedding === true;

  if (meta.toolCall && model.tool_call === undefined) model.tool_call = true;
  if (meta.reasoning && model.reasoning === undefined) model.reasoning = true;
  if (!isProbeEmbedding && meta.attachment && model.attachment === undefined) {
    model.attachment = true;
    // Also set vision modalities if not already set
    if (!model.modalities) {
      model.modalities = { input: ["text", "image"], output: ["text"] };
    }
  }
  if (meta.temperature && model.temperature === undefined)
    model.temperature = true;
  if (meta.family && !model.family) model.family = meta.family;
  if (!isProbeEmbedding && meta.modalities && !model.modalities)
    model.modalities = meta.modalities;
}

/** Flattened models.dev index for matching. */
interface ModelsDevIndex {
  readonly id: string;
  readonly normalized: string;
  readonly family?: string;
  readonly meta: ModelsDevMeta;
}

/**
 * Discover models from all eligible providers in the config and enrich
 * with probe metadata and models.dev fallback. Mutates config.provider.*.models in place.
 */
export async function discoverModels(
  config: Record<string, unknown>,
  modelsDevIndex?: readonly ModelsDevIndex[],
  signal?: AbortSignal,
): Promise<void> {
  try {
    // Reset store
    discoveryStore = [];

    const providers = config.provider as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!providers) return;

    for (const [providerName, providerConfig] of Object.entries(providers)) {
      if (signal?.aborted) break;
      try {
        if (!canDiscover(providerConfig)) continue;

        const options = providerConfig.options as
          | Record<string, unknown>
          | undefined;
        const rawBaseURL = options?.baseURL;
        if (!rawBaseURL || typeof rawBaseURL !== "string") continue;

        const baseURL = normalizeBaseURL(rawBaseURL);
        const apiKey = options?.apiKey as string | undefined;

        // Fetch model list (also serves as health check)
        const openaiModels = await fetchModels(baseURL, apiKey, signal);
        if (openaiModels.length === 0) continue;

        const existingModels = (providerConfig.models ?? {}) as Record<
          string,
          unknown
        >;
        const discoveredModels: Record<string, Record<string, unknown>> = {};

        for (const model of openaiModels) {
          // Skip models already configured
          if (existingModels[model.id] !== undefined) continue;

          const category = categorizeModel(model.id);
          const entry: Record<string, unknown> = {
            id: model.id,
            name: formatModelName(model.id),
          };

          const owner = extractModelOwner(model.id);
          if (owner) {
            entry.organizationOwner = owner;
          }

          if (category === "embedding") {
            // Don't set modalities for embedding models —
            // output:["embedding"] is not valid in opencode's schema
          } else if (category === "chat") {
            // Default to text-only; probe will upgrade to image if vision is confirmed
            entry.modalities = {
              input: ["text"],
              output: ["text"],
            };
          }

          discoveredModels[model.id] = entry;
        }

        // Resolve probe (supports explicit names, "auto", or undefined)
        const probeType = options?.probe as string | undefined;
        const context: ProbeContext = { modelsResponse: openaiModels };
        const { probe, detectedServer } = await resolveProbe(
          probeType,
          baseURL,
          apiKey,
          context,
          signal,
        );

        if (probe) {
          try {
            const probeResult = await probe(baseURL, apiKey, context);
            for (const [modelId, meta] of Object.entries(probeResult.models)) {
              const discovered = discoveredModels[modelId];
              if (discovered) {
                applyProbeMeta(discovered, meta);
              }
            }
          } catch (error) {
            console.warn(
              `${LOG_PREFIX} Probe "${probeType}" failed for ${providerName}:`,
              error,
            );
          }
        }

        // Apply models.dev fallback for any remaining unenriched models
        if (modelsDevIndex && modelsDevIndex.length > 0) {
          for (const [modelId, model] of Object.entries(discoveredModels)) {
            const match = findMatch(modelId, modelsDevIndex);
            if (match) {
              applyModelsDevMeta(model, match);
            }
          }
        }

        // Clean up internal sentinel before merging into opencode config
        for (const model of Object.values(discoveredModels)) {
          delete model._probeEmbedding;
        }

        // Merge discovered models into provider config
        if (Object.keys(discoveredModels).length > 0) {
          providerConfig.models = { ...existingModels, ...discoveredModels };
          discoveryStore.push({
            provider: providerName,
            probeType,
            baseURL,
            models: discoveredModels,
            detectedServer,
          });
        }
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} Discovery failed for ${providerName}:`,
          error,
        );
      }
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} Discovery failed:`, error);
  }
}
