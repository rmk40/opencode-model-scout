/** Enriched metadata for a single model returned by a probe. */
export interface ProbeModelMeta {
  /** Context window size in tokens (e.g., 262144) */
  context?: number;
  /** Max output tokens (e.g., 32768) */
  maxTokens?: number;
  /** Model type classification */
  modelType?: "llm" | "vlm" | "embedding";
  /** Authoritative tool/function calling support; false blocks fallback only. */
  toolCall?: boolean;
  /** Authoritative reasoning/thinking support; false blocks fallback only. */
  reasoning?: boolean;
  /** Whether the model supports temperature control */
  temperature?: boolean;
  /** Authoritative image/attachment support; false blocks fallback only. */
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
  /**
   * Authoritative input modalities reported by the provider (Actualyze
   * `modalities.input`). When present it replaces `vision` for input
   * mapping; `text` is listed explicitly when supported.
   */
  inputModalities?: ProbeInputModality[];
  /** Prices reported by the provider, USD per million tokens. */
  cost?: ProbeModelCost;
}

/** Input modalities a probe can report; matches OpenCode 2 `Model.Info`. */
export type ProbeInputModality = "text" | "image" | "pdf" | "audio" | "video";

/**
 * Reported prices in USD per million tokens. Absent cache prices mean
 * "unknown" (Actualyze omits prices it cannot resolve), not zero.
 */
export interface ProbeModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Raw model entry from the OpenAI /v1/models response.
 * Extended with optional non-standard fields that some servers add.
 */
export interface OpenAIModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by?: string;
  /** vLLM and SGLang add this non-standard field */
  max_model_len?: number | null;
  /** vLLM adds the model path */
  root?: string;
  /** llama.cpp adds these non-standard fields */
  aliases?: string[];
  tags?: string[];
  status?: Record<string, unknown>;
}

/**
 * Context passed to probes from the discovery layer.
 * Extensible — add fields here rather than new positional parameters.
 */
export interface ProbeContext {
  /** Pre-fetched /v1/models entries, for probes that need them */
  modelsResponse?: OpenAIModelEntry[];
  /** Whether discovery selected the probe automatically or explicitly. */
  probeSelection?: "auto" | "explicit";
  /** Discovery cancellation signal for probes with external I/O. */
  signal?: AbortSignal;
  /** Provider headers to send on probe requests. */
  headers?: Readonly<Record<string, string>>;
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
 * - Use probeFetch()/readJson()/readBody() from ./util for all HTTP calls
 *   (handles connection + body-read timeouts and abort)
 * - Never throw — return EMPTY_RESULT from ./util on any error
 * - Never write to stdout/stderr (no console.*) — discovery runs inside the
 *   shared OpenCode service and must stay silent
 */
export type ProviderProbe = (
  baseURL: string,
  apiKey?: string,
  context?: ProbeContext,
) => Promise<ProbeResult>;
