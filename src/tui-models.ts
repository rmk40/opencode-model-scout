import {
  createProviderFingerprint,
  knownScalar,
  sanitizeEndpointOrigin,
  unknownCapability,
  type CapabilityEvidence,
  type CatalogModelRecord,
  type CatalogProviderRecord,
  type ExactCatalogSnapshot,
  type ModelCapabilityEvidence,
  type ModelListAttempt,
  type ProbeAttempt,
  type ProviderAttemptStatus,
  type ScalarEvidence,
} from "./catalog-snapshot";

/** Minimal structural view of the opencode SDK provider/model state. */
export interface SdkModelView {
  id: string;
  name?: string;
  family?: string;
  api?: { npm?: string; url?: string };
  limit?: { context?: number; output?: number };
  capabilities?: {
    temperature?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    toolcall?: boolean;
    input?: { image?: boolean };
    output?: { text?: boolean };
  };
  [key: string]: unknown;
}

export interface SdkProviderView {
  id: string;
  name?: string;
  source?: string;
  options?: Record<string, unknown>;
  models?: Record<string, SdkModelView>;
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

/** A single host-authoritative model row prepared for display. */
export interface ModelRow {
  id: string;
  name: string;
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
  provenance?: Partial<
    Record<ModelScalarField, ScalarEvidence<string | number>>
  >;
  warnings?: string[];
}

export type CoreMetadataName =
  | "type"
  | "context"
  | "output"
  | "vision"
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
  status?: ProviderAttemptStatus;
  modelListAttempt?: ModelListAttempt;
  probeAttempt?: ProbeAttempt;
  configuredProbe?: string;
  resolvedProbe?: string;
  exactProvenance: boolean;
  warnings?: string[];
  models: ModelRow[];
}

const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

/** Recognize providers the host exposes as OpenAI-compatible. */
function looksDiscoverable(provider: SdkProviderView): boolean {
  const baseURL = provider.options?.baseURL;
  if (typeof baseURL !== "string" || baseURL.length === 0) return false;
  if (baseURL.includes("/v1")) return true;
  return Object.values(provider.models ?? {}).some(
    (model) => model.api?.npm === OPENAI_COMPATIBLE_NPM,
  );
}

