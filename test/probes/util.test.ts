import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { probeFetch, buildHeaders, EMPTY_RESULT } from "../../src/probes/util";

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

describe("probeFetch", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return Response on success", async () => {
    const fakeResponse = { ok: true, status: 200 };
    mockFetch.mockResolvedValue(fakeResponse);

    const result = await probeFetch("http://localhost:8000/v1/models");
    expect(result).toBe(fakeResponse);
  });

  it("should return undefined on network error", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));

    const result = await probeFetch("http://localhost:8000/v1/models");
    expect(result).toBeUndefined();
  });

  it("should return undefined on timeout", async () => {
    // Simulate a fetch that hangs until the signal aborts (like a real slow server)
    mockFetch.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
          // Never resolves on its own — must be aborted by timeout
        }),
    );

    const result = await probeFetch("http://localhost:8000/v1/models", {
      timeoutMs: 50,
    });
    expect(result).toBeUndefined();
  }, 10000);

  it("should return non-OK response (not undefined)", async () => {
    const fakeResponse = { ok: false, status: 500 };
    mockFetch.mockResolvedValue(fakeResponse);

    const result = await probeFetch("http://localhost:8000/v1/models");
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    expect(result!.status).toBe(500);
  });

  it("should abort on caller signal", async () => {
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return { ok: true, status: 200 };
    });

    const controller = new AbortController();
    controller.abort();

    const result = await probeFetch("http://localhost:8000/v1/models", {
      signal: controller.signal,
    });
    expect(result).toBeUndefined();
  });

  it("should use default 2000ms timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await probeFetch("http://localhost:8000/v1/models");
    expect(timeoutSpy).toHaveBeenCalledWith(2000);
  });

  it("should use custom timeoutMs", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await probeFetch("http://localhost:8000/v1/models", { timeoutMs: 5000 });
    expect(timeoutSpy).toHaveBeenCalledWith(5000);
  });
});

describe("buildHeaders", () => {
  it("should add Authorization when apiKey provided", () => {
    const headers = buildHeaders("sk-test");
    expect(headers).toEqual({ Authorization: "Bearer sk-test" });
  });

  it("should return empty object when no apiKey", () => {
    const headers = buildHeaders();
    expect(headers).toEqual({});
  });

  it("should return empty object when apiKey is undefined", () => {
    const headers = buildHeaders(undefined);
    expect(headers).toEqual({});
  });
});

describe("EMPTY_RESULT", () => {
  it("should be frozen", () => {
    expect(Object.isFrozen(EMPTY_RESULT)).toBe(true);
    expect(Object.isFrozen(EMPTY_RESULT.models)).toBe(true);
  });

  it("models should be empty", () => {
    expect(Object.keys(EMPTY_RESULT.models).length).toBe(0);
  });
});
