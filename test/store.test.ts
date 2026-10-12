import { describe, expect, it, vi } from "vitest";
import type { DiscoveryResult, ProviderInventory } from "../src/discover";
import {
  createStore,
  credentialKeys,
  MIN_REFRESH_INTERVAL_MS,
  sharedStore,
  STORE_SYMBOL,
  targetKeys,
  type Binding,
  type StartRequest,
  type Subscriber,
  type TargetIdentity,
} from "../src/store";

const identity: TargetIdentity = {
  providerID: "local",
  baseURL: "http://gpu.local:8000",
  probe: "auto",
  apiKey: "key-a",
  headers: { "X-Team": "a" },
};

function inventory(ids: string[]): ProviderInventory {
  return {
    modelListAttempt: "ready",
    probeAttempt: "not-requested",
    models: ids.map((id) => ({ id })),
    completedAt: "2026-01-01T00:00:00.000Z",
  };
}

function deferred() {
  let resolve!: (value: DiscoveryResult) => void;
  const promise = new Promise<DiscoveryResult>((done) => (resolve = done));
  return { promise, resolve };
}

function request(
  run: StartRequest["run"],
  credential: StartRequest["credential"] = "settings",
): StartRequest {
  return {
    credential,
    endpointKey: "e".repeat(64),
    providerID: "local",
    timeoutMs: 15_000,
    run,
  };
}

function subscriber(): Subscriber & {
  updates: string[];
  persisted: Binding[];
} {
  const updates: string[] = [];
  const persisted: Binding[] = [];
  return {
    updates,
    persisted,
    onUpdate: (_key, update) => updates.push(update),
    persist: async (binding) => {
      persisted.push(binding);
    },
  };
}

const ok = (ids: string[]): DiscoveryResult => ({
  ok: true,
  inventory: inventory(ids),
});

describe("targetKeys", () => {
  const base = targetKeys(identity);

  it("separates the same provider ID at different endpoints", () => {
    const other = targetKeys({ ...identity, baseURL: "http://other:8000" });
    expect(other.key).not.toBe(base.key);
    expect(other.endpointKey).not.toBe(base.endpointKey);
  });

  it("changes only the full key when only the probe selection changes", () => {
    const other = targetKeys({ ...identity, probe: "vllm" });
    expect(other.key).not.toBe(base.key);
    expect(other.endpointKey).toBe(base.endpointKey);
  });

  it.each([
    ["API key", { apiKey: "key-b" }],
    ["headers", { headers: { "X-Team": "b" } }],
    ["provider ID", { providerID: "remote" }],
  ])("treats a different %s as a different endpoint", (_label, change) => {
    expect(targetKeys({ ...identity, ...change }).endpointKey).not.toBe(
      base.endpointKey,
    );
  });

  it("ignores header name case and order", () => {
    const a = targetKeys({ ...identity, headers: { A: "1", b: "2" } });
    const b = targetKeys({ ...identity, headers: { B: "2", a: "1" } });
    expect(a).toEqual(b);
  });

  it("never contains the API key", () => {
    expect(JSON.stringify(base)).not.toContain("key-a");
  });
});

describe("credentialKeys", () => {
  const base = targetKeys({ ...identity, apiKey: undefined });
  const accountA = `integration:${"a".repeat(64)}` as const;
  const accountB = `integration:${"b".repeat(64)}` as const;

  it("keeps the sync keys for a settings API key, which they already cover", () => {
    expect(credentialKeys(base, "settings")).toEqual(base);
  });

  it("gives each resolved credential, and no credential, its own entry", () => {
    const keys = [accountA, accountB, "none" as const].map(
      (credential) => credentialKeys(base, credential).key,
    );
    expect(new Set([...keys, base.key]).size).toBe(4);
  });

  it("keeps the endpoint key the synchronous transform compares against", () => {
    expect(credentialKeys(base, accountA).endpointKey).toBe(base.endpointKey);
  });

  it("separates a target with settings.apiKey resolved to that key from the same target resolved to its integration", () => {
    const withKey = targetKeys(identity);
    expect(credentialKeys(withKey, accountA).key).not.toBe(
      credentialKeys(withKey, "settings").key,
    );
  });
});

