/**
 * Catalog record status fields: credential source, credential and result
 * epochs, refresh times from the store's throttle and retry hints, the
 * `status` event, and the built-in Actualyze signal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateCatalogPayload,
  type CatalogProviderRecord,
} from "../src/catalog-evidence";
import type {
  DiscoveryResult,
  DiscoveryTarget,
  ProviderInventory,
} from "../src/discover";
import {
  createRefresher,
  type HostEvent,
  type Refresher,
  type RefresherHost,
} from "../src/refresher";
import {
  createStore,
  MIN_REFRESH_INTERVAL_MS,
  type DiscoveryStore,
} from "../src/store";
import {
  createModelTransform,
  createTransformState,
  eligibleTarget,
  type ModelEditor,
  type ProviderLike,
  type TransformState,
} from "../src/transform";

const COMPAT = "aisdk:@ai-sdk/openai-compatible";
const HERE = { directory: "/projects/a" };
const T0 = Date.parse("2026-10-11T12:00:00.000Z");
const MINUTE = MIN_REFRESH_INTERVAL_MS;
const iso = (at: number) => new Date(at).toISOString();

const ACCOUNT_A = { connection: "credential:a", key: "account-a" };
const ACCOUNT_B = { connection: "credential:b", key: "account-b" };
const SWITCH: HostEvent = {
  type: "credential.switched",
  data: { integrationID: "acme", credentialID: "b" },
};

function provider(
  id: string,
  settings: Record<string, unknown> = { baseURL: `http://${id}/v1` },
  extra: Partial<ProviderLike> = {},
): ProviderLike {
  return { id, package: COMPAT, settings, ...extra };
}

const viaAcme = (extra: Partial<ProviderLike> = {}) =>
  provider(
    "local",
    { baseURL: "http://local/v1" },
    {
      integrationID: "acme",
      ...extra,
    },
  );

function deferred() {
  let resolve!: (value: DiscoveryResult) => void;
  const promise = new Promise<DiscoveryResult>((done) => (resolve = done));
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
}

interface Clock {
  now: number;
}

function inventory(
  ids: string[],
  clock: Clock,
  extra: Partial<ProviderInventory> = {},
): ProviderInventory {
  return {
    modelListAttempt: "ready",
    probeAttempt: "not-requested",
    models: ids.map((id) => ({ id })),
    completedAt: iso(clock.now),
    ...extra,
  };
}

interface Harness {
  host: RefresherHost;
  providers: ProviderLike[];
  credentials: Map<string, { connection: string; key: string }>;
  statuses: string[];
  reload: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function harness(providers: ProviderLike[], location = HERE): Harness {
  const h = {
    providers,
    credentials: new Map<string, { connection: string; key: string }>(),
    statuses: [] as string[],
    reload: vi.fn(async () => {}),
  } as Harness;
  h.host = {
    location,
    listProviders: async () => h.providers,
    activeCredential: async (id) => h.credentials.get(id),
    reload: () => h.reload(),
    events: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<HostEvent>>(() => {}),
      }),
    }),
    emitUpdated: async () => {},
    emitStatus: async (at) => {
      h.statuses.push(at);
    },
    persist: async () => {},
  };
  return h;
}

/** The host's model fold over source records that declare no models. */
function fold(state: TransformState, providers: readonly ProviderLike[]) {
  const records = providers.map((entry) => ({
    provider: entry,
    models: new Map(),
  }));
  const editor = {
    provider: {
      list: () => records,
      get: (id: string) => records.find((entry) => entry.provider.id === id),
    },
    update: (
      providerID: string,
      modelID: string,
      update: (model: Record<string, unknown>) => void,
    ) => {
      update({
        id: modelID,
        modelID,
        providerID,
        name: modelID,
        capabilities: { tools: false, input: ["text"], output: ["text"] },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 200_000, output: 0 },
      });
    },
  } as unknown as ModelEditor;
  createModelTransform(state)(editor);
}

const created: Refresher[] = [];

afterEach(() => {
  for (const refresher of created.splice(0)) refresher.dispose();
});

type Discover = (
  target: DiscoveryTarget,
  signal: AbortSignal,
) => Promise<DiscoveryResult>;

