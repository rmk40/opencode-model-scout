/**
 * Evidence contract shared by the server plugin (which builds it) and the TUI
 * (which validates every RPC response with {@link validateCatalogPayload}
 * before rendering it).
 *
 * The payload carries no credentials, provider settings, or process
 * identifiers: endpoints are reduced to credential-free origins, and the host
 * scopes RPC calls by location. The one exception is `instanceID`, a random
 * value generated per refresher, so a client can tell that the plugin was
 * reloaded or restarted; it identifies nothing outside that.
 */

export const CATALOG_SCHEMA_VERSION = 5 as const;
export const MAX_ID_LENGTH = 4096;
export const MAX_PROVIDERS = 4096;
export const MAX_MODELS_PER_PROVIDER = 100_000;

export type MetadataSource =
  | "pre-existing"
  | "server-list"
  | "provider-probe"
  | "models.dev"
  | "heuristic"
  | "policy-default"
  /** The value is OpenCode's `Model.Info` default, not an observation. */
  | "host-default"
  | "unmatched-host";

export type ClaimStrength =
  | "authoritative"
  | "configured"
  | "reported"
  | "inferred"
  | "assumed"
  | "unmatched";

export type ScalarEvidence<T extends string | number> =
  | {
      state: "known";
      value: T;
      source: MetadataSource;
      strength: ClaimStrength;
    }
  | { state: "unknown" };

export type CapabilityEvidence =
  | {
      state: "supported";
      source: MetadataSource;
      strength: ClaimStrength;
    }
  | {
      state: "unsupported";
      source: "provider-probe" | "pre-existing" | "models.dev";
      strength: "authoritative" | "configured" | "inferred";
    }
  | { state: "unknown" };

export interface ModelCapabilityEvidence {
  toolCall: CapabilityEvidence;
  reasoning: CapabilityEvidence;
  temperature: CapabilityEvidence;
}

export const INPUT_MODALITIES = [
  "text",
  "image",
  "pdf",
  "audio",
  "video",
] as const;

export type InputModality = (typeof INPUT_MODALITIES)[number];

/** Per-modality input evidence; output is always text in OpenCode 2. */
export type InputModalityEvidence = Record<InputModality, CapabilityEvidence>;

/**
 * Prices in USD per million tokens. A missing cache price stays `unknown`
 * here even though the emitted `Model.Info.cost` zero-fills it.
 */
export interface CostEvidence {
  input: ScalarEvidence<number>;
  output: ScalarEvidence<number>;
  cacheRead: ScalarEvidence<number>;
  cacheWrite: ScalarEvidence<number>;
}

export interface CatalogModelRecord {
  id: string;
  origin: "discovered" | "pre-existing";
  /** False when scout emits the model disabled (embedding models). */
  enabled: boolean;
  identity: ScalarEvidence<string>;
  name: ScalarEvidence<string>;
  modelType: ScalarEvidence<"llm" | "vlm" | "embedding">;
  /** `host-default` means the 200 000 token `Model.Info` default. */
  context: ScalarEvidence<number>;
  /**
   * `unknown` when no output limit was observed; the emitted
   * `limit.output` is then 0, which the host treats as "fit to the
   * remaining context".
   */
  output: ScalarEvidence<number>;
  family: ScalarEvidence<string>;
  organizationOwner: ScalarEvidence<string>;
  parameterSize: ScalarEvidence<string>;
  quantization: ScalarEvidence<string>;
  sizeBytes: ScalarEvidence<number>;
  probeIdentity: ScalarEvidence<string>;
  capabilities: ModelCapabilityEvidence;
  inputModalities: InputModalityEvidence;
  cost: CostEvidence;
}

export type ModelListAttempt =
  | "pending"
  | "ready"
  | "empty"
  | "unreachable"
  | "aborted"
  | "http-error"
  | "invalid-response"
  | "error";

export type ProbeAttempt =
  | "pending"
  | "not-requested"
  | "unresolved"
  | "complete"
  | "empty"
  | "aborted"
  | "error";

