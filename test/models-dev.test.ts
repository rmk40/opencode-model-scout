import { describe, it, expect } from "vitest";
import { findMatch, type ModelsDevMeta } from "../src/models-dev";

/** Helper to build a flat model entry for the index. */
function entry(id: string, meta: Partial<ModelsDevMeta> & { family?: string }) {
  const normalized = id.toLowerCase().replace(/.*\//, "").replace(/:/g, "-");
  return {
    id,
    normalized,
    family: meta.family,
    meta: {
      toolCall: meta.toolCall ?? false,
      reasoning: meta.reasoning ?? false,
      attachment: meta.attachment ?? false,
      temperature: meta.temperature ?? true,
      family: meta.family,
      modalities: meta.modalities,
    },
  };
}

const index = [
  entry("qwen3-30b-a3b", {
    family: "qwen",
    toolCall: true,
    reasoning: false,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
  }),
  entry("qwen3-0.6b", {
    family: "qwen",
    toolCall: true,
    reasoning: false,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
  }),
  entry("gemma-3-4b-it", {
    family: "gemma",
    toolCall: true,
    reasoning: false,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
  }),
  entry("llama-3.2-3b-instruct", {
    family: "llama",
    toolCall: false,
    reasoning: false,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
  }),
  entry("deepseek-r1-distill-qwen-7b", {
    family: "deepseek-thinking",
    toolCall: true,
    reasoning: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
  }),
];

describe("findMatch", () => {
  it("should return undefined for empty index", () => {
    expect(findMatch("qwen3:0.6b", [])).toBeUndefined();
  });

  it("should match by exact normalized ID", () => {
    const result = findMatch("qwen3-30b-a3b", index);
    expect(result).toBeDefined();
    expect(result!.toolCall).toBe(true);
    expect(result!.family).toBe("qwen");
  });

  it("should normalize colon to dash for Ollama-style IDs", () => {
    // "qwen3:0.6b" normalizes to "qwen3-0.6b" which matches the index entry
    const result = findMatch("qwen3:0.6b", index);
    expect(result).toBeDefined();
    expect(result!.toolCall).toBe(true);
    expect(result!.family).toBe("qwen");
  });

  it("should match by family + size when exact match fails", () => {
    // "gemma3:4b-it" normalizes to "gemma3-4b-it"
    // No exact match, but family "gemma" + size "4b" matches "gemma-3-4b-it"
    const result = findMatch("gemma3:4b-it", index);
    expect(result).toBeDefined();
    expect(result!.attachment).toBe(true);
    expect(result!.family).toBe("gemma");
  });

  it("should match by family only when size doesn't match", () => {
    // "qwen3:14b" — no exact or size match, but family "qwen" matches
    const result = findMatch("qwen3:14b", index);
    expect(result).toBeDefined();
    expect(result!.toolCall).toBe(true);
    expect(result!.family).toBe("qwen");
  });

  it("should return undefined when no family matches", () => {
    const result = findMatch("smollm2:135m", index);
    expect(result).toBeUndefined();
  });

  it("should strip owner prefix for matching", () => {
    // "meta/llama-3.2-3b-instruct" should match "llama-3.2-3b-instruct"
    const result = findMatch("meta/llama-3.2-3b-instruct", index);
    expect(result).toBeDefined();
    expect(result!.attachment).toBe(true);
    expect(result!.family).toBe("llama");
  });

  it("should match deepseek models by family", () => {
    const result = findMatch("deepseek-r1:7b", index);
    expect(result).toBeDefined();
    expect(result!.reasoning).toBe(true);
  });

  it("should not match 4b inside 14b via family+size tier", () => {
    // Index has only 14b — searching for 4b should NOT match via tier 2 (family+size)
    // but WILL match via tier 3 (family-only fallback) since family "qwen" matches
    const indexWith14b = [
      entry("qwen3-14b", {
        family: "qwen",
        toolCall: true,
        reasoning: true,
      }),
    ];
    // Verify match comes from family-only, not from 4b matching inside 14b
    const result = findMatch("qwen3:4b", indexWith14b);
    expect(result).toBeDefined(); // matches via family-only fallback
    expect(result!.family).toBe("qwen");

    // Now add a real 4b model — it should be preferred over 14b
    const indexWithBoth = [
      entry("qwen3-14b", {
        family: "qwen",
        toolCall: true,
        reasoning: true,
        attachment: false,
      }),
      entry("qwen3-4b", {
        family: "qwen",
        toolCall: false,
        reasoning: false,
        attachment: true,
      }),
    ];
    const result2 = findMatch("qwen3:4b", indexWithBoth);
    expect(result2).toBeDefined();
    // Should match the 4b entry (exact normalized match), not 14b
    expect(result2!.toolCall).toBe(false);
    expect(result2!.attachment).toBe(true);
  });
});
