import { describe, expect, it } from "vitest";
import { preExistingRecord, toModelInfo } from "../src/discover";
import { EMPTY_INDEX } from "../src/models-dev-index";
import type {
  CapabilityEvidence,
  ScalarEvidence,
} from "../src/catalog-evidence";
import {
  collectModelGroups,
  coreMetadataCoverage,
  modelCertainty,
  toModelRow,
  type HostModel,
  type HostModelCost,
  type HostProvider,
  type ModelRow,
} from "../src/tui-models";

function hostModel(overrides: Partial<HostModel> = {}): HostModel {
  return {
    id: "qwen3-30b",
    providerID: "omlx",
    name: "Qwen3 30B",
    family: "qwen3",
    enabled: true,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    cost: [],
    limit: { context: 131_072, output: 32_768 },
    ...overrides,
  };
}

function hostProvider(overrides: Partial<HostProvider> = {}): HostProvider {
  return {
    id: "omlx",
    name: "oMLX",
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: "http://localhost:8000/v1" },
    ...overrides,
  };
}

describe("toModelRow from host rows only", () => {
  it("maps name, limits, family, and host capabilities into a display row", () => {
    const row = toModelRow(
      "qwen3-30b",
      hostModel({ variants: [{ id: "high" }] }),
    );

    expect(row).toMatchObject({
      name: "Qwen3 30B",
      context: 131_072,
      output: 32_768,
      family: "qwen3",
      type: "llm",
      enabled: true,
    });
    expect(row.flags).toEqual(["Tools", "Reasoning"]);
    expect(row.provenance?.context).toMatchObject({ source: "unmatched-host" });
  });

  it("classifies image input as vlm and maps every listed input modality", () => {
    const row = toModelRow(
      "gemma3",
      hostModel({
        capabilities: {
          tools: true,
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
      }),
    );

    expect(row.type).toBe("vlm");
    expect(row.flags).toContain("Image");
    expect(row.inputModalities?.pdf).toMatchObject({
      state: "supported",
      source: "unmatched-host",
    });
    expect(row.inputModalities?.audio.state).toBe("unknown");
  });

  it("treats host tools false as no claim rather than an unsupported fact", () => {
    const row = toModelRow(
      "m",
      hostModel({
        capabilities: { tools: false, input: ["text"], output: ["text"] },
      }),
    );
    expect(row.capabilities?.toolCall.state).toBe("unknown");
    expect(row.flags).not.toContain("Tools");
  });

  it("leaves type unknown when the host lists no text output", () => {
    const row = toModelRow(
      "m",
      hostModel({ capabilities: { tools: true, input: [], output: [] } }),
    );
    expect(row.type).toBeUndefined();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 4096.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 2],
  ])("treats %s host limits as absent", (_label, limit) => {
    const row = toModelRow(
      "m",
      hostModel({ limit: { context: limit, output: limit } }),
    );
    expect(row.context).toBeUndefined();
    expect(row.output).toBeUndefined();
    expect(row.provenance?.context).toBeUndefined();
  });

  it("maps the first host cost tier and leaves an empty cost unknown", () => {
    const priced = toModelRow(
      "m",
      hostModel({
        cost: [{ input: 1, output: 2, cache: { read: 0.5, write: 0 } }],
      }),
    );
    expect(priced.cost?.input).toMatchObject({
      state: "known",
      value: 1,
      source: "unmatched-host",
    });
    expect(priced.cost?.cacheWrite).toMatchObject({ state: "known", value: 0 });

    const free = toModelRow("m", hostModel());
    expect(free.cost).toEqual({
      input: { state: "unknown" },
      output: { state: "unknown" },
      cacheRead: { state: "unknown" },
      cacheWrite: { state: "unknown" },
    });
  });

  describe("prices next to discovery evidence", () => {
    const priced = hostModel({
      cost: [{ input: 1, output: 2, cache: { read: 0.5, write: 0 } }],
    });

    it("keeps the host's prices for a model declared in config", () => {
      const row = toModelRow(
        "qwen3-30b",
        priced,
        preExistingRecord("qwen3-30b"),
      );
      expect(row.cost?.input).toMatchObject({ state: "known", value: 1 });
      expect(row.cost?.cacheRead).toMatchObject({ state: "known", value: 0.5 });
    });

    it("uses the evidence prices for a discovered model, unknown cache prices included", () => {
      const [mapped] = toModelInfo(
        {
          modelListAttempt: "ready",
          probeAttempt: "complete",
          resolvedProbe: "actualyze",
          models: [
            { id: "qwen3-30b", meta: { cost: { input: 3, output: 4 } } },
          ],
          completedAt: "2026-01-01T00:00:00.000Z",
        },
        EMPTY_INDEX,
        { reasoningVariants: true },
      );
      const row = toModelRow("qwen3-30b", priced, mapped.evidence);
      expect(row.cost?.input).toMatchObject({ state: "known", value: 3 });
      expect(row.cost?.cacheRead.state).toBe("unknown");
    });
  });

  it("falls back to the ID when the host name is empty", () => {
    expect(toModelRow("local-model", hostModel({ name: "" })).name).toBe(
      "local-model",
    );
  });
});