/** Failure kinds that come from an HTTP status; each carries `httpStatus`. */
export type HttpFailureKind =
  | "unauthorized"
  | "forbidden"
  | "payment-required"
  | "rate-limited"
  | "not-found"
  | "server-error"
  | "http-error";

export type ProviderFailureKind =
  | HttpFailureKind
  | "unreachable"
  | "timeout"
  | "aborted"
  | "invalid-response"
  | "error";

/** The failure kind for a non-success HTTP status of the model list. */
export function failureKindForStatus(status: number): HttpFailureKind {
  switch (status) {
    case 401:
      return "unauthorized";
    case 402:
      return "payment-required";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 429:
      return "rate-limited";
    default:
      return status >= 500 && status <= 599 ? "server-error" : "http-error";
  }
}

/** The most recent discovery attempt failed; the last good inventory stays. */
export interface ProviderFailure {
  kind: ProviderFailureKind;
  /** ISO timestamp of the failed attempt. */
  at: string;
  /** HTTP status of the model list; set exactly for the HTTP kinds. */
  httpStatus?: number;
  /**
   * ISO time before which no discovery starts with this credential, from
   * `Retry-After` or `X-RateLimit-Reset`, clamped to at most one hour after
   * the attempt.
   */
  retryAt?: string;
}

/**
 * What a target discovers with: an integration connection, `settings.apiKey`,
 * provider headers that replace the key for its probe, no key, or nothing
 * resolved yet (the credential lookup failed and no earlier resolution is
 * kept, or a credential switch revoked it).
 */
export type CredentialSource =
  | "connection"
  | "settings"
  | "headers"
  | "none"
  | "unresolved";

export interface CatalogProviderRecord {
  id: string;
  endpointOrigin: ScalarEvidence<string>;
  configuredProbe: ScalarEvidence<string>;
  resolvedProbe: ScalarEvidence<string>;
  /** ISO time of the inventory being served, or null before the first success. */
  lastGoodAt: string | null;
  /** Failure of the latest attempt, or null when it succeeded or none ran. */
  failure: ProviderFailure | null;
  /** Outcome of the attempt that produced the served inventory. */
  modelListAttempt: ModelListAttempt;
  probeAttempt: ProbeAttempt;
  skippedModelIds: string[];
  models: CatalogModelRecord[];
  /** A job for the target's current store key is running. */
  discovering: boolean;
  /** ISO start of the latest job for the current store key. */
  lastAttemptAt: string | null;
  /**
   * ISO time before which a refresh is throttled: the later of
   * `lastAttemptAt` plus one minute and the failure's `retryAt`, or null
   * once that has passed.
   */
  nextRefreshAt: string | null;
  credentialSource: CredentialSource;
  /**
   * Incremented, per provider ID, whenever the target's resolved credential
   * changes, including a change to `unresolved`. Never decreases while the
   * same `instanceID` serves the catalog.
   */
  credentialEpoch: number;
  /**
   * The `credentialEpoch` the record's result belongs to, or null before
   * any result. The record is current when it equals `credentialEpoch`.
   */
  resultEpoch: number | null;
}

export type CatalogStatus = "pending" | "running" | "complete";

/**
 * Whether scout manages the `actualyze` provider: `managed` when scout added
 * it or it is a discovery target, `foreign` when another source defined it
 * and it is not a target. `foreign` requires positive evidence of another
 * definition, so it is `managed` too before the first provider fold and
 * when adding the provider failed.
 */
export type BuiltInState = "managed" | "foreign";

/** Output of the RPC `catalog` method. */
export interface CatalogPayload {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  packageVersion: string;
  /** Random per server plugin instance; changes on reload or restart. */
  instanceID: string;
  /** ISO server time when the payload was built. */
  generatedAt: string;
  status: CatalogStatus;
  /** Start of the current or latest refresh cycle. Required while running. */
  startedAt?: string;
  /** End of the latest completed cycle. Required when complete. */
  completedAt?: string;
  builtIn: { actualyze: BuiltInState };
  providers: CatalogProviderRecord[];
}

