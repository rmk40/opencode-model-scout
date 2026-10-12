import { describe, expect, it } from "vitest";
import {
  CATALOG_SCHEMA_VERSION,
  knownScalar,
  unknownCapability,
  unknownScalar,
  type CapabilityEvidence,
  type CatalogModelRecord,
  type CatalogPayload,
  type CatalogProviderRecord,
} from "../src/catalog-evidence";
import {
  collectModelGroups,
  coreMetadataCoverage,
  type HostCatalog,
  type HostModel,
  type HostProvider,
} from "../src/tui-models";

const probeSupported: CapabilityEvidence = {
  state: "supported",
  source: "provider-probe",
  strength: "authoritative",
};
const probeUnsupported: CapabilityEvidence = {
  state: "unsupported",
  source: "provider-probe",
  strength: "authoritative",
};

function evidenceModel(
  id = "atlas-model",
  overrides: Partial<CatalogModelRecord> = {},
): CatalogModelRecord {
  return {
    id,
    origin: "discovered",
    enabled: true,
    identity: knownScalar(id, "server-list", "reported"),
    name: knownScalar("Atlas Model", "heuristic", "inferred"),
    modelType: knownScalar("llm", "provider-probe", "authoritative"),
    context: knownScalar(8192, "provider-probe", "authoritative"),
    output: knownScalar(32_000, "host-default", "assumed"),
    family: knownScalar("atlas", "models.dev", "inferred"),
    organizationOwner: unknownScalar(),
    parameterSize: knownScalar("8B", "provider-probe", "authoritative"),
    quantization: knownScalar("Q4_K_M", "provider-probe", "authoritative"),
    sizeBytes: knownScalar(4_000_000_000, "provider-probe", "authoritative"),
    probeIdentity: knownScalar("actualyze", "provider-probe", "reported"),
    capabilities: {
      toolCall: probeSupported,
      reasoning: unknownCapability(),
      temperature: {
        state: "supported",
        source: "policy-default",
        strength: "assumed",
      },
    },
    inputModalities: {
      text: probeSupported,
      image: probeUnsupported,
      pdf: unknownCapability(),
      audio: unknownCapability(),
      video: unknownCapability(),
    },
    cost: {
      input: knownScalar(3, "provider-probe", "reported"),
      output: knownScalar(15, "provider-probe", "reported"),
      cacheRead: unknownScalar(),
      cacheWrite: unknownScalar(),
    },
    ...overrides,
  };
}

function evidenceProvider(
  overrides: Partial<CatalogProviderRecord> = {},
): CatalogProviderRecord {
  return {
    id: "atlas",
    endpointOrigin: knownScalar(
      "https://atlas.test",
      "pre-existing",
      "configured",
    ),
    configuredProbe: knownScalar("auto", "pre-existing", "configured"),
    resolvedProbe: knownScalar("actualyze", "provider-probe", "reported"),
    lastGoodAt: "2026-10-11T08:00:00.000Z",
    failure: null,
    modelListAttempt: "ready",
    probeAttempt: "complete",
    skippedModelIds: [],
    models: [evidenceModel()],
    ...overrides,
  };
}

function catalog(
  providers: CatalogProviderRecord[] = [evidenceProvider()],
): CatalogPayload {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    packageVersion: "2.0.0",
    status: "complete",
    completedAt: "2026-10-11T08:00:00.000Z",
    providers,
  };
}

function hostModel(overrides: Partial<HostModel> = {}): HostModel {
  return {
    id: "atlas-model",
    providerID: "atlas",
    name: "Atlas Model",
    family: "atlas",
    enabled: true,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    cost: [{ input: 3, output: 15, cache: { read: 0, write: 0 } }],
    limit: { context: 8192, output: 32_000 },
    ...overrides,
  };
}

const atlasProvider: HostProvider = {
  id: "atlas",
  name: "Atlas",
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: "https://atlas.test/openai/v1" },
};

function host(...models: HostModel[]): HostCatalog {
  return {
    providers: [atlasProvider],
    models: models.length > 0 ? models : [hostModel()],
  };
}

function firstRow(hostCatalog: HostCatalog, payload?: CatalogPayload) {
  const row = collectModelGroups(hostCatalog, payload)[0]?.models[0];
  if (!row) throw new Error("missing row");
  return row;
}

