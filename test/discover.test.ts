import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { discoverModels, getDiscoveryStore } from "../src/discover";
import { formatModelsTable } from "../src/command";
import type { DiscoverySnapshot } from "../src/discover";

const mockFetch = vi.fn();
global.fetch = mockFetch;

if (!global.AbortSignal.timeout) {
  global.AbortSignal.timeout = vi.fn(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    return controller.signal;
  });
}

if (!global.AbortSignal.any) {
  global.AbortSignal.any = vi.fn(() => {
    const controller = new AbortController();
    return controller.signal;
  });
}

/**
 * Helper: route fetch calls to handlers based on URL pattern.
 */
function setupFetchRouter(
  routes: Record<
    string,
    | { ok: boolean; status?: number; body?: unknown }
    | (() => { ok: boolean; status?: number; body?: unknown })
    | "reject"
  >,
) {
  mockFetch.mockImplementation(async (url: string) => {
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        if (handler === "reject") {
          throw new Error("ECONNREFUSED");
        }
        const resolved = typeof handler === "function" ? handler() : handler;
        if (!resolved.ok) {
          return { ok: false, status: resolved.status ?? 500 };
        }
        return { ok: true, json: async () => resolved.body };
      }
    }
    return { ok: false, status: 404 };
  });
}

describe("discoverModels", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should discover models from OpenAI-compatible provider", async () => {
    setupFetchRouter({
      "/v1/models": {
        ok: true,
        body: {
          object: "list",
          data: [
            {
              id: "qwen3-30b-a3b",
              object: "model",
              created: 1700000000,
              owned_by: "local",
            },
          ],
        },
      },
    });

    const config: Record<string, unknown> = {
      provider: {
        "my-provider": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8000/v1",
          },
        },
      },
    };

    await discoverModels(config);

    const providers = config.provider as Record<
      string,
      Record<string, unknown>
    >;
    const models = providers["my-provider"].models as Record<string, unknown>;
    expect(models["qwen3-30b-a3b"]).toBeDefined();

    const store = getDiscoveryStore();
    expect(store).toHaveLength(1);
    expect(store[0].provider).toBe("my-provider");
  });

  it("should enrich models with oMLX probe", async () => {
    setupFetchRouter({
      "/v1/models/status": {
        ok: true,
        body: {
          models: [
            {
              id: "qwen3-30b-a3b",
              loaded: true,
              model_type: "llm",
              max_context_window: 131072,
              max_tokens: 32768,
            },
          ],
        },
      },
      "/v1/models": {
        ok: true,
        body: {
          object: "list",
          data: [
            {
              id: "qwen3-30b-a3b",
              object: "model",
              created: 1700000000,
              owned_by: "local",
            },
          ],
        },
      },
    });

    const config: Record<string, unknown> = {
      provider: {
        "omlx-local": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8000/v1",
            probe: "omlx",
          },
        },
      },
    };

    await discoverModels(config);

    const providers = config.provider as Record<
      string,
      Record<string, unknown>
    >;
    const models = providers["omlx-local"].models as Record<
      string,
      Record<string, unknown>
    >;
    const model = models["qwen3-30b-a3b"];
    expect(model).toBeDefined();
    expect(model.limit).toEqual({ context: 131072, output: 32768 });
    expect(model.modalities).toEqual({ input: ["text"], output: ["text"] });
  });

  it("should not run probe when options.probe is not set", async () => {
    setupFetchRouter({
      "/v1/models": {
        ok: true,
        body: {
          object: "list",
          data: [
            {
              id: "some-model",
              object: "model",
              created: 1700000000,
              owned_by: "local",
            },
          ],
        },
      },
    });

    const config: Record<string, unknown> = {
      provider: {
        "no-probe": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8000/v1",
          },
        },
      },
    };

    await discoverModels(config);

    // Verify no probe-specific endpoints were called
    const calls = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(calls.some((u) => u.includes("/models/status"))).toBe(false);
    expect(calls.some((u) => u.includes("/api/tags"))).toBe(false);
    expect(calls.some((u) => u.includes("/api/show"))).toBe(false);
  });

  it("should handle probe failure without breaking discovery", async () => {
    setupFetchRouter({
      "/v1/models/status": {
        ok: false,
        status: 500,
      },
      "/v1/models": {
        ok: true,
        body: {
          object: "list",
          data: [
            {
              id: "qwen3-30b",
              object: "model",
              created: 1700000000,
              owned_by: "local",
            },
          ],
        },
      },
    });

    const config: Record<string, unknown> = {
      provider: {
        "my-provider": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8000/v1",
            probe: "omlx",
          },
        },
      },
    };

    await discoverModels(config);

    const providers = config.provider as Record<
      string,
      Record<string, unknown>
    >;
    const models = providers["my-provider"].models as Record<string, unknown>;
    // Model still discovered, just no enrichment
    expect(models["qwen3-30b"]).toBeDefined();
  });

  it("should not modify manually configured models", async () => {
    setupFetchRouter({
      "/v1/models/status": {
        ok: true,
        body: {
          models: [
            {
              id: "manually-configured",
              loaded: true,
              model_type: "llm",
              max_context_window: 131072,
              max_tokens: 32768,
            },
          ],
        },
      },
      "/v1/models": {
        ok: true,
        body: {
          object: "list",
          data: [
            {
              id: "manually-configured",
              object: "model",
              created: 1700000000,
              owned_by: "local",
            },
            {
              id: "discovered-model",
              object: "model",
              created: 1700000000,
              owned_by: "local",
            },
          ],
        },
      },
    });

    const existingModelConfig = {
      id: "manually-configured",
      name: "My Custom Config",
      limit: { context: 4096, output: 1024 },
    };

    const config: Record<string, unknown> = {
      provider: {
        "my-provider": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8000/v1",
            probe: "omlx",
          },
          models: {
            "manually-configured": existingModelConfig,
          },
        },
      },
    };

    await discoverModels(config);

    const providers = config.provider as Record<
      string,
      Record<string, unknown>
    >;
    const models = providers["my-provider"].models as Record<
      string,
      Record<string, unknown>
    >;

    // Manually configured model should NOT be overwritten
    expect(models["manually-configured"]).toBe(existingModelConfig);
    expect(models["manually-configured"].name).toBe("My Custom Config");
    expect(models["manually-configured"].limit).toEqual({
      context: 4096,
      output: 1024,
    });

    // But the new model should be discovered
    expect(models["discovered-model"]).toBeDefined();
  });

  it("should skip non-OpenAI-compatible providers", async () => {
    const config: Record<string, unknown> = {
      provider: {
        anthropic: {
          npm: "@ai-sdk/anthropic",
          options: {
            apiKey: "sk-test",
          },
        },
      },
    };

    await discoverModels(config);

    // No fetch calls should have been made
    expect(mockFetch).not.toHaveBeenCalled();

    const store = getDiscoveryStore();
    expect(store).toHaveLength(0);
  });

  it("should handle offline providers gracefully", async () => {
    setupFetchRouter({
      "/v1/models": "reject",
    });

    const config: Record<string, unknown> = {
      provider: {
        "offline-provider": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:9999/v1",
          },
        },
      },
    };

    // Should not throw
    await discoverModels(config);

    const store = getDiscoveryStore();
    expect(store).toHaveLength(0);
  });

  it('should auto-detect and run probe when probe is "auto"', async () => {
    setupFetchRouter({
      "/v1/models": {
        ok: true,
        body: {
          object: "list",
          data: [
            {
              id: "meta-llama/Llama-3-8B",
              object: "model",
              created: 1700000000,
              owned_by: "vllm",
              max_model_len: 8192,
            },
          ],
        },
      },
    });

    const config: Record<string, unknown> = {
      provider: {
        "vllm-provider": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8000/v1",
            probe: "auto",
          },
        },
      },
    };

    await discoverModels(config);

    const providers = config.provider as Record<
      string,
      Record<string, unknown>
    >;
    const models = providers["vllm-provider"].models as Record<
      string,
      Record<string, unknown>
    >;
    const model = models["meta-llama/Llama-3-8B"];
    expect(model).toBeDefined();
    expect(model.limit).toEqual({ context: 8192 });
  });

  it("should skip probing when auto-detection returns undefined", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/v1/models")) {
        return {
          ok: true,
          json: async () => ({
            object: "list",
            data: [
              {
                id: "some-model",
                object: "model",
                created: 1700000000,
                owned_by: "unknown-provider",
              },
            ],
          }),
        };
      }
      // All fingerprint endpoints return 404
      return { ok: false, status: 404 };
    });

    const config: Record<string, unknown> = {
      provider: {
        "mystery-provider": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8000/v1",
            probe: "auto",
          },
        },
      },
    };

    await discoverModels(config);

    const providers = config.provider as Record<
      string,
      Record<string, unknown>
    >;
    const models = providers["mystery-provider"].models as Record<
      string,
      Record<string, unknown>
    >;
    // Model discovered but no probe enrichment (no limit set)
    expect(models["some-model"]).toBeDefined();
    expect(models["some-model"].limit).toBeUndefined();
  });

  it("should include detectedServer in discovery snapshot", async () => {
    setupFetchRouter({
      "/v1/models": {
        ok: true,
        body: {
          object: "list",
          data: [
            {
              id: "meta-llama/Llama-3-8B",
              object: "model",
              created: 1700000000,
              owned_by: "vllm",
              max_model_len: 8192,
            },
          ],
        },
      },
    });

    const config: Record<string, unknown> = {
      provider: {
        "auto-vllm": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8000/v1",
            probe: "auto",
          },
        },
      },
    };

    await discoverModels(config);

    const store = getDiscoveryStore();
    expect(store).toHaveLength(1);
    expect(store[0].detectedServer).toBe("vllm");
  });

  it("should still work with explicit probe names", async () => {
    setupFetchRouter({
      "/v1/models/status": {
        ok: true,
        body: {
          models: [
            {
              id: "qwen3-30b-a3b",
              loaded: true,
              model_type: "llm",
              max_context_window: 131072,
              max_tokens: 32768,
            },
          ],
        },
      },
      "/v1/models": {
        ok: true,
        body: {
          object: "list",
          data: [
            {
              id: "qwen3-30b-a3b",
              object: "model",
              created: 1700000000,
              owned_by: "local",
            },
          ],
        },
      },
    });

    const config: Record<string, unknown> = {
      provider: {
        "explicit-omlx": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8000/v1",
            probe: "omlx",
          },
        },
      },
    };

    await discoverModels(config);

    const providers = config.provider as Record<
      string,
      Record<string, unknown>
    >;
    const models = providers["explicit-omlx"].models as Record<
      string,
      Record<string, unknown>
    >;
    const model = models["qwen3-30b-a3b"];
    expect(model).toBeDefined();
    expect(model.limit).toEqual({ context: 131072, output: 32768 });
  });

  it("should abort discovery when signal is already aborted", async () => {
    setupFetchRouter({
      "/v1/models": {
        ok: true,
        body: {
          object: "list",
          data: [
            {
              id: "some-model",
              object: "model",
              created: 1700000000,
              owned_by: "local",
            },
          ],
        },
      },
    });

    const controller = new AbortController();
    controller.abort();

    const config: Record<string, unknown> = {
      provider: {
        "my-provider": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8000/v1",
          },
        },
      },
    };

    await discoverModels(config, undefined, controller.signal);

    // No fetch calls should have been made — abort checked before any work
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should continue discovery when one provider throws", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      // Provider A: model list succeeds, but fingerprint probe endpoint throws
      if (url.includes("localhost:8001") && url.includes("/v1/models")) {
        return {
          ok: true,
          json: async () => ({
            object: "list",
            data: [
              {
                id: "model-a",
                object: "model",
                created: 1700000000,
                owned_by: "unknown-corp",
              },
            ],
          }),
        };
      }
      // Provider A: any other endpoint throws (simulates network error during probe)
      if (url.includes("localhost:8001")) {
        throw new TypeError("ECONNREFUSED");
      }

      // Provider B: everything works
      if (url.includes("localhost:8002") && url.includes("/v1/models")) {
        return {
          ok: true,
          json: async () => ({
            object: "list",
            data: [
              {
                id: "model-b",
                object: "model",
                created: 1700000000,
                owned_by: "local",
              },
            ],
          }),
        };
      }

      return { ok: false, status: 404 };
    });

    const config: Record<string, unknown> = {
      provider: {
        "provider-a": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8001/v1",
            probe: "auto",
          },
        },
        "provider-b": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8002/v1",
          },
        },
      },
    };

    await discoverModels(config);

    const providers = config.provider as Record<
      string,
      Record<string, unknown>
    >;

    // Provider B's model should still be discovered
    const modelsB = providers["provider-b"].models as Record<string, unknown>;
    expect(modelsB["model-b"]).toBeDefined();
  });

  it("should show auto-detected server in formatModelsTable", () => {
    const snapshots: DiscoverySnapshot[] = [
      {
        provider: "my-vllm",
        probeType: "auto",
        baseURL: "http://localhost:8000",
        models: {
          "meta-llama/Llama-3-8B": {
            id: "meta-llama/Llama-3-8B",
            name: "Llama 3 8B",
            limit: { context: 8192, output: 0 },
          },
        },
        detectedServer: "vllm",
      },
    ];

    const output = formatModelsTable(snapshots);
    expect(output).toContain("auto \u2192 vllm");
  });
});
