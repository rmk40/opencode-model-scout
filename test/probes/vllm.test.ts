import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { probeVllm } from "../../src/probes/vllm";

const mockFetch = vi.fn();
global.fetch = mockFetch;

if (!global.AbortSignal.timeout) {
  global.AbortSignal.timeout = vi.fn(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    return controller.signal;
  });
}

describe("probeVllm", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should extract max_model_len from modelsResponse", async () => {
    const result = await probeVllm("http://localhost:8000", undefined, {
      modelsResponse: [
        {
          id: "model-1",
          object: "model",
          created: 1700000000,
          owned_by: "vllm",
          max_model_len: 8192,
        },
      ],
    });

    expect(Object.keys(result.models)).toHaveLength(1);
    const model = result.models["model-1"];
    expect(model).toBeDefined();
    expect(model.context).toBe(8192);
    expect(model.temperature).toBe(true);
  });

  it("should handle missing max_model_len gracefully", async () => {
    const result = await probeVllm("http://localhost:8000", undefined, {
      modelsResponse: [
        {
          id: "model-1",
          object: "model",
          created: 1700000000,
          owned_by: "vllm",
        },
      ],
    });

    expect(Object.keys(result.models)).toHaveLength(1);
    const model = result.models["model-1"];
    expect(model).toBeDefined();
    expect(model.temperature).toBe(true);
    expect(model.context).toBeUndefined();
  });

  it("should handle empty modelsResponse", async () => {
    const result = await probeVllm("http://localhost:8000", undefined, {
      modelsResponse: [],
    });

    expect(result).toEqual({ models: {} });
  });

  it("should handle undefined context parameter", async () => {
    const result = await probeVllm("http://localhost:8000", undefined);
    expect(result).toEqual({ models: {} });
  });

  it("should handle multiple models in modelsResponse", async () => {
    const result = await probeVllm("http://localhost:8000", undefined, {
      modelsResponse: [
        {
          id: "model-a",
          object: "model",
          created: 1700000000,
          owned_by: "vllm",
          max_model_len: 8192,
        },
        {
          id: "model-b",
          object: "model",
          created: 1700000000,
          owned_by: "vllm",
          max_model_len: 32768,
        },
      ],
    });

    expect(Object.keys(result.models)).toHaveLength(2);
    expect(result.models["model-a"].context).toBe(8192);
    expect(result.models["model-b"].context).toBe(32768);
  });
});
