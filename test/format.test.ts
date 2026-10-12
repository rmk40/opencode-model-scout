import { describe, it, expect } from "vitest";
import {
  compactCount,
  extractModelOwner,
  formatBytes,
  formatModelName,
  formatNumber,
} from "../src/format";

describe("formatNumber", () => {
  it("should format numbers with commas", () => {
    expect(formatNumber(262144)).toBe("262,144");
    expect(formatNumber(42)).toBe("42");
  });
});

describe("formatBytes", () => {
  it("should pick the unit by magnitude", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1572864)).toBe("1.5 MB");
    expect(formatBytes(20285680936)).toBe("18.9 GB");
  });
});

describe("compactCount", () => {
  it("compacts thousands and millions", () => {
    expect(compactCount(262144)).toBe("262K");
    expect(compactCount(1000000)).toBe("1M");
    expect(compactCount(1500000)).toBe("1.5M");
  });

  it("passes small values through with commas", () => {
    expect(compactCount(512)).toBe("512");
  });

  it("rolls over to millions instead of rendering 1000K", () => {
    expect(compactCount(999999)).toBe("1M");
    expect(compactCount(999499)).toBe("999K");
  });
});

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
