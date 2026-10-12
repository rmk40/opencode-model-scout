import type {
  ProbeContext,
  ProbeModelMeta,
  ProbeResult,
  ProviderProbe,
} from "./types";
import {
  buildHeaders,
  probeFetchJson,
  EMPTY_RESULT,
  isFiniteNumber,
} from "./util";

/** Status entry for a single model in the oMLX /v1/models/status response. */
interface OmlxModelStatus {
  id: string;
  loaded: boolean;
  model_type?: string;
  max_context_window?: number | null;
  max_tokens?: number | null;
  estimated_size?: number | null;
}

/** Shape of the oMLX /v1/models/status response body. */
interface OmlxStatusResponse {
  models: OmlxModelStatus[];
}

/**
 * Probe oMLX for model metadata via GET /v1/models/status.
 */
export const probeOmlx: ProviderProbe = async (
  baseURL: string,
  apiKey?: string,
  context?: ProbeContext,
): Promise<ProbeResult> => {
  try {
    const headers = buildHeaders(apiKey, context?.headers);

    const data = await probeFetchJson<OmlxStatusResponse>(
      `${baseURL}/v1/models/status`,
      "oMLX probe",
      { headers },
    );
    if (!data) return EMPTY_RESULT;
    const models: Record<string, ProbeModelMeta> = {};

    for (const entry of data.models ?? []) {
      const meta: ProbeModelMeta = {
        loaded: entry.loaded,
      };

      if (isFiniteNumber(entry.max_context_window)) {
        meta.context = entry.max_context_window;
      }
      if (isFiniteNumber(entry.max_tokens)) {
        meta.maxTokens = entry.max_tokens;
      }
      if (isFiniteNumber(entry.estimated_size)) {
        meta.sizeBytes = entry.estimated_size;
      }

      // Only map model_type when it's "llm" or "vlm"
      if (entry.model_type === "llm" || entry.model_type === "vlm") {
        meta.modelType = entry.model_type;
        if (entry.model_type === "vlm") {
          meta.vision = true;
        }
      }

      models[entry.id] = meta;
    }

    return { models };
  } catch {
    // Probe failed; degrade silently (never write to stdout/stderr).
    return EMPTY_RESULT;
  }
};
