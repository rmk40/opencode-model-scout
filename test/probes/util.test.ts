import { describe, it, expect, vi } from "vitest";
import {
  probeFetch,
  probeFetchJson,
  buildHeaders,
  readBody,
  readJson,
  EMPTY_RESULT,
  fetchOutcome,
  readJsonOutcome,
  setHeader,
} from "../../src/probes/util";

describe("probeFetch", () => {
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

describe("probeFetchJson", () => {
  it("should return parsed JSON on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ foo: "bar" }),
    });

    const result = await probeFetchJson<{ foo: string }>(
      "http://localhost:8000/info",
      "test probe",
    );
    expect(result).toEqual({ foo: "bar" });
  });

  it("should return undefined on network error", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));

    const result = await probeFetchJson(
      "http://localhost:8000/info",
      "test probe",
    );
    expect(result).toBeUndefined();
  });

  it("should return undefined on non-OK response without writing to console", async () => {
    const warnSpy = vi.mocked(console.warn);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    });

    const result = await probeFetchJson(
      "http://localhost:8000/info",
      "test probe",
    );
    expect(result).toBeUndefined();
    // The plugin runs in opencode's config hook and must stay silent.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("should return undefined on JSON parse failure without writing to console", async () => {
    const warnSpy = vi.mocked(console.warn);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    });

    const result = await probeFetchJson(
      "http://localhost:8000/info",
      "test probe",
    );
    expect(result).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("should pass custom options through to probeFetch", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 1 }),
    });

    await probeFetchJson("http://localhost:8000/api", "test probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"model":"test"}',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/api",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"model":"test"}',
      }),
    );
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

  it("should add provider headers after the derived Authorization", () => {
    expect(buildHeaders("sk-test", { "X-Gateway": "team-a" })).toEqual({
      Authorization: "Bearer sk-test",
      "X-Gateway": "team-a",
    });
    expect(buildHeaders(undefined, { "X-Gateway": "team-a" })).toEqual({
      "X-Gateway": "team-a",
    });
  });

  it.each(["Authorization", "authorization", "AUTHORIZATION"])(
    "should let a provider %s header replace the derived one",
    (name) => {
      expect(buildHeaders("sk-test", { [name]: "Basic abc" })).toEqual({
        [name]: "Basic abc",
      });
    },
  );

  it("should keep one entry when provider header names differ only in case", () => {
    expect(
      buildHeaders(undefined, { "X-Gateway": "first", "x-gateway": "second" }),
    ).toEqual({ "x-gateway": "second" });
  });
});

describe("setHeader", () => {
  it("should replace an existing header whose name differs only in case", () => {
    const headers = { "content-type": "text/plain", Accept: "*/*" };
    expect(setHeader(headers, "Content-Type", "application/json")).toEqual({
      Accept: "*/*",
      "Content-Type": "application/json",
    });
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

describe("readBody / readJson — bounded body reads", () => {
  it("readBody returns undefined when the body read hangs past the timeout", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const res = {
      text: () => new Promise<string>(() => {}), // never resolves
      body: { cancel },
    } as unknown as Response;

    const start = Date.now();
    const result = await readBody(res, 30);
    expect(result).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(cancel).toHaveBeenCalled(); // stream cancelled to release the socket
  });

  it("readBody returns the text on a fast body", async () => {
    const res = { text: () => Promise.resolve("hello") } as unknown as Response;
    expect(await readBody(res, 100)).toBe("hello");
  });

  it("readJson returns undefined when the body hangs past the timeout", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const res = {
      json: () => new Promise(() => {}), // never resolves
      text: () => new Promise<string>(() => {}),
      body: { cancel },
    } as unknown as Response;

    const start = Date.now();
    expect(await readJson(res, 30)).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
    // Response not created via probeFetch (no registered aborter), so the
    // stream-cancel fallback is what releases the socket here.
    expect(cancel).toHaveBeenCalled();
  });

  it("readJson aborts the fetch that probeFetch created when the body stalls", async () => {
    // A real probeFetch Response registers an AbortController; a stalled body
    // read must abort it (rejecting the in-flight read + tearing down the
    // socket), not merely call res.body.cancel().
    const aborted = vi.fn();
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      (init?.signal as AbortSignal | undefined)?.addEventListener(
        "abort",
        aborted,
      );
      return {
        ok: true,
        status: 200,
        json: () => new Promise(() => {}), // headers arrived, body stalls
        text: () => new Promise<string>(() => {}),
        body: { cancel: () => Promise.resolve() },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      const res = await probeFetch("http://x/models", { timeoutMs: 1000 });
      expect(res).toBeDefined();
      const result = await readJson(res as Response, 30);
      expect(result).toBeUndefined();
      expect(aborted).toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("reports a stalled body after fetchOutcome as a body timeout, not an invalid body", async () => {
    // The body rejects as soon as the fetch signal aborts, the way a real
    // fetch body does. The header-phase timer (20 ms) must not abort it once
    // headers have arrived; only the body-read timer (80 ms) may.
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      const body = new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
      body.catch(() => {});
      return {
        ok: true,
        status: 200,
        json: () => body,
        body: { cancel: () => Promise.resolve() },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      const outcome = await fetchOutcome("http://x/models", { timeoutMs: 20 });
      expect(outcome.type).toBe("ok");
      if (outcome.type !== "ok") return;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(await readJsonOutcome(outcome.response, 80)).toEqual({
        type: "timeout",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("readJson parses via res.json() when available", async () => {
    const res = {
      json: () => Promise.resolve({ a: 1 }),
    } as unknown as Response;
    expect(await readJson<{ a: number }>(res, 100)).toEqual({ a: 1 });
  });

  it("readJson falls back to text + parse when res.json is absent", async () => {
    const res = {
      text: () => Promise.resolve('{"b":2}'),
    } as unknown as Response;
    expect(await readJson<{ b: number }>(res, 100)).toEqual({ b: 2 });
  });

  it("readJson returns undefined on malformed body", async () => {
    const res = {
      text: () => Promise.resolve("not json"),
    } as unknown as Response;
    expect(await readJson(res, 100)).toBeUndefined();
  });
});
