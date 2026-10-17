/**
 * Discovery for one provider target (`discoverProvider`, network I/O) and
 * the pure mapping from its inventory to OpenCode 2 `Model.Info` patches
 * plus catalog evidence (`toModelInfo`).
 *
 * Evidence precedence for a discovered model, strongest first: probe
 * evidence (including authoritative negatives), a models.dev match, keyword
 * heuristics, host defaults. Declared models are never patched; the
 * transform filters them out before applying patches.
 */
import { resolveProbe } from "./probes/index";
import type {
  OpenAIModelEntry,
  ProbeContext,
  ProbeInputModality,
  ProbeKey,
  ProbeModelCost,
  ProbeModelMeta,
} from "./probes/index";
import { buildHeaders, fetchOutcome, readJsonOutcome } from "./probes/util";
import { extractModelOwner, formatModelName } from "./format";
import {
  findModelsDevMatch,
  type ModelsDevIndex,
  type ModelsDevMatch,
} from "./models-dev-index";
import {
  INPUT_MODALITIES,
  failureKindForStatus,
  knownScalar,
  sanitizeEndpointOrigin,
  unknownCapability,
  unknownScalar,
  type CapabilityEvidence,
  type CatalogModelRecord,
  type CostEvidence,
  type InputModality,
  type InputModalityEvidence,
  type ModelListAttempt,
  type ProbeAttempt,
  type ProviderFailureKind,
  type ScalarEvidence,
} from "./catalog-evidence";

/** `Model.Info` defaults the host applies to a model a plugin adds. */
export const HOST_DEFAULT_CONTEXT = 200_000;
export const HOST_DEFAULT_OUTPUT = 32_000;

/**
 * Emitted `limit.output` when no source reports one. The host treats `0` as
 * unknown and fits the output budget to the room the prompt leaves in the
 * context window.
 */
export const UNKNOWN_OUTPUT_LIMIT = 0;

const LIST_TIMEOUT_MS = 10_000;

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** A provider to discover, with its credential already resolved. */
export interface DiscoveryTarget {
  readonly providerID: string;
  /** `settings.baseURL` as configured. */
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** `settings.probe` as configured, including `auto` and aliases. */
  readonly probe?: string;
}

/** One served model and what the probe reported for it. */
export interface InventoryModel {
  readonly id: string;
  /** List entry `created`, in epoch seconds. */
  readonly created?: number;
  readonly meta?: ProbeModelMeta;
}

/**
 * What one successful discovery found. JSON-serializable: it is persisted
 * across restarts and carries no credentials.
 */
export interface ProviderInventory {
  readonly endpointOrigin?: string;
  /** Canonical registry key of the probe that ran (aliases resolved). */
  readonly resolvedProbe?: ProbeKey;
  readonly modelListAttempt: "ready" | "empty";
  readonly probeAttempt: ProbeAttempt;
  readonly models: readonly InventoryModel[];
  /** ISO time the discovery completed. */
  readonly completedAt: string;
}

export type DiscoveryResult =
  | { readonly ok: true; readonly inventory: ProviderInventory }
  | {
      readonly ok: false;
      readonly failure: ProviderFailureKind;
      readonly modelListAttempt: ModelListAttempt;
      /** HTTP status of the model list, for the HTTP failure kinds. */
      readonly httpStatus?: number;
      /** Epoch milliseconds before which discovery should not retry. */
      readonly retryAt?: number;
    };

interface FetchModelsResult {
  readonly models: OpenAIModelEntry[];
  readonly attempt: ModelListAttempt;
  /** Set for a failed attempt other than a caller abort. */
  readonly failure?: ProviderFailureKind;
  readonly httpStatus?: number;
  readonly retryAt?: number;
}

/** Longest delay a server's retry hint can impose. */
export const MAX_RETRY_DELAY_MS = 3_600_000;

/** Epoch seconds below this are read as a delay in seconds, not a time. */
const EPOCH_SECONDS_FLOOR = 1_000_000_000;
const EPOCH_MILLISECONDS_FLOOR = 1_000_000_000_000;

function parseRetryAfter(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return now + Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? date : undefined;
}

/**
 * `X-RateLimit-Reset` is sent as epoch seconds, epoch milliseconds, or
 * seconds until the reset, depending on the server.
 */
