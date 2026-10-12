import { describe, it, expect } from "vitest";
import {
  collectModelGroups,
  coreMetadataCoverage,
  toModelRow,
  type ModelRow,
  type SdkProviderView,
} from "../src/tui-models";

describe("toModelRow", () => {
  it("maps SDK capabilities and limits into a display row", () => {
    const row = toModelRow("qwen3-30b", {
      id: "qwen3-30b",
      name: "Qwen3 30B",
      family: "qwen3",
      limit: { context: 131072, output: 32768 },
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { image: false },
        output: { text: true },
      },
    });

    expect(row.name).toBe("Qwen3 30B");
    expect(row.context).toBe(131072);
    expect(row.output).toBe(32768);
    expect(row.type).toBe("llm");
    expect(row.flags).toEqual(["Tools", "Reasoning", "Temp"]);
    expect(row.family).toBe("qwen3");
  });

  it("classifies a vision model as vlm and adds the Vision flag", () => {
    const row = toModelRow("gemma3-12b", {
      id: "gemma3-12b",
      capabilities: {
        attachment: true,
        input: { image: true },
        output: { text: true },
      },
    });

    expect(row.type).toBe("vlm");
    expect(row.flags).toContain("Vision");
  });

  it("classifies attachment support as vlm without nested image input", () => {
    const row = toModelRow("atlas-vision", {
      id: "atlas-vision",
      capabilities: { attachment: true, output: { text: true } },
    });

    expect(row.type).toBe("vlm");
    expect(row.flags).toContain("Vision");
  });

  it("falls back to the id when name is missing", () => {
    const row = toModelRow("local-model", { id: "local-model" });
    expect(row.name).toBe("local-model");
    expect(row.type).toBeUndefined();
    expect(row.flags).toEqual([]);
  });

  it("ignores non-finite numeric fields", () => {
    const row = toModelRow("m", {
      id: "m",
      limit: { context: Number.NaN, output: Number.POSITIVE_INFINITY },
      sizeBytes: Number.NaN as unknown as number,
    });
    expect(row.context).toBeUndefined();
    expect(row.output).toBeUndefined();
    expect(row.sizeBytes).toBeUndefined();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 4096.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 2],
  ])("treats %s host limits as absent, not known metadata", (_label, limit) => {
    // The host normalizes omitted limits to 0; such values must never render
    // as "ctx 0" or count toward known core metadata.
    const row = toModelRow("m", {
      id: "m",
      limit: { context: limit, output: limit },
    });
    expect(row.context).toBeUndefined();
    expect(row.output).toBeUndefined();
    expect(row.provenance?.context).toBeUndefined();
    expect(row.provenance?.output).toBeUndefined();
  });

  it("keeps zero for general numeric metadata outside limits", () => {
    const row = toModelRow("m", { id: "m", sizeBytes: 0 });
    expect(row.sizeBytes).toBe(0);
  });

  it("retains positive snapshot capability evidence when the host is silent", () => {
    // A host that omits capability booleans is silent, not conflicting:
    // supported exact evidence must survive with its flags.
    const row = toModelRow(
      "atlas-model",
      { id: "atlas-model" },
      {
        id: "atlas-model",
        origin: "discovered",
        identity: {
          state: "known",
          value: "atlas-model",
          source: "server-list",
          strength: "reported",
        },
        name: { state: "unknown" },
        modelType: {
          state: "known",
          value: "llm",
          source: "provider-probe",
          strength: "authoritative",
        },
        context: { state: "unknown" },
        output: { state: "unknown" },
        family: {
          state: "known",
          value: "atlas",
          source: "models.dev",
          strength: "inferred",
        },
        organizationOwner: { state: "unknown" },
        parameterSize: { state: "unknown" },
        quantization: { state: "unknown" },
        sizeBytes: { state: "unknown" },
        probeIdentity: { state: "unknown" },
        capabilities: {
          vision: {
            state: "supported",
            source: "provider-probe",
            strength: "authoritative",
          },
          toolCall: {
            state: "supported",
            source: "provider-probe",
            strength: "authoritative",
          },
          reasoning: { state: "unknown" },
          temperature: {
            state: "supported",
            source: "policy-default",
            strength: "assumed",
          },
        },
      },
    );
    expect(row.capabilities?.vision).toMatchObject({
      state: "supported",
      source: "provider-probe",
    });
    expect(row.capabilities?.toolCall.state).toBe("supported");
    expect(row.capabilities?.temperature).toMatchObject({
      state: "supported",
      source: "policy-default",
    });
    expect(row.capabilities?.reasoning.state).toBe("unknown");
    expect(row.flags).toEqual(["Vision", "Tools", "Temp"]);
    expect(row.family).toBe("atlas");
    expect(row.provenance?.family).toMatchObject({ source: "models.dev" });
  });

  it("surfaces probe-injected metadata fields", () => {
    const row = toModelRow("q", {
      id: "q",
      parameterSize: "0.6B",
      quantization: "Q4_K_M",
      sizeBytes: 480500000,
    });
    expect(row.parameterSize).toBe("0.6B");
    expect(row.quantization).toBe("Q4_K_M");
    expect(row.sizeBytes).toBe(480500000);
  });
});

