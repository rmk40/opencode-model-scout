import { afterEach, describe, expect, it, vi } from "vitest";
import { isActualyzeOwner, probeActualyze } from "../../src/probes/actualyze";
import type { OpenAIModelEntry, ProbeContext } from "../../src/probes/types";

const BASE_URL = "https://actualyze.test/openai";

/**
 * List entries in the shape a current Actualyze deployment serves, trimmed to
 * the fields the probe reads. Each detail response equals its list entry.
 */
const ADVERTISED_LIST: Record<string, unknown>[] = [
  {
    id: "claude-sonnet-4-6",
    object: "model",
    created: 1_791_524_713,
    owned_by: "actualyze",
    context_window: 1_000_000,
    max_output_tokens: 64_000,
    capabilities: {
      vision: true,
      video: false,
      tool_use: true,
      thinking: true,
      thinking_adaptive: null,
      audio: false,
      document: true,
      temperature: null,
    },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  {
    id: "cost-optimized",
    object: "model",
    created: 1_791_524_743,
    owned_by: "actualyze",
    context_window: 128_000,
    max_output_tokens: 16_384,
    capabilities: {
      vision: true,
      video: false,
      tool_use: true,
      thinking: null,
      thinking_adaptive: false,
      audio: null,
      document: false,
      temperature: null,
    },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 2.5, output: 10, cache_read: 0.25, cache_write: 3.125 },
  },
  {
    id: "z-ai/glm-4.5",
    object: "model",
    created: 1_791_524_713,
    owned_by: "actualyze",
    context_window: 131_072,
    max_output_tokens: 131_072,
    capabilities: {
      vision: null,
      video: false,
      tool_use: true,
      thinking: null,
      thinking_adaptive: false,
      audio: null,
      document: false,
      temperature: null,
    },
    modalities: { input: ["text"], output: ["text"] },
    cost: { input: 1, output: 4, cache_read: 0.1, cache_write: 1.25 },
  },
];

function asEntries(values: Record<string, unknown>[]): OpenAIModelEntry[] {
  return values as unknown as OpenAIModelEntry[];
}

/** An entry as listed by a deployment that does not enrich the list. */
function thinEntry(
  id: string,
  ownedBy: string | null = "actualyze",
): OpenAIModelEntry {
  return {
    id,
    object: "model",
    created: 1_700_000_000,
    owned_by: ownedBy ?? undefined,
  };
}

function modelObject(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    object: "model",
    created: 1_700_000_000,
    owned_by: "actualyze",
    context_window: 131_072,
    max_output_tokens: 16_384,
    capabilities: {
      vision: true,
      video: false,
      tool_use: true,
      thinking: true,
      thinking_adaptive: false,
      audio: false,
      document: true,
      temperature: true,
    },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    ...overrides,
  };
}

function advertisedEntry(
  id: string,
  overrides: Record<string, unknown> = {},
): OpenAIModelEntry {
  return modelObject(id, overrides) as unknown as OpenAIModelEntry;
}

function withoutContextWindow(entry: OpenAIModelEntry): OpenAIModelEntry {
  const { context_window: _omitted, ...rest } = entry as OpenAIModelEntry & {
    context_window?: unknown;
  };
  return rest;
}

const DETAIL_META = {
  context: 131_072,
  maxTokens: 16_384,
  modelType: "vlm",
  vision: true,
  toolCall: true,
  reasoning: true,
  temperature: true,
  inputModalities: ["text", "image", "pdf"],
};

function idFromUrl(url: string): string {
  return decodeURIComponent(url.split("/v1/models/").at(-1) ?? "");
}

function serveDetails(
  responses: Record<string, unknown> = {},
): (url: string) => Promise<Partial<Response>> {
  return async (url: string) => {
    const id = idFromUrl(url);
    const body = Object.hasOwn(responses, id) ? responses[id] : modelObject(id);
    return { ok: true, json: async () => body };
  };
}

function requestedIds(): string[] {
  return mockFetch.mock.calls.map(([url]) => idFromUrl(String(url))).sort();
}