export function unknownScalar<T extends string | number>(): ScalarEvidence<T> {
  return { state: "unknown" };
}

export function unknownCapability(): CapabilityEvidence {
  return { state: "unknown" };
}

export function knownScalar<T extends string | number>(
  value: T,
  source: MetadataSource,
  strength: ClaimStrength,
): ScalarEvidence<T> {
  return { state: "known", value, source, strength };
}

/** Reduce a provider URL to a credential-free origin. */
export function sanitizeEndpointOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin === "null" ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

// ── Structural guards (shared with other strict validators) ─────────────

/** A plain object (Object or null prototype), never an array or class instance. */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === required.length && required.every((key) => key in value)
  );
}

/**
 * Every key is from `required` or `optional`, every required key exists, and
 * no key holds `undefined`: an optional key is either absent or set, which is
 * how the host decodes optional fields.
 */
function hasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    Object.entries(value).every(
      ([key, child]) => allowed.has(key) && child !== undefined,
    ) && required.every((key) => key in value)
  );
}

export function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

/** A canonical ISO-8601 timestamp, as produced by `Date#toISOString`. */
export function isTimestamp(value: unknown): value is string {
  if (!isBoundedString(value)) return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

export interface TraversalLimits {
  /** Deepest object or array nesting allowed; the root is depth 0. */
  maxDepth: number;
  /** Most objects and arrays visited before the scan gives up. */
  maxNodes: number;
}

const UNBOUNDED: TraversalLimits = {
  maxDepth: Number.POSITIVE_INFINITY,
  maxNodes: Number.POSITIVE_INFINITY,
};

/**
 * Rejects cycles, non-plain objects, and prototype-polluting keys at any
 * depth. An object reached along several paths without being its own
 * ancestor is accepted and scanned once per path, each visit counting
 * toward `maxNodes`. Returns false once `limits` is exceeded, so a bounded
 * scan cannot overflow the stack or run unbounded on a wide shared graph.
 */
export function hasSafeObjectKeys(
  value: unknown,
  limits: TraversalLimits = UNBOUNDED,
): boolean {
  const ancestors = new Set<object>();
  let visited = 0;
  const visitChildren = (node: object, depth: number): boolean => {
    if (Array.isArray(node))
      return node.every((child) => visit(child, depth + 1));
    if (!isPlainRecord(node)) return false;
    for (const [key, child] of Object.entries(node)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor")
        return false;
      if (!visit(child, depth + 1)) return false;
    }
    return true;
  };
  const visit = (node: unknown, depth: number): boolean => {
    if (typeof node !== "object" || node === null) return true;
    if (depth > limits.maxDepth || ++visited > limits.maxNodes) return false;
    if (ancestors.has(node)) return false;
    ancestors.add(node);
    try {
      return visitChildren(node, depth);
    } finally {
      ancestors.delete(node);
    }
  };
  return visit(value, 0);
}

// ── Evidence validation ─────────────────────────────────────────────────

const SOURCES = new Set<MetadataSource>([
  "pre-existing",
  "server-list",
  "provider-probe",
  "models.dev",
  "heuristic",
  "policy-default",
  "host-default",
  "unmatched-host",
]);
const STRENGTHS = new Set<ClaimStrength>([
  "authoritative",
  "configured",
  "reported",
  "inferred",
  "assumed",
  "unmatched",
]);

/** A string literal from `allowed`; non-strings are rejected before lookup. */
function isOneOf<T extends string>(
  allowed: ReadonlySet<T>,
  value: unknown,
): value is T {
  return typeof value === "string" && allowed.has(value as T);
}

const MODEL_TYPES = new Set<"llm" | "vlm" | "embedding">([
  "llm",
  "vlm",
  "embedding",
]);

function isClaimPair(source: MetadataSource, strength: ClaimStrength): boolean {
  switch (source) {
    case "pre-existing":
      return strength === "configured";
    case "server-list":
      return strength === "reported";
    case "provider-probe":
      return strength === "authoritative" || strength === "reported";
    case "models.dev":
    case "heuristic":
      return strength === "inferred";
    case "policy-default":
    case "host-default":
      return strength === "assumed";
    case "unmatched-host":
      return strength === "unmatched";
  }
}

type ScalarKind = "string" | "number" | "non-negative" | "model-type";

function isScalarEvidence(value: unknown, kind: ScalarKind): boolean {
  if (!isPlainRecord(value) || typeof value.state !== "string") return false;
  if (value.state === "unknown") return hasExactKeys(value, ["state"]);
  if (
    value.state !== "known" ||
    !hasExactKeys(value, ["state", "value", "source", "strength"]) ||
    !isOneOf(SOURCES, value.source) ||
    !isOneOf(STRENGTHS, value.strength) ||
    !isClaimPair(value.source, value.strength)
  )
    return false;
  if (kind === "number")
    return typeof value.value === "number" && Number.isFinite(value.value);
  if (kind === "non-negative")
    return (
      typeof value.value === "number" &&
      Number.isFinite(value.value) &&
      value.value >= 0
    );
  if (kind === "model-type") return isOneOf(MODEL_TYPES, value.value);
  return isBoundedString(value.value);
}

function isCapabilityEvidence(value: unknown): value is CapabilityEvidence {
  if (!isPlainRecord(value) || typeof value.state !== "string") return false;
  if (value.state === "unknown") return hasExactKeys(value, ["state"]);
  if (!hasExactKeys(value, ["state", "source", "strength"])) return false;
  if (value.state === "unsupported") {
    return (
      (value.source === "provider-probe" &&
        value.strength === "authoritative") ||
      (value.source === "pre-existing" && value.strength === "configured") ||
      (value.source === "models.dev" && value.strength === "inferred")
    );
  }
  return (
    value.state === "supported" &&
    isOneOf(SOURCES, value.source) &&
    isOneOf(STRENGTHS, value.strength) &&
    isClaimPair(value.source, value.strength)
  );
}

function isEvidenceGroup(value: unknown, keys: readonly string[]): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, keys) &&
    Object.values(value).every(isCapabilityEvidence)
  );
}

