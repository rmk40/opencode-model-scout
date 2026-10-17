import { describe, expect, it } from "vitest";
import {
  CATALOG_SCHEMA_VERSION,
  failureKindForStatus,
  hasSafeObjectKeys,
  knownScalar,
  sanitizeEndpointOrigin,
  unknownCapability,
  unknownScalar,
  validateCatalogPayload,
  type CatalogModelRecord,
  type CatalogPayload,
  type CatalogProviderRecord,
} from "../src/catalog-evidence";

const AT = "2026-10-11T12:00:00.000Z";
const LATER = "2026-10-11T12:00:05.000Z";

function model(id = "claude-sonnet-4-6"): CatalogModelRecord {
  return {
    id,
    origin: "discovered",
    enabled: true,
    identity: knownScalar(id, "server-list", "reported"),
    name: knownScalar("Claude Sonnet 4.6", "heuristic", "inferred"),
    modelType: knownScalar("vlm", "provider-probe", "authoritative"),
    context: knownScalar(1_000_000, "provider-probe", "authoritative"),
    output: knownScalar(32_000, "host-default", "assumed"),
    family: unknownScalar(),
    organizationOwner: unknownScalar(),
    parameterSize: unknownScalar(),
    quantization: unknownScalar(),
    sizeBytes: unknownScalar(),
    probeIdentity: knownScalar("actualyze", "provider-probe", "reported"),
    capabilities: {
      toolCall: {
        state: "supported",
        source: "provider-probe",
        strength: "authoritative",
      },
      reasoning: unknownCapability(),
      temperature: {
        state: "unsupported",
        source: "models.dev",
        strength: "inferred",
      },
    },
    inputModalities: {
      text: {
        state: "supported",
        source: "provider-probe",
        strength: "authoritative",
      },
      image: {
        state: "supported",
        source: "provider-probe",
        strength: "authoritative",
      },
      pdf: {
        state: "unsupported",
        source: "provider-probe",
        strength: "authoritative",
      },
      audio: unknownCapability(),
      video: unknownCapability(),
    },
    cost: {
      input: knownScalar(3, "provider-probe", "reported"),
      output: knownScalar(15, "provider-probe", "reported"),
      cacheRead: knownScalar(0.3, "provider-probe", "reported"),
      cacheWrite: unknownScalar(),
    },
  };
}

function provider(id = "actualyze-dev"): CatalogProviderRecord {
  return {
    id,
    endpointOrigin: knownScalar(
      "http://localhost:8000",
      "pre-existing",
      "configured",
    ),
    configuredProbe: knownScalar("auto", "pre-existing", "configured"),
    resolvedProbe: knownScalar("actualyze", "provider-probe", "reported"),
    lastGoodAt: AT,
    failure: { kind: "unreachable", at: LATER },
    modelListAttempt: "ready",
    probeAttempt: "complete",
    skippedModelIds: ["declared-model"],
    models: [model()],
    discovering: false,
    lastAttemptAt: AT,
    nextRefreshAt: null,
    credentialSource: "connection",
    credentialEpoch: 0,
    resultEpoch: 0,
  };
}

function payload(): CatalogPayload {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    packageVersion: "2.0.0",
    instanceID: "instance",
    generatedAt: LATER,
    status: "complete",
    startedAt: AT,
    completedAt: LATER,
    builtIn: { actualyze: "managed" },
    providers: [provider()],
  };
}

