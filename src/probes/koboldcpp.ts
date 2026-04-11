import type {
  ProbeModelMeta,
  ProbeResult,
  ProviderProbe,
  ProbeContext,
} from "./types";
import { LOG_PREFIX } from "../constants";
import { buildHeaders, probeFetchJson, EMPTY_RESULT } from "./util";

interface KoboldVersionResponse {
  result?: string;
  version?: string;
  vision?: boolean;
  audio?: boolean;
  embeddings?: boolean;
  jinja?: boolean;
  [key: string]: unknown;
}

interface KoboldContextResponse {
  value?: number;
}

export const probeKoboldcpp: ProviderProbe = async (
  baseURL: string,
  apiKey?: string,
  context?: ProbeContext,
): Promise<ProbeResult> => {
  try {
    const modelId = context?.modelsResponse?.[0]?.id;
    if (!modelId) return EMPTY_RESULT;

    const headers = buildHeaders(apiKey);

    const meta: ProbeModelMeta = {};

    // Fetch version/capabilities — don't let failure block context fetch
    const versionData = await probeFetchJson<KoboldVersionResponse>(
      `${baseURL}/api/extra/version`,
      "KoboldCpp version probe",
      { headers },
    );
    if (versionData) {
      if (versionData.vision) {
        meta.vision = true;
        meta.modelType = "vlm";
      } else {
        meta.modelType = "llm";
      }
      // NOTE: Do NOT infer toolCall from jinja: true
    }

    // Fetch context length
    const ctxData = await probeFetchJson<KoboldContextResponse>(
      `${baseURL}/api/v1/config/max_context_length`,
      "KoboldCpp context probe",
      { headers },
    );
    if (ctxData?.value !== undefined) {
      meta.context = ctxData.value;
    }

    return { models: { [modelId]: meta } };
  } catch (error) {
    console.warn(`${LOG_PREFIX} KoboldCpp probe failed:`, error);
    return EMPTY_RESULT;
  }
};
