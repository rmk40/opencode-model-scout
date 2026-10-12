import type { ProbeModelMeta, OpenAIModelEntry } from "./probes/types";
import { resolveProbe } from "./probes/index";
import type { ProbeContext, DetectedServer } from "./probes/index";
import {
  extractModelOwner,
  formatModelName,
  formatNumber,
  formatBytes,
} from "./format";
import { findMatch, type ModelsDevMeta } from "./models-dev";
import {
  buildHeaders,
  isFiniteNumber,
  probeFetch,
  readJson,
} from "./probes/util";
import {
  knownScalar,
  sanitizeEndpointOrigin,
  unknownCapability,
  unknownScalar,
  type CapabilityEvidence,
  type CatalogModelRecord,
  type CatalogProviderRecord,
  type MetadataSource,
  type ModelListAttempt,
  type ScalarEvidence,
} from "./catalog-snapshot";

/** Snapshot of what was discovered for a single provider. */
export interface DiscoverySnapshot {
  provider: string;
  probeType: string | undefined;
  baseURL: string;
  models: Record<string, Record<string, unknown>>;
  /** Model IDs found on the server but already configured in opencode.json. */
  skipped: string[];
  detectedServer?: DetectedServer;
}

/** Shape of the OpenAI /v1/models response body. */
interface OpenAIModelsResponse {
  data?: unknown;
}

interface FetchModelsResult {
  models: OpenAIModelEntry[];
  attempt: ModelListAttempt;
}

