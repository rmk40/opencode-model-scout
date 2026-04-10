import type {
  ProbeModelMeta,
  ProbeResult,
  ProviderProbe,
  ProbeContext,
} from "./types";
import { LOG_PREFIX } from "../constants";

interface LmStudioModel {
  key: string;
  type?: string;
  display_name?: string;
  publisher?: string;
  architecture?: string;
  quantization?: { name?: string; bits_per_weight?: number };
  size_bytes?: number;
  params_string?: string;
  max_context_length?: number;
  format?: string;
  capabilities?: { vision?: boolean; trained_for_tool_use?: boolean };
  loaded_instances?: unknown[];
}

export const probeLmstudio: ProviderProbe = async (
  baseURL: string,
  apiKey?: string,
  _context?: ProbeContext,
): Promise<ProbeResult> => {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(`${baseURL}/api/v1/models`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });

    if (!res.ok) {
      console.warn(`${LOG_PREFIX} LM Studio probe: HTTP ${res.status}`);
      return { models: {} };
    }

    const data = (await res.json()) as LmStudioModel[];
    if (!Array.isArray(data)) return { models: {} };

    const models: Record<string, ProbeModelMeta> = {};

    for (const entry of data) {
      const meta: ProbeModelMeta = { temperature: true };

      if (entry.max_context_length !== undefined) {
        meta.context = entry.max_context_length;
      }

      // Model type
      if (entry.type === "llm") meta.modelType = "llm";
      else if (entry.type === "embedding") meta.modelType = "embedding";

      // Capabilities
      if (entry.capabilities?.vision) {
        meta.vision = true;
        meta.modelType = "vlm";
      }
      if (entry.capabilities?.trained_for_tool_use) {
        meta.toolCall = true;
      }

      // Architecture → family
      if (entry.architecture) meta.family = entry.architecture;

      // Size info
      if (entry.params_string) meta.parameterSize = entry.params_string;
      if (entry.quantization?.name) meta.quantization = entry.quantization.name;
      if (entry.size_bytes !== undefined) meta.sizeBytes = entry.size_bytes;

      // Load state
      if (entry.loaded_instances && entry.loaded_instances.length > 0) {
        meta.loaded = true;
      }

      // Use `key` as model identifier — this is what LM Studio uses
      models[entry.key] = meta;
    }

    return { models };
  } catch (error) {
    console.warn(`${LOG_PREFIX} LM Studio probe failed:`, error);
    return { models: {} };
  }
};