export function hostProviderFingerprint(
  providers: readonly SdkProviderView[],
): string {
  return createProviderFingerprint(
    providers
      .filter(
        (provider) =>
          typeof provider.options?.baseURL === "string" &&
          provider.options.baseURL.length > 0,
      )
      .map((provider) => ({
        id: provider.id,
        baseURL: provider.options?.baseURL,
        probe: provider.options?.probe,
      })),
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Host context/output limits mirror the server invariant that unknown limits
 * are omitted rather than set to zero: opencode's provider state normalizes
 * missing limits to 0, so non-positive, fractional, or unsafe values are
 * treated as absent instead of displayed, counted as known core metadata, or
 * allowed to override exact snapshot evidence as a false host conflict.
 */
function readHostLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

interface HostModelType {
  value: ModelRow["type"];
  explicit: boolean;
}

function hostModelType(model: SdkModelView): HostModelType {
  const caps = model.capabilities;
  const explicit = readString(model.type);
  if (explicit === "llm" || explicit === "vlm" || explicit === "embedding")
    return { value: explicit, explicit: true };
  if (caps?.attachment === true || caps?.input?.image === true)
    return { value: "vlm", explicit: false };
  if (caps?.output?.text) return { value: "llm", explicit: false };
  return { value: undefined, explicit: false };
}

function reconcileModelType(
  host: HostModelType,
  snapshot: CatalogModelRecord["modelType"] | undefined,
  warnings: string[],
): {
  value: ModelRow["type"];
  evidence: CatalogModelRecord["modelType"] | undefined;
} {
  if (host.explicit)
    return reconcileScalar("type", host.value, snapshot, warnings, true);
  if (
    snapshot?.state === "known" &&
    snapshot.source === "provider-probe" &&
    snapshot.strength === "authoritative"
  ) {
    if (host.value !== undefined && !scalarAgrees(host.value, snapshot.value))
      warnings.push("provenance conflict for type; using provider probe value");
    return { value: snapshot.value, evidence: snapshot };
  }
  return reconcileScalar("type", host.value, snapshot, warnings, true);
}

function normalizeString(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function scalarAgrees<T extends string | number>(left: T, right: T): boolean {
  return typeof left === "string" && typeof right === "string"
    ? normalizeString(left) === normalizeString(right)
    : Object.is(left, right);
}

function reconcileScalar<T extends string | number>(
  field: ModelScalarField,
  hostValue: T | undefined,
  snapshot: ScalarEvidence<T> | undefined,
  warnings: string[],
  snapshotOnly = false,
): { value: T | undefined; evidence: ScalarEvidence<T> | undefined } {
  if (hostValue !== undefined) {
    if (snapshot?.state === "known") {
      if (scalarAgrees(hostValue, snapshot.value))
        return { value: hostValue, evidence: snapshot };
      warnings.push(`provenance conflict for ${field}; using host value`);
    }
    return {
      value: hostValue,
      evidence: knownScalar(hostValue, "unmatched-host", "unmatched"),
    };
  }
  if (snapshotOnly && snapshot?.state === "known")
    return { value: snapshot.value, evidence: snapshot };
  return { value: undefined, evidence: undefined };
}

function hostCapability(value: boolean | undefined): CapabilityEvidence {
  return value === true
    ? {
        state: "supported",
        source: "unmatched-host",
        strength: "unmatched",
      }
    : unknownCapability();
}

function reconcileCapability(
  field: keyof ModelCapabilityEvidence,
  hostValue: boolean | undefined,
  snapshot: CapabilityEvidence | undefined,
  warnings: string[],
): CapabilityEvidence {
  if (hostValue === true) {
    if (snapshot?.state === "supported") return snapshot;
    if (snapshot?.state === "unsupported")
      warnings.push(`provenance conflict for ${field}; using host support`);
    return hostCapability(true);
  }
  if (snapshot?.state === "unsupported") return snapshot;
  if (hostValue === false) {
    if (snapshot?.state === "supported")
      warnings.push(`provenance conflict for ${field}; using host value`);
    return unknownCapability();
  }
  // The host is silent, not conflicting: retain positive exact evidence so
  // snapshot-only providers (and hosts that omit capability booleans) keep
  // their supported states, flags, and core coverage.
  if (snapshot?.state === "supported") return snapshot;
  return unknownCapability();
}

function snapshotModel(
  provider: CatalogProviderRecord | undefined,
  modelId: string,
): CatalogModelRecord | undefined {
  return provider?.models.find((model) => model.id === modelId);
}

function snapshotString(
  value: ScalarEvidence<string> | undefined,
): string | undefined {
  return value?.state === "known" ? value.value : undefined;
}

const CHAT_CORE_FIELDS: readonly CoreMetadataName[] = [
  "type",
  "context",
  "output",
  "vision",
  "tools",
  "reasoning",
  "temperature",
];
const BASE_CORE_FIELDS: readonly CoreMetadataName[] = ["type", "context"];

/** Applicability-aware core metadata coverage for one model row. */
export function coreMetadataCoverage(model: ModelRow): CoreMetadataCoverage {
  const applicable =
    model.type === "llm" || model.type === "vlm"
      ? CHAT_CORE_FIELDS
      : BASE_CORE_FIELDS;
  const known = (field: CoreMetadataName): boolean => {
    switch (field) {
      case "type":
        return model.type !== undefined;
      case "context":
        return model.context !== undefined;
      case "output":
        return model.output !== undefined;
      case "vision":
        return Boolean(
          model.capabilities && model.capabilities.vision.state !== "unknown",
        );
      case "tools":
        return Boolean(
          model.capabilities && model.capabilities.toolCall.state !== "unknown",
        );
      case "reasoning":
        return Boolean(
          model.capabilities &&
          model.capabilities.reasoning.state !== "unknown",
        );
      case "temperature":
        return Boolean(
          model.capabilities &&
          model.capabilities.temperature.state !== "unknown",
        );
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

/** Map one SDK model and optional exact evidence into a display row. */
export function toModelRow(
  id: string,
  model: SdkModelView,
  snapshot?: CatalogModelRecord,
): ModelRow {
  const warnings: string[] = [];
  const provenance: ModelRow["provenance"] = {};
  const assign = <T extends string | number>(
    field: ModelScalarField,
    result: { value: T | undefined; evidence: ScalarEvidence<T> | undefined },
  ): T | undefined => {
    if (result.evidence)
      provenance[field] = result.evidence as ScalarEvidence<string | number>;
    return result.value;
  };

  assign(
    "identity",
    reconcileScalar("identity", id, snapshot?.identity, warnings),
  );
  const name =
    assign(
      "name",
      reconcileScalar(
        "name",
        readString(model.name) ?? id,
        snapshot?.name,
        warnings,
      ),
    ) ?? id;
  const type = assign(
    "type",
    reconcileModelType(hostModelType(model), snapshot?.modelType, warnings),
  );
  // Limits are snapshot-capable: when the host omits a limit (normalized to
  // 0 and read back as absent), exact snapshot evidence still surfaces.
  const context = assign(
    "context",
    reconcileScalar(
      "context",
      readHostLimit(model.limit?.context),
      snapshot?.context,
      warnings,
      true,
    ),
  );
  const output = assign(
    "output",
    reconcileScalar(
      "output",
      readHostLimit(model.limit?.output),
      snapshot?.output,
      warnings,
      true,
    ),
  );
  const family = assign(
    "family",
    reconcileScalar(
      "family",
      readString(model.family),
      snapshot?.family,
      warnings,
      true,
    ),
  );

  // These diagnostics are deliberately snapshot-only when the host does not
  // expose them. Host values still win if a future host adds supported fields.
  const parameterSize = assign(
    "parameterSize",
    reconcileScalar(
      "parameterSize",
      readString(model.parameterSize),
      snapshot?.parameterSize,
      warnings,
      true,
    ),
  );
  const quantization = assign(
    "quantization",
    reconcileScalar(
      "quantization",
      readString(model.quantization),
      snapshot?.quantization,
      warnings,
      true,
    ),
  );
  const sizeBytes = assign(
    "sizeBytes",
    reconcileScalar(
      "sizeBytes",
      readFiniteNumber(model.sizeBytes),
      snapshot?.sizeBytes,
      warnings,
      true,
    ),
  );
  const probeIdentity = assign(
    "probeIdentity",
    reconcileScalar(
      "probeIdentity",
      undefined,
      snapshot?.probeIdentity,
      warnings,
      true,
    ),
  );

  const caps = model.capabilities;
  const hostVision =
    caps?.attachment === true || caps?.input?.image === true ? true : undefined;
  const capabilities: ModelCapabilityEvidence = {
    vision: reconcileCapability(
      "vision",
      hostVision,
      snapshot?.capabilities.vision,
      warnings,
    ),
    toolCall: reconcileCapability(
      "toolCall",
      caps?.toolcall,
      snapshot?.capabilities.toolCall,
      warnings,
    ),
    reasoning: reconcileCapability(
      "reasoning",
      caps?.reasoning,
      snapshot?.capabilities.reasoning,
      warnings,
    ),
    temperature: reconcileCapability(
      "temperature",
      caps?.temperature,
      snapshot?.capabilities.temperature,
      warnings,
    ),
  };
  const flags: string[] = [];
  if (capabilities.vision.state === "supported") flags.push("Vision");
  if (capabilities.toolCall.state === "supported") flags.push("Tools");
  if (capabilities.reasoning.state === "supported") flags.push("Reasoning");
  if (capabilities.temperature.state === "supported") flags.push("Temp");

  return {
    id,
    name,
    context,
    output,
    type,
    flags,
    family,
    parameterSize,
    quantization,
    sizeBytes,
    probeIdentity,
    origin: snapshot?.origin,
    capabilities,
    provenance,
    warnings,
  };
}

/** Reconcile discoverable host providers with optional exact-attempt evidence. */
export function collectModelGroups(
  providers: readonly SdkProviderView[],
  exact?: ExactCatalogSnapshot,
): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  const snapshotProviders = new Map(
    exact?.snapshot.providers.map((provider) => [provider.id, provider]),
  );
  const seenProviders = new Set<string>();

  for (const provider of providers) {
    const evidence = snapshotProviders.get(provider.id);
    if (!looksDiscoverable(provider) && !evidence) continue;
    seenProviders.add(provider.id);
    const models = provider.models ?? {};
    const rows: ModelRow[] = [];
    for (const [id, model] of Object.entries(models)) {
      if (!id) continue;
      const modelEvidence = snapshotModel(evidence, id);
      const row = toModelRow(id, model, modelEvidence);
      if (exact && !modelEvidence)
        row.warnings?.push("exact snapshot has no provenance for this model");
      rows.push(row);
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));

    const warnings: string[] = [];
    if (!exact)
      warnings.push("provenance unavailable; showing host state only");
    else if (!evidence)
      warnings.push("provider absent from exact catalog snapshot");
    groups.push({
      id: provider.id,
      provider: readString(provider.name) ?? provider.id,
      endpoint: sanitizeEndpointOrigin(provider.options?.baseURL),
      status: evidence?.status,
      modelListAttempt: evidence?.modelListAttempt,
      probeAttempt: evidence?.probeAttempt,
      configuredProbe: snapshotString(evidence?.configuredProbe),
      resolvedProbe: snapshotString(evidence?.resolvedProbe),
      exactProvenance: Boolean(exact && evidence),
      warnings,
      models: rows,
    });
  }

  // Exact snapshot records may describe an eligible provider omitted from the
  // host's normal discoverability projection. This path is never used without
  // full launch correlation.
  if (exact) {
    for (const evidence of exact.snapshot.providers) {
      if (seenProviders.has(evidence.id)) continue;
      const rows = evidence.models.map((model) =>
        toModelRow(
          model.id,
          {
            id: model.id,
            name: snapshotString(model.name) ?? model.id,
          },
          model,
        ),
      );
      rows.sort((a, b) => a.id.localeCompare(b.id));
      groups.push({
        id: evidence.id,
        provider: evidence.id,
        endpoint: snapshotString(evidence.endpointOrigin),
        status: evidence.status,
        modelListAttempt: evidence.modelListAttempt,
        probeAttempt: evidence.probeAttempt,
        configuredProbe: snapshotString(evidence.configuredProbe),
        resolvedProbe: snapshotString(evidence.resolvedProbe),
        exactProvenance: true,
        warnings: [],
        models: rows,
      });
    }
  }

  groups.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  );
  return groups;
}