function setup(
  h: Harness,
  discover: Discover,
  options: {
    clock?: Clock;
    store?: DiscoveryStore;
    refreshIntervalMs?: number;
    state?: TransformState;
  } = {},
) {
  const clock = options.clock ?? { now: T0 };
  const store = options.store ?? createStore(() => clock.now);
  const state = options.state ?? createTransformState();
  state.recorded ??= new Set();
  // A long debounce keeps event-triggered syncs out of the tests, which
  // call `sync()` themselves.
  // A reload runs the model fold, which fills the view the catalog's model
  // evidence comes from.
  h.reload.mockImplementation(async () => fold(state, h.providers));
  const refresher = createRefresher({
    host: h.host,
    options: {
      timeoutMs: 15_000,
      refreshIntervalMs: options.refreshIntervalMs ?? 0,
    },
    state,
    store,
    packageVersion: "2.0.0-test",
    discover,
    now: () => clock.now,
    debounceMs: 3_600_000,
  });
  created.push(refresher);
  return { refresher, state, store, clock };
}

/** Discovery that lists one model named after the key it was sent. */
function byKey(clock: Clock) {
  return vi.fn<Discover>(async (target) => ({
    ok: true,
    inventory: inventory([`via-${target.apiKey ?? "none"}`], clock),
  }));
}

function record(refresher: Refresher, id = "local"): CatalogProviderRecord {
  const payload = refresher.catalog();
  expect(validateCatalogPayload(payload)).toBeDefined();
  const found = payload.providers.find((entry) => entry.id === id);
  expect(found).toBeDefined();
  return found!;
}

const modelIDs = (entry: CatalogProviderRecord) =>
  entry.models.map((model) => model.id);

const unauthorized: DiscoveryResult = {
  ok: false,
  failure: "unauthorized",
  modelListAttempt: "http-error",
  httpStatus: 401,
};

function rateLimited(retryAt: number): DiscoveryResult {
  return {
    ok: false,
    failure: "rate-limited",
    modelListAttempt: "http-error",
    httpStatus: 429,
    retryAt,
  };
}

/** A refresher whose `local` target is bound to account A at epoch 0. */
async function boundToAccountA(discover: Discover, clock: Clock = { now: T0 }) {
  const h = harness([viaAcme()]);
  h.credentials.set("acme", ACCOUNT_A);
  const s = setup(h, discover, { clock });
  await s.refresher.sync();
  await flush();
  return { h, ...s };
}

// ── Credential source ───────────────────────────────────────────────────

describe("credentialSource", () => {
  it.each([
    ["a connected integration key", viaAcme(), ACCOUNT_A, "connection"],
    [
      "settings.apiKey without a connection",
      provider("local", { baseURL: "http://local/v1", apiKey: "s" }),
      undefined,
      "settings",
    ],
    ["no key at all", provider("local"), undefined, "none"],
    [
      "an Authorization header",
      provider(
        "local",
        { baseURL: "http://local/v1", apiKey: "s" },
        { headers: { Authorization: "Bearer h" } },
      ),
      undefined,
      "headers",
    ],
    [
      "an X-API-Key header on a non-Actualyze probe",
      provider(
        "local",
        { baseURL: "http://local/v1", apiKey: "s", probe: "vllm" },
        { headers: { "X-API-Key": "h" } },
      ),
      undefined,
      "headers",
    ],
    [
      "an x-api-key header on the Actualyze probe, which ignores it",
      provider(
        "local",
        { baseURL: "http://local/v1", apiKey: "s", probe: "actualyze" },
        { headers: { "x-api-key": "h" } },
      ),
      undefined,
      "settings",
    ],
    [
      "an x-api-key header on the deprecated Actualyze probe alias",
      provider(
        "local",
        { baseURL: "http://local/v1", apiKey: "s", probe: "atlas" },
        { headers: { "x-api-key": "h" } },
      ),
      undefined,
      "settings",
    ],
    [
      "an X-Actualyze-Api-Key header next to a different connected key",
      provider(
        "actualyze",
        { baseURL: "http://actualyze/openai/v1", probe: "actualyze" },
        {
          integrationID: "acme",
          headers: { "X-Actualyze-Api-Key": "header-key" },
        },
      ),
      ACCOUNT_A,
      "headers",
    ],
    [
      "an x-actualyze-api-key header on a non-Actualyze probe",
      provider(
        "local",
        { baseURL: "http://local/v1", apiKey: "s", probe: "vllm" },
        { headers: { "x-actualyze-api-key": "h" } },
      ),
      undefined,
      "settings",
    ],
    [
      "a header that carries no key",
      provider(
        "local",
        { baseURL: "http://local/v1", apiKey: "s" },
        { headers: { "X-Team": "a" } },
      ),
      undefined,
      "settings",
    ],
  ] as const)("is reported for %s", async (_label, p, credential, source) => {
    const h = harness([p]);
    if (credential) h.credentials.set("acme", credential);
    const { refresher } = setup(h, byKey({ now: T0 }));
    await refresher.sync();
    await flush();
    expect(record(refresher, p.id).credentialSource).toBe(source);
  });

  it.each([
    ["actualyze", "settings"],
    ["vllm", "headers"],
  ] as const)(
    "applies the header rule of the probe that auto mode resolved to (%s)",
    async (resolvedProbe, source) => {
      const clock = { now: T0 };
      const h = harness([
        provider(
          "local",
          { baseURL: "http://local/v1", apiKey: "s", probe: "auto" },
          { headers: { "x-api-key": "h" } },
        ),
      ]);
      const { refresher } = setup(h, async () => ({
        ok: true,
        inventory: inventory(["m"], clock, {
          resolvedProbe,
          probeAttempt: "complete",
        }),
      }));
      await refresher.sync();
      await flush();
      expect(record(refresher).credentialSource).toBe(source);
    },
  );
});

