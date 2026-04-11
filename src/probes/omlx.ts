import type { ProbeModelMeta, ProbeResult, ProviderProbe } from "./types";
import { LOG_PREFIX } from "../constants";
import { buildHeaders, probeFetchJson, EMPTY_RESULT } from "./util";

/** Status entry for a single model in the oMLX /v1/models/status response. */
interface OmlxModelStatus {
  id: string;
  loaded: boolean;
  model_type?: string;
  max_context_window?: number;
  max_tokens?: number;
  estimated_size?: number;
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
): Promise<ProbeResult> => {
  try {
    const headers = buildHeaders(apiKey);

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

      if (entry.max_context_window !== undefined) {
        meta.context = entry.max_context_window;
      }
      if (entry.max_tokens !== undefined) {
        meta.maxTokens = entry.max_tokens;
      }
      if (entry.estimated_size !== undefined) {
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
  } catch (error) {
    console.warn(`${LOG_PREFIX} oMLX probe failed:`, error);
    return EMPTY_RESULT;
  }
};
