import { describe, expect, it } from "vitest";
import {
  CATALOG_SCHEMA_VERSION,
  createAttemptId,
  createProviderFingerprint,
  createRuntimeKey,
  createServerKey,
  createWorktreeKey,
  knownScalar,
  unknownCapability,
  unknownScalar,
  type CatalogModelRecord,
  type ExactCatalogSnapshot,
} from "../src/catalog-snapshot";
import {
  collectModelGroups,
  hostProviderFingerprint,
  toModelRow,
  type SdkModelView,
  type SdkProviderView,
} from "../src/tui-models";
import { discoverableProviderEntries } from "../src/discover";

function evidenceModel(id = "atlas-model"): CatalogModelRecord {
  return {
    id,
    origin: "discovered",
    identity: knownScalar(id, "server-list", "reported"),
    name: knownScalar("Atlas Model", "heuristic", "inferred"),
    modelType: knownScalar("llm", "provider-probe", "authoritative"),
    context: knownScalar(8192, "provider-probe", "authoritative"),
    output: unknownScalar(),
    family: knownScalar("atlas", "models.dev", "inferred"),
    organizationOwner: unknownScalar(),
    parameterSize: knownScalar("8B", "provider-probe", "authoritative"),
    quantization: knownScalar("Q4_K_M", "provider-probe", "authoritative"),
    sizeBytes: knownScalar(4_000_000_000, "provider-probe", "authoritative"),
    probeIdentity: knownScalar("atlas", "provider-probe", "reported"),
    capabilities: {
      vision: {
        state: "unsupported",
        source: "provider-probe",
        strength: "authoritative",
      },
      toolCall: {
        state: "supported",
        source: "provider-probe",
        strength: "authoritative",
      },
      reasoning: unknownCapability(),
      temperature: {
        state: "supported",
        source: "policy-default",
        strength: "assumed",
      },
    },
  };
}

function exact(model = evidenceModel()): ExactCatalogSnapshot {
  const startedAt = new Date().toISOString();
  return {
    exactAttempt: true,
    snapshot: {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      packageVersion: "1.6.0",
      status: "complete",
      attemptId: createAttemptId(),
      startedAt,
      completedAt: startedAt,
      worktreeKey: createWorktreeKey("/tmp/worktree"),
      serverKey: createServerKey("http://127.0.0.1:4096")!,
      runtimeKey: createRuntimeKey(),
      providerFingerprint: createProviderFingerprint([
        { id: "atlas", baseURL: "https://atlas.test/v1" },
      ]),
      providers: [
        {
          id: "atlas",
          endpointOrigin: knownScalar(
            "https://atlas.test",
            "pre-existing",
            "configured",
          ),
          configuredProbe: knownScalar("auto", "pre-existing", "configured"),
          resolvedProbe: knownScalar("atlas", "provider-probe", "reported"),
          status: "ready",
          modelListAttempt: "ready",
          probeAttempt: "complete",
          skippedModelIds: [],
          models: [model],
        },
      ],
    },
  };
}

function host(overrides: Partial<SdkModelView> = {}): SdkProviderView[] {
  return [
    {
      id: "atlas",
      name: "Atlas",
      options: { baseURL: "https://atlas.test/v1" },
      models: {
        "atlas-model": {
          id: "atlas-model",
          name: "Atlas Model",
          family: "atlas",
          limit: { context: 8192 },
          capabilities: {
            output: { text: true },
            attachment: false,
            toolcall: true,
            temperature: true,
          },
          ...overrides,
        },
      },
    },
  ];
}