describe("jobs", () => {
  it("joins an in-flight job for the same credential", async () => {
    const store = createStore();
    const job = deferred();
    const run = vi.fn(() => job.promise);
    expect(store.start("k", request(run))).toBe("started");
    expect(store.start("k", request(run))).toBe("joined");
    job.resolve(ok(["a"]));
    await store.settled("k");
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.served("k")?.inventory.models).toEqual([{ id: "a" }]);
  });

  it("throttles a new start within the minimum interval", async () => {
    let now = 0;
    const store = createStore(() => now);
    store.start(
      "k",
      request(async () => ok(["a"])),
    );
    await store.settled("k");
    now = MIN_REFRESH_INTERVAL_MS - 1;
    expect(
      store.start(
        "k",
        request(async () => ok(["b"])),
      ),
    ).toBe("throttled");
    now = MIN_REFRESH_INTERVAL_MS;
    expect(
      store.start(
        "k",
        request(async () => ok(["b"])),
      ),
    ).toBe("started");
  });

  it("keeps the last good binding and records a failure", async () => {
    let now = 0;
    const store = createStore(() => now);
    const sub = subscriber();
    store.subscribe("k", sub);
    store.start(
      "k",
      request(async () => ok(["a"])),
    );
    await store.settled("k");
    now = MIN_REFRESH_INTERVAL_MS;
    store.start(
      "k",
      request(async () => ({
        ok: false,
        failure: "unreachable",
        modelListAttempt: "unreachable",
      })),
    );
    await store.settled("k");
    expect(store.served("k")?.inventory.models).toEqual([{ id: "a" }]);
    expect(store.state("k")?.failure).toMatchObject({ kind: "unreachable" });
    expect(sub.updates).toEqual(["binding", "failure"]);
  });

  it("persists a new binding through one subscriber only", async () => {
    const store = createStore();
    const first = subscriber();
    const second = subscriber();
    store.subscribe("k", first);
    store.subscribe("k", second);
    store.start(
      "k",
      request(async () => ok(["a"])),
    );
    await store.settled("k");
    expect(first.persisted.length + second.persisted.length).toBe(1);
    expect(first.updates).toEqual(["binding"]);
    expect(second.updates).toEqual(["binding"]);
  });

  it("treats a rejected run as a failure", async () => {
    const store = createStore();
    store.start(
      "k",
      request(async () => {
        throw new Error("boom");
      }),
    );
    await store.settled("k");
    expect(store.state("k")?.failure).toMatchObject({ kind: "error" });
  });
});

describe("invalidation", () => {
  it("clears the binding, notifies, and lets discovery restart at once", async () => {
    const store = createStore(() => 0);
    const sub = subscriber();
    store.subscribe("k", sub);
    store.start(
      "k",
      request(async () => ok(["a"])),
    );
    await store.settled("k");
    store.invalidate("k");
    expect(store.served("k")).toBeUndefined();
    expect(sub.updates).toEqual(["binding", "invalidated"]);
    expect(
      store.start(
        "k",
        request(async () => ok(["b"])),
      ),
    ).toBe("started");
  });

  it("rejects the result of a job whose generation went stale", async () => {
    const store = createStore();
    const job = deferred();
    let signal: AbortSignal | undefined;
    store.start(
      "k",
      request((received) => {
        signal = received;
        return job.promise;
      }),
    );
    await Promise.resolve();
    store.invalidate("k");
    expect(signal?.aborted).toBe(true);
    job.resolve(ok(["old-account"]));
    await job.promise;
    await Promise.resolve();
    expect(store.served("k")).toBeUndefined();
  });

  it("replaces an in-flight job when the account switches", async () => {
    const accountA = `integration:${"a".repeat(64)}` as const;
    const accountB = `integration:${"b".repeat(64)}` as const;
    const store = createStore();
    const oldJob = deferred();
    const newJob = deferred();
    store.start(
      "k",
      request(() => oldJob.promise, accountA),
    );
    expect(
      store.start(
        "k",
        request(() => newJob.promise, accountB),
      ),
    ).toBe("started");
    oldJob.resolve(ok(["account-a-model"]));
    newJob.resolve(ok(["account-b-model"]));
    await store.settled("k");
    await oldJob.promise;
    await Promise.resolve();
    expect(store.served("k")?.inventory.models).toEqual([
      { id: "account-b-model" },
    ]);
    expect(store.served("k")?.credential).toBe(accountB);
  });

  it("does not bring back the old account's models when the replacement fails", async () => {
    const store = createStore();
    store.start(
      "k",
      request(async () => ok(["account-a-model"])),
    );
    await store.settled("k");
    store.invalidate("k");
    store.start(
      "k",
      request(async () => ({
        ok: false,
        failure: "credential",
        modelListAttempt: "http-error",
      })),
    );
    await store.settled("k");
    expect(store.served("k")).toBeUndefined();
    expect(store.state("k")?.failure).toMatchObject({ kind: "credential" });
  });
});