describe("validateCatalogPayload", () => {
  it("accepts a complete v5 payload and returns it unchanged", () => {
    const value = payload();
    expect(validateCatalogPayload(value)).toBe(value);
  });

  it("accepts a pending provider with no inventory and no failure", () => {
    const value = payload();
    value.status = "pending";
    delete value.startedAt;
    delete value.completedAt;
    value.providers[0] = {
      ...provider(),
      lastGoodAt: null,
      failure: null,
      modelListAttempt: "pending",
      probeAttempt: "pending",
      skippedModelIds: [],
      models: [],
    };
    expect(validateCatalogPayload(value)).toBeDefined();
  });

  it("rejects another schema version", () => {
    expect(
      validateCatalogPayload({ ...payload(), schemaVersion: 4 }),
    ).toBeUndefined();
  });

  it.each([
    ["top level", (value: CatalogPayload) => Object.assign(value, { x: 1 })],
    [
      "provider",
      (value: CatalogPayload) => Object.assign(value.providers[0], { x: 1 }),
    ],
    [
      "model",
      (value: CatalogPayload) =>
        Object.assign(value.providers[0].models[0], { x: 1 }),
    ],
    [
      "cost",
      (value: CatalogPayload) =>
        Object.assign(value.providers[0].models[0].cost, { x: 1 }),
    ],
    [
      "input modalities",
      (value: CatalogPayload) =>
        Object.assign(value.providers[0].models[0].inputModalities, {
          x: unknownCapability(),
        }),
    ],
  ])("rejects an unknown key on the %s record", (_name, mutate) => {
    const value = payload();
    mutate(value);
    expect(validateCatalogPayload(value)).toBeUndefined();
  });

  it("rejects process and server correlation keys", () => {
    expect(
      validateCatalogPayload({ ...payload(), serverKey: "a".repeat(64) }),
    ).toBeUndefined();
  });

  it.each([
    ["an array holding an allowed literal", ["llm"]],
    ["an object that cannot be coerced to a string", { toString: null }],
  ])("rejects a model type given as %s", (_name, bad) => {
    const value = payload();
    (
      value.providers[0].models[0].modelType as unknown as { value: unknown }
    ).value = bad;
    expect(validateCatalogPayload(value)).toBeUndefined();
  });

  it("rejects an enum field given as a non-string", () => {
    const value = payload() as unknown as { status: unknown };
    value.status = ["complete"];
    expect(validateCatalogPayload(value)).toBeUndefined();
  });

  it("rejects a deeply nested extra field without throwing", () => {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 200_000; index += 1) nested = { nested };
    const value = Object.assign(payload(), { extra: nested });
    expect(() => validateCatalogPayload(value)).not.toThrow();
    expect(validateCatalogPayload(value)).toBeUndefined();
  });

  it("returns undefined when reading a field throws", () => {
    const value = payload();
    Object.defineProperty(value, "packageVersion", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(validateCatalogPayload(value)).toBeUndefined();
  });

  it("accepts one evidence object reused in two places", () => {
    const value = payload();
    const shared = value.providers[0].models[0].capabilities;
    value.providers[0].models.push({ ...model("other"), capabilities: shared });
    expect(validateCatalogPayload(value)).toBe(value);
  });

  it.each([
    ["startedAt", "pending"],
    ["completedAt", "running"],
  ] as const)(
    "rejects an optional %s key that is present but undefined",
    (key, status) => {
      const value = payload();
      value.status = status;
      delete value.completedAt;
      if (key === "startedAt") delete value.startedAt;
      expect(validateCatalogPayload(value)).toBe(value);

      value[key] = undefined;
      expect(validateCatalogPayload(value)).toBeUndefined();
    },
  );

  it("rejects prototype-polluting keys and non-plain objects", () => {
    const polluted = JSON.parse(
      JSON.stringify(payload()).replace(
        '"packageVersion"',
        '"__proto__":{"admin":true},"packageVersion"',
      ),
    ) as unknown;
    expect(validateCatalogPayload(polluted)).toBeUndefined();

    const value = payload();
    (value.providers[0] as unknown as { models: unknown }).models = [
      Object.assign(new (class Model {})(), model()),
    ];
    expect(validateCatalogPayload(value)).toBeUndefined();
  });

  it("rejects cycles", () => {
    const value = payload() as CatalogPayload & { self?: unknown };
    value.self = value;
    expect(validateCatalogPayload(value)).toBeUndefined();
  });

  it("requires completedAt when complete and startedAt when running", () => {
    const complete = payload();
    delete complete.completedAt;
    expect(validateCatalogPayload(complete)).toBeUndefined();

    const running = payload();
    running.status = "running";
    delete running.startedAt;
    expect(validateCatalogPayload(running)).toBeUndefined();

    const pending = payload();
    pending.status = "pending";
    expect(validateCatalogPayload(pending)).toBeUndefined();
  });

  it("allows a running cycle that started after the last completion", () => {
    const value = payload();
    value.status = "running";
    value.startedAt = LATER;
    value.completedAt = AT;
    expect(validateCatalogPayload(value)).toBeDefined();
  });

  it("rejects a completion before its start", () => {
    const value = payload();
    value.startedAt = LATER;
    value.completedAt = AT;
    expect(validateCatalogPayload(value)).toBeUndefined();
  });

  it("rejects non-canonical timestamps", () => {
    const value = payload();
    value.providers[0].lastGoodAt = "2026-10-11";
    expect(validateCatalogPayload(value)).toBeUndefined();
  });

  it("rejects an unknown failure kind and extra failure keys", () => {
    const kind = payload();
    kind.providers[0].failure = {
      kind: "teapot" as "error",
      at: LATER,
    };
    expect(validateCatalogPayload(kind)).toBeUndefined();

    const extra = payload();
    Object.assign(extra.providers[0].failure!, { message: "secret" });
    expect(validateCatalogPayload(extra)).toBeUndefined();
  });

  it("accepts host-default only as an assumed claim", () => {
    const value = payload();
    value.providers[0].models[0].context = knownScalar(
      200_000,
      "host-default",
      "assumed",
    );
    expect(validateCatalogPayload(value)).toBeDefined();
    value.providers[0].models[0].context = knownScalar(
      200_000,
      "host-default",
      "authoritative",
    );
    expect(validateCatalogPayload(value)).toBeUndefined();
  });

  it("rejects negative or non-finite prices and limits", () => {
    for (const bad of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const cost = payload();
      cost.providers[0].models[0].cost.cacheWrite = knownScalar(
        bad,
        "provider-probe",
        "reported",
      );
      expect(validateCatalogPayload(cost)).toBeUndefined();

      const limit = payload();
      limit.providers[0].models[0].output = knownScalar(
        bad,
        "provider-probe",
        "authoritative",
      );
      expect(validateCatalogPayload(limit)).toBeUndefined();
    }
  });

  it("permits unsupported only from probe, config, or models.dev", () => {
    const value = payload();
    value.providers[0].models[0].inputModalities.video = {
      state: "unsupported",
      source: "heuristic" as "models.dev",
      strength: "inferred",
    };
    expect(validateCatalogPayload(value)).toBeUndefined();
  });

  it("requires a boolean enabled flag", () => {
    const value = payload();
    (value.providers[0].models[0] as unknown as { enabled: unknown }).enabled =
      "false";
    expect(validateCatalogPayload(value)).toBeUndefined();
  });

  it("rejects duplicate provider, model, and skipped IDs", () => {
    const providers = payload();
    providers.providers.push(provider());
    expect(validateCatalogPayload(providers)).toBeUndefined();

    const models = payload();
    models.providers[0].models.push(model());
    expect(validateCatalogPayload(models)).toBeUndefined();

    const skipped = payload();
    skipped.providers[0].skippedModelIds.push("declared-model");
    expect(validateCatalogPayload(skipped)).toBeUndefined();
  });
});