describe("host/snapshot reconciliation", () => {
  it("accepts agreeing evidence and preserves assumed temperature confidence", () => {
    const row = collectModelGroups(host(), exact())[0].models[0];
    expect(row.context).toBe(8192);
    expect(row.provenance?.context).toMatchObject({
      source: "provider-probe",
      strength: "authoritative",
    });
    expect(row.capabilities?.toolCall).toMatchObject({
      state: "supported",
      source: "provider-probe",
      strength: "authoritative",
    });
    expect(row.capabilities?.temperature).toEqual({
      state: "supported",
      source: "policy-default",
      strength: "assumed",
    });
    expect(row.origin).toBe("discovered");
  });

  it("applies authoritative negatives only with exact-attempt evidence", () => {
    const exactRow = collectModelGroups(host(), exact())[0].models[0];
    expect(exactRow.capabilities?.vision.state).toBe("unsupported");

    const hostOnly = collectModelGroups(host())[0].models[0];
    expect(hostOnly.capabilities?.vision.state).toBe("unknown");
    expect(hostOnly.origin).toBeUndefined();
  });

  it("keeps conflicting host values and emits non-fatal warnings", () => {
    const providers = host({ limit: { context: 4096 } });
    const row = collectModelGroups(providers, exact())[0].models[0];
    expect(row.context).toBe(4096);
    expect(row.provenance?.context).toMatchObject({
      source: "unmatched-host",
      strength: "unmatched",
    });
    expect(row.warnings).toContain(
      "provenance conflict for context; using host value",
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -4096],
    ["fractional", 8192.25],
    ["unsafe", Number.MAX_SAFE_INTEGER + 2],
  ])(
    "does not let a %s host limit override positive exact snapshot evidence",
    (_label, limit) => {
      // opencode's provider state normalizes omitted limits to 0. Such host
      // values are absent, not a conflicting host claim, so the exact
      // snapshot context (8192, provider-probe) must win without warnings.
      const providers = host({ limit: { context: limit, output: limit } });
      const row = collectModelGroups(providers, exact())[0].models[0];
      expect(row.context).toBe(8192);
      expect(row.provenance?.context).toMatchObject({
        source: "provider-probe",
        strength: "authoritative",
      });
      expect(row.warnings ?? []).not.toContain(
        "provenance conflict for context; using host value",
      );
      // Snapshot output is unknown and the host limit is absent: stay unset.
      expect(row.output).toBeUndefined();
    },
  );

  it("surfaces snapshot-only limits when the host omits them entirely", () => {
    const providers = host({ limit: undefined });
    const row = collectModelGroups(providers, exact())[0].models[0];
    expect(row.context).toBe(8192);
    expect(row.provenance?.context).toMatchObject({
      source: "provider-probe",
      strength: "authoritative",
    });
  });

  it("uses exact context and output evidence when host limits are invalid", () => {
    const snapshot = exact();
    snapshot.snapshot.providers[0].models[0].output = knownScalar(
      2048,
      "provider-probe",
      "authoritative",
    );
    const row = collectModelGroups(
      host({ limit: { context: 0, output: -1 } }),
      snapshot,
    )[0].models[0];

    expect(row.context).toBe(8192);
    expect(row.output).toBe(2048);
    expect(row.provenance?.context).toMatchObject({
      source: "provider-probe",
      strength: "authoritative",
    });
    expect(row.provenance?.output).toMatchObject({
      source: "provider-probe",
      strength: "authoritative",
    });
    expect(row.warnings).toEqual([]);
  });

  it("does not promote one model conflict to provider or sibling warnings", () => {
    const providers = host({ limit: { context: 4096 } });
    providers[0].models!["atlas-clean"] = {
      id: "atlas-clean",
      name: "Atlas Model",
      limit: { context: 8192 },
      capabilities: { output: { text: true } },
    };
    const snapshot = exact();
    snapshot.snapshot.providers[0].models.push(evidenceModel("atlas-clean"));
    const group = collectModelGroups(providers, snapshot)[0];
    const conflict = group.models.find((model) => model.id === "atlas-model");
    const clean = group.models.find((model) => model.id === "atlas-clean");
    expect(conflict?.warnings).toContain(
      "provenance conflict for context; using host value",
    );
    expect(clean?.warnings).not.toContain(
      "provenance conflict for context; using host value",
    );
    expect(group.warnings).not.toContain(
      "provenance conflict for context; using host value",
    );
  });

  it("accepts exact snapshot-only diagnostic fields", () => {
    const row = collectModelGroups(host(), exact())[0].models[0];
    expect(row).toMatchObject({
      parameterSize: "8B",
      quantization: "Q4_K_M",
      sizeBytes: 4_000_000_000,
      probeIdentity: "atlas",
    });
    const hostOnly = collectModelGroups(host())[0].models[0];
    expect(hostOnly.parameterSize).toBeUndefined();
    expect(hostOnly.probeIdentity).toBeUndefined();
  });

  it("uses exact model type evidence when the host cannot represent embedding type", () => {
    const embedding = evidenceModel();
    embedding.modelType = knownScalar(
      "embedding",
      "provider-probe",
      "authoritative",
    );
    const providers = host({ capabilities: undefined });
    const row = collectModelGroups(providers, exact(embedding))[0].models[0];
    expect(row.type).toBe("embedding");
    expect(row.provenance?.type).toMatchObject({
      source: "provider-probe",
      strength: "authoritative",
    });
  });

  it("keeps stronger exact model type evidence over host attachment inference", () => {
    const providers = host({
      capabilities: { attachment: true, output: { text: true } },
    });
    const row = collectModelGroups(providers, exact())[0].models[0];
    expect(row.type).toBe("llm");
    expect(row.warnings).toContain(
      "provenance conflict for type; using provider probe value",
    );
  });

  it("keeps an explicit host model type over conflicting snapshot evidence", () => {
    const embedding = evidenceModel();
    embedding.modelType = knownScalar(
      "embedding",
      "provider-probe",
      "authoritative",
    );
    const row = toModelRow(
      "atlas-chat",
      { id: "atlas-chat", type: "llm" },
      embedding,
    );
    expect(row.type).toBe("llm");
    expect(row.warnings).toContain(
      "provenance conflict for type; using host value",
    );
  });

  it("joins on provider ID plus model ID", () => {
    const wrongModel = evidenceModel("other-model");
    const row = collectModelGroups(host(), exact(wrongModel))[0].models[0];
    expect(row.provenance?.context).toMatchObject({
      source: "unmatched-host",
    });
    expect(row.parameterSize).toBeUndefined();
  });

  it("reports provider attempt and resolved probe metadata", () => {
    const group = collectModelGroups(host(), exact())[0];
    expect(group).toMatchObject({
      status: "ready",
      configuredProbe: "auto",
      resolvedProbe: "atlas",
    });
  });

  it("fingerprints every base URL path and configured probe without credentials", () => {
    const providers = host();
    providers[0].options = {
      baseURL: "https://user:secret@atlas.test/v1/private?token=secret",
      probe: "auto",
    };
    expect(hostProviderFingerprint(providers)).toBe(
      createProviderFingerprint([
        {
          id: "atlas",
          baseURL: "https://atlas.test/v1/private",
          probe: "auto",
        },
      ]),
    );
  });

  it("includes exact empty providers and npm-only non-v1 host providers", () => {
    const emptyExact = exact();
    emptyExact.snapshot.providers[0].status = "empty";
    emptyExact.snapshot.providers[0].modelListAttempt = "empty";
    emptyExact.snapshot.providers[0].models = [];
    const [empty] = collectModelGroups(
      [
        {
          id: "atlas",
          options: { baseURL: "https://atlas.test/v1" },
          models: {},
        },
      ],
      emptyExact,
    );
    expect(empty).toMatchObject({ status: "empty", models: [] });

    const [npmOnly] = collectModelGroups([
      {
        id: "atlas-npm",
        options: { baseURL: "https://atlas.test/openai" },
        models: {
          model: {
            id: "model",
            api: { npm: "@ai-sdk/openai-compatible" },
          },
        },
      },
    ]);
    expect(npmOnly.id).toBe("atlas-npm");
  });

  it("keeps all positive exact evidence for a snapshot-only provider", () => {
    // The provider exists only in the exact snapshot (absent from host
    // state). Positive evidence — scalar family/parameterSize and supported
    // capabilities — must reconcile exactly like negatives do.
    const [group] = collectModelGroups([], exact());
    expect(group).toMatchObject({
      id: "atlas",
      exactProvenance: true,
      status: "ready",
    });
    const row = group.models[0];
    expect(row).toMatchObject({
      family: "atlas",
      parameterSize: "8B",
      quantization: "Q4_K_M",
      sizeBytes: 4_000_000_000,
      probeIdentity: "atlas",
      context: 8192,
      type: "llm",
    });
    expect(row.provenance?.family).toMatchObject({
      source: "models.dev",
      strength: "inferred",
    });
    expect(row.capabilities?.toolCall).toMatchObject({
      state: "supported",
      source: "provider-probe",
      strength: "authoritative",
    });
    expect(row.capabilities?.temperature).toMatchObject({
      state: "supported",
      source: "policy-default",
    });
    expect(row.capabilities?.vision.state).toBe("unsupported");
    expect(row.capabilities?.reasoning.state).toBe("unknown");
    expect(row.flags).toEqual(["Tools", "Temp"]);
    expect(row.warnings).toEqual([]);
  });

  it("keeps host capability and family values winning over conflicting snapshots", () => {
    const snapshot = exact();
    snapshot.snapshot.providers[0].models[0].family = knownScalar(
      "other-family",
      "models.dev",
      "inferred",
    );
    snapshot.snapshot.providers[0].models[0].capabilities.toolCall = {
      state: "supported",
      source: "provider-probe",
      strength: "authoritative",
    };
    const providers = host({
      family: "atlas",
      capabilities: { output: { text: true }, toolcall: false },
    });
    const row = collectModelGroups(providers, snapshot)[0].models[0];
    expect(row.family).toBe("atlas");
    expect(row.warnings).toContain(
      "provenance conflict for family; using host value",
    );
    // An explicit host false suppresses a supported snapshot claim.
    expect(row.capabilities?.toolCall.state).toBe("unknown");
    expect(row.warnings).toContain(
      "provenance conflict for toolCall; using host value",
    );
  });

  it("treats either host image capability field as vision support", () => {
    const row = toModelRow("atlas-vision", {
      id: "atlas-vision",
      capabilities: { attachment: false, input: { image: true } },
    });
    expect(row.type).toBe("vlm");
    expect(row.capabilities?.vision.state).toBe("supported");
  });

  it("keeps server and TUI provider fingerprints invariant", () => {
    const config = {
      provider: {
        atlas: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "https://atlas.test/openai/v2?token=secret",
            probe: "atlas",
          },
        },
        "atlas-empty": {
          options: { baseURL: "https://atlas.test/empty", probe: "auto" },
        },
        ignored: { options: { baseURL: "" } },
      },
    };
    const tuiProviders: SdkProviderView[] = [
      {
        id: "atlas",
        options: {
          baseURL: "https://atlas.test/openai/v2?token=secret",
          probe: "atlas",
        },
        models: {
          model: {
            id: "model",
            api: { npm: "@ai-sdk/openai-compatible" },
          },
        },
      },
      {
        id: "atlas-empty",
        options: { baseURL: "https://atlas.test/empty", probe: "auto" },
        models: {},
      },
      { id: "ignored", options: { baseURL: "" }, models: {} },
    ];
    expect(hostProviderFingerprint(tuiProviders)).toBe(
      createProviderFingerprint(discoverableProviderEntries(config)),
    );
  });
});
