import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ProbeIndex from "../src/probes/index";

const probeControl = vi.hoisted(() => ({
  override: undefined as
    | ((...args: Parameters<typeof ProbeIndex.resolveProbe>) => unknown)
    | undefined,
}));

vi.mock("../src/probes/index", async () => {
  const actual = await vi.importActual<typeof ProbeIndex>(
    "../src/probes/index",
  );
  return {
    ...actual,
    resolveProbe: (...args: Parameters<typeof actual.resolveProbe>) =>
      probeControl.override
        ? probeControl.override(...args)
        : actual.resolveProbe(...args),
  };
});

import { discoverProvider, sanitizeProbeMeta } from "../src/discover";

function listResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ data }),
  };
}

function vllmEntry(id: string, maxModelLen?: number) {
  return {
    id,
    object: "model",
    created: 1_700_000_000,
    owned_by: "vllm",
    ...(maxModelLen === undefined ? {} : { max_model_len: maxModelLen }),
  };
}

const target = {
  providerID: "local",
  baseURL: "http://user:pass@gpu.local:8000/v1/",
  apiKey: "secret-key",
};

beforeEach(() => {
  probeControl.override = undefined;
});

describe("discoverProvider model list", () => {
  it("requests the normalized /v1/models URL with the bearer key", async () => {
    mockFetch.mockResolvedValue(listResponse([vllmEntry("m")]));
    await discoverProvider(target);
    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe("http://user:pass@gpu.local:8000/v1/models");
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret-key" });
  });

  it("lets an explicit provider authorization header replace the derived one", async () => {
    mockFetch.mockResolvedValue(listResponse([vllmEntry("m")]));
    await discoverProvider({
      ...target,
      headers: { authorization: "Custom token", "X-Team": "a" },
    });
    const init = mockFetch.mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(init.headers).toEqual({
      authorization: "Custom token",
      "X-Team": "a",
    });
  });

  it("keeps valid entries next to malformed ones and drops duplicate IDs", async () => {
    mockFetch.mockResolvedValue(
      listResponse([
        vllmEntry("a"),
        null,
        { id: "" },
        { object: "model" },
        vllmEntry("constructor"),
        vllmEntry("a"),
      ]),
    );
    const result = await discoverProvider(target);
    expect(result.ok && result.inventory.models.map((m) => m.id)).toEqual([
      "a",
      "constructor",
    ]);
  });

  it("returns an empty inventory as a success", async () => {
    mockFetch.mockResolvedValue(listResponse([]));
    const result = await discoverProvider(target);
    expect(result).toMatchObject({
      ok: true,
      inventory: { modelListAttempt: "empty", models: [] },
    });
  });

  it.each([
    [
      "unreachable",
      () => mockFetch.mockRejectedValue(new Error("down")),
      "unreachable",
    ],
    [
      "HTTP 500",
      () => mockFetch.mockResolvedValue(listResponse([], 500)),
      "http-error",
    ],
    [
      "HTTP 401",
      () => mockFetch.mockResolvedValue(listResponse([], 401)),
      "credential",
    ],
    [
      "a body without data",
      () =>
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ models: [] }),
        }),
      "invalid-response",
    ],
  ])("classifies %s as a failure", async (_label, arrange, failure) => {
    arrange();
    const result = await discoverProvider(target);
    expect(result).toMatchObject({ ok: false, failure });
  });

  it("distinguishes a timeout from a cancellation", async () => {
    mockFetch.mockResolvedValue(listResponse([vllmEntry("m")]));
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await discoverProvider(target, cancelled.signal)).toMatchObject({
      ok: false,
      failure: "aborted",
    });

    const timedOut = new AbortController();
    timedOut.abort(new DOMException("timed out", "TimeoutError"));
    expect(await discoverProvider(target, timedOut.signal)).toMatchObject({
      ok: false,
      failure: "timeout",
    });
  });

  it("keeps the endpoint origin without credentials, path, or query", async () => {
    mockFetch.mockResolvedValue(listResponse([vllmEntry("m")]));
    const result = await discoverProvider({
      ...target,
      baseURL: "https://user:pw@api.test/private/v1?token=abc",
    });
    expect(result.ok && result.inventory.endpointOrigin).toBe(
      "https://api.test",
    );
    expect(JSON.stringify(result)).not.toMatch(/secret-key|pw|private|token/);
  });
});

