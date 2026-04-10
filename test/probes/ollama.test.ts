import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { probeOllama } from "../../src/probes/ollama";

const mockFetch = vi.fn();
global.fetch = mockFetch;

if (!global.AbortSignal.timeout) {
  global.AbortSignal.timeout = vi.fn(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    return controller.signal;
  });
}

/**
 * Helper: create a mock fetch that routes to different handlers based on URL.
 * tagsResponse is for GET /api/tags.
 * showResponses is a map from model name to the /api/show response body.
 */
function setupOllamaMocks(
  tagsResponse: { ok: boolean; status?: number; body?: unknown },
  showResponses?: Record<
    string,
    { ok: boolean; status?: number; body?: unknown } | "reject"
  >,
) {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/tags")) {
      if (!tagsResponse.ok) {
        return { ok: false, status: tagsResponse.status ?? 500 };
      }
      return { ok: true, json: async () => tagsResponse.body };
    }

    if (url.endsWith("/api/show") && showResponses) {
      const bodyStr = init?.body as string;
      const parsed = JSON.parse(bodyStr);
      const modelName = parsed.model as string;
      const resp = showResponses[modelName];

      if (resp === "reject") {
        throw new Error("Connection refused");
      }
      if (!resp || !resp.ok) {
        return { ok: false, status: resp?.status ?? 500 };
      }
      return { ok: true, json: async () => resp.body };
    }

    return { ok: false, status: 404 };
  });
}