function isCostEvidence(value: unknown): value is CostEvidence {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["input", "output", "cacheRead", "cacheWrite"]) &&
    Object.values(value).every((price) =>
      isScalarEvidence(price, "non-negative"),
    )
  );
}

const MODEL_KEYS = [
  "id",
  "origin",
  "enabled",
  "identity",
  "name",
  "modelType",
  "context",
  "output",
  "family",
  "organizationOwner",
  "parameterSize",
  "quantization",
  "sizeBytes",
  "probeIdentity",
  "capabilities",
  "inputModalities",
  "cost",
] as const;

function isModelRecord(value: unknown): value is CatalogModelRecord {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, MODEL_KEYS) &&
    isBoundedString(value.id) &&
    (value.origin === "discovered" || value.origin === "pre-existing") &&
    typeof value.enabled === "boolean" &&
    isScalarEvidence(value.identity, "string") &&
    isScalarEvidence(value.name, "string") &&
    isScalarEvidence(value.modelType, "model-type") &&
    isScalarEvidence(value.context, "non-negative") &&
    isScalarEvidence(value.output, "non-negative") &&
    isScalarEvidence(value.family, "string") &&
    isScalarEvidence(value.organizationOwner, "string") &&
    isScalarEvidence(value.parameterSize, "string") &&
    isScalarEvidence(value.quantization, "string") &&
    isScalarEvidence(value.sizeBytes, "non-negative") &&
    isScalarEvidence(value.probeIdentity, "string") &&
    isEvidenceGroup(value.capabilities, [
      "toolCall",
      "reasoning",
      "temperature",
    ]) &&
    isEvidenceGroup(value.inputModalities, INPUT_MODALITIES) &&
    isCostEvidence(value.cost)
  );
}

