import { describe, it, expect } from "vitest";
import { probeOmlx } from "../../src/probes/omlx";

describe("probeOmlx", () => {
  it("should extract metadata from oMLX status response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          {
            id: "qwen3-30b-a3b",
            loaded: true,
            model_type: "llm",
            max_context_window: 131072,
            max_tokens: 32768,
            estimated_size: 20285680936,
          },
          {
            id: "gemma3-12b-it",
            loaded: false,
            model_type: "vlm",
            max_context_window: 262144,
            max_tokens: 16384,
            estimated_size: 8100000000,
          },
        ],
      }),
    });

    const result = await probeOmlx("http://localhost:8000");

    expect(Object.keys(result.models)).toHaveLength(2);

    const llm = result.models["qwen3-30b-a3b"];
    expect(llm).toBeDefined();
    expect(llm.context).toBe(131072);
    expect(llm.maxTokens).toBe(32768);
    expect(llm.modelType).toBe("llm");
    expect(llm.vision).toBeUndefined();
    expect(llm.loaded).toBe(true);
    expect(llm.sizeBytes).toBe(20285680936);

    const vlm = result.models["gemma3-12b-it"];
    expect(vlm).toBeDefined();
    expect(vlm.context).toBe(262144);
    expect(vlm.maxTokens).toBe(16384);
    expect(vlm.modelType).toBe("vlm");
    expect(vlm.vision).toBe(true);
    expect(vlm.loaded).toBe(false);
    expect(vlm.sizeBytes).toBe(8100000000);
  });

  it("should handle network error gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await probeOmlx("http://localhost:8000");
    expect(result).toEqual({ models: {} });
  });

  it("should handle timeout gracefully", async () => {
    const err = new DOMException("The operation was aborted.", "TimeoutError");
    mockFetch.mockRejectedValueOnce(err);

    const result = await probeOmlx("http://localhost:8000");
    expect(result).toEqual({ models: {} });
  });

  it("should handle malformed response gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const result = await probeOmlx("http://localhost:8000");
    expect(result).toEqual({ models: {} });
  });

  it("should handle non-OK HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await probeOmlx("http://localhost:8000");
    expect(result).toEqual({ models: {} });
  });

  it("should work without apiKey", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [] }),
    });

    await probeOmlx("http://localhost:8000");

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("should include apiKey in Authorization header when provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [] }),
    });

    await probeOmlx("http://localhost:8000", "test-key-123");

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key-123");
  });

  it("should not set toolCall", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          {
            id: "model-a",
            loaded: true,
            model_type: "llm",
            max_context_window: 8192,
          },
          {
            id: "model-b",
            loaded: false,
            model_type: "vlm",
          },
        ],
      }),
    });

    const result = await probeOmlx("http://localhost:8000");

    for (const meta of Object.values(result.models)) {
      expect(meta.toolCall).toBeUndefined();
    }
  });

  it("should ignore unknown model_type values", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          {
            id: "whisper-large",
            loaded: true,
            model_type: "audio",
            max_context_window: 4096,
          },
        ],
      }),
    });

    const result = await probeOmlx("http://localhost:8000");

    const model = result.models["whisper-large"];
    expect(model).toBeDefined();
    expect(model.modelType).toBeUndefined();
    expect(model.vision).toBeUndefined();
    expect(model.context).toBe(4096);
  });
});
