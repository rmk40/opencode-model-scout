import { describe, expect, it } from "vitest";
import {
  HOST_DEFAULT_CONTEXT,
  UNKNOWN_OUTPUT_LIMIT,
  toModelInfo,
  type InventoryModel,
  type ProviderInventory,
} from "../src/discover";
import {
  buildModelsDevIndex,
  EMPTY_INDEX,
  type ModelsDevIndex,
  type SourceModelLike,
} from "../src/models-dev-index";
import type { ProbeKey, ProbeModelMeta } from "../src/probes/index";

const COMPAT = { reasoningVariants: true };

function inventory(
  models: InventoryModel[],
  resolvedProbe?: ProbeKey,
): ProviderInventory {
  return {
    ...(resolvedProbe ? { resolvedProbe } : {}),
    modelListAttempt: "ready",
    probeAttempt: resolvedProbe ? "complete" : "not-requested",
    models,
    completedAt: "2026-01-01T00:00:00.000Z",
  };
}

function one(
  meta: ProbeModelMeta | undefined,
  options: {
    id?: string;
    probe?: ProbeKey;
    index?: ModelsDevIndex;
    created?: number;
    reasoningVariants?: boolean;
  } = {},
) {
  const id = options.id ?? "model-x";
  const [mapped] = toModelInfo(
    inventory(
      [
        {
          id,
          ...(options.created === undefined
            ? {}
            : { created: options.created }),
          ...(meta ? { meta } : {}),
        },
      ],
      meta ? (options.probe ?? "omlx") : undefined,
    ),
    options.index ?? EMPTY_INDEX,
    { reasoningVariants: options.reasoningVariants ?? true },
  );
  return mapped;
}

function modelsDev(
  id: string,
  overrides: Partial<{
    tools: boolean;
    input: string[];
    family: string;
    variants: unknown[];
  }>,
): ModelsDevIndex {
  const model: SourceModelLike = {
    ...(overrides.family ? { family: overrides.family } : {}),
    capabilities: {
      tools: overrides.tools ?? true,
      input: overrides.input ?? ["text"],
    },
    variants: overrides.variants ?? [],
  };
  return buildModelsDevIndex([
    { provider: { id: "catalog" }, models: new Map([[id, model]]) },
  ]);
}

describe("limits", () => {
  it("uses probe limits and records them as authoritative", () => {
    const mapped = one({ context: 8192, maxTokens: 1024 });
    expect(mapped.patch).toMatchObject({ context: 8192, output: 1024 });
    expect(mapped.evidence.context).toMatchObject({
      value: 8192,
      source: "provider-probe",
    });
    expect(mapped.evidence.output).toMatchObject({
      value: 1024,
      source: "provider-probe",
    });
  });

  it("falls back to the host context default and an unknown output", () => {
    const mapped = one(undefined);
    expect(mapped.patch).toMatchObject({
      context: HOST_DEFAULT_CONTEXT,
      output: UNKNOWN_OUTPUT_LIMIT,
    });
    expect(mapped.evidence.context).toMatchObject({ source: "host-default" });
    expect(mapped.evidence.output).toEqual({ state: "unknown" });
  });

  it("clamps a reported output limit to a reported context", () => {
    expect(one({ context: 4096, maxTokens: 8192 }).patch.output).toBe(4096);
  });

  it("keeps a reported output limit when only the host context is assumed", () => {
    expect(one({ maxTokens: 300_000 }).patch.output).toBe(300_000);
  });
});

describe("tools", () => {
  it("keeps an authoritative probe false over a models.dev true", () => {
    const mapped = one(
      { toolCall: false },
      { id: "qwen3-8b", index: modelsDev("qwen3-8b", { tools: true }) },
    );
    expect(mapped.patch.tools).toBe(false);
    expect(mapped.evidence.capabilities.toolCall).toMatchObject({
      state: "unsupported",
      source: "provider-probe",
    });
  });

  it("takes models.dev when the probe is silent, including a negative", () => {
    const mapped = one(undefined, {
      id: "qwen3-8b",
      index: modelsDev("qwen3-8b", { tools: false }),
    });
    expect(mapped.patch.tools).toBe(false);
    expect(mapped.evidence.capabilities.toolCall).toMatchObject({
      state: "unsupported",
      source: "models.dev",
    });
  });

  it("falls back to the host default", () => {
    const mapped = one(undefined);
    expect(mapped.patch.tools).toBe(true);
    expect(mapped.evidence.capabilities.toolCall).toMatchObject({
      source: "host-default",
    });
  });
});

