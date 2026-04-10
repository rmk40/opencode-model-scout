/** Enriched metadata for a single model returned by a probe. */
export interface ProbeModelMeta {
  /** Context window size in tokens (e.g., 262144) */
  context?: number;
  /** Max output tokens (e.g., 32768) */
  maxTokens?: number;
  /** Model type classification */
  modelType?: "llm" | "vlm" | "embedding";
  /** Whether the model supports tool/function calling */
  toolCall?: boolean;
  /** Whether the model supports reasoning/thinking mode */
  reasoning?: boolean;
  /** Whether the model supports temperature control */
  temperature?: boolean;
  /** Whether the model supports image/attachment input */
  vision?: boolean;
  /** Whether the model is currently loaded in memory */
  loaded?: boolean;
  /** Model size on disk in bytes */
  sizeBytes?: number;
  /** Parameter count string (e.g., "30.5B") */
  parameterSize?: string;
  /** Model family (e.g., "qwen3moe", "llama") */
  family?: string;
  /** Quantization level (e.g., "Q8_0", "4bit") */
  quantization?: string;
}

/** Result returned by a provider probe. Keys are model IDs. */
export interface ProbeResult {
  models: Record<string, ProbeModelMeta>;
}

/**
 * A probe function signature. Takes a normalized base URL (without /v1
 * suffix) and optional API key. Returns enriched metadata for all
 * models the provider knows about.
 *
 * Probes MUST:
 * - Use AbortSignal.timeout(2000) on every fetch call
 * - Never throw — return { models: {} } on any error
 * - Log warnings on failure via console.warn with LOG_PREFIX from constants
 */
export type ProviderProbe = (
  baseURL: string,
  apiKey?: string,
) => Promise<ProbeResult>;