// ── Record lifetime and epochs ──────────────────────────────────────────

describe("credential epochs", () => {
  it("makes the first result current at epoch 0", async () => {
    const clock = { now: T0 };
    const job = deferred();
    const h = harness([viaAcme()]);
    h.credentials.set("acme", ACCOUNT_A);
    const { refresher } = setup(h, () => job.promise, { clock });
    await refresher.sync();
    expect(record(refresher)).toMatchObject({
      credentialEpoch: 0,
      resultEpoch: null,
      discovering: true,
      lastAttemptAt: iso(T0),
      models: [],
    });

    job.resolve({ ok: true, inventory: inventory(["a-model"], clock) });
    await flush();
    const settled = record(refresher);
    expect(settled).toMatchObject({
      credentialEpoch: 0,
      resultEpoch: 0,
      discovering: false,
      credentialSource: "connection",
    });
    expect(modelIDs(settled)).toEqual(["a-model"]);
  });

  it("keeps the record through a switch and shows the new credential's result only once it lands", async () => {
    const clock = { now: T0 };
    const next = deferred();
    const discover = vi
      .fn<Discover>()
      .mockResolvedValueOnce({
        ok: true,
        inventory: inventory(["a-model"], clock),
      })
      .mockReturnValueOnce(next.promise);
    const { h, refresher } = await boundToAccountA(discover, clock);
    expect(modelIDs(record(refresher))).toEqual(["a-model"]);

    refresher.handleEvent(SWITCH);
    expect(record(refresher)).toMatchObject({
      credentialSource: "unresolved",
      credentialEpoch: 1,
      resultEpoch: 0,
      lastGoodAt: null,
      failure: null,
      models: [],
      discovering: false,
    });

    h.credentials.set("acme", ACCOUNT_B);
    clock.now += 1_000;
    await refresher.sync();
    expect(record(refresher)).toMatchObject({
      credentialSource: "connection",
      credentialEpoch: 2,
      resultEpoch: 0,
      discovering: true,
      lastAttemptAt: iso(T0 + 1_000),
      lastGoodAt: null,
      failure: null,
      models: [],
      skippedModelIds: [],
    });

    next.resolve({ ok: true, inventory: inventory(["b-model"], clock) });
    await flush();
    const settled = record(refresher);
    expect(settled).toMatchObject({ credentialEpoch: 2, resultEpoch: 2 });
    expect(modelIDs(settled)).toEqual(["b-model"]);
  });

  it("does not carry the previous credential's failure into the new epoch", async () => {
    const next = deferred();
    const discover = vi
      .fn<Discover>()
      .mockResolvedValueOnce(unauthorized)
      .mockReturnValueOnce(next.promise);
    const { h, refresher } = await boundToAccountA(discover);
    expect(record(refresher).failure).toMatchObject({
      kind: "unauthorized",
      httpStatus: 401,
    });

    h.credentials.set("acme", ACCOUNT_B);
    refresher.handleEvent(SWITCH);
    await refresher.sync();
    expect(record(refresher)).toMatchObject({
      credentialEpoch: 2,
      resultEpoch: 0,
      failure: null,
    });
  });

  it("keeps the record as it is when a lookup fails and the previous resolution is kept", async () => {
    const clock = { now: T0 };
    const { h, refresher } = await boundToAccountA(byKey(clock), clock);
    const before = record(refresher);

    vi.spyOn(h.host, "activeCredential").mockRejectedValueOnce(
      new Error("credential store unavailable"),
    );
    await refresher.sync();
    await flush();
    const after = record(refresher);
    expect(after).toMatchObject({
      credentialSource: "connection",
      credentialEpoch: 0,
      resultEpoch: 0,
    });
    expect(modelIDs(after)).toEqual(modelIDs(before));
  });

  it("counts a switch and the failed lookup after it as one change", async () => {
    const clock = { now: T0 };
    const { h, refresher } = await boundToAccountA(byKey(clock), clock);
    vi.spyOn(h.host, "activeCredential").mockRejectedValue(
      new Error("credential store unavailable"),
    );
    refresher.handleEvent(SWITCH);
    await refresher.sync();
    await flush();
    expect(record(refresher)).toMatchObject({
      credentialSource: "unresolved",
      credentialEpoch: 1,
    });
    expect(refresher.refresh("local")).toEqual({
      accepted: false,
      reason: "no-targets",
    });
  });

  it.each([
    [
      "a settings.apiKey edit",
      { baseURL: "http://local/v1", apiKey: "key-2", probe: "vllm" },
      {},
      1,
    ],
    [
      "a header edit",
      { baseURL: "http://local/v1", apiKey: "key-1", probe: "vllm" },
      { headers: { "X-Team": "b" } },
      1,
    ],
    [
      "a probe-only edit",
      { baseURL: "http://local/v1", apiKey: "key-1", probe: "omlx" },
      {},
      0,
    ],
  ] as const)(
    "advances the epoch by %s as expected",
    async (_label, settings, extra, epoch) => {
      const clock = { now: T0 };
      const h = harness([
        provider(
          "local",
          { baseURL: "http://local/v1", apiKey: "key-1", probe: "vllm" },
          { headers: { "X-Team": "a" } },
        ),
      ]);
      const { refresher } = setup(h, byKey(clock), { clock });
      await refresher.sync();
      await flush();

      h.providers = [
        provider("local", settings, { headers: { "X-Team": "a" }, ...extra }),
      ];
      await refresher.sync();
      expect(record(refresher).credentialEpoch).toBe(epoch);
    },
  );

  it("keeps counting when a provider leaves the catalog and returns", async () => {
    const clock = { now: T0 };
    const withKey = (key: string) =>
      provider("local", { baseURL: "http://local/v1", apiKey: key });
    const h = harness([withKey("key-1")]);
    const { refresher } = setup(h, byKey(clock), { clock });
    await refresher.sync();
    await flush();
    h.providers = [withKey("key-2")];
    await refresher.sync();
    await flush();
    expect(record(refresher).credentialEpoch).toBe(1);

    h.providers = [];
    await refresher.sync();
    expect(refresher.catalog().providers).toEqual([]);

    h.providers = [withKey("key-2")];
    await refresher.sync();
    expect(record(refresher).credentialEpoch).toBe(1);
    h.providers = [withKey("key-3")];
    await refresher.sync();
    expect(record(refresher).credentialEpoch).toBe(2);
  });

  it("makes a stored binding for the new credential current without discovery", async () => {
    const clock = { now: T0 };
    const withKey = (key: string) =>
      provider("local", { baseURL: "http://local/v1", apiKey: key });
    const h = harness([withKey("key-1")]);
    const discover = byKey(clock);
    const { refresher, store } = setup(h, discover, { clock });
    await refresher.sync();
    await flush();

    const { keys } = eligibleTarget(withKey("key-2"), new Set())!;
    store.seed({
      key: keys.key,
      endpointKey: keys.endpointKey,
      providerID: "local",
      credential: "settings",
      inventory: inventory(["stored-model"], clock),
    });
    h.providers = [withKey("key-2")];
    await refresher.sync();
    await flush();
    const current = record(refresher);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(current).toMatchObject({ credentialEpoch: 1, resultEpoch: 1 });
    expect(modelIDs(current)).toEqual(["stored-model"]);
  });
});