describe("failureKindForStatus", () => {
  it.each([
    [401, "unauthorized"],
    [402, "payment-required"],
    [403, "forbidden"],
    [404, "not-found"],
    [429, "rate-limited"],
    [500, "server-error"],
    [503, "server-error"],
    [599, "server-error"],
    [400, "http-error"],
    [418, "http-error"],
    [302, "http-error"],
    [600, "http-error"],
  ] as const)("maps HTTP %i to %s", (status, kind) => {
    expect(failureKindForStatus(status)).toBe(kind);
  });
});

describe("validateCatalogPayload v5 fields", () => {
  const RETRY = "2026-10-11T12:01:00.000Z";

  function unresolved(): CatalogProviderRecord {
    return {
      ...provider(),
      resolvedProbe: unknownScalar(),
      lastGoodAt: null,
      failure: null,
      modelListAttempt: "pending",
      probeAttempt: "pending",
      skippedModelIds: [],
      models: [],
      discovering: false,
      lastAttemptAt: null,
      nextRefreshAt: null,
      credentialSource: "unresolved",
      credentialEpoch: 3,
      resultEpoch: 0,
    };
  }

  function withProvider(record: CatalogProviderRecord): CatalogPayload {
    return { ...payload(), providers: [record] };
  }

  it.each(["instanceID", "generatedAt", "builtIn"] as const)(
    "rejects a payload without %s",
    (key) => {
      const value = payload();
      delete (value as Partial<CatalogPayload>)[key];
      expect(validateCatalogPayload(value)).toBeUndefined();
    },
  );

  it.each([
    "discovering",
    "lastAttemptAt",
    "nextRefreshAt",
    "credentialSource",
    "credentialEpoch",
    "resultEpoch",
  ] as const)("rejects a provider record without %s", (key) => {
    const record = provider();
    delete (record as Partial<CatalogProviderRecord>)[key];
    expect(validateCatalogPayload(withProvider(record))).toBeUndefined();
  });

  it.each([
    ["an empty instanceID", { instanceID: "" }],
    ["a non-canonical generatedAt", { generatedAt: "2026-10-11" }],
    ["an unknown builtIn state", { builtIn: { actualyze: "hidden" } }],
    [
      "an extra builtIn key",
      { builtIn: { actualyze: "managed", other: "managed" } },
    ],
  ])("rejects %s", (_label, change) => {
    expect(
      validateCatalogPayload({ ...payload(), ...change } as unknown),
    ).toBeUndefined();
  });

  it("accepts a foreign built-in provider", () => {
    expect(
      validateCatalogPayload({
        ...payload(),
        builtIn: { actualyze: "foreign" },
      }),
    ).toBeDefined();
  });

  it.each([
    ["an unknown credential source", { credentialSource: "env" }],
    ["a string discovering flag", { discovering: "true" }],
    ["a negative credentialEpoch", { credentialEpoch: -1 }],
    ["a fractional credentialEpoch", { credentialEpoch: 1.5 }],
    ["a resultEpoch above credentialEpoch", { resultEpoch: 1 }],
    ["a non-canonical nextRefreshAt", { nextRefreshAt: "soon" }],
    ["a non-canonical lastAttemptAt", { lastAttemptAt: 0 }],
  ])("rejects a provider record with %s", (_label, change) => {
    const record = { ...provider(), ...change } as CatalogProviderRecord;
    expect(validateCatalogPayload(withProvider(record))).toBeUndefined();
  });

  it("accepts a record with no result yet and a pending refresh time", () => {
    const record: CatalogProviderRecord = {
      ...provider(),
      discovering: true,
      nextRefreshAt: RETRY,
      credentialEpoch: 2,
      resultEpoch: null,
    };
    expect(validateCatalogPayload(withProvider(record))).toBeDefined();
  });

  it("accepts an unresolved record that carries status fields only", () => {
    expect(validateCatalogPayload(withProvider(unresolved()))).toBeDefined();
  });

  it.each([
    ["models", { models: [model()] }],
    ["skipped IDs", { skippedModelIds: ["declared-model"] }],
    ["a last good inventory", { lastGoodAt: AT }],
    ["a failure", { failure: { kind: "unreachable", at: AT } }],
    ["a running job", { discovering: true }],
    ["an attempt time", { lastAttemptAt: AT }],
    ["a next refresh time", { nextRefreshAt: RETRY }],
  ])("rejects an unresolved record with %s", (_label, change) => {
    const record = { ...unresolved(), ...change } as CatalogProviderRecord;
    expect(validateCatalogPayload(withProvider(record))).toBeUndefined();
  });

  describe("failures", () => {
    function withFailure(failure: unknown): CatalogPayload {
      return withProvider({
        ...provider(),
        failure: failure as CatalogProviderRecord["failure"],
      });
    }

    it.each([
      [
        "an HTTP kind with its status",
        { kind: "unauthorized", httpStatus: 401 },
      ],
      ["a 1xx http-error", { kind: "http-error", httpStatus: 101 }],
      [
        "a rate limit with a retry time",
        { kind: "rate-limited", httpStatus: 429, retryAt: RETRY },
      ],
      [
        "a server error with a retry time",
        { kind: "server-error", httpStatus: 503, retryAt: RETRY },
      ],
      ["a non-HTTP kind without a status", { kind: "timeout" }],
    ])("accepts %s", (_label, failure) => {
      expect(
        validateCatalogPayload(withFailure({ ...failure, at: AT })),
      ).toBeDefined();
    });

    it.each([
      ["the retired credential kind", { kind: "credential" }],
      ["an HTTP kind without a status", { kind: "forbidden" }],
      [
        "a status that belongs to another kind",
        { kind: "unauthorized", httpStatus: 403 },
      ],
      ["a success status", { kind: "http-error", httpStatus: 200 }],
      ["a status out of range", { kind: "http-error", httpStatus: 600 }],
      ["a fractional status", { kind: "http-error", httpStatus: 400.5 }],
      ["a non-HTTP kind with a status", { kind: "timeout", httpStatus: 504 }],
      [
        "a retry time without a status",
        { kind: "unreachable", retryAt: RETRY },
      ],
      [
        "a non-canonical retry time",
        { kind: "rate-limited", httpStatus: 429, retryAt: "in 5s" },
      ],
    ])("rejects %s", (_label, failure) => {
      expect(
        validateCatalogPayload(withFailure({ ...failure, at: AT })),
      ).toBeUndefined();
    });
  });
});

