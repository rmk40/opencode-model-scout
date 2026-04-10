import type {
  ProbeModelMeta,
  ProbeResult,
  ProviderProbe,
  ProbeContext,
} from "./types";
import { LOG_PREFIX } from "../constants";
import { buildHeaders, probeFetch, EMPTY_RESULT } from "./util";

interface SglangModelInfoResponse {
  model_path?: string;
  is_generation?: boolean;
  model_type?: string;
  has_image_understanding?: boolean;
  has_audio_understanding?: boolean;
  architectures?: string[];
}

export const probeSglang: ProviderProbe = async (
  baseURL: string,
  apiKey?: string,
  context?: ProbeContext,
): Promise<ProbeResult> => {
  try {
    const headers = buildHeaders(apiKey);

    const res = await probeFetch(`${baseURL}/model_info`, { headers });

    if (!res) return EMPTY_RESULT;

    if (!res.ok) {
      console.warn(`${LOG_PREFIX} SGLang probe: HTTP ${res.status}`);
      return EMPTY_RESULT;
    }

    const info = (await res.json()) as SglangModelInfoResponse;
    const entries = context?.modelsResponse;

    // Use discovered model ID (matches what discoverModels uses as key).
    // Fall back to model_path for SGLang servers without /v1/models.
    const modelId = entries?.[0]?.id ?? info.model_path;
    if (!modelId) return EMPTY_RESULT;

    const meta: ProbeModelMeta = { temperature: true };

    // Get context from modelsResponse max_model_len
    const entry = entries?.find((e) => e.id === modelId) ?? entries?.[0];
    if (entry?.max_model_len !== undefined) {
      meta.context = entry.max_model_len;
    }

    // Map capabilities
    if (info.has_image_understanding) {
      meta.vision = true;
      meta.modelType = "vlm";
    } else if (info.is_generation) {
      meta.modelType = "llm";
    }

    // Family from model_type
    if (info.model_type) {
      meta.family = info.model_type;
    }

    return { models: { [modelId]: meta } };
  } catch (error) {
    console.warn(`${LOG_PREFIX} SGLang probe failed:`, error);
    return EMPTY_RESULT;
  }
};
