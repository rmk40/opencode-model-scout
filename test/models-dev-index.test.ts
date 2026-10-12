import { describe, expect, it } from "vitest";
import {
  buildModelsDevIndex,
  createModelsDevIndexCache,
  findModelsDevMatch,
  type SourceModelLike,
  type SourceRecordLike,
} from "../src/models-dev-index";

function model(
  overrides: Partial<{
    family: string;
    tools: boolean;
    input: string[];
    variants: unknown[];
  }> = {},
): SourceModelLike {
  return {
    ...(overrides.family ? { family: overrides.family } : {}),
    capabilities: {
      tools: overrides.tools ?? true,
      input: overrides.input ?? ["text"],
    },
    variants: overrides.variants ?? [],
  };
}

function record(
  id: string,
  models: Record<string, SourceModelLike>,
): SourceRecordLike {
  return { provider: { id }, models: new Map(Object.entries(models)) };
}

describe("findModelsDevMatch", () => {
  const index = buildModelsDevIndex([
    record("catalog", {
      "qwen/qwen3-30b-a3b": model({
        family: "qwen3",
        input: ["text", "image"],
      }),
      "qwen3-14b": model({ family: "qwen3", input: ["text", "pdf"] }),
      "qwen3-4b": model({ family: "qwen3", tools: false }),
      "llama-3.1-8b": model({ family: "llama", variants: [{ id: "high" }] }),
    }),
  ]);

  it("prefers an exact normalized ID over family matches", () => {
    expect(findModelsDevMatch("Qwen3:30B-A3B", index)).toMatchObject({
      input: ["text", "image"],
    });
  });

  it("matches family plus size without matching a size inside a larger one", () => {
    expect(findModelsDevMatch("qwen3:14b-instruct", index)).toMatchObject({
      input: ["text", "pdf"],
    });
    // "qwen3-14b" comes first in the index; "4b" must not match inside "14b".
    expect(findModelsDevMatch("qwen3:4b-instruct", index)).toMatchObject({
      tools: false,
    });
  });

  it("falls back to a family-only match", () => {
    expect(findModelsDevMatch("llama-3.2-1b-instruct", index)).toMatchObject({
      family: "llama",
    });
  });

  it("returns undefined when nothing matches", () => {
    expect(findModelsDevMatch("totally-unknown", index)).toBeUndefined();
  });

  it("counts non-empty variants as reasoning and empty variants as unknown", () => {
    expect(findModelsDevMatch("llama-3.1-8b", index)?.reasoning).toBe(true);
    expect(findModelsDevMatch("qwen3-4b", index)?.reasoning).toBe(false);
  });

  it("skips records whose capabilities are malformed", () => {
    const malformed = buildModelsDevIndex([
      record("catalog", {
        broken: {
          capabilities: null,
          variants: [],
        } as unknown as SourceModelLike,
      }),
    ]);
    expect(findModelsDevMatch("broken", malformed)).toBeUndefined();
  });
});

describe("createModelsDevIndexCache", () => {
  it("reuses the index while every record keeps its identity", () => {
    const cache = createModelsDevIndexCache();
    const first = record("a", { "m-1": model() });
    const second = record("b", { "m-2": model() });
    const index = cache([first, second]);
    expect(cache([first, second])).toBe(index);
  });

  it("rebuilds when a record is replaced", () => {
    const cache = createModelsDevIndexCache();
    const first = record("a", { "m-1": model() });
    const index = cache([first, record("b", { "m-2": model() })]);
    const rebuilt = cache([first, record("b", { "m-3": model() })]);
    expect(rebuilt).not.toBe(index);
    expect(findModelsDevMatch("m-3", rebuilt)).toBeDefined();
  });
});