describe("subscriptions", () => {
  it("keeps a shared job running while another subscriber remains", async () => {
    const store = createStore();
    const first = subscriber();
    const second = subscriber();
    store.subscribe("k", first);
    store.subscribe("k", second);
    const job = deferred();
    let signal: AbortSignal | undefined;
    store.start(
      "k",
      request((received) => {
        signal = received;
        return job.promise;
      }),
    );
    await Promise.resolve();
    store.unsubscribe("k", first);
    expect(signal?.aborted).toBe(false);
    job.resolve(ok(["a"]));
    await store.settled("k");
    expect(store.served("k")).toBeDefined();
    expect(second.updates).toEqual(["binding"]);
    expect(first.updates).toEqual([]);
  });

  it("lets a new subscriber start at once after an abandoned job", async () => {
    let now = 0;
    const store = createStore(() => now);
    const first = subscriber();
    store.subscribe("k", first);
    store.start(
      "k",
      request(() => deferred().promise),
    );
    await Promise.resolve();
    store.unsubscribe("k", first);
    now = 1;
    store.subscribe("k", subscriber());
    expect(
      store.start(
        "k",
        request(async () => ok(["a"])),
      ),
    ).toBe("started");
  });

  it("still throttles after the last subscriber leaves a finished job", async () => {
    let now = 0;
    const store = createStore(() => now);
    const first = subscriber();
    store.subscribe("k", first);
    store.start(
      "k",
      request(async () => ok(["a"])),
    );
    await store.settled("k");
    store.unsubscribe("k", first);
    now = 1;
    store.subscribe("k", subscriber());
    expect(
      store.start(
        "k",
        request(async () => ok(["b"])),
      ),
    ).toBe("throttled");
  });

  it("aborts the job when the last subscriber leaves", () => {
    const store = createStore();
    const sub = subscriber();
    store.subscribe("k", sub);
    let signal: AbortSignal | undefined;
    store.start(
      "k",
      request((received) => {
        signal = received;
        return deferred().promise;
      }),
    );
    return Promise.resolve().then(() => {
      store.unsubscribe("k", sub);
      expect(signal?.aborted).toBe(true);
      expect(store.state("k")?.running).toBe(false);
    });
  });
});

describe("persisted bindings", () => {
  const binding = (credential: Binding["credential"]): Binding => ({
    key: "k",
    endpointKey: "e",
    providerID: "local",
    credential,
    inventory: inventory(["a"]),
  });

  it("serves a settings-key binding immediately", () => {
    const store = createStore();
    store.seed(binding("settings"));
    expect(store.served("k")).toBeDefined();
  });

  it("holds an integration binding until its credential is confirmed", () => {
    const store = createStore();
    const credential = `integration:${"a".repeat(64)}` as const;
    store.seed(binding(credential));
    expect(store.served("k")).toBeUndefined();
    expect(store.verify("k", credential)).toBe(true);
    expect(store.served("k")).toBeDefined();
  });

  it("drops an integration binding for another account", () => {
    const store = createStore();
    store.seed(binding(`integration:${"a".repeat(64)}`));
    expect(store.verify("k", `integration:${"b".repeat(64)}`)).toBe(false);
    expect(store.served("k")).toBeUndefined();
    expect(store.verify("k", `integration:${"a".repeat(64)}`)).toBe(false);
  });

  it("does not replace a live binding", async () => {
    const store = createStore();
    store.start(
      "k",
      request(async () => ok(["live"])),
    );
    await store.settled("k");
    store.seed(binding("settings"));
    expect(store.served("k")?.inventory.models).toEqual([{ id: "live" }]);
  });
});

describe("sharedStore", () => {
  it("lives on globalThis under the versioned symbol", () => {
    expect(sharedStore()).toBe(
      (globalThis as Record<symbol, unknown>)[STORE_SYMBOL],
    );
    expect(STORE_SYMBOL).toBe(
      Symbol.for("opencode-model-scout/discovery-store/v1"),
    );
  });
});
