import {
  INPUT_MODALITIES,
  knownScalar,
  sanitizeEndpointOrigin,
  unknownCapability,
  unknownScalar,
  type CapabilityEvidence,
  type CatalogModelRecord,
  type CatalogPayload,
  type CatalogProviderRecord,
  type CostEvidence,
  type InputModality,
  type InputModalityEvidence,
  type ModelCapabilityEvidence,
  type ModelListAttempt,
  type ProbeAttempt,
  type ProviderFailure,
  type ScalarEvidence,
} from "./catalog-evidence";
import {
  NEVER_PROBED_PROVIDER_IDS,
  OPENAI_COMPATIBLE_PACKAGES,
} from "./constants";

/**
 * One entry of an OpenCode `Model.Info.cost` array. The entry without a
 * `tier` is the base price; a `context` tier applies once the request's
 * context exceeds `size` tokens.
 */
export interface HostModelCost {
  readonly tier?: { readonly type: string; readonly size: number };
  readonly input: number;
  readonly output: number;
  readonly cache: { readonly read: number; readonly write: number };
}

/** The fields of OpenCode's `ModelInfo` that the browser reconciles. */
export interface HostModel {
  readonly id: string;
  readonly providerID: string;
  readonly name: string;
  readonly family?: string;
  readonly enabled: boolean;
  readonly capabilities: {
    readonly tools: boolean;
    readonly input: readonly string[];
    readonly output: readonly string[];
    /**
     * Whether the model accepts a sampling temperature, from OpenCode 2.0.31;
     * the pinned 2.0.26 types lack it, so it is read as `unknown` and checked.
     */
    readonly temperature?: unknown;
  };
  readonly variants: readonly unknown[];
  readonly cost: readonly HostModelCost[];
  readonly limit: { readonly context: number; readonly output: number };
}

/** The fields of OpenCode's `ProviderInfo` that the browser reads. */
export interface HostProvider {
  readonly id: string;
  readonly name: string;
  readonly package: string;
  readonly canonical?: string;
  readonly settings?: Readonly<Record<string, unknown>>;
}

/** Host rows for one location. */
export interface HostCatalog {
  readonly providers: readonly HostProvider[];
  readonly models: readonly HostModel[];
}

export type ModelScalarField =
  | "identity"
  | "name"
  | "type"
  | "context"
  | "output"
  | "family"
  | "parameterSize"
  | "quantization"
  | "sizeBytes"
  | "probeIdentity";

/** A single model row prepared for display. */
export interface ModelRow {
  id: string;
  name: string;
  /** False for models the host hides from the picker (embedding models). */
  enabled: boolean;
  context?: number;
  output?: number;
  type?: "llm" | "vlm" | "embedding";
  flags: string[];
  family?: string;
  parameterSize?: string;
  quantization?: string;
  sizeBytes?: number;
  probeIdentity?: string;
  origin?: "discovered" | "pre-existing";
  capabilities?: ModelCapabilityEvidence;
  inputModalities?: InputModalityEvidence;
  /** Base prices; for context-priced models, the tier below every threshold. */
  cost?: CostEvidence;
  /** Context-priced tiers above the base price, by ascending threshold. */
  priceTiers?: readonly PriceTier[];
  /** The host's explicit `capabilities.temperature`, when it states one. */
  hostTemperature?: boolean;
  provenance?: Partial<
    Record<ModelScalarField, ScalarEvidence<string | number>>
  >;
  warnings?: string[];
}