const LIST_ATTEMPTS = new Set<ModelListAttempt>([
  "pending",
  "ready",
  "empty",
  "unreachable",
  "aborted",
  "http-error",
  "invalid-response",
  "error",
]);
const PROBE_ATTEMPTS = new Set<ProbeAttempt>([
  "pending",
  "not-requested",
  "unresolved",
  "complete",
  "empty",
  "aborted",
  "error",
]);
const HTTP_FAILURE_KINDS = new Set<ProviderFailureKind>([
  "unauthorized",
  "forbidden",
  "payment-required",
  "rate-limited",
  "not-found",
  "server-error",
  "http-error",
]);
const FAILURE_KINDS = new Set<ProviderFailureKind>([
  ...HTTP_FAILURE_KINDS,
  "unreachable",
  "timeout",
  "aborted",
  "invalid-response",
  "error",
]);

/**
 * `httpStatus` is present exactly for the HTTP kinds and matches the kind;
 * `retryAt` only accompanies an HTTP status.
 */
export function isProviderFailure(value: unknown): value is ProviderFailure {
  if (
    !isPlainRecord(value) ||
    !hasAllowedKeys(value, ["kind", "at"], ["httpStatus", "retryAt"]) ||
    !isOneOf(FAILURE_KINDS, value.kind) ||
    !isTimestamp(value.at) ||
    (value.retryAt !== undefined && !isTimestamp(value.retryAt))
  )
    return false;
  const status = value.httpStatus;
  if (status === undefined)
    return !HTTP_FAILURE_KINDS.has(value.kind) && value.retryAt === undefined;
  return (
    typeof status === "number" &&
    Number.isSafeInteger(status) &&
    status >= 100 &&
    status <= 599 &&
    (status < 200 || status >= 300) &&
    failureKindForStatus(status) === value.kind
  );
}

const CREDENTIAL_SOURCES = new Set<CredentialSource>([
  "connection",
  "settings",
  "headers",
  "none",
  "unresolved",
]);

function isEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

const PROVIDER_KEYS = [
  "id",
  "endpointOrigin",
  "configuredProbe",
  "resolvedProbe",
  "lastGoodAt",
  "failure",
  "modelListAttempt",
  "probeAttempt",
  "skippedModelIds",
  "models",
  "discovering",
  "lastAttemptAt",
  "nextRefreshAt",
  "credentialSource",
  "credentialEpoch",
  "resultEpoch",
] as const;

/**
 * An `unresolved` record has no credential, so it carries status fields
 * only: no result, no models, and no job.
 */
function isUnresolvedConsistent(value: Record<string, unknown>): boolean {
  return (
    value.credentialSource !== "unresolved" ||
    (value.lastGoodAt === null &&
      value.failure === null &&
      Array.isArray(value.models) &&
      value.models.length === 0 &&
      Array.isArray(value.skippedModelIds) &&
      value.skippedModelIds.length === 0 &&
      value.discovering === false &&
      value.lastAttemptAt === null &&
      value.nextRefreshAt === null)
  );
}