describe("input modalities", () => {
  it("emits text only without image evidence", () => {
    expect(one(undefined).patch.input).toEqual(["text"]);
  });

  it("treats reported modalities as authoritative, in canonical order", () => {
    const mapped = one({ inputModalities: ["pdf", "text", "image"] });
    expect(mapped.patch.input).toEqual(["text", "image", "pdf"]);
    expect(mapped.evidence.inputModalities.audio).toMatchObject({
      state: "unsupported",
      source: "provider-probe",
    });
  });

  it("adds image from probe vision", () => {
    const mapped = one({ vision: true });
    expect(mapped.patch.input).toEqual(["text", "image"]);
    expect(mapped.evidence.modelType).toMatchObject({
      value: "vlm",
      source: "provider-probe",
    });
  });

  it("does not let models.dev add image to a probe-classified LLM", () => {
    const mapped = one(
      { modelType: "llm" },
      {
        id: "qwen3-vl",
        index: modelsDev("qwen3-vl", { input: ["text", "image"] }),
      },
    );
    expect(mapped.patch.input).toEqual(["text"]);
  });

  it("takes image, pdf, audio, and video from models.dev when the probe is silent", () => {
    const mapped = one(undefined, {
      id: "gemma-3-27b",
      index: modelsDev("gemma-3-27b", {
        input: ["text", "image", "pdf", "audio", "video"],
      }),
    });
    expect(mapped.patch.input).toEqual([
      "text",
      "image",
      "pdf",
      "audio",
      "video",
    ]);
    expect(mapped.evidence.inputModalities.pdf).toMatchObject({
      source: "models.dev",
    });
  });

  it("falls back to text when the reported list has no known modality", () => {
    expect(one({ inputModalities: [] }).patch.input).toEqual(["text"]);
  });
});

describe("variants", () => {
  const efforts = ["low", "medium", "high"];

  it("adds effort variants for a reasoning model on the openai-compatible package", () => {
    expect(one({ reasoning: true }).patch.variants).toEqual(efforts);
  });

  it("adds none on another package", () => {
    expect(
      one({ reasoning: true }, { reasoningVariants: false }).patch.variants,
    ).toEqual([]);
  });

  it("adds none for Actualyze models", () => {
    expect(
      one({ reasoning: true }, { probe: "actualyze" }).patch.variants,
    ).toEqual([]);
  });

  it("uses a positive models.dev reasoning signal unless the probe denies it", () => {
    const index = modelsDev("deepseek-r1", { variants: [{ id: "high" }] });
    expect(one(undefined, { id: "deepseek-r1", index }).patch.variants).toEqual(
      efforts,
    );
    expect(
      one({ reasoning: false }, { id: "deepseek-r1", index }).patch.variants,
    ).toEqual([]);
  });

  it("treats empty models.dev variants as unknown reasoning", () => {
    const mapped = one(undefined, {
      id: "deepseek-v3",
      index: modelsDev("deepseek-v3", { variants: [] }),
    });
    expect(mapped.evidence.capabilities.reasoning).toEqual({
      state: "unknown",
    });
    expect(mapped.patch.variants).toEqual([]);
  });
});

describe("cost", () => {
  it("zero-fills missing cache prices but records them as unknown", () => {
    const mapped = one({ cost: { input: 3, output: 15, cacheRead: 0.3 } });
    expect(mapped.patch.cost).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 0,
    });
    expect(mapped.evidence.cost.cacheWrite).toEqual({ state: "unknown" });
    expect(mapped.evidence.cost.cacheRead).toMatchObject({ value: 0.3 });
  });

  it("emits no cost without cost evidence", () => {
    expect(one({ context: 1 }).patch.cost).toBeUndefined();
  });
});

describe("release time", () => {
  it("uses the Actualyze created time in milliseconds", () => {
    expect(
      one({}, { probe: "actualyze", created: 1_700_000_000 }).patch.released,
    ).toBe(1_700_000_000_000);
  });

  it("ignores created times from other servers", () => {
    expect(
      one({}, { probe: "vllm", created: 1_700_000_000 }).patch.released,
    ).toBe(0);
  });
});

describe("embedding models", () => {
  it("disables a probe-confirmed embedding model", () => {
    const mapped = one({ modelType: "embedding" }, { id: "bge-m3" });
    expect(mapped.patch.enabled).toBe(false);
    expect(mapped.evidence.enabled).toBe(false);
  });

  it("disables a model named as an embedding model when no probe classifies it", () => {
    expect(one(undefined, { id: "nomic-embed-text" }).patch.enabled).toBe(
      false,
    );
  });

  it("keeps a probe-classified LLM enabled despite an embedding-like name", () => {
    expect(
      one({ modelType: "llm" }, { id: "embed-chat-7b" }).patch.enabled,
    ).toBe(true);
  });
});

describe("family and identity", () => {
  it("prefers the probe family over models.dev", () => {
    const index = modelsDev("qwen3-8b", { family: "qwen-dev" });
    expect(
      one({ family: "qwen3" }, { id: "qwen3-8b", index }).patch.family,
    ).toBe("qwen3");
    expect(one(undefined, { id: "qwen3-8b", index }).patch.family).toBe(
      "qwen-dev",
    );
  });

  it("records the canonical probe key as the probe identity", () => {
    expect(
      one({ context: 1 }, { probe: "actualyze" }).evidence.probeIdentity,
    ).toMatchObject({ value: "actualyze" });
  });

  it("maps each served ID once", () => {
    const mapped = toModelInfo(
      inventory([{ id: "a" }, { id: "a" }, { id: "b" }]),
      EMPTY_INDEX,
      COMPAT,
    );
    expect(mapped.map((model) => model.id)).toEqual(["a", "b"]);
  });
});