describe("host and evidence reconciliation", () => {
  it("keeps agreeing evidence with its provenance", () => {
    const row = firstRow(host(), catalog());
    expect(row.context).toBe(8192);
    expect(row.provenance?.context).toMatchObject({
      source: "provider-probe",
      strength: "authoritative",
    });
    expect(row.capabilities?.toolCall).toEqual(probeSupported);
    expect(row.capabilities?.temperature).toMatchObject({
      source: "policy-default",
    });
    expect(row.origin).toBe("discovered");
    expect(row.warnings).toEqual([]);
  });

  it("takes host-default limits from evidence, not from the always-present host value", () => {
    const row = firstRow(host(), catalog());
    expect(row.output).toBe(32_000);
    expect(row.provenance?.output).toMatchObject({ source: "host-default" });
    expect(coreMetadataCoverage(row).missing).toContain("output");

    const hostOnly = firstRow(host());
    expect(hostOnly.provenance?.output).toMatchObject({
      source: "unmatched-host",
    });
    expect(coreMetadataCoverage(hostOnly).missing).not.toContain("output");
  });

  it("applies authoritative negatives only when evidence exists", () => {
    expect(firstRow(host(), catalog()).inputModalities?.image).toEqual(
      probeUnsupported,
    );
    expect(firstRow(host()).inputModalities?.image.state).toBe("unknown");
    expect(firstRow(host()).origin).toBeUndefined();
  });

  it("keeps a conflicting host limit and warns about it", () => {
    const row = firstRow(
      host(hostModel({ limit: { context: 4096, output: 32_000 } })),
      catalog(),
    );
    expect(row.context).toBe(4096);
    expect(row.provenance?.context).toMatchObject({
      source: "unmatched-host",
    });
    expect(row.warnings).toContain(
      "provenance conflict for context; using host value",
    );
  });

  it("reports capability conflicts in both directions", () => {
    const hostImage = firstRow(
      host(
        hostModel({
          capabilities: {
            tools: false,
            input: ["text", "image"],
            output: ["text"],
          },
        }),
      ),
      catalog(),
    );
    expect(hostImage.inputModalities?.image).toMatchObject({
      state: "supported",
      source: "unmatched-host",
    });
    expect(hostImage.capabilities?.toolCall.state).toBe("unknown");
    expect(hostImage.warnings).toEqual(
      expect.arrayContaining([
        "provenance conflict for image input; using host support",
        "provenance conflict for toolCall; using host value",
      ]),
    );
  });

  it("lets an authoritative probe type override the host's image-based guess", () => {
    const row = firstRow(
      host(
        hostModel({
          capabilities: {
            tools: true,
            input: ["text", "image"],
            output: ["text"],
          },
        }),
      ),
      catalog(),
    );
    expect(row.type).toBe("llm");
    expect(row.warnings).toContain(
      "provenance conflict for type; using provider probe value",
    );
  });

  it("keeps the host-inferred type over weaker conflicting evidence", () => {
    const heuristic = evidenceModel("atlas-model", {
      modelType: knownScalar("vlm", "heuristic", "inferred"),
    });
    const row = firstRow(
      host(),
      catalog([evidenceProvider({ models: [heuristic] })]),
    );
    expect(row.type).toBe("llm");
    expect(row.warnings).toContain(
      "provenance conflict for type; using host value",
    );
  });

  it("derives reasoning support from host variants when evidence is silent", () => {
    const row = firstRow(
      host(hostModel({ variants: [{ id: "low" }, { id: "high" }] })),
      catalog(),
    );
    expect(row.capabilities?.reasoning).toMatchObject({
      state: "supported",
      source: "unmatched-host",
    });
  });

  it("shows evidence-only diagnostics and prefers evidence cost over zero-filled host prices", () => {
    const row = firstRow(host(), catalog());
    expect(row).toMatchObject({
      parameterSize: "8B",
      quantization: "Q4_K_M",
      sizeBytes: 4_000_000_000,
      probeIdentity: "actualyze",
    });
    expect(row.cost?.cacheRead).toEqual({ state: "unknown" });

    const hostOnly = firstRow(host());
    expect(hostOnly.parameterSize).toBeUndefined();
    expect(hostOnly.cost?.cacheRead).toMatchObject({
      state: "known",
      value: 0,
    });
  });

  it("joins on provider ID plus model ID", () => {
    const row = firstRow(
      host(),
      catalog([evidenceProvider({ models: [evidenceModel("other-model")] })]),
    );
    expect(row.id).toBe("atlas-model");
    expect(row.parameterSize).toBeUndefined();
    expect(row.warnings).toContain(
      "discovery evidence has no record of this model",
    );
  });

  it("adds disabled models that only the evidence lists", () => {
    const embedding = evidenceModel("atlas-embed", {
      enabled: false,
      modelType: knownScalar("embedding", "provider-probe", "authoritative"),
      output: unknownScalar(),
    });
    const group = collectModelGroups(
      host(),
      catalog([evidenceProvider({ models: [evidenceModel(), embedding] })]),
    )[0];
    const row = group?.models.find((model) => model.id === "atlas-embed");
    expect(row).toMatchObject({
      enabled: false,
      type: "embedding",
      context: 8192,
      warnings: [],
    });
    expect(row?.provenance?.identity).toMatchObject({
      source: "server-list",
    });
  });

  it("flags an enabled evidence model the host does not list yet", () => {
    const group = collectModelGroups(
      host(),
      catalog([
        evidenceProvider({
          models: [evidenceModel(), evidenceModel("atlas-late")],
        }),
      ]),
    )[0];
    expect(
      group?.models.find((model) => model.id === "atlas-late")?.warnings,
    ).toContain("not in the host model list yet");
  });
});

