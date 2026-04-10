import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { probeLmstudio } from "../../src/probes/lmstudio";

const mockFetch = vi.fn();
global.fetch = mockFetch;

if (!global.AbortSignal.timeout) {
  global.AbortSignal.timeout = vi.fn(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    return controller.signal;
  });
}

describe("probeLmstudio", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should extract full metadata from /api/v1/models", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          key: "qwen3-30b-a3b",
          type: "llm",
          display_name: "Qwen3 30B A3B",
          publisher: "qwen",
          architecture: "qwen3",
          quantization: { name: "Q4_K_M", bits_per_weight: 4.5 },
          size_bytes: 20285680936,
          params_string: "30.5B",
          max_context_length: 131072,
          format: "gguf",
        },
      ],
    });

    const result = await probeLmstudio("http://localhost:8000");

    expect(Object.keys(result.models)).toHaveLength(1);
    const model = result.models["qwen3-30b-a3b"];
    expect(model).toBeDefined();
    expect(model.context).toBe(131072);
    expect(model.family).toBe("qwen3");
    expect(model.parameterSize).toBe("30.5B");
    expect(model.quantization).toBe("Q4_K_M");
    expect(model.sizeBytes).toBe(20285680936);
    expect(model.modelType).toBe("llm");
    expect(model.temperature).toBe(true);
  });

  it("should detect vision and tool_call from capabilities", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          key: "gemma3-12b",
          type: "llm",
          capabilities: { vision: true, trained_for_tool_use: true },
        },
      ],
    });

    const result = await probeLmstudio("http://localhost:8000");

    const model = result.models["gemma3-12b"];
    expect(model).toBeDefined();
    expect(model.vision).toBe(true);
    expect(model.toolCall).toBe(true);
    expect(model.modelType).toBe("vlm");
  });

  it("should detect loaded state from loaded_instances", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          key: "model-a",
          type: "llm",
          loaded_instances: [{ id: "inst-1" }],
        },
      ],
    });

    const result = await probeLmstudio("http://localhost:8000");

    const model = result.models["model-a"];
    expect(model).toBeDefined();
    expect(model.loaded).toBe(true);
  });

  it("should handle network error gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await probeLmstudio("http://localhost:8000");
    expect(result).toEqual({ models: {} });
  });

  it("should handle empty model list", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const result = await probeLmstudio("http://localhost:8000");
    expect(result).toEqual({ models: {} });
  });
});
