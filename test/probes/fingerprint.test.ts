import { describe, it, expect } from "vitest";
import { fingerprint, PROBE_MAP } from "../../src/probes/fingerprint";
import type { OpenAIModelEntry } from "../../src/probes/types";

/** Helper: create a minimal OpenAI model entry. */
function makeModel(
  overrides: Partial<OpenAIModelEntry> & { id?: string },
): OpenAIModelEntry {
  return {
    id: overrides.id ?? "test-model",
    object: "model",
    created: 1700000000,
    owned_by: "unknown",
    ...overrides,
  };
}

/** Helper: mock all fetch calls to return 404. */
function mockAllEndpoints404() {
  mockFetch.mockImplementation(async () => ({
    ok: false,
    status: 404,
  }));
}

/** Helper: route fetch calls based on URL patterns. */
function setupFetchRouter(
  routes: Record<
    string,
    { ok: boolean; status?: number; json?: unknown; text?: string } | "reject"
  >,
) {
  mockFetch.mockImplementation(async (url: string) => {
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        if (handler === "reject") {
          throw new Error("ECONNREFUSED");
        }
        if (!handler.ok) {
          return { ok: false, status: handler.status ?? 500 };
        }
        return {
          ok: true,
          json: async () => handler.json,
          text: async () => handler.text ?? "",
        };
      }
    }
    return { ok: false, status: 404 };
  });
}

