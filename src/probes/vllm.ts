import type {
  ProbeModelMeta,
  ProbeResult,
  ProviderProbe,
  ProbeContext,
} from "./types";
import { EMPTY_RESULT } from "./util";

/**
 * Probe vLLM for model metadata from the /v1/models response.
 * vLLM includes max_model_len in its model entries, so no HTTP calls needed.
 * Non-async because it only reads from context — ProviderProbe accepts
 * sync functions that return Promise<ProbeResult>.
 */
export const probeVllm: ProviderProbe = (
  _baseURL: string,
  _apiKey?: string,
  context?: ProbeContext,
): Promise<ProbeResult> => {
  const entries = context?.modelsResponse;
  if (!entries?.length) return Promise.resolve(EMPTY_RESULT);

  const models: Record<string, ProbeModelMeta> = {};
  for (const entry of entries) {
    const meta: ProbeModelMeta = { temperature: true };
    if (entry.max_model_len !== undefined) {
      meta.context = entry.max_model_len;
    }
    models[entry.id] = meta;
  }
  return Promise.resolve({ models });
};