describe("provider grouping with evidence", () => {
  it("carries discovery attempts, probe selection, and inventory timing", () => {
    const failure = {
      kind: "timeout" as const,
      at: "2026-10-11T09:00:00.000Z",
    };
    const [group] = collectModelGroups(
      host(),
      catalog([evidenceProvider({ failure })]),
    );
    expect(group).toMatchObject({
      id: "atlas",
      provider: "Atlas",
      endpoint: "https://atlas.test",
      hasEvidence: true,
      lastGoodAt: "2026-10-11T08:00:00.000Z",
      failure,
      modelListAttempt: "ready",
      probeAttempt: "complete",
      configuredProbe: "auto",
      resolvedProbe: "actualyze",
      warnings: [],
    });
  });

  it("shows evidence providers the host does not list, named by ID", () => {
    const [group] = collectModelGroups(
      { providers: [], models: [] },
      catalog(),
    );
    expect(group).toMatchObject({
      id: "atlas",
      provider: "atlas",
      endpoint: "https://atlas.test",
      hasEvidence: true,
    });
    expect(group?.models[0]).toMatchObject({
      family: "atlas",
      context: 8192,
      type: "llm",
      flags: ["Tools", "Temp"],
    });
  });

  it("shows an evidence provider even when the host heuristic would skip it", () => {
    const aliased: HostProvider = { ...atlasProvider, canonical: "openai" };
    const groups = collectModelGroups(
      { providers: [aliased], models: [hostModel()] },
      catalog(),
    );
    expect(groups.map((group) => group.id)).toEqual(["atlas"]);
    expect(groups[0]?.provider).toBe("Atlas");
  });

  it("warns about a provider with an explicit probe missing from the catalog", () => {
    const probed: HostProvider = {
      ...atlasProvider,
      settings: { ...atlasProvider.settings, probe: "auto" },
    };
    const groups = collectModelGroups(
      { providers: [probed], models: [hostModel()] },
      catalog([]),
    );
    expect(groups[0]).toMatchObject({
      id: "atlas",
      hasEvidence: false,
      warnings: ["not in the server's discovery catalog"],
    });
    expect(groups[0]?.models[0]?.warnings).toEqual([]);
  });

  it("does not warn about a provider with an explicit probe before the server resolves its targets", () => {
    const probed: HostProvider = {
      ...atlasProvider,
      settings: { ...atlasProvider.settings, probe: "auto" },
    };
    const starting: CatalogPayload = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      packageVersion: "2.0.0",
      status: "pending",
      providers: [],
    };
    const [group] = collectModelGroups(
      { providers: [probed], models: [hostModel()] },
      starting,
    );
    expect(group).toMatchObject({ id: "atlas", hasEvidence: false });
    expect(group?.warnings).toEqual([]);
    expect(group?.models[0]?.warnings).toEqual([]);
  });

  it("lists an auto-eligible provider missing from the catalog without a warning", () => {
    // Auto-eligibility depends on provider load order the TUI cannot observe,
    // so absence from the catalog is not evidence of a fault.
    const groups = collectModelGroups(host(), catalog([]));
    expect(groups[0]).toMatchObject({
      id: "atlas",
      hasEvidence: false,
      warnings: [],
    });
  });
});