function isProviderRecord(value: unknown): value is CatalogProviderRecord {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, PROVIDER_KEYS) ||
    typeof value.discovering !== "boolean" ||
    !isNullableTimestamp(value.lastAttemptAt) ||
    !isNullableTimestamp(value.nextRefreshAt) ||
    !isOneOf(CREDENTIAL_SOURCES, value.credentialSource) ||
    !isEpoch(value.credentialEpoch) ||
    !(
      value.resultEpoch === null ||
      (isEpoch(value.resultEpoch) && value.resultEpoch <= value.credentialEpoch)
    ) ||
    !isBoundedString(value.id) ||
    !isScalarEvidence(value.endpointOrigin, "string") ||
    !isScalarEvidence(value.configuredProbe, "string") ||
    !isScalarEvidence(value.resolvedProbe, "string") ||
    !(value.lastGoodAt === null || isTimestamp(value.lastGoodAt)) ||
    !(value.failure === null || isProviderFailure(value.failure)) ||
    !isOneOf(LIST_ATTEMPTS, value.modelListAttempt) ||
    !isOneOf(PROBE_ATTEMPTS, value.probeAttempt) ||
    !Array.isArray(value.skippedModelIds) ||
    value.skippedModelIds.length > MAX_MODELS_PER_PROVIDER ||
    !value.skippedModelIds.every(isBoundedString) ||
    !Array.isArray(value.models) ||
    value.models.length > MAX_MODELS_PER_PROVIDER ||
    !value.models.every(isModelRecord)
  )
    return false;
  const modelIds = new Set(value.models.map((model) => model.id));
  const skippedIds = new Set(value.skippedModelIds);
  return (
    modelIds.size === value.models.length &&
    skippedIds.size === value.skippedModelIds.length &&
    isUnresolvedConsistent(value)
  );
}

const STATUSES = new Set<CatalogStatus>(["pending", "running", "complete"]);
const BUILT_IN_STATES = new Set<BuiltInState>(["managed", "foreign"]);

function isBuiltIn(value: unknown): value is CatalogPayload["builtIn"] {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["actualyze"]) &&
    isOneOf(BUILT_IN_STATES, value.actualyze)
  );
}

/**
 * Bounds for the final safety scan. A valid payload nests objects six levels
 * below the root (payload, providers, provider, models, model, evidence
 * group, evidence), and the structural checks have already capped every
 * array before the scan runs.
 */
const PAYLOAD_TRAVERSAL_LIMITS: TraversalLimits = {
  maxDepth: 6,
  maxNodes: 10_000_000,
};

/**
 * Strictly validate an RPC `catalog` payload. Returns the value unchanged
 * when valid, otherwise `undefined`; it never throws. Unknown keys, keys set
 * to `undefined`, wrong evidence pairs, duplicate IDs, cycles, and
 * prototype-polluting keys are all rejected.
 */
export function validateCatalogPayload(
  value: unknown,
): CatalogPayload | undefined {
  try {
    return isCatalogPayload(value) &&
      hasSafeObjectKeys(value, PAYLOAD_TRAVERSAL_LIMITS)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Exact structure, array caps, and cross-field rules, at fixed depth. */
function isCatalogPayload(value: unknown): value is CatalogPayload {
  if (!isPlainRecord(value)) return false;
  if (
    !hasAllowedKeys(
      value,
      [
        "schemaVersion",
        "packageVersion",
        "instanceID",
        "generatedAt",
        "status",
        "builtIn",
        "providers",
      ],
      ["startedAt", "completedAt"],
    ) ||
    value.schemaVersion !== CATALOG_SCHEMA_VERSION ||
    !isBoundedString(value.packageVersion) ||
    !isBoundedString(value.instanceID) ||
    !isTimestamp(value.generatedAt) ||
    !isBuiltIn(value.builtIn) ||
    !isOneOf(STATUSES, value.status) ||
    (value.startedAt !== undefined && !isTimestamp(value.startedAt)) ||
    (value.completedAt !== undefined && !isTimestamp(value.completedAt))
  )
    return false;
  const { startedAt, completedAt } = value;
  switch (value.status) {
    case "pending":
      if (completedAt !== undefined) return false;
      break;
    case "running":
      if (startedAt === undefined) return false;
      break;
    case "complete":
      if (
        typeof completedAt !== "string" ||
        (typeof startedAt === "string" &&
          Date.parse(completedAt) < Date.parse(startedAt))
      )
        return false;
      break;
  }
  if (
    !Array.isArray(value.providers) ||
    value.providers.length > MAX_PROVIDERS ||
    !value.providers.every(isProviderRecord)
  )
    return false;
  const providerIds = new Set(value.providers.map((provider) => provider.id));
  return providerIds.size === value.providers.length;
}
