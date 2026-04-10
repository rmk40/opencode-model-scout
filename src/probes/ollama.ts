import type { ProbeModelMeta, ProbeResult, ProviderProbe } from "./types";
import { LOG_PREFIX } from "../constants";

/** A single model entry from Ollama's GET /api/tags response. */
interface OllamaTagModel {
  name: string;
  size: number;
  details?: {
    parameter_size?: string;
    family?: string;
    quantization_level?: string;
  };
}

/** Shape of Ollama's GET /api/tags response body. */
interface OllamaTagsResponse {
  models: OllamaTagModel[];
}

/** Shape of Ollama's POST /api/show response body. */
interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
  details?: {
    parameter_size?: string;
    family?: string;
    quantization_level?: string;
  };
  capabilities?: string[];
}

/**
 * Extract context_length from model_info by finding a key that ends
 * with ".context_length".
 */
function extractContextLength(
  modelInfo: Record<string, unknown>,
): number | undefined {
  for (const key of Object.keys(modelInfo)) {
    if (key.endsWith(".context_length")) {
      const value = Number(modelInfo[key]);
      return Number.isFinite(value) ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Build request headers for Ollama API calls.
 */
function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Probe Ollama for model metadata via /api/tags + /api/show per model.
 */
export const probeOllama: ProviderProbe = async (
  baseURL: string,
  apiKey?: string,
): Promise<ProbeResult> => {
  try {
    const headers = buildHeaders(apiKey);

    // Step 1: List all models
    const tagsRes = await fetch(`${baseURL}/api/tags`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });

    if (!tagsRes.ok) {
      console.warn(
        `${LOG_PREFIX} Ollama probe: /api/tags HTTP ${tagsRes.status}`,
      );
      return { models: {} };
    }

    const tagsData = (await tagsRes.json()) as OllamaTagsResponse;
    const models: Record<string, ProbeModelMeta> = {};

    // Build partial metadata from tags
    const tagModels = tagsData.models ?? [];
    for (const tag of tagModels) {
      const meta: ProbeModelMeta = {
        temperature: true,
        sizeBytes: tag.size,
      };
      if (tag.details?.parameter_size) {
        meta.parameterSize = tag.details.parameter_size;
      }
      if (tag.details?.family) {
        meta.family = tag.details.family;
      }
      if (tag.details?.quantization_level) {
        meta.quantization = tag.details.quantization_level;
      }
      models[tag.name] = meta;
    }

    // Step 2: Get detailed info per model in parallel
    const showResults = await Promise.allSettled(
      tagModels.map(async (tag) => {
        const res = await fetch(`${baseURL}/api/show`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: tag.name }),
          signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as OllamaShowResponse;
        return { name: tag.name, data };
      }),
    );

    for (const result of showResults) {
      if (result.status !== "fulfilled" || !result.value) continue;

      const { name, data } = result.value;
      const meta = models[name];
      if (!meta) continue;

      // Extract context length from model_info
      if (data.model_info) {
        const ctx = extractContextLength(data.model_info);
        if (ctx !== undefined) {
          meta.context = ctx;
        }
      }

      // Override details from show response if available
      if (data.details?.parameter_size) {
        meta.parameterSize = data.details.parameter_size;
      }
      if (data.details?.family) {
        meta.family = data.details.family;
      }
      if (data.details?.quantization_level) {
        meta.quantization = data.details.quantization_level;
      }

      // Map capabilities
      const caps = data.capabilities ?? [];

      // Capability flags — only set to true, never set to false
      if (caps.includes("tools")) {
        meta.toolCall = true;
      }
      if (caps.includes("vision")) {
        meta.vision = true;
      }
      if (caps.includes("thinking")) {
        meta.reasoning = true;
      }

      // Model type
      if (caps.includes("embedding")) {
        meta.modelType = "embedding";
      } else if (caps.includes("vision")) {
        meta.modelType = "vlm";
      } else {
        meta.modelType = "llm";
      }
    }

    return { models };
  } catch (error) {
    console.warn(`${LOG_PREFIX} Ollama probe failed:`, error);
    return { models: {} };
  }
};