describe("collectModelGroups without discovery evidence", () => {
  const models = [
    hostModel({ id: "b-model", name: "B Model" }),
    hostModel({ id: "a-model", name: "A Model" }),
  ];

  it("groups host models by provider and warns that evidence is missing", () => {
    const groups = collectModelGroups({
      providers: [hostProvider()],
      models: [...models, hostModel({ id: "other", providerID: "elsewhere" })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: "omlx",
      provider: "oMLX",
      endpoint: "http://localhost:8000",
      hasEvidence: false,
      warnings: ["evidence unavailable; showing host state only"],
    });
    expect(groups[0]?.models.map((model) => model.id)).toEqual([
      "a-model",
      "b-model",
    ]);
  });

  it.each([
    ["the openai-compatible package", hostProvider()],
    [
      "the AI SDK openai-compatible package",
      hostProvider({ package: "aisdk:@ai-sdk/openai-compatible" }),
    ],
    [
      "an explicit probe on any package",
      hostProvider({
        package: "@opencode/ai/providers/anthropic",
        canonical: "anthropic",
        settings: { baseURL: "https://gateway.test/v1", probe: "auto" },
      }),
    ],
  ])("includes a provider with a base URL and %s", (_label, provider) => {
    expect(
      collectModelGroups({ providers: [provider], models: [] }),
    ).toHaveLength(1);
  });

  it.each([
    ["has no base URL", hostProvider({ settings: { apiKey: "public" } })],
    [
      "is an alias of a catalog provider",
      hostProvider({ canonical: "openai" }),
    ],
    [
      "uses another package without a probe",
      hostProvider({ package: "@opencode/ai/providers/anthropic" }),
    ],
    [
      "is a built-in local discovery provider",
      hostProvider({
        id: "ollama",
        settings: { baseURL: "http://x/v1", probe: "auto" },
      }),
    ],
    ["is the hosted OpenCode catalog", hostProvider({ id: "opencode" })],
  ])("excludes a provider that %s", (_label, provider) => {
    expect(collectModelGroups({ providers: [provider], models: [] })).toEqual(
      [],
    );
  });

  it("keeps providers with no models and sorts groups by display name", () => {
    const groups = collectModelGroups({
      providers: [
        hostProvider(),
        hostProvider({ id: "vllm-box", name: "Aardvark" }),
      ],
      models,
    });
    expect(groups.map((group) => group.provider)).toEqual(["Aardvark", "oMLX"]);
    expect(groups[0]?.models).toEqual([]);
  });

  it("keeps only a sanitized endpoint origin and omits invalid URLs", () => {
    const [secret] = collectModelGroups({
      providers: [
        hostProvider({
          settings: {
            baseURL:
              "https://user:secret@atlas.test:8443/v1/private?token=secret#models",
          },
        }),
      ],
      models: [],
    });
    expect(secret?.endpoint).toBe("https://atlas.test:8443");

    const [relative] = collectModelGroups({
      providers: [hostProvider({ settings: { baseURL: "/v1/not-a-url" } })],
      models: [],
    });
    expect(relative?.endpoint).toBeUndefined();
  });
});

describe("core metadata coverage", () => {
  const supported = {
    state: "supported" as const,
    source: "unmatched-host" as const,
    strength: "unmatched" as const,
  };
  const unknown = { state: "unknown" as const };
  const inputs = (image: typeof supported | typeof unknown) => ({
    text: supported,
    image,
    pdf: unknown,
    audio: unknown,
    video: unknown,
  });
  const row = (overrides: Partial<ModelRow>): ModelRow => ({
    id: "atlas-model",
    name: "Atlas Model",
    enabled: true,
    flags: [],
    capabilities: {
      toolCall: supported,
      reasoning: supported,
      temperature: supported,
    },
    inputModalities: inputs(supported),
    ...overrides,
  });

  it.each(["llm", "vlm"] as const)(
    "requires all chat core fields for %s models",
    (type) => {
      expect(
        coreMetadataCoverage(row({ type, context: 8192, output: 1024 })),
      ).toEqual({ known: 7, total: 7, missing: [], complete: true });
    },
  );

  it("reports unknown chat evidence as missing metadata", () => {
    expect(
      coreMetadataCoverage(
        row({
          type: "vlm",
          context: 8192,
          inputModalities: inputs(unknown),
          capabilities: {
            toolCall: unknown,
            reasoning: unknown,
            temperature: supported,
          },
        }),
      ),
    ).toEqual({
      known: 3,
      total: 7,
      missing: ["output", "image", "tools", "reasoning"],
      complete: false,
    });
  });

  it("counts a limit marked as the host default as missing", () => {
    const coverage = coreMetadataCoverage(
      row({
        type: "llm",
        context: 200_000,
        output: 32_000,
        provenance: {
          context: {
            state: "known",
            value: 200_000,
            source: "host-default",
            strength: "assumed",
          },
          output: {
            state: "known",
            value: 32_000,
            source: "provider-probe",
            strength: "authoritative",
          },
        },
      }),
    );
    expect(coverage.missing).toEqual(["context"]);
  });

  it("treats chat capabilities as inapplicable to embeddings", () => {
    expect(
      coreMetadataCoverage(
        row({
          type: "embedding",
          context: 2048,
          capabilities: undefined,
          inputModalities: undefined,
        }),
      ),
    ).toEqual({ known: 2, total: 2, missing: [], complete: true });
  });

  it("requires type and context to establish an unknown model", () => {
    expect(coreMetadataCoverage(row({ context: 4096 }))).toEqual({
      known: 1,
      total: 2,
      missing: ["type"],
      complete: false,
    });
  });

  it("counts an assumed policy-default limit as missing and an inferred one as known", () => {
    const coverage = coreMetadataCoverage(
      row({
        type: "llm",
        context: 131_072,
        output: 4096,
        provenance: {
          context: {
            state: "known",
            value: 131_072,
            source: "models.dev",
            strength: "inferred",
          },
          output: {
            state: "known",
            value: 4096,
            source: "policy-default",
            strength: "assumed",
          },
        },
      }),
    );
    expect(coverage.missing).toEqual(["output"]);
  });

  it("counts a host temperature denial as known temperature metadata", () => {
    const coverage = coreMetadataCoverage(
      row({
        type: "llm",
        context: 8192,
        output: 1024,
        capabilities: {
          toolCall: supported,
          reasoning: supported,
          temperature: unknown,
        },
        hostTemperature: false,
      }),
    );
    expect(coverage.complete).toBe(true);
  });
});

function cost(
  input: number,
  output: number,
  tier?: HostModelCost["tier"],
): HostModelCost {
  return {
    ...(tier ? { tier } : {}),
    input,
    output,
    cache: { read: input / 10, write: input / 2 },
  };
}

describe("context-priced tiers", () => {
  it("takes the base price from the entry without a tier, wherever it is listed", () => {
    const row = toModelRow(
      "m",
      hostModel({
        cost: [cost(6, 22.5, { type: "context", size: 200_000 }), cost(3, 15)],
      }),
    );
    expect(row.cost?.input).toMatchObject({ state: "known", value: 3 });
    expect(row.cost?.output).toMatchObject({ state: "known", value: 15 });
    expect(row.priceTiers).toEqual([
      {
        above: 200_000,
        input: 6,
        output: 22.5,
        cacheRead: 0.6,
        cacheWrite: 3,
      },
    ]);
  });

  it("uses the first entry as the base when every entry has a tier, and sorts the rest by threshold", () => {
    const row = toModelRow(
      "m",
      hostModel({
        cost: [
          cost(1, 2, { type: "context", size: 0 }),
          cost(4, 8, { type: "context", size: 500_000 }),
          cost(2, 4, { type: "context", size: 128_000 }),
        ],
      }),
    );
    expect(row.cost?.input).toMatchObject({ value: 1 });
    expect(row.priceTiers?.map((tier) => tier.above)).toEqual([
      128_000, 500_000,
    ]);
  });

  it("ignores entries that are not valid context tiers", () => {
    const row = toModelRow(
      "m",
      hostModel({
        cost: [
          cost(3, 15),
          cost(9, 9, { type: "time-of-day", size: 1 }),
          cost(9, 9, { type: "context", size: -1 }),
          cost(9, 9, { type: "context", size: 1.5 }),
        ],
      }),
    );
    expect(row).not.toHaveProperty("priceTiers");
  });

  it("leaves an invalid tier price out of the tier", () => {
    const [tier] =
      toModelRow(
        "m",
        hostModel({
          cost: [cost(3, 15), cost(-1, 30, { type: "context", size: 200_000 })],
        }),
      ).priceTiers ?? [];
    expect(tier?.input).toBeUndefined();
    expect(tier?.output).toBe(30);
  });

  it("has no tiers for a single-priced model", () => {
    expect(
      toModelRow("m", hostModel({ cost: [cost(3, 15)] })),
    ).not.toHaveProperty("priceTiers");
  });

  const tiered = hostModel({
    cost: [cost(3, 15), cost(6, 22.5, { type: "context", size: 200_000 })],
  });

  it("keeps the host's tiers for a model declared in config", () => {
    const row = toModelRow("qwen3-30b", tiered, preExistingRecord("qwen3-30b"));
    expect(row.priceTiers).toHaveLength(1);
  });

  it("shows no host tiers for a discovered model", () => {
    const [mapped] = toModelInfo(
      {
        modelListAttempt: "ready",
        probeAttempt: "complete",
        resolvedProbe: "actualyze",
        models: [{ id: "qwen3-30b", meta: { cost: { input: 3, output: 15 } } }],
        completedAt: "2026-01-01T00:00:00.000Z",
      },
      EMPTY_INDEX,
      { reasoningVariants: true },
    );
    const row = toModelRow("qwen3-30b", tiered, mapped.evidence);
    expect(row).not.toHaveProperty("priceTiers");
  });
});

describe("host temperature capability", () => {
  const withTemperature = (temperature: unknown): HostModel =>
    hostModel({
      capabilities: {
        tools: true,
        input: ["text"],
        output: ["text"],
        temperature,
      },
    });

  it("treats host true as support from the host", () => {
    const row = toModelRow("m", withTemperature(true));
    expect(row.hostTemperature).toBe(true);
    expect(row.capabilities?.temperature).toMatchObject({
      state: "supported",
      source: "unmatched-host",
    });
    expect(row.flags).toContain("Temp");
    expect(modelCertainty(row).capabilities.temperature).toBe("confirmed");
  });

  it("records host false and shows temperature as unsupported", () => {
    const row = toModelRow("m", withTemperature(false));
    expect(row.hostTemperature).toBe(false);
    expect(row.capabilities?.temperature.state).toBe("unknown");
    expect(row.flags).not.toContain("Temp");
    expect(modelCertainty(row).capabilities.temperature).toBe("unsupported");
  });

  it("reports a conflict when the host denies temperature that evidence supports", () => {
    const [mapped] = toModelInfo(
      {
        modelListAttempt: "ready",
        probeAttempt: "complete",
        resolvedProbe: "actualyze",
        models: [{ id: "m", meta: { temperature: true } }],
        completedAt: "2026-01-01T00:00:00.000Z",
      },
      EMPTY_INDEX,
      { reasoningVariants: true },
    );
    const row = toModelRow("m", withTemperature(false), mapped.evidence);
    expect(row.warnings).toContain(
      "provenance conflict for temperature; using host value",
    );
    expect(modelCertainty(row).capabilities.temperature).toBe("unsupported");
  });

  it.each([
    ["absent", undefined],
    ["not a boolean", "yes"],
  ])("ignores a host temperature that is %s", (_label, temperature) => {
    const row = toModelRow("m", withTemperature(temperature));
    expect(row).not.toHaveProperty("hostTemperature");
    expect(row.capabilities?.temperature.state).toBe("unknown");
    expect(modelCertainty(row).capabilities.temperature).toBe("not-reported");
  });
});

describe("modelCertainty", () => {
  const unknown = { state: "unknown" as const };
  const allUnknown = {
    text: unknown,
    image: unknown,
    pdf: unknown,
    audio: unknown,
    video: unknown,
  };
  const row = (overrides: Partial<ModelRow> = {}): ModelRow => ({
    id: "atlas",
    name: "Atlas",
    enabled: true,
    flags: [],
    capabilities: {
      toolCall: unknown,
      reasoning: unknown,
      temperature: unknown,
    },
    inputModalities: allUnknown,
    ...overrides,
  });
  const withTools = (toolCall: CapabilityEvidence): ModelRow =>
    row({
      capabilities: { toolCall, reasoning: unknown, temperature: unknown },
    });

  it.each([
    ["provider-probe", "authoritative", "confirmed"],
    ["provider-probe", "reported", "confirmed"],
    ["pre-existing", "configured", "confirmed"],
    ["server-list", "reported", "confirmed"],
    ["unmatched-host", "unmatched", "confirmed"],
    ["models.dev", "inferred", "inferred"],
    ["heuristic", "inferred", "inferred"],
    ["policy-default", "assumed", "assumed"],
    ["host-default", "assumed", "assumed"],
  ] as const)(
    "rates support from %s (%s) as %s",
    (source, strength, expected) => {
      expect(
        modelCertainty(withTools({ state: "supported", source, strength }))
          .capabilities.tools,
      ).toBe(expected);
    },
  );

  it("rates a stated lack of support as unsupported", () => {
    expect(
      modelCertainty(
        withTools({
          state: "unsupported",
          source: "models.dev",
          strength: "inferred",
        }),
      ).capabilities.tools,
    ).toBe("unsupported");
  });

  it("rates every capability not-reported without evidence", () => {
    const certainty = modelCertainty(
      row({ capabilities: undefined, inputModalities: undefined }),
    );
    expect(Object.values(certainty.capabilities)).toEqual(
      Array(8).fill("not-reported"),
    );
  });

  it("rates each input modality from its own evidence", () => {
    const certainty = modelCertainty(
      row({
        inputModalities: {
          ...allUnknown,
          text: {
            state: "supported",
            source: "policy-default",
            strength: "assumed",
          },
          image: {
            state: "supported",
            source: "provider-probe",
            strength: "authoritative",
          },
          pdf: {
            state: "unsupported",
            source: "provider-probe",
            strength: "authoritative",
          },
        },
      }),
    ).capabilities;
    expect([
      certainty.text,
      certainty.image,
      certainty.pdf,
      certainty.audio,
    ]).toEqual(["assumed", "confirmed", "unsupported", "not-reported"]);
  });

  it("keeps stated temperature support even when the host denies it", () => {
    const certainty = modelCertainty(
      row({
        capabilities: {
          toolCall: unknown,
          reasoning: unknown,
          temperature: {
            state: "supported",
            source: "provider-probe",
            strength: "authoritative",
          },
        },
        hostTemperature: false,
      }),
    );
    expect(certainty.capabilities.temperature).toBe("confirmed");
  });

  const limit = (
    source: "host-default" | "policy-default" | "models.dev" | "provider-probe",
    strength: "assumed" | "inferred" | "authoritative",
  ): ScalarEvidence<number> => ({
    state: "known",
    value: 200_000,
    source,
    strength,
  });

  it.each([
    ["OpenCode's default", limit("host-default", "assumed"), "assumed"],
    ["a policy default", limit("policy-default", "assumed"), "assumed"],
    ["models.dev", limit("models.dev", "inferred"), "inferred"],
    ["the provider", limit("provider-probe", "authoritative"), "confirmed"],
    ["no recorded source", undefined, "confirmed"],
  ])("rates a limit from %s as %s", (_label, evidence, expected) => {
    const certainty = modelCertainty(
      row({
        context: 200_000,
        output: 200_000,
        provenance: evidence ? { context: evidence, output: evidence } : {},
      }),
    );
    expect(certainty.context).toBe(expected);
    expect(certainty.output).toBe(expected);
  });

  it("rates a missing limit not-reported", () => {
    const certainty = modelCertainty(row());
    expect(certainty.context).toBe("not-reported");
    expect(certainty.output).toBe("not-reported");
  });

  it("rates a discovered model without metadata as assumed tools and context, and unreported output", () => {
    const [mapped] = toModelInfo(
      {
        modelListAttempt: "ready",
        probeAttempt: "complete",
        resolvedProbe: "actualyze",
        models: [{ id: "bare" }],
        completedAt: "2026-01-01T00:00:00.000Z",
      },
      EMPTY_INDEX,
      { reasoningVariants: true },
    );
    // The host lists what scout emitted: tools on, the 200 000 default
    // context, and output 0 for "fit to the remaining context".
    const host = hostModel({
      id: "bare",
      name: "bare",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 200_000, output: 0 },
    });
    const certainty = modelCertainty(toModelRow("bare", host, mapped.evidence));
    expect(certainty.capabilities.tools).toBe("assumed");
    expect(certainty.context).toBe("assumed");
    expect(certainty.output).toBe("not-reported");
  });
});