describe("results produced by another location", () => {
  function twoLocations(discover: Discover) {
    const clock = { now: T0 };
    const store = createStore(() => clock.now);
    const a = harness([viaAcme()]);
    const b = harness([viaAcme()], { directory: "/projects/b" });
    a.credentials.set("acme", ACCOUNT_A);
    b.credentials.set("acme", ACCOUNT_B);
    return {
      clock,
      a,
      b,
      first: setup(a, discover, { clock, store }),
      second: setup(b, discover, { clock, store }),
    };
  }

  it("makes this record current with a failure another location's job settled first", async () => {
    const discover = vi.fn<Discover>(async (target) =>
      target.apiKey === "account-b"
        ? unauthorized
        : { ok: true, inventory: inventory(["a-model"], { now: T0 }) },
    );
    const { a, first, second } = twoLocations(discover);
    await first.refresher.sync();
    await flush();
    await second.refresher.sync();
    await flush();

    a.credentials.set("acme", ACCOUNT_B);
    first.refresher.handleEvent(SWITCH);
    await first.refresher.sync();
    await flush();
    expect(
      discover.mock.calls.filter(([target]) => target.apiKey === "account-b"),
    ).toHaveLength(1);
    expect(record(first.refresher)).toMatchObject({
      credentialEpoch: 2,
      resultEpoch: 2,
      lastGoodAt: null,
      failure: { kind: "unauthorized", httpStatus: 401 },
      models: [],
    });
  });

  it("shows a joined job as discovering in both locations and current once it settles", async () => {
    const clock = { now: T0 };
    const shared = deferred();
    const discover = vi.fn<Discover>(async (target) =>
      target.apiKey === "account-b"
        ? shared.promise
        : { ok: true, inventory: inventory(["a-model"], clock) },
    );
    const { a, first, second } = twoLocations(discover);
    await first.refresher.sync();
    await flush();
    await second.refresher.sync();

    a.credentials.set("acme", ACCOUNT_B);
    first.refresher.handleEvent(SWITCH);
    await first.refresher.sync();
    expect(discover).toHaveBeenCalledTimes(2);
    expect(record(first.refresher)).toMatchObject({
      discovering: true,
      credentialEpoch: 2,
      resultEpoch: 0,
    });
    expect(record(second.refresher)).toMatchObject({
      discovering: true,
      credentialEpoch: 0,
      resultEpoch: null,
    });

    shared.resolve({ ok: true, inventory: inventory(["b-model"], clock) });
    await flush();
    const mine = record(first.refresher);
    const theirs = record(second.refresher);
    expect(mine).toMatchObject({ discovering: false, resultEpoch: 2 });
    expect(theirs).toMatchObject({ discovering: false, resultEpoch: 0 });
    expect(modelIDs(mine)).toEqual(["b-model"]);
    expect(modelIDs(theirs)).toEqual(["b-model"]);
  });
});

