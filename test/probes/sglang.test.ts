import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { probeSglang } from "../../src/probes/sglang";

const mockFetch = vi.fn();
global.fetch = mockFetch;

if (!global.AbortSignal.timeout) {
  global.AbortSignal.timeout = vi.fn(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    return controller.signal;
  });
}

describe("probeSglang", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should extract capabilities from /model_info", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_path: "meta-llama/Llama-3-8B-Instruct",
        is_generation: true,
        model_type: "LlamaForCausalLM",
      }),
    });

    const result = await probeSglang("http://localhost:8000");

    expect(Object.keys(result.models)).toHaveLength(1);
    const model = result.models["meta-llama/Llama-3-8B-Instruct"];
    expect(model).toBeDefined();
    expect(model.family).toBe("LlamaForCausalLM");
    expect(model.modelType).toBe("llm");
    expect(model.temperature).toBe(true);
  });

  it("should detect vision from has_image_understanding", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_path: "llava-v1.5-7b",
        has_image_understanding: true,
        model_type: "LlavaForConditionalGeneration",
      }),
    });

    const result = await probeSglang("http://localhost:8000");

    const model = result.models["llava-v1.5-7b"];
    expect(model).toBeDefined();
    expect(model.vision).toBe(true);
    expect(model.modelType).toBe("vlm");
  });

  it("should use max_model_len from modelsResponse for context", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_path: "meta-llama/Llama-3-8B-Instruct",
        is_generation: true,
        model_type: "LlamaForCausalLM",
      }),
    });

    const result = await probeSglang("http://localhost:8000", undefined, {
      modelsResponse: [
        {
          id: "meta-llama/Llama-3-8B-Instruct",
          object: "model",
          created: 1700000000,
          owned_by: "sglang",
          max_model_len: 32768,
        },
      ],
    });

    const model = result.models["meta-llama/Llama-3-8B-Instruct"];
    expect(model).toBeDefined();
    expect(model.context).toBe(32768);
  });

  it("should prefer discovered model ID over model_path", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_path: "meta-llama/Llama-3-8B-Instruct",
        is_generation: true,
        model_type: "llama",
      }),
    });

    const result = await probeSglang("http://localhost:8000", undefined, {
      modelsResponse: [
        {
          id: "my-alias",
          object: "model",
          created: 1700000000,
          owned_by: "sglang",
          max_model_len: 8192,
        },
      ],
    });

    // Should key by the discovered ID, not model_path
    expect(result.models["my-alias"]).toBeDefined();
    expect(result.models["my-alias"].context).toBe(8192);
    expect(result.models["meta-llama/Llama-3-8B-Instruct"]).toBeUndefined();
  });

  it("should handle /model_info failure gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await probeSglang("http://localhost:8000");
    expect(result).toEqual({ models: {} });
  });
});