function probe(
  context: ProbeContext,
  apiKey?: string,
): ReturnType<typeof probeActualyze> {
  return probeActualyze(BASE_URL, apiKey, context);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isActualyzeOwner", () => {
  it("accepts the current and legacy owner strings exactly", () => {
    expect(isActualyzeOwner("actualyze")).toBe(true);
    expect(isActualyzeOwner("atlas")).toBe(true);
    for (const owner of ["Actualyze", "ATLAS", " atlas", "actualyze ", ""]) {
      expect(isActualyzeOwner(owner)).toBe(false);
    }
    expect(isActualyzeOwner(undefined)).toBe(false);
  });
});

describe("probeActualyze model selection", () => {
  it("auto mode inspects only entries owned by actualyze or atlas", async () => {
    mockFetch.mockImplementation(serveDetails());

    const result = await probe({
      probeSelection: "auto",
      modelsResponse: [
        thinEntry("current", "actualyze"),
        thinEntry("legacy", "atlas"),
        thinEntry("foreign", "vllm"),
        thinEntry("ownerless", null),
        thinEntry("cased", "Actualyze"),
      ],
    });

    expect(requestedIds()).toEqual(["current", "legacy"]);
    expect(Object.keys(result.models).sort()).toEqual(["current", "legacy"]);
  });

  it("auto mode returns empty without requests when no entry is owned", async () => {
    const result = await probe({
      probeSelection: "auto",
      modelsResponse: [
        thinEntry("foreign", "vllm"),
        thinEntry("ownerless", null),
        thinEntry("padded", "atlas "),
      ],
    });

    expect(result).toEqual({ models: {} });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(["explicit", undefined] as const)(
    "%s selection requests details for foreign and ownerless IDs",
    async (probeSelection) => {
      mockFetch.mockImplementation(serveDetails());

      const result = await probe({
        probeSelection,
        modelsResponse: [
          thinEntry("foreign", "vllm"),
          thinEntry("ownerless", null),
        ],
      });

      expect(requestedIds()).toEqual(["foreign", "ownerless"]);
      expect(Object.keys(result.models).sort()).toEqual([
        "foreign",
        "ownerless",
      ]);
    },
  );

  it("explicit selection does not trust a foreign-owned entry's list fields", async () => {
    mockFetch.mockImplementation(serveDetails());

    await probe({
      probeSelection: "explicit",
      modelsResponse: [advertisedEntry("relabelled", { owned_by: "gateway" })],
    });

    expect(requestedIds()).toEqual(["relabelled"]);
  });

  it("rejects dot-segment IDs before constructing URLs", async () => {
    const result = await probe({
      modelsResponse: [thinEntry("."), thinEntry("..")],
    });

    expect(result).toEqual({ models: {} });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("collapses duplicate IDs and prefers a fully advertised duplicate", async () => {
    mockFetch.mockImplementation(serveDetails());

    const result = await probe({
      modelsResponse: [
        thinEntry("dup"),
        advertisedEntry("dup", { context_window: 4_096 }),
        thinEntry("thin-dup"),
        thinEntry("thin-dup"),
      ],
    });

    expect(requestedIds()).toEqual(["thin-dup"]);
    expect(result.models.dup.context).toBe(4_096);
    expect(result.models["thin-dup"].context).toBe(131_072);
  });

  it("returns empty without requests when the list is absent or empty", async () => {
    await expect(probeActualyze(BASE_URL)).resolves.toEqual({ models: {} });
    await expect(probe({ modelsResponse: [] })).resolves.toEqual({
      models: {},
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("probeActualyze list-first reads", () => {
  it("maps fully advertised list entries without detail requests", async () => {
    const result = await probe({
      probeSelection: "auto",
      modelsResponse: asEntries(ADVERTISED_LIST),
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.models).toEqual({
      "claude-sonnet-4-6": {
        context: 1_000_000,
        maxTokens: 64_000,
        modelType: "vlm",
        vision: true,
        toolCall: true,
        reasoning: true,
        inputModalities: ["text", "image", "pdf"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
      "cost-optimized": {
        context: 128_000,
        maxTokens: 16_384,
        modelType: "vlm",
        vision: true,
        toolCall: true,
        inputModalities: ["text", "image"],
        cost: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 },
      },
      "z-ai/glm-4.5": {
        context: 131_072,
        maxTokens: 131_072,
        toolCall: true,
        inputModalities: ["text"],
        cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 },
      },
    });
  });

  it("treats an entry with null limits and null flags as fully advertised", async () => {
    const result = await probe({
      probeSelection: "auto",
      modelsResponse: [
        advertisedEntry("unknown-pool", {
          context_window: null,
          max_output_tokens: null,
          capabilities: {
            vision: null,
            tool_use: null,
            thinking: null,
            thinking_adaptive: null,
            temperature: null,
          },
          modalities: undefined,
        }),
      ],
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.models).toEqual({ "unknown-pool": {} });
  });

  it("does not request details when cost or cache prices are absent", async () => {
    const result = await probe({
      probeSelection: "auto",
      modelsResponse: [
        advertisedEntry("no-cost"),
        advertisedEntry("no-cache", { cost: { input: 1, output: 2 } }),
      ],
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.models["no-cost"].cost).toBeUndefined();
    expect(result.models["no-cache"].cost).toEqual({ input: 1, output: 2 });
  });

  it("requests details only for owned entries that lack context_window or a capabilities object", async () => {
    mockFetch.mockImplementation(serveDetails());

    const result = await probe({
      probeSelection: "auto",
      modelsResponse: [
        advertisedEntry("complete", { context_window: 8_192 }),
        thinEntry("thin"),
        withoutContextWindow(advertisedEntry("no-context-key")),
        advertisedEntry("null-capabilities", { capabilities: null }),
        advertisedEntry("array-capabilities", { capabilities: [] }),
      ],
    });

    expect(requestedIds()).toEqual([
      "array-capabilities",
      "no-context-key",
      "null-capabilities",
      "thin",
    ]);
    expect(result.models.complete.context).toBe(8_192);
    expect(result.models.thin).toEqual(DETAIL_META);
  });

  it("returns list-derived metadata when a sibling's detail request fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    const result = await probe({
      probeSelection: "auto",
      modelsResponse: [advertisedEntry("listed"), thinEntry("missing")],
    });

    expect(Object.keys(result.models)).toEqual(["listed"]);
  });
});

describe("probeActualyze field mapping", () => {
  it("keeps null flags unknown and false flags authoritative", async () => {
    const result = await probe({
      modelsResponse: [
        advertisedEntry("negative", {
          capabilities: {
            vision: false,
            tool_use: false,
            thinking: false,
            thinking_adaptive: false,
            temperature: false,
          },
        }),
        advertisedEntry("unknown", {
          capabilities: {
            vision: null,
            tool_use: null,
            thinking: null,
            thinking_adaptive: false,
            temperature: null,
          },
        }),
        advertisedEntry("wrong-type", {
          capabilities: {
            vision: "true",
            tool_use: 1,
            thinking: "yes",
            thinking_adaptive: 0,
            temperature: "false",
          },
        }),
      ],
    });

    expect(result.models.negative.modelType).toBeUndefined();
    expect(result.models.negative).toMatchObject({
      vision: false,
      toolCall: false,
      reasoning: false,
      temperature: false,
    });
    for (const id of ["unknown", "wrong-type"]) {
      const meta = result.models[id];
      expect(meta.vision).toBeUndefined();
      expect(meta.modelType).toBeUndefined();
      expect(meta.toolCall).toBeUndefined();
      expect(meta.reasoning).toBeUndefined();
      expect(meta.temperature).toBeUndefined();
    }
  });

  it("classifies embedding output as an embedding model, whatever the vision flag says", async () => {
    const embedding = (id: string, vision: boolean | null, output: string[]) =>
      advertisedEntry(id, {
        capabilities: { vision, tool_use: false },
        modalities: { input: ["text"], output },
      });
    const result = await probe({
      modelsResponse: [
        embedding("embed-only", false, ["embedding"]),
        embedding("embed-and-text", true, ["text", "embedding"]),
        embedding("text-no-vision", false, ["text"]),
        embedding("vision", true, ["text"]),
      ],
    });

    expect(result.models["embed-only"].modelType).toBe("embedding");
    expect(result.models["embed-and-text"].modelType).toBe("embedding");
    // vision: false leaves the type to the name heuristic.
    expect(result.models["text-no-vision"].modelType).toBeUndefined();
    expect(result.models["text-no-vision"].vision).toBe(false);
    expect(result.models.vision.modelType).toBe("vlm");
  });

  it("treats either thinking flag as reasoning", async () => {
    const result = await probe({
      modelsResponse: [
        advertisedEntry("adaptive-only", {
          capabilities: { thinking: false, thinking_adaptive: true },
        }),
        advertisedEntry("thinking-only", {
          capabilities: { thinking: true, thinking_adaptive: null },
        }),
      ],
    });

    expect(result.models["adaptive-only"].reasoning).toBe(true);
    expect(result.models["thinking-only"].reasoning).toBe(true);
  });

  it("omits limits that are not positive safe integers", async () => {
    const invalid = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "131072",
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ];

    const result = await probe({
      modelsResponse: invalid.map((value, index) =>
        advertisedEntry(`invalid-${index}`, {
          context_window: value,
          max_output_tokens: value,
        }),
      ),
    });

    expect(Object.keys(result.models)).toHaveLength(invalid.length);
    for (const meta of Object.values(result.models)) {
      expect(meta.context).toBeUndefined();
      expect(meta.maxTokens).toBeUndefined();
    }
  });

  it("takes input modalities from modalities.input in canonical order, ignoring unknown values", async () => {
    const result = await probe({
      modelsResponse: [
        advertisedEntry("all", {
          capabilities: { vision: null, document: null },
          modalities: {
            input: ["video", "audio", "pdf", "image", "text", "file", 3],
          },
        }),
        advertisedEntry("only-unknown", { modalities: { input: ["file"] } }),
      ],
    });

    expect(result.models.all.inputModalities).toEqual([
      "text",
      "image",
      "pdf",
      "audio",
      "video",
    ]);
    expect(result.models.all.vision).toBeUndefined();
    expect(result.models["only-unknown"].inputModalities).toBeUndefined();
  });

  it("derives input modalities from capability flags only when every input flag is known", async () => {
    const result = await probe({
      modelsResponse: [
        advertisedEntry("known", {
          modalities: undefined,
          capabilities: {
            vision: false,
            document: true,
            audio: true,
            video: false,
          },
        }),
        advertisedEntry("partly-unknown", {
          modalities: undefined,
          capabilities: {
            vision: true,
            document: true,
            audio: null,
            video: false,
          },
        }),
      ],
    });

    expect(result.models.known.inputModalities).toEqual([
      "text",
      "pdf",
      "audio",
    ]);
    expect(result.models["partly-unknown"].inputModalities).toBeUndefined();
  });

  it("maps cost and leaves invalid or missing prices unknown", async () => {
    const result = await probe({
      modelsResponse: [
        advertisedEntry("read-only-cache", {
          cost: { input: 0, output: 4, cache_read: 0.1 },
        }),
        advertisedEntry("bad-cache", {
          cost: { input: 1, output: 4, cache_read: -1, cache_write: "1" },
        }),
        advertisedEntry("missing-output", { cost: { input: 1 } }),
        advertisedEntry("bad-input", {
          cost: { input: Number.NaN, output: 4 },
        }),
      ],
    });

    expect(result.models["read-only-cache"].cost).toEqual({
      input: 0,
      output: 4,
      cacheRead: 0.1,
    });
    expect(result.models["bad-cache"].cost).toEqual({ input: 1, output: 4 });
    expect(result.models["missing-output"].cost).toBeUndefined();
    expect(result.models["bad-input"].cost).toBeUndefined();
  });
});

describe("probeActualyze detail requests", () => {
  it("sends the API key and provider headers to the encoded detail URL", async () => {
    mockFetch.mockImplementation(serveDetails());

    await probe(
      {
        modelsResponse: [thinEntry("org/model:latest")],
        headers: { "X-Gateway": "team-a" },
      },
      "secret",
    );

    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/v1/models/org%2Fmodel%3Alatest`,
      expect.objectContaining({
        headers: { Authorization: "Bearer secret", "X-Gateway": "team-a" },
      }),
    );
  });

  it("accepts details owned by either owner string and rejects mismatched identities", async () => {
    mockFetch.mockImplementation(
      serveDetails({
        legacy: modelObject("legacy", { owned_by: "atlas" }),
        "wrong-id": modelObject("other-id"),
        "wrong-owner": modelObject("wrong-owner", { owned_by: "vllm" }),
        "wrong-object": modelObject("wrong-object", { object: "list" }),
        "bad-created": modelObject("bad-created", { created: "now" }),
        "no-capabilities": modelObject("no-capabilities", {
          capabilities: undefined,
        }),
      }),
    );

    const result = await probe({
      modelsResponse: [
        "current",
        "legacy",
        "wrong-id",
        "wrong-owner",
        "wrong-object",
        "bad-created",
        "no-capabilities",
      ].map((id) => thinEntry(id)),
    });

    expect(Object.keys(result.models).sort()).toEqual(["current", "legacy"]);
  });

  it("supports reserved property names as literal model IDs", async () => {
    mockFetch.mockImplementation(serveDetails());

    const result = await probe({
      modelsResponse: [thinEntry("constructor"), thinEntry("__proto__")],
    });

    expect(Object.hasOwn(result.models, "constructor")).toBe(true);
    expect(Object.hasOwn(result.models, "__proto__")).toBe(true);
    expect(result.models["__proto__"].context).toBe(131_072);
  });

  it("isolates a malformed Unicode ID from a valid sibling", async () => {
    mockFetch.mockImplementation(serveDetails());

    const result = await probe({
      modelsResponse: [thinEntry("\ud800"), thinEntry("valid-model")],
    });

    expect(requestedIds()).toEqual(["valid-model"]);
    expect(Object.keys(result.models)).toEqual(["valid-model"]);
  });

  it("isolates non-OK, network, malformed, and hanging-body failures", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => undefined);
    mockFetch.mockImplementation(async (url: string) => {
      const id = idFromUrl(url);
      if (id === "non-ok") return { ok: false, status: 503, body: { cancel } };
      if (id === "network") throw new Error("ECONNRESET");
      if (id === "malformed") {
        return {
          ok: true,
          json: async () => Promise.reject(new SyntaxError()),
        };
      }
      if (id === "hanging") {
        return {
          ok: true,
          json: () => new Promise<never>(() => {}),
          body: { cancel: async () => undefined },
        };
      }
      return { ok: true, json: async () => modelObject(id) };
    });

    const resultPromise = probe({
      modelsResponse: ["good", "non-ok", "network", "malformed", "hanging"].map(
        (id) => thinEntry(id),
      ),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await resultPromise;

    expect(result.models).toEqual({ good: DETAIL_META });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns empty when every detail request fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const result = await probe({
      modelsResponse: [thinEntry("a"), thinEntry("b")],
    });

    expect(result).toEqual({ models: {} });
  });

  it("bounds concurrent detail requests", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `model-${index}`);
    let active = 0;
    let maxActive = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFetch.mockImplementation(async (url: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return { ok: true, json: async () => modelObject(idFromUrl(url)) };
    });

    const resultPromise = probe({
      probeSelection: "auto",
      modelsResponse: ids.map((id) => thinEntry(id)),
    });
    await vi.waitFor(() => expect(active).toBe(8));
    release?.();
    const result = await resultPromise;

    expect(maxActive).toBe(8);
    expect(Object.keys(result.models)).toHaveLength(20);
  });

  it("aborts active requests and returns no partial metadata", async () => {
    const controller = new AbortController();
    const ids = Array.from({ length: 20 }, (_, index) => `model-${index}`);
    let started = 0;
    let aborted = 0;
    mockFetch.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          started += 1;
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted += 1;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );

    const resultPromise = probe({
      probeSelection: "auto",
      modelsResponse: [
        advertisedEntry("listed"),
        ...ids.map((id) => thinEntry(id)),
      ],
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(started).toBe(8));
    controller.abort();

    await expect(resultPromise).resolves.toEqual({ models: {} });
    expect(started).toBe(8);
    expect(aborted).toBe(8);
  });

  it("returns empty without requests when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await probe({
      modelsResponse: [advertisedEntry("listed"), thinEntry("thin")],
      signal: controller.signal,
    });

    expect(result).toEqual({ models: {} });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
