import type {
  ProbeModelMeta,
  ProbeResult,
  ProviderProbe,
  ProbeContext,
} from "./types";
import {
  buildHeaders,
  probeFetchJson,
  EMPTY_RESULT,
  isFiniteNumber,
} from "./util";

interface TgiInfoResponse {
  model_id?: string;
  max_total_tokens?: number | null;
  max_input_tokens?: number | null;
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
    const headers = buildHeaders(apiKey, context?.headers);

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

    if (isFiniteNumber(info.max_total_tokens)) {
      meta.context = info.max_total_tokens;
    }
    if (
      isFiniteNumber(info.max_total_tokens) &&
      isFiniteNumber(info.max_input_tokens)
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
  } catch {
    // Probe failed; degrade silently (never write to stdout/stderr).
    return EMPTY_RESULT;
  }
};