describe("discoverProvider probes", () => {
  it("does not resolve a probe when none is configured", async () => {
    const resolve = vi.fn();
    probeControl.override = resolve;
    mockFetch.mockResolvedValue(listResponse([vllmEntry("m", 4096)]));
    const result = await discoverProvider(target);
    expect(resolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      inventory: { probeAttempt: "not-requested", models: [{ id: "m" }] },
    });
    expect(result.ok && result.inventory.models[0].meta).toBeUndefined();
  });

  it("records the canonical probe key and the probe's metadata", async () => {
    mockFetch.mockResolvedValue(listResponse([vllmEntry("m", 4096)]));
    const result = await discoverProvider({ ...target, probe: "vllm" });
    expect(result).toMatchObject({
      ok: true,
      inventory: {
        resolvedProbe: "vllm",
        probeAttempt: "complete",
        models: [{ id: "m", meta: { context: 4096 } }],
      },
    });
  });

  it("records the canonical key for a deprecated probe alias", async () => {
    probeControl.override = async () => ({
      key: "actualyze",
      probe: async () => ({ models: {} }),
    });
    mockFetch.mockResolvedValue(listResponse([vllmEntry("m")]));
    const result = await discoverProvider({ ...target, probe: "atlas" });
    expect(result.ok && result.inventory.resolvedProbe).toBe("actualyze");
  });

  it("forwards provider headers to the probe context", async () => {
    let seen: unknown;
    probeControl.override = async (_type, _base, _key, context) => {
      seen = context?.headers;
      return { probe: undefined };
    };
    mockFetch.mockResolvedValue(listResponse([vllmEntry("m")]));
    await discoverProvider({
      ...target,
      probe: "auto",
      headers: { "X-A": "1" },
    });
    expect(seen).toEqual({ "X-A": "1" });
  });

  it("applies probe metadata only to listed models", async () => {
    probeControl.override = async () => ({
      key: "omlx",
      probe: async () => ({
        models: { listed: { context: 1000 }, unlisted: { context: 2000 } },
      }),
    });
    mockFetch.mockResolvedValue(listResponse([vllmEntry("listed")]));
    const result = await discoverProvider({ ...target, probe: "omlx" });
    expect(result.ok && result.inventory.models).toEqual([
      { id: "listed", created: 1_700_000_000, meta: { context: 1000 } },
    ]);
  });

  it("keeps the listed models when the probe throws", async () => {
    probeControl.override = async () => ({
      key: "omlx",
      probe: async () => {
        throw new Error("probe failed");
      },
    });
    mockFetch.mockResolvedValue(listResponse([vllmEntry("m")]));
    const result = await discoverProvider({ ...target, probe: "omlx" });
    expect(result).toMatchObject({
      ok: true,
      inventory: { probeAttempt: "error", models: [{ id: "m" }] },
    });
  });

  it("marks an unresolvable probe as unresolved", async () => {
    mockFetch.mockResolvedValue(listResponse([vllmEntry("m")]));
    const result = await discoverProvider({
      ...target,
      probe: "no-such-probe",
    });
    expect(result).toMatchObject({
      ok: true,
      inventory: { probeAttempt: "unresolved" },
    });
    expect(result.ok && result.inventory.resolvedProbe).toBeUndefined();
  });
});

describe("sanitizeProbeMeta", () => {
  it("drops values that cannot be emitted as Model.Info fields", () => {
    expect(
      sanitizeProbeMeta({
        context: 1.5,
        maxTokens: -1,
        modelType: "image",
        toolCall: "yes",
        sizeBytes: Number.NaN,
        family: "",
        inputModalities: ["text", "file", "pdf"],
        cost: { input: 1, output: Number.POSITIVE_INFINITY },
      }),
    ).toEqual({ inputModalities: ["text", "pdf"] });
  });

  it("keeps known cache prices and omits unknown ones", () => {
    expect(
      sanitizeProbeMeta({ cost: { input: 3, output: 15, cacheRead: 0.3 } }),
    ).toEqual({ cost: { input: 3, output: 15, cacheRead: 0.3 } });
  });
});
