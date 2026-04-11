import { describe, it, expect } from "vitest";
import { formatModelsTable, formatNumber, formatBytes } from "../src/command";
import type { DiscoverySnapshot } from "../src/discover";

describe("formatModelsTable", () => {
  it("should show message for empty store", () => {
    const result = formatModelsTable([]);
    expect(result).toContain("No models discovered");
  });

  it("should format a single provider with no probe", () => {
    const snapshots: DiscoverySnapshot[] = [
      {
        provider: "local-server",
        probeType: undefined,
        baseURL: "http://localhost:8000",
        models: {
          "qwen3-30b": {
            id: "qwen3-30b",
            name: "Qwen3 30B",
          },
        },
      },
    ];

    const result = formatModelsTable(snapshots);
    expect(result).toContain("local-server");
    expect(result).toContain("(no probe)");
    expect(result).toContain("qwen3-30b");
  });

  it("should format a provider with probe metadata", () => {
    const snapshots: DiscoverySnapshot[] = [
      {
        provider: "omlx-local",
        probeType: "omlx",
        baseURL: "http://localhost:8000",
        models: {
          "qwen3-30b": {
            id: "qwen3-30b",
            name: "Qwen3 30B",
            limit: { context: 131072, output: 32768 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    ];

    const result = formatModelsTable(snapshots);
    expect(result).toContain("omlx-local");
    expect(result).toContain("probe: omlx");
    expect(result).toContain("131,072");
    expect(result).toContain("32,768");
    expect(result).toContain("Type: llm");
  });

  it("should show Vision flag for VLM model", () => {
    const snapshots: DiscoverySnapshot[] = [
      {
        provider: "omlx-local",
        probeType: "omlx",
        baseURL: "http://localhost:8000",
        models: {
          "gemma3-12b-it": {
            id: "gemma3-12b-it",
            name: "Gemma3 12B IT",
            modalities: { input: ["text", "image"], output: ["text"] },
            attachment: true,
          },
        },
      },
    ];

    const result = formatModelsTable(snapshots);
    expect(result).toContain("Type: vlm");
    expect(result).toContain("Vision");
  });

  it("should show capability flags", () => {
    const snapshots: DiscoverySnapshot[] = [
      {
        provider: "ollama-local",
        probeType: "ollama",
        baseURL: "http://localhost:11434",
        models: {
          "qwen3:30b": {
            id: "qwen3:30b",
            name: "Qwen3 30B",
            tool_call: true,
            reasoning: true,
            temperature: true,
            family: "qwen3",
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    ];

    const result = formatModelsTable(snapshots);
    expect(result).toContain("Tools");
    expect(result).toContain("Reasoning");
    expect(result).toContain("Temp");
    expect(result).toContain("Family: qwen3");
  });

  it("should format multiple providers", () => {
    const snapshots: DiscoverySnapshot[] = [
      {
        provider: "provider-a",
        probeType: "omlx",
        baseURL: "http://localhost:8000",
        models: {
          "model-a": { id: "model-a", name: "Model A" },
        },
      },
      {
        provider: "provider-b",
        probeType: "ollama",
        baseURL: "http://localhost:11434",
        models: {
          "model-b": { id: "model-b", name: "Model B" },
        },
      },
    ];

    const result = formatModelsTable(snapshots);
    expect(result).toContain("provider-a");
    expect(result).toContain("provider-b");
    expect(result).toContain("model-a");
    expect(result).toContain("model-b");
    // Each provider gets a separator
    const separatorCount = (result.match(/\u2500{50}/g) || []).length;
    expect(separatorCount).toBe(2);
  });
});

describe("formatNumber", () => {
  it("should format numbers with commas", () => {
    expect(formatNumber(262144)).toBe("262,144");
    expect(formatNumber(1000)).toBe("1,000");
    expect(formatNumber(42)).toBe("42");
    expect(formatNumber(1000000)).toBe("1,000,000");
  });
});

describe("formatBytes", () => {
  it("should format bytes as human readable", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1048576)).toBe("1.0 MB");
    expect(formatBytes(1572864)).toBe("1.5 MB");
    expect(formatBytes(1073741824)).toBe("1.0 GB");
    expect(formatBytes(20285680936)).toBe("18.9 GB");
  });
});
