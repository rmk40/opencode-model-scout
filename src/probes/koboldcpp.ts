import type {
  ProbeModelMeta,
  ProbeResult,
  ProviderProbe,
  ProbeContext,
} from "./types";
import { LOG_PREFIX } from "../constants";

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
    if (!modelId) return { models: {} };

    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const meta: ProbeModelMeta = { temperature: true };

    // Fetch version/capabilities — don't let failure block context fetch
    try {
      const res = await fetch(`${baseURL}/api/extra/version`, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json()) as KoboldVersionResponse;
        if (data.vision) {
          meta.vision = true;
          meta.modelType = "vlm";
        } else {
          meta.modelType = "llm";
        }
        // NOTE: Do NOT infer toolCall from jinja: true
      } else {
        console.warn(
          `${LOG_PREFIX} KoboldCpp version probe: HTTP ${res.status}`,
        );
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} KoboldCpp version probe failed:`, error);
    }

    // Fetch context length
    try {
      const res = await fetch(`${baseURL}/api/v1/config/max_context_length`, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json()) as KoboldContextResponse;
        if (data.value !== undefined) {
          meta.context = data.value;
        }
      } else {
        console.warn(
          `${LOG_PREFIX} KoboldCpp context probe: HTTP ${res.status}`,
        );
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} KoboldCpp context probe failed:`, error);
    }

    return { models: { [modelId]: meta } };
  } catch (error) {
    console.warn(`${LOG_PREFIX} KoboldCpp probe failed:`, error);
    return { models: {} };
  }
};