/** Module-level store of discovery results, reset on each run. */
let discoveryStore: DiscoverySnapshot[] = [];
let catalogStore: CatalogProviderRecord[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenAIModelEntry(value: unknown): value is OpenAIModelEntry {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0;
}

/** Get the current discovery store (read-only). */
export function getDiscoveryStore(): readonly DiscoverySnapshot[] {
  return discoveryStore;
}

/** Get typed provenance records from the most recent completed discovery run. */
export function getCatalogStore(): readonly CatalogProviderRecord[] {
  return catalogStore;
}

/**
 * Strip trailing slash and trailing /v1 from a URL.
 * E.g. "http://localhost:8000/v1/" → "http://localhost:8000"
 */
function normalizeBaseURL(url: string): string {
  let normalized = url.replace(/\/+$/, "");
  if (normalized.endsWith("/v1")) {
    normalized = normalized.slice(0, -3);
  }
  return normalized;
}

/**
 * Fetch the list of models from a provider's /v1/models endpoint.
 * Also serves as a health check. The outcome stays conservative because
 * probeFetch intentionally hides transport details from callers.
 */
async function fetchModels(
  baseURL: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<FetchModelsResult> {
  try {
    const headers = buildHeaders(apiKey);
    const res = await probeFetch(`${baseURL}/v1/models`, {
      headers,
      signal,
      timeoutMs: 3000,
    });
    if (!res)
      return {
        models: [],
        attempt: signal?.aborted ? "aborted" : "unreachable",
      };
    if (!res.ok) return { models: [], attempt: "http-error" };
    // Bounded body read: some gateways send headers fast then stall the body.
    const data = await readJson<OpenAIModelsResponse>(res, 3000);
    if (!data || !Array.isArray(data.data))
      return {
        models: [],
        attempt: signal?.aborted ? "aborted" : "invalid-response",
      };
    if (signal?.aborted) return { models: [], attempt: "aborted" };
    const models = data.data.filter(isOpenAIModelEntry);
    return { models, attempt: models.length > 0 ? "ready" : "empty" };
  } catch {
    return {
      models: [],
      attempt: signal?.aborted ? "aborted" : "error",
    };
  }
}

/**
 * Check if a provider config is eligible for model discovery.
 * Returns true if:
 * - npm is "@ai-sdk/openai-compatible" (standard OpenAI-compatible SDK), OR
 * - options.baseURL contains "/v1" (likely OpenAI-compatible even with other npm packages)
 */
function canDiscover(provider: Record<string, unknown>): boolean {
  if (provider.npm === "@ai-sdk/openai-compatible") return true;

  const options = provider.options as Record<string, unknown> | undefined;
  if (options?.baseURL && typeof options.baseURL === "string") {
    return options.baseURL.includes("/v1");
  }

  return false;
}

/** Sanitized provider identities used to correlate server and TUI state. */
export function discoverableProviderEntries(
  config: Record<string, unknown>,
): Array<{ id: string; baseURL: unknown; probe: unknown }> {
  const providers = config.provider;
  if (!isRecord(providers)) return [];
  const entries: Array<{ id: string; baseURL: unknown; probe: unknown }> = [];
  for (const [id, value] of Object.entries(providers)) {
    if (!isRecord(value)) continue;
    const options = isRecord(value.options) ? value.options : undefined;
    if (typeof options?.baseURL !== "string" || options.baseURL.length === 0)
      continue;
    entries.push({ id, baseURL: options.baseURL, probe: options.probe });
  }
  return entries;
}

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

/**
 * Short keywords that need word-boundary matching to avoid false positives
 * (e.g., "yi" inside "binaryai"). Matched with regex \bKEYWORD\b.
 */
const LLM_KEYWORDS_BOUNDARY = [/\byi\b/i];

/**
 * Categorize a model by its ID using keyword matching.
 * Returns "embedding", "chat", or "unknown".
 */
function categorizeModel(id: string): "embedding" | "chat" | "unknown" {
  const lower = id.toLowerCase();
  if (lower.includes("embedding") || lower.includes("embed")) {
    return "embedding";
  }
  for (const keyword of LLM_KEYWORDS) {
    if (lower.includes(keyword)) return "chat";
  }
  for (const pattern of LLM_KEYWORDS_BOUNDARY) {
    if (pattern.test(id)) return "chat";
  }
  return "unknown";
}

function createModelRecord(
  id: string,
  origin: CatalogModelRecord["origin"],
  identitySource: MetadataSource,
): CatalogModelRecord {
  return {
    id,
    origin,
    identity: knownScalar(
      id,
      identitySource,
      identitySource === "server-list" ? "reported" : "configured",
    ),
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
      vision: unknownCapability(),
      toolCall: unknownCapability(),
      reasoning: unknownCapability(),
      temperature: unknownCapability(),
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function setPreExistingScalar<T extends string | number>(
  value: T | undefined,
): ScalarEvidence<T> {
  return value === undefined
    ? unknownScalar()
    : knownScalar(value, "pre-existing", "configured");
}

function supportedBy(
  source: Exclude<MetadataSource, "unmatched-host">,
  strength:
    | "authoritative"
    | "configured"
    | "reported"
    | "inferred"
    | "assumed",
): CapabilityEvidence {
  return { state: "supported", source, strength };
}

function probeCapability(value: boolean): CapabilityEvidence {
  return value
    ? supportedBy("provider-probe", "authoritative")
    : {
        state: "unsupported",
        source: "provider-probe",
        strength: "authoritative",
      };
}

function modelTypeFromModalities(
  value: unknown,
): "llm" | "vlm" | "embedding" | undefined {
  if (!isRecord(value)) return undefined;
  const input = Array.isArray(value.input) ? value.input : [];
  const output = Array.isArray(value.output) ? value.output : [];
  if (output.includes("embedding")) return "embedding";
  if (input.includes("image")) return "vlm";
  if (output.includes("text")) return "llm";
  return undefined;
}

function recordPreExistingModel(
  id: string,
  value: unknown,
): CatalogModelRecord {
  const record = createModelRecord(id, "pre-existing", "pre-existing");
  if (!isRecord(value)) return record;
  record.name = setPreExistingScalar(readString(value.name));
  record.family = setPreExistingScalar(readString(value.family));
  record.organizationOwner = setPreExistingScalar(
    readString(value.organizationOwner),
  );
  record.parameterSize = setPreExistingScalar(readString(value.parameterSize));
  record.quantization = setPreExistingScalar(readString(value.quantization));
  record.sizeBytes = setPreExistingScalar(
    isFiniteNumber(value.sizeBytes) ? value.sizeBytes : undefined,
  );
  record.modelType = setPreExistingScalar(
    modelTypeFromModalities(value.modalities),
  );
  if (isRecord(value.limit)) {
    record.context = setPreExistingScalar(
      isFiniteNumber(value.limit.context) ? value.limit.context : undefined,
    );
    record.output = setPreExistingScalar(
      isFiniteNumber(value.limit.output) ? value.limit.output : undefined,
    );
  }
  const configuredCapability = (value: unknown): CapabilityEvidence =>
    value === true
      ? supportedBy("pre-existing", "configured")
      : value === false
        ? {
            state: "unsupported",
            source: "pre-existing",
            strength: "configured",
          }
        : unknownCapability();
  record.capabilities.vision = configuredCapability(value.attachment);
  record.capabilities.toolCall = configuredCapability(value.tool_call);
  record.capabilities.reasoning = configuredCapability(value.reasoning);
  record.capabilities.temperature = configuredCapability(value.temperature);
  return record;
}

/**
 * Enrich a model config object with metadata from a probe.
 */
function applyProbeMeta(
  model: Record<string, unknown>,
  meta: ProbeModelMeta,
  evidence: CatalogModelRecord,
  probeIdentity: string,
): void {
  // Limits — only set if not already present. Omit unknown fields
  // rather than defaulting to 0 (which would mean "no output allowed").
  if (
    !model.limit &&
    (isFiniteNumber(meta.context) || isFiniteNumber(meta.maxTokens))
  ) {
    const limit: Record<string, number> = {};
    if (isFiniteNumber(meta.context)) {
      limit.context = meta.context;
      evidence.context = knownScalar(
        meta.context,
        "provider-probe",
        "authoritative",
      );
    }
    if (isFiniteNumber(meta.maxTokens)) {
      limit.output = meta.maxTokens;
      evidence.output = knownScalar(
        meta.maxTokens,
        "provider-probe",
        "authoritative",
      );
    }
    model.limit = limit;
  }

  // Modalities — probe is more accurate than keyword guess, always override for discovered models
  if (meta.vision === false) {
    model._probeNoVision = true;
    evidence.capabilities.vision = probeCapability(false);
  }
  if (meta.vision || meta.modelType === "vlm") {
    model.modalities = { input: ["text", "image"], output: ["text"] };
    model.attachment = true;
    evidence.modelType = knownScalar("vlm", "provider-probe", "authoritative");
    evidence.capabilities.vision = probeCapability(true);
  } else if (meta.modelType === "llm") {
    model.modalities = { input: ["text"], output: ["text"] };
    evidence.modelType = knownScalar("llm", "provider-probe", "authoritative");
    // An authoritative LLM classification excludes image input unless the
    // probe explicitly reports vision support. Keep the denial internal while
    // making the negative evidence explicit for exact TUI reconciliation.
    model._probeNoVision = true;
    evidence.capabilities.vision = probeCapability(false);
  } else if (meta.modelType === "embedding") {
    // Probe confirms this is an embedding model — clear any chat modalities
    // that keyword categorization may have set (output:["embedding"] is invalid
    // in opencode, so we remove modalities entirely)
    delete model.modalities;
    delete model.attachment;
    // Mark as probe-confirmed embedding so fallback enrichment skips modalities
    model._probeEmbedding = true;
    evidence.modelType = knownScalar(
      "embedding",
      "provider-probe",
      "authoritative",
    );
  }

  // Capability flags — only set if not already present on model
  if (meta.toolCall === true && model.tool_call === undefined) {
    model.tool_call = true;
    evidence.capabilities.toolCall = probeCapability(true);
  } else if (meta.toolCall === false) {
    model._probeNoToolCall = true;
    evidence.capabilities.toolCall = probeCapability(false);
  }
  if (meta.reasoning === true && model.reasoning === undefined) {
    model.reasoning = true;
    evidence.capabilities.reasoning = probeCapability(true);
  } else if (meta.reasoning === false) {
    model._probeNoReasoning = true;
    evidence.capabilities.reasoning = probeCapability(false);
  }
  // temperature: all probed models support temperature — set as default,
  // allow probe override if it explicitly provides a different value
  if (model.temperature === undefined) {
    model.temperature = true;
    evidence.capabilities.temperature = supportedBy(
      "policy-default",
      "assumed",
    );
  }
  if (meta.temperature !== undefined) {
    model.temperature = meta.temperature;
    evidence.capabilities.temperature = probeCapability(meta.temperature);
  }
  if (meta.family && !model.family) {
    model.family = meta.family;
    evidence.family = knownScalar(
      meta.family,
      "provider-probe",
      "authoritative",
    );
  }

  // Probe-only diagnostics stay in the catalog. They are not provider request
  // options and are not emitted as unknown top-level model properties.
  if (meta.parameterSize)
    evidence.parameterSize = knownScalar(
      meta.parameterSize,
      "provider-probe",
      "authoritative",
    );
  if (meta.quantization)
    evidence.quantization = knownScalar(
      meta.quantization,
      "provider-probe",
      "authoritative",
    );
  if (isFiniteNumber(meta.sizeBytes))
    evidence.sizeBytes = knownScalar(
      meta.sizeBytes,
      "provider-probe",
      "authoritative",
    );
  evidence.probeIdentity = knownScalar(
    probeIdentity,
    "provider-probe",
    "reported",
  );
}

/**
 * Apply models.dev metadata as a fallback enrichment source.
 * Only sets fields that are not already present on the model.
 * Respects probe authority sentinels for unsupported capabilities and
 * probe-confirmed embedding models.
 */
function applyModelsDevMeta(
  model: Record<string, unknown>,
  meta: ModelsDevMeta,
  evidence: CatalogModelRecord,
): void {
  const isProbeEmbedding = model._probeEmbedding === true;
  const isProbeLlm =
    evidence.modelType.state === "known" &&
    evidence.modelType.value === "llm" &&
    evidence.modelType.source === "provider-probe";
  const isToolCallDenied = model._probeNoToolCall === true;
  const isReasoningDenied = model._probeNoReasoning === true;
  const isVisionDenied = model._probeNoVision === true;

  if (meta.toolCall && !isToolCallDenied && model.tool_call === undefined) {
    model.tool_call = true;
    evidence.capabilities.toolCall = supportedBy("models.dev", "inferred");
  }
  if (meta.reasoning && !isReasoningDenied && model.reasoning === undefined) {
    model.reasoning = true;
    evidence.capabilities.reasoning = supportedBy("models.dev", "inferred");
  }
  if (!isProbeEmbedding && !isProbeLlm && !isVisionDenied && meta.attachment) {
    model.attachment = true;
    model.modalities = { input: ["text", "image"], output: ["text"] };
    evidence.modelType = knownScalar("vlm", "models.dev", "inferred");
    evidence.capabilities.vision = supportedBy("models.dev", "inferred");
  }
  if (meta.temperature && model.temperature === undefined) {
    model.temperature = true;
    evidence.capabilities.temperature = supportedBy("models.dev", "inferred");
  }
  if (meta.family && !model.family) {
    model.family = meta.family;
    evidence.family = knownScalar(meta.family, "models.dev", "inferred");
  }
  if (
    !isProbeEmbedding &&
    !isProbeLlm &&
    !isVisionDenied &&
    meta.modalities &&
    !model.modalities
  ) {
    model.modalities = meta.modalities;
    if (meta.modalities.input.includes("image")) {
      evidence.modelType = knownScalar("vlm", "models.dev", "inferred");
      evidence.capabilities.vision = supportedBy("models.dev", "inferred");
    }
  }
}

function legacyDisplayModels(
  models: Record<string, Record<string, unknown>>,
  evidenceByModel: ReadonlyMap<string, CatalogModelRecord>,
): Record<string, Record<string, unknown>> {
  const display = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [id, model] of Object.entries(models)) {
    const copy = { ...model };
    const evidence = evidenceByModel.get(id);
    if (evidence?.parameterSize.state === "known")
      copy.parameterSize = evidence.parameterSize.value;
    if (evidence?.quantization.state === "known")
      copy.quantization = evidence.quantization.value;
    if (evidence?.sizeBytes.state === "known")
      copy.sizeBytes = evidence.sizeBytes.value;
    display[id] = copy;
  }
  return display;
}

/** Flattened models.dev index for matching. */
interface ModelsDevIndex {
  readonly id: string;
  readonly normalized: string;
  readonly family?: string;
  readonly meta: ModelsDevMeta;
}

/**
 * Discover models from all eligible providers in the config and enrich
 * with probe metadata and models.dev fallback. Mutates config.provider.*.models in place.
 */
export async function discoverModels(
  config: Record<string, unknown>,
  modelsDevIndex?: readonly ModelsDevIndex[],
  signal?: AbortSignal,
): Promise<CatalogProviderRecord[]> {
  try {
    // If the config-hook budget already expired (e.g. while the models.dev
    // index was still loading), do nothing: withTimeout has returned its
    // fallback and clearing the store now would race a later read.
    if (signal?.aborted) return catalogStore;

    // Reset store
    discoveryStore = [];
    catalogStore = [];

    const providers = config.provider as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!providers) return catalogStore;

    for (const [providerName, providerConfig] of Object.entries(providers)) {
      if (signal?.aborted) break;
      let providerRecord: CatalogProviderRecord | undefined;
      try {
        if (!canDiscover(providerConfig)) continue;

        const options = providerConfig.options as
          | Record<string, unknown>
          | undefined;
        const rawBaseURL = options?.baseURL;
        if (!rawBaseURL || typeof rawBaseURL !== "string") continue;

        const baseURL = normalizeBaseURL(rawBaseURL);
        const apiKey = options?.apiKey as string | undefined;
        const probeType = readString(options?.probe);
        const endpointOrigin = sanitizeEndpointOrigin(baseURL);
        const existingModels = isRecord(providerConfig.models)
          ? providerConfig.models
          : {};
        const preExistingRecords = Object.entries(existingModels)
          .filter(([id]) => id.length > 0)
          .map(([id, value]) => recordPreExistingModel(id, value));
        providerRecord = {
          id: providerName,
          endpointOrigin: endpointOrigin
            ? knownScalar(endpointOrigin, "pre-existing", "configured")
            : unknownScalar(),
          configuredProbe: probeType
            ? knownScalar(probeType, "pre-existing", "configured")
            : unknownScalar(),
          resolvedProbe: unknownScalar(),
          status: "error",
          modelListAttempt: "error",
          probeAttempt: probeType ? "unresolved" : "not-requested",
          skippedModelIds: [],
          models: preExistingRecords,
        };

        // Fetch model list (also serves as health check)
        const fetched = await fetchModels(baseURL, apiKey, signal);
        providerRecord.modelListAttempt = fetched.attempt;
        if (fetched.models.length === 0) {
          providerRecord.status =
            fetched.attempt === "empty"
              ? "empty"
              : fetched.attempt === "unreachable"
                ? "unreachable"
                : fetched.attempt === "aborted"
                  ? "aborted"
                  : "error";
          catalogStore.push(providerRecord);
          if (fetched.attempt === "aborted") break;
          continue;
        }
        const openaiModels = fetched.models;
        providerRecord.status = "ready";

        const discoveredModels = Object.create(null) as Record<
          string,
          Record<string, unknown>
        >;
        const skippedIds: string[] = [];
        const evidenceByModel = new Map<string, CatalogModelRecord>(
          preExistingRecords.map((record) => [record.id, record]),
        );

        for (const model of openaiModels) {
          // Track models already configured but don't overwrite them
          if (Object.hasOwn(existingModels, model.id)) {
            if (!skippedIds.includes(model.id)) {
              skippedIds.push(model.id);
            }
            continue;
          }

          // Some servers return duplicate IDs. Keep one catalog/config record.
          if (evidenceByModel.has(model.id)) continue;

          const category = categorizeModel(model.id);
          const entry: Record<string, unknown> = {
            id: model.id,
            name: formatModelName(model.id),
          };
          const evidence = createModelRecord(
            model.id,
            "discovered",
            "server-list",
          );
          evidence.name = knownScalar(
            entry.name as string,
            "heuristic",
            "inferred",
          );

          const owner = extractModelOwner(model.id);
          if (owner) {
            entry.organizationOwner = owner;
            evidence.organizationOwner = knownScalar(
              owner,
              "heuristic",
              "inferred",
            );
          }

          if (category === "embedding") {
            // Don't set modalities for embedding models —
            // output:["embedding"] is not valid in opencode's schema
            evidence.modelType = knownScalar(
              "embedding",
              "heuristic",
              "inferred",
            );
          } else if (category === "chat") {
            // Default to text-only; probe will upgrade to image if vision is confirmed
            entry.modalities = {
              input: ["text"],
              output: ["text"],
            };
            evidence.modelType = knownScalar("llm", "heuristic", "inferred");
          }

          discoveredModels[model.id] = entry;
          evidenceByModel.set(model.id, evidence);
        }

        const probeSelection = probeType === "auto" ? "auto" : "explicit";
        const context: ProbeContext = {
          modelsResponse: openaiModels,
          probeSelection,
          signal,
        };
        // Resolve probe (supports explicit names, "auto", or undefined)
        const { probe, detectedServer } = await resolveProbe(
          probeType,
          baseURL,
          apiKey,
          context,
          signal,
        );
        const probeIdentity =
          detectedServer ??
          (probe && probeType !== "auto" ? probeType : undefined);
        if (probeIdentity) {
          providerRecord.resolvedProbe = knownScalar(
            probeIdentity,
            "provider-probe",
            "reported",
          );
        }

        if (probe) {
          try {
            const probeResult = await probe(baseURL, apiKey, context);
            const probeEntries = Object.entries(probeResult.models);
            providerRecord.probeAttempt =
              probeEntries.length === 0 ? "empty" : "complete";
            for (const [modelId, meta] of probeEntries) {
              const discovered = discoveredModels[modelId];
              const evidence = evidenceByModel.get(modelId);
              if (discovered && evidence && probeIdentity) {
                applyProbeMeta(discovered, meta, evidence, probeIdentity);
              }
            }
          } catch {
            providerRecord.probeAttempt = signal?.aborted ? "aborted" : "error";
            // Probe failed — the model is still discovered, just less enriched.
            // Never write to stdout/stderr from a config-hook plugin.
          }
        }

        // Apply models.dev fallback for any remaining unenriched models
        if (modelsDevIndex && modelsDevIndex.length > 0) {
          for (const [modelId, model] of Object.entries(discoveredModels)) {
            const match = findMatch(modelId, modelsDevIndex);
            const evidence = evidenceByModel.get(modelId);
            if (match && evidence) {
              applyModelsDevMeta(model, match, evidence);
            }
          }
        }

        // If the config-hook budget expired while we were awaiting fetch/probe
        // above, the hook has already returned its fallback. Do not mutate the
        // (now-consumed) config or the discovery store — that would be a
        // post-timeout race with opencode reading the config.
        if (signal?.aborted) {
          providerRecord.status = "aborted";
          providerRecord.probeAttempt = "aborted";
          catalogStore.push(providerRecord);
          break;
        }

        // Clean up internal sentinel before merging into opencode config
        for (const model of Object.values(discoveredModels)) {
          delete model._probeEmbedding;
          delete model._probeNoToolCall;
          delete model._probeNoReasoning;
          delete model._probeNoVision;
        }

        // Merge discovered models into provider config
        if (Object.keys(discoveredModels).length > 0) {
          providerConfig.models = { ...existingModels, ...discoveredModels };
        }

        providerRecord.skippedModelIds = skippedIds;
        providerRecord.models = [...evidenceByModel.values()];
        catalogStore.push(providerRecord);

        // Record discovery results (including skipped models for /modelscout)
        if (Object.keys(discoveredModels).length > 0 || skippedIds.length > 0) {
          discoveryStore.push({
            provider: providerName,
            probeType,
            baseURL,
            models: legacyDisplayModels(discoveredModels, evidenceByModel),
            skipped: skippedIds,
            detectedServer,
          });
        }
      } catch {
        // Per-provider isolation: one failing provider never blocks the others.
        if (providerRecord && !catalogStore.includes(providerRecord)) {
          providerRecord.status = signal?.aborted ? "aborted" : "error";
          if (signal?.aborted) providerRecord.probeAttempt = "aborted";
          catalogStore.push(providerRecord);
        }
      }
    }
  } catch {
    // Discovery is best-effort; failures must never break opencode startup.
  }
  return catalogStore;
}

/**
 * Format discovery results as a human-readable table.
 * Pure function — no side effects. Operates on the server-side
 * `DiscoverySnapshot` shape produced by `discoverModels`.
 */
export function formatModelsTable(
  snapshots: readonly DiscoverySnapshot[],
): string {
  if (snapshots.length === 0) {
    return "Models Discovery\n\nNo models discovered. Providers may be offline or excluded by config.";
  }

  const sections: string[] = ["Models Discovery"];

  for (const snap of snapshots) {
    const discovered = Object.keys(snap.models).length;
    const total = discovered + snap.skipped.length;
    const probeLabel = snap.detectedServer
      ? `auto \u2192 ${snap.detectedServer}`
      : snap.probeType
        ? `probe: ${snap.probeType}`
        : "no probe";
    const countLabel =
      snap.skipped.length > 0
        ? `${total} model${total !== 1 ? "s" : ""} (${discovered} new)`
        : `${discovered} model${discovered !== 1 ? "s" : ""}`;
    const header = `\n${snap.provider} (${probeLabel}) — ${countLabel}`;
    const separator = "\u2500".repeat(50);

    sections.push(header);
    sections.push(separator);

    for (const [id, model] of Object.entries(snap.models)) {
      sections.push(`  ${id}`);

      const parts: string[] = [];

      // Context and output limits
      const limit = model.limit as
        | { context?: number; output?: number }
        | undefined;
      if (limit?.context) parts.push(`Context: ${formatNumber(limit.context)}`);
      if (limit?.output) parts.push(`Output: ${formatNumber(limit.output)}`);

      // Model type from modalities
      if (model.modalities) {
        const mod = model.modalities as {
          input?: string[];
          output?: string[];
        };
        if (mod.output?.includes("embedding")) {
          parts.push("Type: embedding");
        } else if (mod.input?.includes("image")) {
          parts.push("Type: vlm");
        } else {
          parts.push("Type: llm");
        }
      }

      // Capability flags
      const flags: string[] = [];
      if (model.attachment) flags.push("Vision");
      if (model.tool_call) flags.push("Tools");
      if (model.reasoning) flags.push("Reasoning");
      if (model.temperature) flags.push("Temp");
      if (flags.length > 0) parts.push(flags.join(", "));

      // Family and probe details (values are strings from probe metadata)
      if (model.family) parts.push(`Family: ${model.family as string}`);
      if (model.parameterSize)
        parts.push(`Params: ${model.parameterSize as string}`);
      if (model.quantization)
        parts.push(`Quant: ${model.quantization as string}`);
      if (model.sizeBytes)
        parts.push(`Size: ${formatBytes(model.sizeBytes as number)}`);

      if (parts.length > 0) {
        sections.push(`    ${parts.join(" | ")}`);
      }
    }

    if (snap.skipped.length > 0) {
      sections.push(
        `\n  Already configured (${snap.skipped.length}): ${snap.skipped.join(", ")}`,
      );
    }
  }

  return sections.join("\n");
}