describe("fingerprint", () => {
  // ── Tier 1 — owned_by detection ──────────────────────────────────

  it("should detect omlx from owned_by", async () => {
    const models = [makeModel({ owned_by: "omlx" })];
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBe("omlx");
  });

  it("should detect vllm from owned_by", async () => {
    const models = [makeModel({ owned_by: "vllm" })];
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBe("vllm");
  });

  it("should detect sglang from owned_by", async () => {
    const models = [makeModel({ owned_by: "sglang" })];
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBe("sglang");
  });

  it("should detect llamacpp from owned_by", async () => {
    const models = [makeModel({ owned_by: "llamacpp" })];
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBe("llamacpp");
  });

  it("should detect koboldcpp from owned_by", async () => {
    const models = [makeModel({ owned_by: "koboldcpp" })];
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBe("koboldcpp");
  });

  it('should detect ollama from owned_by "library"', async () => {
    const models = [makeModel({ owned_by: "library" })];
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBe("ollama");
  });

  it("should detect llamacpp from aliases field", async () => {
    const models = [makeModel({ owned_by: "some-org", aliases: ["alias1"] })];
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBe("llamacpp");
  });

  it("should detect llamacpp from tags field", async () => {
    const models = [makeModel({ owned_by: "some-org", tags: ["tag1"] })];
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBe("llamacpp");
  });

  it("should detect llamacpp from status field", async () => {
    const models = [
      makeModel({ owned_by: "some-org", status: { loaded: true } }),
    ];
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBe("llamacpp");
  });

  it("should prefer owned_by over llamacpp non-standard fields", async () => {
    // A model with owned_by: "vllm" AND tags should be detected as vllm, not llamacpp
    const models = [makeModel({ owned_by: "vllm", tags: ["some-tag"] })];
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBe("vllm");
  });

  it("should handle models with undefined owned_by", async () => {
    const models = [makeModel({ owned_by: undefined })];
    mockAllEndpoints404();
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBeUndefined();
  });

  it("should NOT detect any server from missing/unknown owned_by", async () => {
    const models = [makeModel({ owned_by: "unknown-corp" })];
    mockAllEndpoints404();
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBeUndefined();
  });

  it("should treat mixed owned_by as inconclusive", async () => {
    const models = [
      makeModel({ id: "model-a", owned_by: "vllm" }),
      makeModel({ id: "model-b", owned_by: "sglang" }),
    ];
    mockAllEndpoints404();
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
    );
    expect(result).toBeUndefined();
  });

  // ── Tier 2 — endpoint probes ─────────────────────────────────────

  it("should detect tgi via GET /info with router field", async () => {
    setupFetchRouter({
      "/info": {
        ok: true,
        json: { router: "text-generation-router", version: "1.0" },
      },
    });
    const result = await fingerprint("http://localhost:8000");
    expect(result).toBe("tgi");
  });

  it("should NOT detect tgi from /info without router", async () => {
    setupFetchRouter({
      "/info": { ok: true, json: { version: "1.0" } },
    });
    const result = await fingerprint("http://localhost:8000");
    expect(result).not.toBe("tgi");
  });

  it("should detect lmstudio via GET /api/v1/models with shape", async () => {
    setupFetchRouter({
      "/api/v1/models": {
        ok: true,
        json: [{ key: "model-1", type: "llm" }],
      },
    });
    const result = await fingerprint("http://localhost:8000");
    expect(result).toBe("lmstudio");
  });

  it("should NOT detect lmstudio from generic 200", async () => {
    setupFetchRouter({
      "/api/v1/models": { ok: true, json: {} },
    });
    const result = await fingerprint("http://localhost:8000");
    expect(result).not.toBe("lmstudio");
  });

  // ── Tier 3 — low confidence ──────────────────────────────────────

  it("should NOT auto-route on Ollama root body", async () => {
    setupFetchRouter({
      "/": { ok: true, json: undefined, text: "Ollama is running" },
    });

    // Need to make sure /info and /api/v1/models don't accidentally match "/"
    // The router checks patterns in order, so "/" must come last or be specific
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/info")) {
        return { ok: false, status: 404 };
      }
      if (url.includes("/api/v1/models")) {
        return { ok: false, status: 404 };
      }
      if (url.endsWith("/api/tags")) {
        return { ok: false, status: 404 };
      }
      // Root URL
      return {
        ok: true,
        text: async () => "Ollama is running",
        json: async () => ({}),
      };
    });

    const result = await fingerprint("http://localhost:8000");
    expect(result).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Auto-detect: server looks like Ollama"),
    );
  });

  it("should NOT auto-route on /api/tags match", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "llama3" }] }),
        };
      }
      if (url.endsWith("/")) {
        return {
          ok: true,
          text: async () => "not ollama",
        };
      }
      return { ok: false, status: 404 };
    });

    const result = await fingerprint("http://localhost:8000");
    expect(result).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Auto-detect: server looks like Ollama"),
    );
  });

  it("should NOT detect from /api/tags without models array", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({}),
        };
      }
      if (url.endsWith("/")) {
        return {
          ok: true,
          text: async () => "some other server",
        };
      }
      return { ok: false, status: 404 };
    });

    const result = await fingerprint("http://localhost:8000");
    expect(result).toBeUndefined();
  });

  // ── Integration ──────────────────────────────────────────────────

  it("should return undefined when nothing matches", async () => {
    mockAllEndpoints404();
    const result = await fingerprint("http://localhost:8000");
    expect(result).toBeUndefined();
  });

  it("should return undefined when signal is aborted (unknown owned_by)", async () => {
    const controller = new AbortController();
    controller.abort();

    const models = [makeModel({ owned_by: "unknown-corp" })];
    const result = await fingerprint(
      "http://localhost:8000",
      undefined,
      models,
      controller.signal,
    );
    expect(result).toBeUndefined();
    // Abort check happens after Tier 1, before Tier 2 HTTP probes — no fetch calls
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should map detected server to correct probe", () => {
    expect(PROBE_MAP["llamacpp"]).toBe("ollama");
    expect(PROBE_MAP["ollama"]).toBe("ollama");
    expect(PROBE_MAP["omlx"]).toBe("omlx");
    expect(PROBE_MAP["vllm"]).toBe("vllm");
    expect(PROBE_MAP["tgi"]).toBe("tgi");
    expect(PROBE_MAP["sglang"]).toBe("sglang");
    expect(PROBE_MAP["lmstudio"]).toBe("lmstudio");
    expect(PROBE_MAP["koboldcpp"]).toBe("koboldcpp");
  });
});