describe("probeOllama", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should extract metadata from Ollama tags and show responses", async () => {
    setupOllamaMocks(
      {
        ok: true,
        body: {
          models: [
            {
              name: "qwen3:30b",
              size: 19854000000,
              details: {
                parameter_size: "30.5B",
                family: "qwen3",
                quantization_level: "Q4_K_M",
              },
            },
            {
              name: "gemma3:12b",
              size: 8100000000,
              details: {
                parameter_size: "12B",
                family: "gemma3",
                quantization_level: "Q8_0",
              },
            },
          ],
        },
      },
      {
        "qwen3:30b": {
          ok: true,
          body: {
            model_info: {
              "qwen3.context_length": 40960,
            },
            details: {
              parameter_size: "30.5B",
              family: "qwen3",
              quantization_level: "Q4_K_M",
            },
            capabilities: ["completion", "tools"],
          },
        },
        "gemma3:12b": {
          ok: true,
          body: {
            model_info: {
              "gemma3.context_length": 131072,
            },
            details: {
              parameter_size: "12B",
              family: "gemma3",
              quantization_level: "Q8_0",
            },
            capabilities: ["completion", "tools", "vision", "thinking"],
          },
        },
      },
    );

    const result = await probeOllama("http://localhost:11434");

    expect(Object.keys(result.models)).toHaveLength(2);

    const qwen = result.models["qwen3:30b"];
    expect(qwen).toBeDefined();
    expect(qwen.context).toBe(40960);
    expect(qwen.toolCall).toBe(true);
    expect(qwen.vision).toBeUndefined();
    expect(qwen.reasoning).toBeUndefined();
    expect(qwen.modelType).toBe("llm");
    expect(qwen.sizeBytes).toBe(19854000000);
    expect(qwen.parameterSize).toBe("30.5B");
    expect(qwen.family).toBe("qwen3");
    expect(qwen.quantization).toBe("Q4_K_M");
    expect(qwen.temperature).toBe(true);

    const gemma = result.models["gemma3:12b"];
    expect(gemma).toBeDefined();
    expect(gemma.context).toBe(131072);
    expect(gemma.toolCall).toBe(true);
    expect(gemma.vision).toBe(true);
    expect(gemma.reasoning).toBe(true);
    expect(gemma.modelType).toBe("vlm");
    expect(gemma.sizeBytes).toBe(8100000000);
  });

  it("should handle /api/tags failure gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await probeOllama("http://localhost:11434");
    expect(result).toEqual({ models: {} });
  });

  it("should handle non-OK /api/tags response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    const result = await probeOllama("http://localhost:11434");
    expect(result).toEqual({ models: {} });
  });

  it("should handle individual /api/show failures gracefully", async () => {
    setupOllamaMocks(
      {
        ok: true,
        body: {
          models: [
            {
              name: "model-a",
              size: 5000000000,
              details: { family: "llama" },
            },
            {
              name: "model-b",
              size: 3000000000,
              details: { family: "mistral" },
            },
          ],
        },
      },
      {
        "model-a": {
          ok: true,
          body: {
            model_info: { "llama.context_length": 8192 },
            capabilities: ["completion", "tools"],
          },
        },
        "model-b": "reject",
      },
    );

    const result = await probeOllama("http://localhost:11434");

    expect(Object.keys(result.models)).toHaveLength(2);

    // model-a has full data from /api/show
    const a = result.models["model-a"];
    expect(a.context).toBe(8192);
    expect(a.toolCall).toBe(true);
    expect(a.modelType).toBe("llm");

    // model-b has only partial data from tags (no show data)
    const b = result.models["model-b"];
    expect(b.sizeBytes).toBe(3000000000);
    expect(b.family).toBe("mistral");
    expect(b.context).toBeUndefined();
    expect(b.toolCall).toBeUndefined();
    expect(b.modelType).toBeUndefined();
  });

  it("should extract context_length from different architecture-namespaced keys", async () => {
    setupOllamaMocks(
      {
        ok: true,
        body: {
          models: [
            { name: "llama3:8b", size: 4000000000 },
            { name: "qwen3moe:30b", size: 19000000000 },
          ],
        },
      },
      {
        "llama3:8b": {
          ok: true,
          body: {
            model_info: {
              "llama.context_length": 8192,
              "general.architecture": "llama",
            },
            capabilities: ["completion"],
          },
        },
        "qwen3moe:30b": {
          ok: true,
          body: {
            model_info: {
              "qwen3moe.context_length": 40960,
              "general.architecture": "qwen3moe",
            },
            capabilities: ["completion"],
          },
        },
      },
    );

    const result = await probeOllama("http://localhost:11434");

    expect(result.models["llama3:8b"].context).toBe(8192);
    expect(result.models["qwen3moe:30b"].context).toBe(40960);
  });

  it("should handle empty model list", async () => {
    setupOllamaMocks({ ok: true, body: { models: [] } });

    const result = await probeOllama("http://localhost:11434");
    expect(result).toEqual({ models: {} });

    // No /api/show calls should have been made
    const showCalls = mockFetch.mock.calls.filter((call) =>
      (call[0] as string).endsWith("/api/show"),
    );
    expect(showCalls).toHaveLength(0);
  });

  it("should classify embedding models correctly", async () => {
    setupOllamaMocks(
      {
        ok: true,
        body: {
          models: [{ name: "nomic-embed-text", size: 274000000 }],
        },
      },
      {
        "nomic-embed-text": {
          ok: true,
          body: {
            model_info: { "nomic-bert.context_length": 8192 },
            capabilities: ["embedding"],
          },
        },
      },
    );

    const result = await probeOllama("http://localhost:11434");

    const embed = result.models["nomic-embed-text"];
    expect(embed).toBeDefined();
    expect(embed.modelType).toBe("embedding");
  });

  it("should handle null/undefined models in tags response", async () => {
    setupOllamaMocks({ ok: true, body: {} });

    const result = await probeOllama("http://localhost:11434");
    expect(result).toEqual({ models: {} });
  });

  it("should only set capability flags to true, not false", async () => {
    setupOllamaMocks(
      {
        ok: true,
        body: {
          models: [{ name: "basic-model", size: 2000000000 }],
        },
      },
      {
        "basic-model": {
          ok: true,
          body: {
            model_info: {},
            capabilities: ["completion"],
          },
        },
      },
    );

    const result = await probeOllama("http://localhost:11434");

    const model = result.models["basic-model"];
    expect(model).toBeDefined();
    expect(model.toolCall).toBeUndefined();
    expect(model.vision).toBeUndefined();
    expect(model.reasoning).toBeUndefined();
    // modelType is set to "llm" for non-embedding, non-vision models
    expect(model.modelType).toBe("llm");
  });
});