describe("collectModelGroups", () => {
  const local: SdkProviderView = {
    id: "omlx",
    name: "oMLX",
    options: { baseURL: "http://localhost:8000/v1" },
    models: {
      "b-model": { id: "b-model", name: "B Model" },
      "a-model": { id: "a-model", name: "A Model" },
    },
  };

  it("includes OpenAI-compatible providers via baseURL /v1", () => {
    const groups = collectModelGroups([local]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("omlx");
    expect(groups[0]?.provider).toBe("oMLX");
    expect(groups[0]?.endpoint).toBe("http://localhost:8000");
  });

  it("excludes built-in cloud providers that lack options.baseURL", () => {
    // Regression: opencode's built-in cloud providers (OpenCode Zen/Go) are
    // served via @ai-sdk/openai-compatible and carry their endpoint on
    // model.api.url, but have NO options.baseURL. They must not appear.
    const groups = collectModelGroups([
      {
        id: "opencode",
        name: "OpenCode Zen",
        source: "custom",
        options: { apiKey: "public" },
        models: {
          "mimo-v2.5-free": {
            id: "mimo-v2.5-free",
            api: {
              npm: "@ai-sdk/openai-compatible",
              url: "https://opencode.ai/zen/v1",
            },
          },
        },
      },
      {
        id: "opencode-go",
        name: "OpenCode Go",
        source: "api",
        options: { apiKey: "dummy" },
        models: {
          "deepseek-v4-flash": {
            id: "deepseek-v4-flash",
            api: {
              npm: "@ai-sdk/openai-compatible",
              url: "https://opencode.ai/zen/go/v1",
            },
          },
        },
      },
    ]);
    expect(groups).toHaveLength(0);
  });

  it("includes a configured openai-compatible provider whose baseURL lacks /v1", () => {
    // Matches the server's `canDiscover` npm branch: a local provider with
    // options.baseURL and openai-compatible models is discovered even when the
    // baseURL has no "/v1" (the server appends "/v1/models" itself).
    const groups = collectModelGroups([
      {
        id: "local-oai",
        name: "Local OAI",
        source: "config",
        options: { baseURL: "http://localhost:9000" },
        models: {
          m: { id: "m", api: { npm: "@ai-sdk/openai-compatible" } },
        },
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.provider).toBe("Local OAI");
  });

  it("excludes providers that are not OpenAI-compatible", () => {
    const groups = collectModelGroups([
      {
        id: "anthropic",
        name: "Anthropic",
        source: "custom",
        options: { apiKey: "" },
        models: { "claude-x": { id: "claude-x" } },
      },
    ]);
    expect(groups).toHaveLength(0);
  });

  it("excludes a non-openai-compatible provider even if it has a baseURL without /v1", () => {
    const groups = collectModelGroups([
      {
        id: "weird",
        name: "Weird",
        options: { baseURL: "http://localhost:7000" },
        models: { m: { id: "m", api: { npm: "@ai-sdk/anthropic" } } },
      },
    ]);
    expect(groups).toHaveLength(0);
  });

  it("keeps discoverable providers with no models for provider status views", () => {
    const groups = collectModelGroups([
      { id: "empty", options: { baseURL: "http://x/v1" }, models: {} },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: "empty", models: [] });
  });

  it("sorts models within a group and providers across groups", () => {
    const second: SdkProviderView = {
      id: "vllm",
      name: "Aardvark",
      options: { baseURL: "http://localhost:9000/v1" },
      models: { z: { id: "z" } },
    };
    const groups = collectModelGroups([local, second]);
    expect(groups.map((g) => g.provider)).toEqual(["Aardvark", "oMLX"]);
    expect(groups[1]?.models.map((m) => m.id)).toEqual(["a-model", "b-model"]);
  });

  it("falls back to provider id when name is missing", () => {
    const groups = collectModelGroups([
      {
        id: "raw-id",
        options: { baseURL: "http://x/v1" },
        models: { m: { id: "m" } },
      },
    ]);
    expect(groups[0]?.provider).toBe("raw-id");
  });

  it("keeps only a sanitized endpoint origin", () => {
    const groups = collectModelGroups([
      {
        id: "atlas-public",
        name: "Atlas",
        options: {
          baseURL:
            "https://user:secret@atlas.test:8443/v1/private?token=secret#models",
        },
        models: { atlas: { id: "atlas" } },
      },
    ]);

    expect(groups[0]?.endpoint).toBe("https://atlas.test:8443");
  });

  it("omits invalid endpoint URLs", () => {
    const groups = collectModelGroups([
      {
        id: "atlas-public",
        name: "Atlas",
        options: { baseURL: "/v1/not-a-url" },
        models: {
          atlas: {
            id: "atlas",
            api: { npm: "@ai-sdk/openai-compatible" },
          },
        },
      },
    ]);

    expect(groups[0]?.endpoint).toBeUndefined();
  });
});

describe("core metadata coverage", () => {
  const supported = {
    state: "supported" as const,
    source: "unmatched-host" as const,
    strength: "unmatched" as const,
  };
  const unknown = { state: "unknown" as const };
  const row = (overrides: Partial<ModelRow>): ModelRow => ({
    id: "atlas-model",
    name: "Atlas Model",
    flags: [],
    capabilities: {
      vision: supported,
      toolCall: supported,
      reasoning: supported,
      temperature: supported,
    },
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

  it("reports unknown chat evidence as expected missing metadata", () => {
    const coverage = coreMetadataCoverage(
      row({
        type: "vlm",
        context: 8192,
        capabilities: {
          vision: supported,
          toolCall: unknown,
          reasoning: unknown,
          temperature: supported,
        },
      }),
    );
    expect(coverage).toEqual({
      known: 4,
      total: 7,
      missing: ["output", "tools", "reasoning"],
      complete: false,
    });
  });

  it("treats chat capabilities as inapplicable to embeddings", () => {
    expect(
      coreMetadataCoverage(
        row({ type: "embedding", context: 2048, capabilities: undefined }),
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