function parseRateLimitReset(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const number = Number(trimmed);
  if (!Number.isFinite(number)) return undefined;
  if (number >= EPOCH_MILLISECONDS_FLOOR) return number;
  if (number >= EPOCH_SECONDS_FLOOR) return number * 1000;
  return now + number * 1000;
}

/**
 * When a failed model-list request may be retried: `Retry-After` (seconds
 * or an HTTP date) on a 429 or 503, else `X-RateLimit-Reset` on a 429,
 * clamped to `[now, now + MAX_RETRY_DELAY_MS]`. Undefined for any other
 * status or when neither header parses.
 */
export function retryAtFromHeaders(
  status: number,
  headers: { get(name: string): string | null } | undefined,
  now: number,
): number | undefined {
  if (status !== 429 && status !== 503) return undefined;
  const read = (name: string): string | undefined => {
    try {
      return headers?.get(name) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const retryAfter = read("retry-after");
  let at =
    retryAfter === undefined ? undefined : parseRetryAfter(retryAfter, now);
  if (at === undefined && status === 429) {
    const reset = read("x-ratelimit-reset");
    if (reset !== undefined) at = parseRateLimitReset(reset, now);
  }
  if (at === undefined) return undefined;
  return Math.min(now + MAX_RETRY_DELAY_MS, Math.max(now, at));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenAIModelEntry(value: unknown): value is OpenAIModelEntry {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0;
}

/** Strip trailing slashes and a trailing `/v1`. */
export function normalizeBaseURL(url: string): string {
  let normalized = url.replace(/\/+$/, "");
  if (normalized.endsWith("/v1")) normalized = normalized.slice(0, -3);
  return normalized;
}

function abortKind(signal: AbortSignal | undefined): ProviderFailureKind {
  const reason: unknown = signal?.reason;
  return reason instanceof Error && reason.name === "TimeoutError"
    ? "timeout"
    : "aborted";
}

/**
 * Fetch the model list. A fired list timer (headers or body) is a `timeout`
 * failure with the `aborted` list attempt, the same attempt a job-budget
 * timeout records; a caller abort leaves `failure` unset for the caller to
 * classify from its signal.
 */
async function fetchModels(
  baseURL: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<FetchModelsResult> {
  const aborted = (): FetchModelsResult => ({ models: [], attempt: "aborted" });
  const timedOut = (): FetchModelsResult => ({
    models: [],
    attempt: "aborted",
    failure: "timeout",
  });
  try {
    const outcome = await fetchOutcome(`${baseURL}/v1/models`, {
      headers,
      signal,
      timeoutMs: LIST_TIMEOUT_MS,
    });
    if (signal?.aborted || outcome.type === "aborted") return aborted();
    switch (outcome.type) {
      case "timeout":
        return timedOut();
      case "network":
        return { models: [], attempt: "unreachable", failure: "unreachable" };
      case "status": {
        const retryAt = retryAtFromHeaders(
          outcome.status,
          outcome.headers,
          Date.now(),
        );
        return {
          models: [],
          attempt: "http-error",
          failure: failureKindForStatus(outcome.status),
          httpStatus: outcome.status,
          ...(retryAt === undefined ? {} : { retryAt }),
        };
      }
      case "ok":
        break;
    }
    const body = await readJsonOutcome(outcome.response, LIST_TIMEOUT_MS);
    if (signal?.aborted) return aborted();
    if (body.type === "timeout") return timedOut();
    const data = body.type === "ok" ? body.value : undefined;
    if (!isRecord(data) || !Array.isArray(data.data))
      return {
        models: [],
        attempt: "invalid-response",
        failure: "invalid-response",
      };
    const models = data.data.filter(isOpenAIModelEntry);
    return { models, attempt: models.length > 0 ? "ready" : "empty" };
  } catch {
    return signal?.aborted
      ? aborted()
      : { models: [], attempt: "error", failure: "error" };
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeCost(value: unknown): ProbeModelCost | undefined {
  if (!isRecord(value) || !isPrice(value.input) || !isPrice(value.output))
    return undefined;
  return {
    input: value.input,
    output: value.output,
    ...(isPrice(value.cacheRead) ? { cacheRead: value.cacheRead } : {}),
    ...(isPrice(value.cacheWrite) ? { cacheWrite: value.cacheWrite } : {}),
  };
}

/**
 * Keep only well-typed probe fields. Used for fresh probe results and for
 * inventories read back from storage, so a malformed value can never reach
 * a `Model.Info` patch.
 */
export function sanitizeProbeMeta(value: unknown): ProbeModelMeta | undefined {
  if (!isRecord(value)) return undefined;
  const meta: ProbeModelMeta = {};
  if (isPositiveInteger(value.context)) meta.context = value.context;
  if (isPositiveInteger(value.maxTokens)) meta.maxTokens = value.maxTokens;
  if (
    value.modelType === "llm" ||
    value.modelType === "vlm" ||
    value.modelType === "embedding"
  )
    meta.modelType = value.modelType;
  for (const key of [
    "toolCall",
    "reasoning",
    "temperature",
    "vision",
  ] as const) {
    const flag = value[key];
    if (typeof flag === "boolean") meta[key] = flag;
  }
  if (typeof value.loaded === "boolean") meta.loaded = value.loaded;
  if (
    typeof value.sizeBytes === "number" &&
    Number.isFinite(value.sizeBytes) &&
    value.sizeBytes >= 0
  )
    meta.sizeBytes = value.sizeBytes;
  for (const key of ["parameterSize", "family", "quantization"] as const) {
    const text = nonEmptyString(value[key]);
    if (text !== undefined && text.length <= 4096) meta[key] = text;
  }
  if (Array.isArray(value.inputModalities)) {
    // Unknown modality names are dropped; the known ones stay authoritative.
    const reported: unknown[] = value.inputModalities;
    meta.inputModalities = INPUT_MODALITIES.filter((modality) =>
      reported.includes(modality),
    );
  }
  const cost = sanitizeCost(value.cost);
  if (cost) meta.cost = cost;
  return meta;
}

/**
 * Discover one provider: fetch `/v1/models`, resolve and run the configured
 * probe, and return the inventory. Never throws; a failed model list is a
 * failure result, while a failed probe still yields the listed models.
 */
export async function discoverProvider(
  target: DiscoveryTarget,
  signal?: AbortSignal,
): Promise<DiscoveryResult> {
  try {
    const baseURL = normalizeBaseURL(target.baseURL);
    const headers = buildHeaders(target.apiKey, target.headers);
    const fetched = await fetchModels(baseURL, headers, signal);
    if (fetched.attempt !== "ready" && fetched.attempt !== "empty") {
      return {
        ok: false,
        failure: fetched.failure ?? abortKind(signal),
        modelListAttempt: fetched.attempt,
        ...(fetched.httpStatus === undefined
          ? {}
          : { httpStatus: fetched.httpStatus }),
        ...(fetched.retryAt === undefined ? {} : { retryAt: fetched.retryAt }),
      };
    }

    const listed = new Map<string, OpenAIModelEntry>();
    for (const entry of fetched.models) {
      if (!listed.has(entry.id)) listed.set(entry.id, entry);
    }

    const probeType = nonEmptyString(target.probe);
    let probeAttempt: ProbeAttempt = probeType ? "unresolved" : "not-requested";
    let resolvedProbe: ProbeKey | undefined;
    const metaById = new Map<string, ProbeModelMeta>();
    if (probeType && fetched.models.length > 0) {
      const context: ProbeContext = {
        modelsResponse: fetched.models,
        probeSelection: probeType === "auto" ? "auto" : "explicit",
        signal,
        ...(target.headers ? { headers: target.headers } : {}),
      };
      try {
        const resolved = await resolveProbe(
          probeType,
          baseURL,
          target.apiKey,
          context,
          signal,
        );
        if (resolved.probe && resolved.key) {
          resolvedProbe = resolved.key;
          const result = await resolved.probe(baseURL, target.apiKey, context);
          const entries = Object.entries(result.models);
          probeAttempt = entries.length > 0 ? "complete" : "empty";
          for (const [id, meta] of entries) {
            const clean = sanitizeProbeMeta(meta);
            // Probe metadata applies only to models the server listed.
            if (clean && listed.has(id)) metaById.set(id, clean);
          }
        }
      } catch {
        probeAttempt = signal?.aborted ? "aborted" : "error";
      }
    }

    if (signal?.aborted) {
      return {
        ok: false,
        failure: abortKind(signal),
        modelListAttempt: "aborted",
      };
    }

    const endpointOrigin = sanitizeEndpointOrigin(baseURL);
    const models: InventoryModel[] = [...listed.values()].map((entry) => {
      const meta = metaById.get(entry.id);
      const created =
        typeof entry.created === "number" &&
        Number.isFinite(entry.created) &&
        entry.created > 0
          ? entry.created
          : undefined;
      return {
        id: entry.id,
        ...(created === undefined ? {} : { created }),
        ...(meta ? { meta } : {}),
      };
    });
    return {
      ok: true,
      inventory: {
        ...(endpointOrigin ? { endpointOrigin } : {}),
        ...(resolvedProbe ? { resolvedProbe } : {}),
        modelListAttempt: fetched.attempt,
        probeAttempt,
        models,
        completedAt: new Date().toISOString(),
      },
    };
  } catch {
    return {
      ok: false,
      failure: signal?.aborted ? abortKind(signal) : "error",
      modelListAttempt: signal?.aborted ? "aborted" : "error",
    };
  }
}

// ── Mapping ─────────────────────────────────────────────────────────────

/** Known LLM model name patterns for keyword-based categorization. */
const LLM_KEYWORDS = [
  "llama",
  "qwen",
  "gemma",
  "mistral",
  "phi",
  "gpt",
  "claude",
  "deepseek",
  "codestral",
  "starcoder",
  "coder",
  "chat",
  "instruct",
  "wizard",
  "falcon",
  "internlm",
  "glm",
  "command",
  "solar",
  "hermes",
  "vicuna",
  "orca",
  "zephyr",
  "neural",
  "tinyllama",
];

/** Short keywords matched on word boundaries ("yi" must not match "binaryai"). */
const LLM_KEYWORDS_BOUNDARY = [/\byi\b/i];

function categorizeModel(id: string): "embedding" | "chat" | "unknown" {
  const lower = id.toLowerCase();
  if (lower.includes("embedding") || lower.includes("embed"))
    return "embedding";
  if (LLM_KEYWORDS.some((keyword) => lower.includes(keyword))) return "chat";
  if (LLM_KEYWORDS_BOUNDARY.some((pattern) => pattern.test(id))) return "chat";
  return "unknown";
}

/** Values written into a scout-added `Model.Info`. */
export interface ModelPatch {
  readonly name: string;
  readonly family?: string;
  readonly tools: boolean;
  readonly input: readonly InputModality[];
  readonly context: number;
  readonly output: number;
  readonly variants: readonly ReasoningEffort[];
  /** Zero-filled cache prices; undefined emits `cost: []`. */
  readonly cost?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  /** Epoch milliseconds, or 0 when unknown. */
  readonly released: number;
  readonly enabled: boolean;
}

export interface MappedModel {
  readonly id: string;
  readonly patch: ModelPatch;
  readonly evidence: CatalogModelRecord;
}

export interface MappingOptions {
  /**
   * Emit `low`/`medium`/`high` effort variants (`settings.reasoningEffort`)
   * for reasoning models. Only meaningful on the openai-compatible package.
   */
  readonly reasoningVariants: boolean;
}

const supported = (
  source: "provider-probe" | "models.dev" | "policy-default" | "host-default",
): CapabilityEvidence =>
  source === "provider-probe"
    ? { state: "supported", source, strength: "authoritative" }
    : source === "models.dev"
      ? { state: "supported", source, strength: "inferred" }
      : { state: "supported", source, strength: "assumed" };

const unsupported = (
  source: "provider-probe" | "models.dev",
): CapabilityEvidence =>
  source === "provider-probe"
    ? { state: "unsupported", source, strength: "authoritative" }
    : { state: "unsupported", source, strength: "inferred" };

const probeFlag = (value: boolean): CapabilityEvidence =>
  value ? supported("provider-probe") : unsupported("provider-probe");

const probeScalar = <T extends string | number>(value: T): ScalarEvidence<T> =>
  knownScalar(value, "provider-probe", "authoritative");

function isOn(evidence: CapabilityEvidence): boolean {
  return evidence.state === "supported";
}

function inputEvidence(
  meta: ProbeModelMeta | undefined,
  match: ModelsDevMatch | undefined,
  embedding: boolean,
): InputModalityEvidence {
  const reported = meta?.inputModalities;
  if (reported) {
    const evidence = {} as InputModalityEvidence;
    for (const modality of INPUT_MODALITIES)
      evidence[modality] = probeFlag(
        reported.includes(modality as ProbeInputModality),
      );
    return evidence;
  }
  const evidence: InputModalityEvidence = {
    text: supported("policy-default"),
    image: unknownCapability(),
    pdf: unknownCapability(),
    audio: unknownCapability(),
    video: unknownCapability(),
  };
  if (embedding) return evidence;
  if (meta?.vision === true || meta?.modelType === "vlm")
    evidence.image = supported("provider-probe");
  else if (meta?.vision === false || meta?.modelType === "llm")
    // An authoritative LLM classification excludes image input unless the
    // probe also reports vision.
    evidence.image = unsupported("provider-probe");
  else if (match)
    evidence.image = match.input.includes("image")
      ? supported("models.dev")
      : unsupported("models.dev");
  if (match) {
    for (const modality of ["pdf", "audio", "video"] as const)
      evidence[modality] = match.input.includes(modality)
        ? supported("models.dev")
        : unsupported("models.dev");
  }
  return evidence;
}

function costEvidence(cost: ProbeModelCost | undefined): CostEvidence {
  const price = (value: number | undefined): ScalarEvidence<number> =>
    value === undefined
      ? unknownScalar()
      : knownScalar(value, "provider-probe", "reported");
  return {
    input: price(cost?.input),
    output: price(cost?.output),
    cacheRead: price(cost?.cacheRead),
    cacheWrite: price(cost?.cacheWrite),
  };
}

function mapModel(
  model: InventoryModel,
  probeKey: ProbeKey | undefined,
  index: ModelsDevIndex,
  options: MappingOptions,
): MappedModel {
  const { id } = model;
  const meta = probeKey ? model.meta : undefined;
  const category = categorizeModel(id);
  const embedding =
    meta?.modelType === "embedding" ||
    (meta?.modelType === undefined && category === "embedding");
  const match = embedding ? undefined : findModelsDevMatch(id, index);

  const name = formatModelName(id);
  const owner = extractModelOwner(id);

  const inputModalities = inputEvidence(meta, match, embedding);
  let input = INPUT_MODALITIES.filter((modality) =>
    isOn(inputModalities[modality]),
  );
  if (input.length === 0) {
    inputModalities.text = supported("policy-default");
    input = ["text"];
  }

  let modelType: CatalogModelRecord["modelType"];
  if (meta?.modelType === "embedding") modelType = probeScalar("embedding");
  else if (inputModalities.image.state === "supported")
    modelType =
      inputModalities.image.source === "provider-probe"
        ? probeScalar("vlm")
        : knownScalar("vlm", "models.dev", "inferred");
  else if (meta?.modelType) modelType = probeScalar(meta.modelType);
  else if (category === "embedding")
    modelType = knownScalar("embedding", "heuristic", "inferred");
  else if (category === "chat")
    modelType = knownScalar("llm", "heuristic", "inferred");
  else modelType = unknownScalar();

  const toolCall: CapabilityEvidence =
    typeof meta?.toolCall === "boolean"
      ? probeFlag(meta.toolCall)
      : match
        ? match.tools
          ? supported("models.dev")
          : unsupported("models.dev")
        : supported("host-default");

  const reasoning: CapabilityEvidence =
    typeof meta?.reasoning === "boolean"
      ? probeFlag(meta.reasoning)
      : match?.reasoning
        ? supported("models.dev")
        : unknownCapability();

  const temperature: CapabilityEvidence =
    typeof meta?.temperature === "boolean"
      ? probeFlag(meta.temperature)
      : unknownCapability();

  const family = meta?.family
    ? probeScalar(meta.family)
    : match?.family
      ? knownScalar(match.family, "models.dev", "inferred")
      : unknownScalar<string>();

  const contextKnown = meta?.context !== undefined;
  const context = meta?.context ?? HOST_DEFAULT_CONTEXT;
  const output =
    meta?.maxTokens === undefined
      ? UNKNOWN_OUTPUT_LIMIT
      : contextKnown
        ? Math.min(meta.maxTokens, context)
        : meta.maxTokens;

  const cost = meta?.cost;
  const released =
    probeKey === "actualyze" && model.created !== undefined
      ? model.created * 1000
      : 0;

  // Actualyze's OpenAI-compatible chat endpoint does not translate
  // `reasoning_effort` into the upstream provider's thinking settings, so
  // effort variants would change nothing there.
  const variants =
    options.reasoningVariants &&
    probeKey !== "actualyze" &&
    !embedding &&
    isOn(reasoning)
      ? REASONING_EFFORTS
      : [];

  const evidence: CatalogModelRecord = {
    id,
    origin: "discovered",
    enabled: !embedding,
    identity: knownScalar(id, "server-list", "reported"),
    name: knownScalar(name || id, "heuristic", "inferred"),
    modelType,
    context: contextKnown
      ? probeScalar(context)
      : knownScalar(HOST_DEFAULT_CONTEXT, "host-default", "assumed"),
    output:
      meta?.maxTokens === undefined ? unknownScalar() : probeScalar(output),
    family,
    organizationOwner: owner
      ? knownScalar(owner, "heuristic", "inferred")
      : unknownScalar(),
    parameterSize: meta?.parameterSize
      ? probeScalar(meta.parameterSize)
      : unknownScalar(),
    quantization: meta?.quantization
      ? probeScalar(meta.quantization)
      : unknownScalar(),
    sizeBytes:
      meta?.sizeBytes !== undefined
        ? probeScalar(meta.sizeBytes)
        : unknownScalar(),
    probeIdentity:
      meta && probeKey
        ? knownScalar(probeKey, "provider-probe", "reported")
        : unknownScalar(),
    capabilities: { toolCall, reasoning, temperature },
    inputModalities,
    cost: costEvidence(cost),
  };

  const familyValue = family.state === "known" ? family.value : undefined;
  return {
    id,
    patch: {
      name: name || id,
      ...(familyValue === undefined ? {} : { family: familyValue }),
      tools: isOn(toolCall),
      input,
      context,
      output,
      variants,
      ...(cost
        ? {
            cost: {
              input: cost.input,
              output: cost.output,
              cacheRead: cost.cacheRead ?? 0,
              cacheWrite: cost.cacheWrite ?? 0,
            },
          }
        : {}),
      released,
      enabled: !embedding,
    },
    evidence,
  };
}

/**
 * Map every served model of an inventory to its `Model.Info` patch and
 * evidence record. Pure: the same inputs always give equal outputs.
 */
export function toModelInfo(
  inventory: ProviderInventory,
  index: ModelsDevIndex,
  options: MappingOptions,
): MappedModel[] {
  const seen = new Set<string>();
  const mapped: MappedModel[] = [];
  for (const model of inventory.models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    mapped.push(mapModel(model, inventory.resolvedProbe, index, options));
  }
  return mapped;
}

/** Evidence for a model declared in config or models.dev; scout leaves it unchanged. */
export function preExistingRecord(id: string): CatalogModelRecord {
  return {
    id,
    origin: "pre-existing",
    enabled: true,
    identity: knownScalar(id, "pre-existing", "configured"),
    name: unknownScalar(),
    modelType: unknownScalar(),
    context: unknownScalar(),
    output: unknownScalar(),
    family: unknownScalar(),
    organizationOwner: unknownScalar(),
    parameterSize: unknownScalar(),
    quantization: unknownScalar(),
    sizeBytes: unknownScalar(),
    probeIdentity: unknownScalar(),
    capabilities: {
      toolCall: unknownCapability(),
      reasoning: unknownCapability(),
      temperature: unknownCapability(),
    },
    inputModalities: {
      text: unknownCapability(),
      image: unknownCapability(),
      pdf: unknownCapability(),
      audio: unknownCapability(),
      video: unknownCapability(),
    },
    cost: costEvidence(undefined),
  };
}
