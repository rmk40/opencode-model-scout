import type {
  ProbeModelMeta,
  ProbeResult,
  ProviderProbe,
  ProbeContext,
} from "./types";

export const probeVllm: ProviderProbe = async (
  _baseURL: string,
  _apiKey?: string,
  context?: ProbeContext,
): Promise<ProbeResult> => {
  const entries = context?.modelsResponse;
  if (!entries?.length) return { models: {} };

  const models: Record<string, ProbeModelMeta> = {};
  for (const entry of entries) {
    const meta: ProbeModelMeta = { temperature: true };
    if (entry.max_model_len !== undefined) {
      meta.context = entry.max_model_len;
    }
    models[entry.id] = meta;
  }
  return { models };
};
