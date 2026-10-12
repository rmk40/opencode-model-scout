import { describe, expect, it } from "vitest";
import { preExistingRecord, toModelInfo } from "../src/discover";
import { EMPTY_INDEX } from "../src/models-dev-index";
import {
  collectModelGroups,
  coreMetadataCoverage,
  toModelRow,
  type HostModel,
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
});
