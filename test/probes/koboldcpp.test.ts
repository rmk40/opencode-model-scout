import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { probeKoboldcpp } from "../../src/probes/koboldcpp";

const mockFetch = vi.fn();
global.fetch = mockFetch;

if (!global.AbortSignal.timeout) {
  global.AbortSignal.timeout = vi.fn(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    return controller.signal;
  });
}

/** Helper: route fetch calls based on URL patterns. */
function setupKoboldMocks(
  versionResponse?: { ok: boolean; body?: unknown } | "reject",
  contextResponse?: { ok: boolean; body?: unknown } | "reject",
) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/extra/version")) {
      if (versionResponse === "reject") {
        throw new Error("ECONNREFUSED");
      }
      if (!versionResponse || !versionResponse.ok) {
        return { ok: false, status: 500 };
      }
      return { ok: true, json: async () => versionResponse.body };
    }

    if (url.includes("/api/v1/config/max_context_length")) {
      if (contextResponse === "reject") {
        throw new Error("ECONNREFUSED");
      }
      if (!contextResponse || !contextResponse.ok) {
        return { ok: false, status: 500 };
      }
      return { ok: true, json: async () => contextResponse.body };
    }

    return { ok: false, status: 404 };
  });
}

describe("probeKoboldcpp", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should extract capabilities from /api/extra/version", async () => {
    setupKoboldMocks(
      { ok: true, body: { vision: true, jinja: true, version: "1.88" } },
      { ok: true, body: { value: 8192 } },
    );

    const result = await probeKoboldcpp("http://localhost:5001", undefined, {
      modelsResponse: [
        {
          id: "koboldcpp-model",
          object: "model",
          created: 1700000000,
          owned_by: "koboldcpp",
        },
      ],
    });

    expect(Object.keys(result.models)).toHaveLength(1);
    const model = result.models["koboldcpp-model"];
    expect(model).toBeDefined();
    expect(model.vision).toBe(true);
    expect(model.modelType).toBe("vlm");
    expect(model.context).toBe(8192);
    // jinja does NOT mean toolCall
    expect(model.toolCall).toBeUndefined();
    expect(model.temperature).toBe(true);
  });

  it("should extract context from /api/v1/config/max_context_length", async () => {
    setupKoboldMocks({ ok: false }, { ok: true, body: { value: 4096 } });

    const result = await probeKoboldcpp("http://localhost:5001", undefined, {
      modelsResponse: [
        {
          id: "koboldcpp-model",
          object: "model",
          created: 1700000000,
          owned_by: "koboldcpp",
        },
      ],
    });

    const model = result.models["koboldcpp-model"];
    expect(model).toBeDefined();
    expect(model.context).toBe(4096);
  });

  it("should handle partial failure", async () => {
    setupKoboldMocks(
      { ok: true, body: { vision: true, version: "1.88" } },
      "reject",
    );

    const result = await probeKoboldcpp("http://localhost:5001", undefined, {
      modelsResponse: [
        {
          id: "koboldcpp-model",
          object: "model",
          created: 1700000000,
          owned_by: "koboldcpp",
        },
      ],
    });

    const model = result.models["koboldcpp-model"];
    expect(model).toBeDefined();
    expect(model.vision).toBe(true);
    expect(model.modelType).toBe("vlm");
    expect(model.context).toBeUndefined();
  });

  it("should detect vision capability", async () => {
    setupKoboldMocks({ ok: true, body: { vision: true } }, { ok: false });

    const result = await probeKoboldcpp("http://localhost:5001", undefined, {
      modelsResponse: [
        {
          id: "koboldcpp-model",
          object: "model",
          created: 1700000000,
          owned_by: "koboldcpp",
        },
      ],
    });

    const model = result.models["koboldcpp-model"];
    expect(model).toBeDefined();
    expect(model.vision).toBe(true);
    expect(model.modelType).toBe("vlm");
  });
});