// ── Refresh times and retry hints ───────────────────────────────────────

describe("nextRefreshAt", () => {
  const settingsProvider = () =>
    provider("local", { baseURL: "http://local/v1", apiKey: "s" });

  async function failedWith(result: DiscoveryResult, refreshIntervalMs = 0) {
    const clock = { now: T0 };
    const h = harness([settingsProvider()]);
    const discover = vi
      .fn<Discover>()
      .mockResolvedValueOnce(result)
      .mockResolvedValue({ ok: true, inventory: inventory(["m"], clock) });
    const s = setup(h, discover, { clock, refreshIntervalMs });
    await s.refresher.sync();
    await flush();
    return { ...s, discover, clock };
  }

  it("is a minute after the last attempt, then null once that has passed", async () => {
    const clock = { now: T0 };
    const { refresher } = setup(harness([settingsProvider()]), byKey(clock), {
      clock,
    });
    await refresher.sync();
    await flush();
    expect(record(refresher)).toMatchObject({
      lastAttemptAt: iso(T0),
      nextRefreshAt: iso(T0 + MINUTE),
    });
    clock.now = T0 + MINUTE;
    expect(record(refresher).nextRefreshAt).toBeNull();
    expect(record(refresher).lastAttemptAt).toBe(iso(T0));
  });

  it("is the server's retry time when that is later, and the failure carries it", async () => {
    const { refresher } = await failedWith(rateLimited(T0 + 5 * MINUTE));
    expect(record(refresher)).toMatchObject({
      nextRefreshAt: iso(T0 + 5 * MINUTE),
      failure: {
        kind: "rate-limited",
        httpStatus: 429,
        retryAt: iso(T0 + 5 * MINUTE),
      },
    });
  });

  it("is a minute after the attempt when the retry time is sooner", async () => {
    const { refresher } = await failedWith(rateLimited(T0 + 10_000));
    expect(record(refresher).nextRefreshAt).toBe(iso(T0 + MINUTE));
  });

  it("throttles a manual refresh until it has passed", async () => {
    const { refresher, discover, clock } = await failedWith(
      rateLimited(T0 + 5 * MINUTE),
    );
    clock.now = T0 + 2 * MINUTE;
    expect(refresher.refresh("local")).toEqual({
      accepted: false,
      reason: "throttled",
    });
    clock.now = T0 + 5 * MINUTE;
    expect(refresher.refresh("local")).toEqual({ accepted: true });
    await flush();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("starts no triggered job before the retry time", async () => {
    const { refresher, discover, clock } = await failedWith(
      rateLimited(T0 + 5 * MINUTE),
      600_000,
    );
    clock.now = T0 + 2 * MINUTE;
    await refresher.sync();
    await flush();
    expect(discover).toHaveBeenCalledTimes(1);
    clock.now = T0 + 5 * MINUTE;
    await refresher.sync();
    await flush();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("does not delay discovery with another credential", async () => {
    const clock = { now: T0 };
    const discover = vi.fn<Discover>(async (target) =>
      target.apiKey === "account-a"
        ? rateLimited(T0 + 30 * MINUTE)
        : { ok: true, inventory: inventory(["b-model"], clock) },
    );
    const { h, refresher } = await boundToAccountA(discover, clock);
    expect(record(refresher).nextRefreshAt).toBe(iso(T0 + 30 * MINUTE));

    clock.now = T0 + 1_000;
    h.credentials.set("acme", ACCOUNT_B);
    refresher.handleEvent(SWITCH);
    await refresher.sync();
    await flush();
    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover.mock.calls[1][0]).toMatchObject({ apiKey: "account-b" });
    expect(record(refresher)).toMatchObject({
      nextRefreshAt: iso(T0 + 1_000 + MINUTE),
      failure: null,
      resultEpoch: 2,
    });
  });
});

describe("failure reporting", () => {
  it("reports an HTTP failure kind that lacks its status as error", async () => {
    const h = harness([provider("local")]);
    const { refresher } = setup(h, async () => ({
      ok: false,
      failure: "unauthorized",
      modelListAttempt: "http-error",
    }));
    await refresher.sync();
    await flush();
    expect(record(refresher).failure).toEqual({ kind: "error", at: iso(T0) });
  });
});

// ── status event ────────────────────────────────────────────────────────

describe("status event", () => {
  it("fires once when a sync starts jobs and once when they settle", async () => {
    const clock = { now: T0 };
    const jobs = [deferred(), deferred()];
    const h = harness([provider("one"), provider("two")]);
    let next = 0;
    const { refresher } = setup(h, () => jobs[next++].promise, { clock });
    await refresher.sync();
    await flush();
    expect(h.statuses).toEqual([iso(T0)]);

    jobs[0].resolve({ ok: true, inventory: inventory(["m"], clock) });
    await flush();
    expect(h.statuses).toHaveLength(2);
    jobs[1].resolve(unauthorized);
    await flush();
    expect(h.statuses).toHaveLength(3);
  });

  it("fires when a refresh joins the running job and not when it is throttled", async () => {
    const clock = { now: T0 };
    const job = deferred();
    const h = harness([provider("local")]);
    const { refresher } = setup(h, () => job.promise, { clock });
    await refresher.sync();
    await flush();
    expect(refresher.refresh("local")).toEqual({ accepted: true });
    await flush();
    expect(h.statuses).toHaveLength(2);

    job.resolve({ ok: true, inventory: inventory(["m"], clock) });
    await flush();
    expect(h.statuses).toHaveLength(3);
    expect(refresher.refresh("local")).toMatchObject({ reason: "throttled" });
    await flush();
    expect(h.statuses).toHaveLength(3);
  });

  it("fires in another location sharing the store key when a refresh here starts a job", async () => {
    const clock = { now: T0 };
    const store = createStore(() => clock.now);
    const jobs = [deferred(), deferred()];
    let next = 0;
    const discover = () => jobs[next++].promise;
    const a = harness([provider("local")]);
    const b = harness([provider("local")], { directory: "/projects/b" });
    const first = setup(a, discover, { clock, store });
    const second = setup(b, discover, { clock, store });
    await first.refresher.sync();
    await second.refresher.sync();
    jobs[0].resolve({ ok: true, inventory: inventory(["m"], clock) });
    await flush();
    expect(record(second.refresher).discovering).toBe(false);
    const before = b.statuses.length;

    clock.now += MINUTE;
    expect(first.refresher.refresh("local")).toEqual({ accepted: true });
    await flush();
    expect(b.statuses).toHaveLength(before + 1);
    expect(record(second.refresher)).toMatchObject({
      discovering: true,
      lastAttemptAt: iso(clock.now),
    });
  });

  it("fires when a credential switch changes the epoch", async () => {
    const clock = { now: T0 };
    const { h, refresher } = await boundToAccountA(byKey(clock), clock);
    const before = h.statuses.length;
    refresher.handleEvent(SWITCH);
    await flush();
    expect(h.statuses).toHaveLength(before + 1);
  });

  it("waits for the reload when a binding settles", async () => {
    const clock = { now: T0 };
    const job = deferred();
    const h = harness([provider("local")]);
    let finishReload!: () => void;
    h.reload.mockImplementationOnce(
      () => new Promise<void>((done) => (finishReload = done)),
    );
    const { refresher } = setup(h, () => job.promise, { clock });
    await refresher.sync();
    await flush();
    expect(h.statuses).toHaveLength(1);

    job.resolve({ ok: true, inventory: inventory(["m"], clock) });
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.statuses).toHaveLength(1);
    finishReload();
    await flush();
    expect(h.statuses).toHaveLength(2);
  });

  it("stops after dispose", async () => {
    const clock = { now: T0 };
    const job = deferred();
    const h = harness([provider("local")]);
    const { refresher } = setup(h, () => job.promise, { clock });
    await refresher.sync();
    await flush();
    expect(h.statuses).toHaveLength(1);
    refresher.dispose();
    job.resolve({ ok: true, inventory: inventory(["m"], clock) });
    await flush();
    expect(h.statuses).toHaveLength(1);
  });
});

// ── Payload identity and the built-in signal ────────────────────────────

describe("payload", () => {
  it("carries a stable random instance ID and the server time", () => {
    const clock = { now: T0 };
    const first = setup(harness([]), vi.fn(), { clock }).refresher;
    const second = setup(harness([]), vi.fn(), { clock }).refresher;
    const payload = first.catalog();
    expect(payload.instanceID).toMatch(/\S/);
    expect(first.catalog().instanceID).toBe(payload.instanceID);
    expect(second.catalog().instanceID).not.toBe(payload.instanceID);
    expect(payload.generatedAt).toBe(iso(T0));
    clock.now += 5_000;
    expect(first.catalog().generatedAt).toBe(iso(T0 + 5_000));
  });

  describe("builtIn.actualyze", () => {
    const configuredTarget = () =>
      provider(
        "actualyze",
        { baseURL: "https://app.actualyze.ai/openai/v1", probe: "actualyze" },
        { integrationID: "actualyze" },
      );
    // A provider another source defined, without `settings.probe`.
    const foreign = () =>
      provider("actualyze", { baseURL: "https://catalog.example/v1" });

    it.each([
      ["before any provider fold", undefined, [], "managed"],
      ["when scout added the provider", "added", [], "managed"],
      ["when adding the provider failed", "failed", [], "managed"],
      [
        "when another source defined it and it is no target",
        "existing",
        [foreign()],
        "foreign",
      ],
      [
        "when another source defined it and config made it a target",
        "existing",
        [configuredTarget()],
        "managed",
      ],
    ] as const)(
      "is reported %s",
      async (_label, added, providers, expected) => {
        const state = createTransformState();
        state.recorded = new Set(providers.map((entry) => entry.id));
        state.actualyze = added;
        const h = harness([...providers]);
        const { refresher } = setup(h, byKey({ now: T0 }), { state });
        await refresher.sync();
        await flush();
        expect(refresher.catalog().builtIn).toEqual({ actualyze: expected });
      },
    );
  });
});
