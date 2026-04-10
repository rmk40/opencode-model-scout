import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { probeTgi } from "../../src/probes/tgi";

const mockFetch = vi.fn();
global.fetch = mockFetch;

if (!global.AbortSignal.timeout) {
  global.AbortSignal.timeout = vi.fn(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    return controller.signal;
  });
}

describe("probeTgi", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should extract metadata from /info response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_id: "meta-llama/Llama-3-8B-Instruct",
        max_total_tokens: 8192,
        max_input_tokens: 7168,
        model_pipeline_tag: "text-generation",
        router: "text-generation-router",
        version: "3.2.0",
      }),
    });

    const result = await probeTgi("http://localhost:8000");

    expect(Object.keys(result.models)).toHaveLength(1);
    const model = result.models["meta-llama/Llama-3-8B-Instruct"];
    expect(model).toBeDefined();
    expect(model.context).toBe(8192);
    expect(model.maxTokens).toBe(1024); // 8192 - 7168
    expect(model.modelType).toBe("llm");
    expect(model.temperature).toBe(true);
  });

  it("should handle network error gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await probeTgi("http://localhost:8000");
    expect(result).toEqual({ models: {} });
  });

  it("should handle non-OK HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await probeTgi("http://localhost:8000");
    expect(result).toEqual({ models: {} });
  });

  it("should prefer discovered model ID over /info model_id", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_id: "meta-llama/Llama-3-8B-Instruct",
        max_total_tokens: 8192,
        model_pipeline_tag: "text-generation",
      }),
    });

    const result = await probeTgi("http://localhost:8000", undefined, {
      modelsResponse: [
        {
          id: "my-alias",
          object: "model",
          created: 1700000000,
          owned_by: "tgi",
        },
      ],
    });

    // Should key by the discovered ID, not /info model_id
    expect(result.models["my-alias"]).toBeDefined();
    expect(result.models["meta-llama/Llama-3-8B-Instruct"]).toBeUndefined();
  });

  it("should not set negative maxTokens", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_id: "misconfigured-model",
        max_total_tokens: 1000,
        max_input_tokens: 2000,
        model_pipeline_tag: "text-generation",
      }),
    });

    const result = await probeTgi("http://localhost:8000");
    const model = result.models["misconfigured-model"];
    expect(model).toBeDefined();
    expect(model.context).toBe(1000);
    expect(model.maxTokens).toBeUndefined();
  });

  it("should map feature-extraction pipeline tag to embedding", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_id: "BAAI/bge-large-en",
        max_total_tokens: 512,
        model_pipeline_tag: "feature-extraction",
      }),
    });

    const result = await probeTgi("http://localhost:8000");
    const model = result.models["BAAI/bge-large-en"];
    expect(model).toBeDefined();
    expect(model.modelType).toBe("embedding");
  });

  it("should use model ID from modelsResponse when /info has no model_id", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        max_total_tokens: 4096,
        max_input_tokens: 3072,
        model_pipeline_tag: "text-generation",
        router: "text-generation-router",
        version: "3.2.0",
      }),
    });

    const result = await probeTgi("http://localhost:8000", undefined, {
      modelsResponse: [
        {
          id: "my-custom-model",
          object: "model",
          created: 1700000000,
          owned_by: "tgi",
        },
      ],
    });

    expect(Object.keys(result.models)).toHaveLength(1);
    const model = result.models["my-custom-model"];
    expect(model).toBeDefined();
    expect(model.context).toBe(4096);
    expect(model.maxTokens).toBe(1024); // 4096 - 3072
  });
});