describe("hasSafeObjectKeys", () => {
  it("accepts an object reached along several paths", () => {
    const leaf = { state: "unknown" };
    const shared = { a: leaf, b: [leaf, leaf] };
    expect(hasSafeObjectKeys({ left: shared, right: [shared] })).toBe(true);
  });

  it.each([
    [
      "an object that contains itself",
      () => {
        const node: Record<string, unknown> = {};
        node.self = node;
        return node;
      },
    ],
    [
      "a cycle below the root through an array",
      () => {
        const inner: Record<string, unknown> = {};
        inner.items = [{ back: inner }];
        return { root: inner };
      },
    ],
  ])("rejects %s", (_name, build) => {
    expect(hasSafeObjectKeys(build())).toBe(false);
  });

  it("counts every visit of a shared object toward the node limit", () => {
    const leaf = { x: 1 };
    const value = { a: leaf, b: leaf };
    expect(hasSafeObjectKeys(value, { maxDepth: 2, maxNodes: 3 })).toBe(true);
    expect(hasSafeObjectKeys(value, { maxDepth: 2, maxNodes: 2 })).toBe(false);
  });

  it("rejects nesting deeper than the depth limit", () => {
    expect(
      hasSafeObjectKeys({ a: { b: {} } }, { maxDepth: 1, maxNodes: 10 }),
    ).toBe(false);
  });
});

describe("sanitizeEndpointOrigin", () => {
  it("drops credentials, path, query, and fragment", () => {
    expect(
      sanitizeEndpointOrigin(
        "https://user:secret@actualyze.test:8443/openai/v1?apiKey=secret#x",
      ),
    ).toBe("https://actualyze.test:8443");
  });

  it("rejects non-HTTP URLs and garbage", () => {
    expect(sanitizeEndpointOrigin("file:///etc/passwd")).toBeUndefined();
    expect(sanitizeEndpointOrigin("not a url")).toBeUndefined();
    expect(sanitizeEndpointOrigin(42)).toBeUndefined();
  });
});
