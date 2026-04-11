import type {
  ProbeModelMeta,
  ProbeResult,
  ProviderProbe,
  ProbeContext,
} from "./types";
import { LOG_PREFIX } from "../constants";
import { buildHeaders, probeFetchJson, EMPTY_RESULT } from "./util";

interface TgiInfoResponse {
  model_id?: string;
  max_total_tokens?: number;
  max_input_tokens?: number;
  model_pipeline_tag?: string;
  router?: string;
  version?: string;
}

export const probeTgi: ProviderProbe = async (
  baseURL: string,
  apiKey?: string,
  context?: ProbeContext,
): Promise<ProbeResult> => {
  try {
    const headers = buildHeaders(apiKey);

    const info = await probeFetchJson<TgiInfoResponse>(
      `${baseURL}/info`,
      "TGI probe",
      { headers },
    );
    if (!info) return EMPTY_RESULT;

    // Use discovered model ID (matches what discoverModels uses as key).
    // Fall back to /info model_id for single-model servers without /v1/models.
    const modelId = context?.modelsResponse?.[0]?.id ?? info.model_id;
    if (!modelId) return EMPTY_RESULT;

    const meta: ProbeModelMeta = {};

    if (info.max_total_tokens !== undefined) {
      meta.context = info.max_total_tokens;
    }
    if (
      info.max_total_tokens !== undefined &&
      info.max_input_tokens !== undefined
    ) {
      const diff = info.max_total_tokens - info.max_input_tokens;
      if (diff > 0) meta.maxTokens = diff;
    }

    // Map model_pipeline_tag to modelType
    if (
      info.model_pipeline_tag === "text-generation" ||
      info.model_pipeline_tag === "text2text-generation"
    ) {
      meta.modelType = "llm";
    } else if (info.model_pipeline_tag === "feature-extraction") {
      meta.modelType = "embedding";
    }
    // else: leave undefined — don't guess for unknown pipeline tags

    return { models: { [modelId]: meta } };
  } catch (error) {
    console.warn(`${LOG_PREFIX} TGI probe failed:`, error);
    return EMPTY_RESULT;
  }
};