/** Prices, USD per 1M tokens, that apply above a context size. */
export interface PriceTier {
  /** Context size in tokens above which these prices apply. */
  readonly above: number;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/**
 * How sure a displayed value is: `confirmed` when reported, configured, or
 * stated by the host; `assumed` when it is an OpenCode or policy default;
 * `inferred` when it comes from models.dev or a heuristic; `unsupported`
 * when a source says the model lacks it; `not-reported` when no source
 * states anything.
 */
export type Certainty =
  | "confirmed"
  | "assumed"
  | "inferred"
  | "unsupported"
  | "not-reported";

export type CapabilityName =
  | "tools"
  | "reasoning"
  | "temperature"
  | InputModality;

export interface ModelCertainty {
  readonly capabilities: Readonly<Record<CapabilityName, Certainty>>;
  /** `assumed` is OpenCode's 200 000 token default, shown as "~200K". */
  readonly context: Exclude<Certainty, "unsupported">;
  /** `not-reported` means OpenCode fits output to the remaining context. */
  readonly output: Exclude<Certainty, "unsupported">;
}

export type CoreMetadataName =
  | "type"
  | "context"
  | "output"
  | "image"
  | "tools"
  | "reasoning"
  | "temperature";

export interface CoreMetadataCoverage {
  known: number;
  total: number;
  missing: CoreMetadataName[];
  complete: boolean;
}

/** A provider grouping prepared for display. */
export interface ProviderGroup {
  id: string;
  provider: string;
  /** Sanitized endpoint origin; never contains credentials, paths, or queries. */
  endpoint?: string;
  /** ISO time of the served inventory; null before the first success. */
  lastGoodAt?: string | null;
  /** The latest discovery attempt's failure, or null when it succeeded. */
  failure?: ProviderFailure | null;
  modelListAttempt?: ModelListAttempt;
  probeAttempt?: ProbeAttempt;
  configuredProbe?: string;
  resolvedProbe?: string;
  /** The server's discovery evidence covers this provider. */
  hasEvidence: boolean;
  warnings?: string[];
  models: ModelRow[];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasDiscoverySettings(provider: HostProvider): boolean {
  return (
    !NEVER_PROBED_PROVIDER_IDS.has(provider.id) &&
    readString(provider.settings?.baseURL) !== undefined
  );
}

/**
 * Host-side approximation of the server's discovery targets: a base URL plus
 * either an explicit probe setting or a non-aliased openai-compatible package.
 */
function looksDiscoverable(provider: HostProvider): boolean {
  if (!hasDiscoverySettings(provider)) return false;
  if (readString(provider.settings?.probe)) return true;
  return (
    provider.canonical === undefined &&
    OPENAI_COMPATIBLE_PACKAGES.has(provider.package)
  );
}

/**
 * Whether the server must have targeted this provider. Auto-eligibility also
 * depends on which providers existed before the config providers loaded,
 * which the TUI cannot see, so only an explicit `settings.probe` counts.
 */
function expectsDiscovery(provider: HostProvider | undefined): boolean {
  return (
    provider !== undefined &&
    hasDiscoverySettings(provider) &&
    readString(provider.settings?.probe) !== undefined
  );
}

/** Host limits are integers OpenCode always fills; anything else is absent. */
function readHostLimit(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function hostModelType(model: HostModel | undefined): ModelRow["type"] {
  if (!model) return undefined;
  if (model.capabilities.input.includes("image")) return "vlm";
  if (model.capabilities.output.includes("text")) return "llm";
  return undefined;
}

function normalizeString(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function scalarAgrees<T extends string | number>(left: T, right: T): boolean {
  return typeof left === "string" && typeof right === "string"
    ? normalizeString(left) === normalizeString(right)
    : Object.is(left, right);
}

interface Reconciled<T extends string | number> {
  value: T | undefined;
  evidence: ScalarEvidence<T> | undefined;
}

/**
 * The host value wins when present; agreeing evidence keeps its provenance,
 * and a disagreement is reported. Without a host value, known evidence is
 * used as is.
 */
function reconcileScalar<T extends string | number>(
  field: ModelScalarField,
  hostValue: T | undefined,
  evidence: ScalarEvidence<T> | undefined,
  warnings: string[],
): Reconciled<T> {
  if (hostValue !== undefined) {
    if (evidence?.state === "known") {
      if (scalarAgrees(hostValue, evidence.value))
        return { value: hostValue, evidence };
      warnings.push(`provenance conflict for ${field}; using host value`);
    }
    return {
      value: hostValue,
      evidence: knownScalar(hostValue, "unmatched-host", "unmatched"),
    };
  }
  if (evidence?.state === "known") return { value: evidence.value, evidence };
  return { value: undefined, evidence: undefined };
}

/**
 * The host cannot state a model type, so only an authoritative probe value
 * overrides the type inferred from host input modalities.
 */
function reconcileModelType(
  hostValue: ModelRow["type"],
  evidence: CatalogModelRecord["modelType"] | undefined,
  warnings: string[],
): Reconciled<"llm" | "vlm" | "embedding"> {
  if (
    evidence?.state === "known" &&
    evidence.source === "provider-probe" &&
    evidence.strength === "authoritative"
  ) {
    if (hostValue !== undefined && !scalarAgrees(hostValue, evidence.value))
      warnings.push("provenance conflict for type; using provider probe value");
    return { value: evidence.value, evidence };
  }
  return reconcileScalar("type", hostValue, evidence, warnings);
}

function hostCapability(value: boolean | undefined): CapabilityEvidence {
  return value === true
    ? { state: "supported", source: "unmatched-host", strength: "unmatched" }
    : unknownCapability();
}

/**
 * Host `true` is a claim of support; host `false` only withholds one, since
 * evidence cannot attribute an unsupported state to the host. `undefined`
 * means the host has no value for this capability.
 */
function reconcileCapability(
  field: string,
  hostValue: boolean | undefined,
  evidence: CapabilityEvidence | undefined,
  warnings: string[],
): CapabilityEvidence {
  if (hostValue === true) {
    if (evidence?.state === "supported") return evidence;
    if (evidence?.state === "unsupported")
      warnings.push(`provenance conflict for ${field}; using host support`);
    return hostCapability(true);
  }
  if (evidence?.state === "unsupported") return evidence;
  if (hostValue === false) {
    if (evidence?.state === "supported")
      warnings.push(`provenance conflict for ${field}; using host value`);
    return unknownCapability();
  }
  if (evidence?.state === "supported") return evidence;
  return unknownCapability();
}

function readPrice(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** The context threshold of a context-priced entry, else undefined. */
function contextTierSize(cost: HostModelCost): number | undefined {
  const tier = cost.tier;
  return tier?.type === "context" &&
    Number.isSafeInteger(tier.size) &&
    tier.size >= 0
    ? tier.size
    : undefined;
}

/**
 * The entry OpenCode prices a request with below every context threshold:
 * the one without a tier, else the first, as OpenCode's own model list does.
 */
function baseCost(model: HostModel | undefined): HostModelCost | undefined {
  return model?.cost.find((cost) => cost.tier === undefined) ?? model?.cost[0];
}

function hostCost(model: HostModel | undefined): CostEvidence {
  const base = baseCost(model);
  const price = (value: unknown): ScalarEvidence<number> => {
    const known = readPrice(value);
    return known === undefined
      ? unknownScalar()
      : knownScalar(known, "unmatched-host", "unmatched");
  };
  return {
    input: price(base?.input),
    output: price(base?.output),
    cacheRead: price(base?.cache.read),
    cacheWrite: price(base?.cache.write),
  };
}

/** Every context-priced entry other than the base, by ascending threshold. */
function hostPriceTiers(model: HostModel | undefined): PriceTier[] {
  const base = baseCost(model);
  const tiers: PriceTier[] = [];
  for (const cost of model?.cost ?? []) {
    if (cost === base) continue;
    const above = contextTierSize(cost);
    if (above === undefined) continue;
    tiers.push({
      above,
      input: readPrice(cost.input),
      output: readPrice(cost.output),
      cacheRead: readPrice(cost.cache.read),
      cacheWrite: readPrice(cost.cache.write),
    });
  }
  return tiers.sort((a, b) => a.above - b.above);
}

function readHostTemperature(
  model: HostModel | undefined,
): boolean | undefined {
  const value = model?.capabilities.temperature;
  return typeof value === "boolean" ? value : undefined;
}

function capabilityCertainty(
  evidence: CapabilityEvidence | undefined,
): Certainty {
  if (!evidence || evidence.state === "unknown") return "not-reported";
  if (evidence.state === "unsupported") return "unsupported";
  switch (evidence.strength) {
    case "assumed":
      return "assumed";
    case "inferred":
      return "inferred";
    case "authoritative":
    case "configured":
    case "reported":
    case "unmatched":
      return "confirmed";
  }
}

function limitCertainty(
  value: number | undefined,
  evidence: ScalarEvidence<string | number> | undefined,
): Exclude<Certainty, "unsupported"> {
  if (value === undefined) return "not-reported";
  if (evidence?.state !== "known") return "confirmed";
  if (evidence.strength === "assumed") return "assumed";
  if (evidence.strength === "inferred") return "inferred";
  return "confirmed";
}

/**
 * How sure each capability and limit of a row is. Host `false` for
 * temperature is the one host denial evidence cannot carry, so it is read
 * from `hostTemperature` when no source states support.
 */
export function modelCertainty(model: ModelRow): ModelCertainty {
  const temperature = capabilityCertainty(model.capabilities?.temperature);
  const capabilities: Record<CapabilityName, Certainty> = {
    tools: capabilityCertainty(model.capabilities?.toolCall),
    reasoning: capabilityCertainty(model.capabilities?.reasoning),
    temperature:
      temperature === "not-reported" && model.hostTemperature === false
        ? "unsupported"
        : temperature,
    text: "not-reported",
    image: "not-reported",
    pdf: "not-reported",
    audio: "not-reported",
    video: "not-reported",
  };
  for (const modality of INPUT_MODALITIES)
    capabilities[modality] = capabilityCertainty(
      model.inputModalities?.[modality],
    );
  return {
    capabilities,
    context: limitCertainty(model.context, model.provenance?.context),
    output: limitCertainty(model.output, model.provenance?.output),
  };
}

const MODALITY_LABELS: Record<InputModality, string> = {
  text: "text input",
  image: "image input",
  pdf: "pdf input",
  audio: "audio input",
  video: "video input",
};

const CHAT_CORE_FIELDS: readonly CoreMetadataName[] = [
  "type",
  "context",
  "output",
  "image",
  "tools",
  "reasoning",
  "temperature",
];
const BASE_CORE_FIELDS: readonly CoreMetadataName[] = ["type", "context"];

/**
 * A limit counts as known only when it is observed: a value that is OpenCode's
 * `Model.Info` default is still missing metadata.
 */
function limitKnown(certainty: Certainty): boolean {
  return certainty !== "not-reported" && certainty !== "assumed";
}

/** Applicability-aware core metadata coverage for one model row. */
export function coreMetadataCoverage(model: ModelRow): CoreMetadataCoverage {
  const applicable =
    model.type === "llm" || model.type === "vlm"
      ? CHAT_CORE_FIELDS
      : BASE_CORE_FIELDS;
  const certainty = modelCertainty(model);
  const stated = (name: CapabilityName): boolean =>
    certainty.capabilities[name] !== "not-reported";
  const known = (field: CoreMetadataName): boolean => {
    switch (field) {
      case "type":
        return model.type !== undefined;
      case "context":
        return limitKnown(certainty.context);
      case "output":
        return limitKnown(certainty.output);
      case "image":
      case "tools":
      case "reasoning":
      case "temperature":
        return stated(field);
    }
  };
  const missing = applicable.filter((field) => !known(field));
  return {
    known: applicable.length - missing.length,
    total: applicable.length,
    missing: [...missing],
    complete: missing.length === 0,
  };
}

/**
 * Reconcile one model from the host list, the server's evidence, or both.
 * A model only in evidence is one the host does not list, such as a disabled
 * embedding model.
 */
export function toModelRow(
  id: string,
  host: HostModel | undefined,
  evidence?: CatalogModelRecord,
): ModelRow {
  const warnings: string[] = [];
  const provenance: NonNullable<ModelRow["provenance"]> = {};
  const assign = <T extends string | number>(
    field: ModelScalarField,
    result: Reconciled<T>,
  ): T | undefined => {
    if (result.evidence)
      provenance[field] = result.evidence as ScalarEvidence<string | number>;
    return result.value;
  };

  assign(
    "identity",
    reconcileScalar(
      "identity",
      host ? id : undefined,
      evidence?.identity,
      warnings,
    ),
  );
  const name =
    assign(
      "name",
      reconcileScalar("name", readString(host?.name), evidence?.name, warnings),
    ) ?? id;
  const type = assign(
    "type",
    reconcileModelType(hostModelType(host), evidence?.modelType, warnings),
  );
  const context = assign(
    "context",
    reconcileScalar(
      "context",
      host ? readHostLimit(host.limit.context) : undefined,
      evidence?.context,
      warnings,
    ),
  );
  const output = assign(
    "output",
    reconcileScalar(
      "output",
      host ? readHostLimit(host.limit.output) : undefined,
      evidence?.output,
      warnings,
    ),
  );
  const family = assign(
    "family",
    reconcileScalar(
      "family",
      readString(host?.family),
      evidence?.family,
      warnings,
    ),
  );
  const evidenceOnly = <T extends string | number>(
    field: ModelScalarField,
    value: ScalarEvidence<T> | undefined,
  ): T | undefined =>
    assign(field, reconcileScalar(field, undefined, value, warnings));
  const parameterSize = evidenceOnly("parameterSize", evidence?.parameterSize);
  const quantization = evidenceOnly("quantization", evidence?.quantization);
  const sizeBytes = evidenceOnly("sizeBytes", evidence?.sizeBytes);
  const probeIdentity = evidenceOnly("probeIdentity", evidence?.probeIdentity);
  const hostTemperature = readHostTemperature(host);

  const capabilities: ModelCapabilityEvidence = {
    toolCall: reconcileCapability(
      "toolCall",
      host?.capabilities.tools,
      evidence?.capabilities.toolCall,
      warnings,
    ),
    reasoning: reconcileCapability(
      "reasoning",
      host && host.variants.length > 0 ? true : undefined,
      evidence?.capabilities.reasoning,
      warnings,
    ),
    temperature: reconcileCapability(
      "temperature",
      hostTemperature,
      evidence?.capabilities.temperature,
      warnings,
    ),
  };
  const inputModalities = Object.fromEntries(
    INPUT_MODALITIES.map((modality) => [
      modality,
      reconcileCapability(
        MODALITY_LABELS[modality],
        host?.capabilities.input.includes(modality),
        evidence?.inputModalities[modality],
        warnings,
      ),
    ]),
  ) as InputModalityEvidence;

  const flags: string[] = [];
  if (inputModalities.image.state === "supported") flags.push("Image");
  if (capabilities.toolCall.state === "supported") flags.push("Tools");
  if (capabilities.reasoning.state === "supported") flags.push("Reasoning");
  if (capabilities.temperature.state === "supported") flags.push("Temp");

  // Scout never prices a declared model, so its prices come from the host.
  // A discovered model's host prices are scout's own single entry.
  const discovered = evidence?.origin === "discovered";
  const priceTiers = discovered ? [] : hostPriceTiers(host);

  return {
    id,
    name,
    enabled: host ? host.enabled : (evidence?.enabled ?? true),
    context,
    output,
    type,
    flags,
    family,
    parameterSize,
    quantization,
    sizeBytes,
    probeIdentity,
    origin: evidence?.origin,
    capabilities,
    inputModalities,
    cost: discovered ? evidence.cost : hostCost(host),
    ...(priceTiers.length > 0 ? { priceTiers } : {}),
    ...(hostTemperature === undefined ? {} : { hostTemperature }),
    provenance,
    warnings,
  };
}

function evidenceString(
  value: ScalarEvidence<string> | undefined,
): string | undefined {
  return value?.state === "known" ? value.value : undefined;
}

function providerRows(
  hostModels: readonly HostModel[],
  evidence: CatalogProviderRecord | undefined,
  catalogAvailable: boolean,
): ModelRow[] {
  const evidenceById = new Map(
    evidence?.models.map((model) => [model.id, model]),
  );
  const rows: ModelRow[] = [];
  const seen = new Set<string>();
  for (const host of hostModels) {
    if (!host.id || seen.has(host.id)) continue;
    seen.add(host.id);
    const modelEvidence = evidenceById.get(host.id);
    const row = toModelRow(host.id, host, modelEvidence);
    if (catalogAvailable && evidence && !modelEvidence)
      row.warnings?.push("discovery evidence has no record of this model");
    rows.push(row);
  }
  for (const modelEvidence of evidence?.models ?? []) {
    if (seen.has(modelEvidence.id)) continue;
    const row = toModelRow(modelEvidence.id, undefined, modelEvidence);
    if (modelEvidence.enabled)
      row.warnings?.push("not in the host model list yet");
    rows.push(row);
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

/**
 * The server has not resolved its targets yet, so the absence of a provider
 * from the payload says nothing about it.
 */
export function isDiscoveryStarting(catalog: CatalogPayload): boolean {
  return catalog.status === "pending" && catalog.providers.length === 0;
}

/**
 * Group host rows by provider and reconcile them with the server's
 * discovery evidence. Every provider in the evidence is shown; host providers
 * that look like discovery targets are shown too, so a missing or partial
 * catalog still lists what the host serves.
 */
export function collectModelGroups(
  host: HostCatalog,
  catalog?: CatalogPayload,
): ProviderGroup[] {
  const starting = catalog !== undefined && isDiscoveryStarting(catalog);
  const evidenceById = new Map(
    catalog?.providers.map((provider) => [provider.id, provider]),
  );
  const hostModels = new Map<string, HostModel[]>();
  for (const model of host.models) {
    const list = hostModels.get(model.providerID) ?? [];
    list.push(model);
    hostModels.set(model.providerID, list);
  }

  const groups: ProviderGroup[] = [];
  const seen = new Set<string>();
  const add = (
    id: string,
    hostProvider: HostProvider | undefined,
    evidence: CatalogProviderRecord | undefined,
  ): void => {
    seen.add(id);
    const warnings: string[] = [];
    if (!catalog)
      warnings.push("evidence unavailable; showing host state only");
    else if (!starting && !evidence && expectsDiscovery(hostProvider))
      warnings.push("not in the server's discovery catalog");
    groups.push({
      id,
      provider: readString(hostProvider?.name) ?? id,
      endpoint:
        sanitizeEndpointOrigin(hostProvider?.settings?.baseURL) ??
        evidenceString(evidence?.endpointOrigin),
      lastGoodAt: evidence?.lastGoodAt,
      failure: evidence?.failure,
      modelListAttempt: evidence?.modelListAttempt,
      probeAttempt: evidence?.probeAttempt,
      configuredProbe: evidenceString(evidence?.configuredProbe),
      resolvedProbe: evidenceString(evidence?.resolvedProbe),
      hasEvidence: evidence !== undefined,
      warnings,
      models: providerRows(
        hostModels.get(id) ?? [],
        evidence,
        catalog !== undefined,
      ),
    });
  };

  for (const provider of host.providers) {
    if (seen.has(provider.id)) continue;
    const evidence = evidenceById.get(provider.id);
    if (!evidence && !looksDiscoverable(provider)) continue;
    add(provider.id, provider, evidence);
  }
  for (const evidence of catalog?.providers ?? []) {
    if (!seen.has(evidence.id)) add(evidence.id, undefined, evidence);
  }

  groups.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  );
  return groups;
}
