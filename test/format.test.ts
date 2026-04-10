import { describe, it, expect } from "vitest";
import { extractModelOwner, formatModelName } from "../src/format";

describe("extractModelOwner", () => {
  it("should extract owner from 'org/model' format", () => {
    expect(extractModelOwner("qwen/qwen3-30b")).toBe("qwen");
    expect(extractModelOwner("meta-llama/llama-3.1-8b")).toBe("meta-llama");
  });

  it("should return undefined for plain model IDs", () => {
    expect(extractModelOwner("qwen3-30b")).toBeUndefined();
    expect(extractModelOwner("llama3:8b")).toBeUndefined();
  });
});

describe("formatModelName", () => {
  it("should format model names with capitalization", () => {
    expect(formatModelName("qwen3-30b-a3b")).toBe("Qwen3 30B A3B");
  });

  it("should handle model IDs with owner prefix", () => {
    expect(formatModelName("qwen/qwen3-30b")).toBe("Qwen3 30B");
  });

  it("should uppercase known acronyms", () => {
    expect(formatModelName("nomic-embed-text")).toBe("NOMIC Embed Text");
  });

  it("should split on colons for Ollama-style IDs", () => {
    expect(formatModelName("qwen3:0.6b")).toBe("Qwen3 0.6B");
    expect(formatModelName("qwen3:30b-a3b")).toBe("Qwen3 30B A3B");
    expect(formatModelName("smollm2:135m")).toBe("Smollm2 135M");
  });
});
