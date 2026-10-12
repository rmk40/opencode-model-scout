/**
 * Discovery store shared by every plugin instance in the process.
 *
 * The host evaluates the plugin module once per location, so module-level
 * state is not shared; the store lives on `globalThis` under a versioned
 * `Symbol.for` key. Entries and their jobs are keyed by the full sync
 * fingerprint of a target (provider ID, normalized base URL, probe
 * selection, API key fingerprint, header fingerprint) plus, for a target
 * without `settings.apiKey`, the fingerprint of the credential the
 * instance resolved for it (see {@link credentialKeys}). Two locations
 * share work only when they would discover the same thing.
 *
 * A job belongs to the store, not to the instance that started it. It is
 * aborted when its last subscriber leaves. Every entry carries a
 * generation, and a job's result is accepted only while its generation is
 * still current. Invalidation bumps the generation and aborts the job; it
 * is a defensive path, because a store key already encodes the one
 * credential fingerprint its jobs and bindings may carry.
 */
import { createHash } from "node:crypto";
import type { ModelListAttempt, ProviderFailure } from "./catalog-evidence";
import type { DiscoveryResult, ProviderInventory } from "./discover";

export const STORE_SYMBOL = Symbol.for(
  "opencode-model-scout/discovery-store/v1",
);

/** Minimum time between discovery starts for one target. */
export const MIN_REFRESH_INTERVAL_MS = 60_000;

/** Credential that produced a binding: none, `settings.apiKey`, or an integration connection hash. */
export type CredentialFingerprint =
  | "none"
  | "settings"
  | `integration:${string}`;

/** Immutable result of a successful discovery for one target. */
export interface Binding {
  readonly key: string;
  readonly endpointKey: string;
  readonly providerID: string;
  readonly credential: CredentialFingerprint;
  readonly inventory: ProviderInventory;
}

/** Failure of the latest attempt; the last good binding stays. */
export interface EntryFailure extends ProviderFailure {
  readonly modelListAttempt: ModelListAttempt;
}

export type StoreUpdate = "binding" | "failure" | "invalidated";

export interface Subscriber {
  onUpdate(key: string, update: StoreUpdate): void;
  /** Persist a new binding; called on one subscriber per completed job. */
  persist(binding: Binding): Promise<void>;
}

export type StartResult = "started" | "joined" | "throttled";

export interface StartRequest {
  readonly credential: CredentialFingerprint;
  readonly endpointKey: string;
  readonly providerID: string;
  readonly timeoutMs: number;
  readonly run: (signal: AbortSignal) => Promise<DiscoveryResult>;
}

interface Job {
  readonly generation: number;
  readonly credential: CredentialFingerprint;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

interface Entry {
  readonly key: string;
  generation: number;
  binding: Binding | undefined;
  /** Persisted binding whose integration credential is not yet confirmed. */
  unverified: Binding | undefined;
  failure: EntryFailure | undefined;
  job: Job | undefined;
  lastStartedAt: number | undefined;
  readonly subscribers: Set<Subscriber>;
}

export interface EntryState {
  readonly generation: number;
  readonly binding: Binding | undefined;
  readonly failure: EntryFailure | undefined;
  readonly running: boolean;
  readonly lastStartedAt: number | undefined;
}

export interface DiscoveryStore {
  /** The servable binding for a key, if any. */
  served(key: string): Binding | undefined;
  state(key: string): EntryState | undefined;
  subscribe(key: string, subscriber: Subscriber): void;
  unsubscribe(key: string, subscriber: Subscriber): void;
  /**
   * Add a persisted binding to an entry that has none. Bindings that depend
   * on an integration credential stay unverified until {@link verify}.
   */
  seed(binding: Binding): void;
  /** Promote an unverified binding when the credential matches; drop it otherwise. */
  verify(key: string, credential: CredentialFingerprint): boolean;
  /**
   * Bump the generation, clear the binding, abort the job, and notify
   * subscribers. Defensive: a store key maps to one credential fingerprint,
   * so the refresher never needs to invalidate an entry.
   */
  invalidate(key: string): void;
  /**
   * Start discovery, or join the in-flight job for the same credential.
   * Starts are throttled to one per {@link MIN_REFRESH_INTERVAL_MS} per key;
   * invalidation resets the throttle. A request whose credential differs
   * from the in-flight job's invalidates the entry first; that is a
   * defensive path, since a store key maps to one credential fingerprint.
   */
  start(key: string, request: StartRequest): StartResult;
  /** Resolves when the key's in-flight job settles. */
  settled(key: string): Promise<void>;
}

function sha256(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:${part}`);
  return hash.digest("hex");
}

/** Fingerprint of a secret value; never reversible to the value. */
export function fingerprint(domain: string, value: string): string {
  return sha256(["opencode-model-scout", domain, value]);
}

export interface TargetIdentity {
  readonly providerID: string;
  /** Normalized base URL. */
  readonly baseURL: string;
  /** Canonical probe selection (`auto`, a registry key, or the raw value). */
  readonly probe: string | undefined;
  readonly apiKey: string | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;
}

export interface TargetKeys {
  /** Full sync fingerprint: endpoint identity plus probe selection. */
  readonly key: string;
  /** Endpoint identity without the probe selection. */
  readonly endpointKey: string;
}

function headersFingerprint(
  headers: Readonly<Record<string, string>> | undefined,
): string {
  if (!headers) return "";
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (entries.length === 0) return "";
  return fingerprint("headers", JSON.stringify(entries));
}

export function targetKeys(identity: TargetIdentity): TargetKeys {
  const endpointKey = sha256([
    "endpoint",
    identity.providerID,
    identity.baseURL,
    identity.apiKey === undefined
      ? ""
      : fingerprint("api-key", identity.apiKey),
    headersFingerprint(identity.headers),
  ]);
  return {
    endpointKey,
    key: sha256(["target", endpointKey, identity.probe ?? ""]),
  };
}

/**
 * Store identity of a target once its credential is resolved. A
 * `settings.apiKey` is already part of the sync key. Any other credential
 * (an integration connection, or none) depends on the instance that
 * resolved it, so its fingerprint is added to the key; locations with
 * different credentials never share an entry. The endpoint key stays the
 * sync endpoint identity, which the synchronous model transform can compute
 * and compare against the instance's active binding.
 */
export function credentialKeys(
  keys: TargetKeys,
  credential: CredentialFingerprint,
): TargetKeys {
  if (credential === "settings") return keys;
  return {
    endpointKey: keys.endpointKey,
    key: sha256(["credential", keys.key, credential]),
  };
}

export function createStore(now: () => number = Date.now): DiscoveryStore {
  const entries = new Map<string, Entry>();

  const entry = (key: string): Entry => {
    let current = entries.get(key);
    if (!current) {
      current = {
        key,
        generation: 0,
        binding: undefined,
        unverified: undefined,
        failure: undefined,
        job: undefined,
        lastStartedAt: undefined,
        subscribers: new Set(),
      };
      entries.set(key, current);
    }
    return current;
  };

  const notify = (current: Entry, update: StoreUpdate): void => {
    for (const subscriber of [...current.subscribers]) {
      try {
        subscriber.onUpdate(current.key, update);
      } catch {
        // One subscriber's failure must not starve the others.
      }
    }
  };

  const abortJob = (current: Entry): void => {
    const job = current.job;
    current.job = undefined;
    job?.controller.abort();
  };

  const invalidate = (key: string): void => {
    const current = entries.get(key);
    if (!current) return;
    current.generation += 1;
    current.binding = undefined;
    current.unverified = undefined;
    current.failure = undefined;
    current.lastStartedAt = undefined;
    abortJob(current);
    notify(current, "invalidated");
  };

  const finish = (
    current: Entry,
    job: Job,
    request: StartRequest,
    result: DiscoveryResult,
  ): void => {
    if (current.job !== job) return;
    current.job = undefined;
    if (current.generation !== job.generation || job.controller.signal.aborted)
      return;
    if (result.ok) {
      const binding: Binding = {
        key: current.key,
        endpointKey: request.endpointKey,
        providerID: request.providerID,
        credential: job.credential,
        inventory: result.inventory,
      };
      current.binding = binding;
      current.unverified = undefined;
      current.failure = undefined;
      const [persister] = current.subscribers;
      if (persister) void persister.persist(binding).catch(() => {});
      notify(current, "binding");
      return;
    }
    current.failure = {
      kind: result.failure,
      at: new Date(now()).toISOString(),
      modelListAttempt: result.modelListAttempt,
    };
    notify(current, "failure");
  };

  return {
    served: (key) => entries.get(key)?.binding,

    state: (key) => {
      const current = entries.get(key);
      if (!current) return undefined;
      return {
        generation: current.generation,
        binding: current.binding,
        failure: current.failure,
        running: current.job !== undefined,
        lastStartedAt: current.lastStartedAt,
      };
    },

    subscribe: (key, subscriber) => {
      entry(key).subscribers.add(subscriber);
    },

    unsubscribe: (key, subscriber) => {
      const current = entries.get(key);
      if (!current) return;
      current.subscribers.delete(subscriber);
      if (current.subscribers.size > 0 || !current.job) return;
      abortJob(current);
      // The aborted job produced nothing, so it must not throttle the next
      // instance that subscribes and starts discovery.
      current.lastStartedAt = undefined;
    },

    seed: (binding) => {
      const current = entry(binding.key);
      if (current.binding || current.unverified || current.job) return;
      if (binding.credential.startsWith("integration:"))
        current.unverified = binding;
      else current.binding = binding;
    },

    verify: (key, credential) => {
      const current = entries.get(key);
      const pending = current?.unverified;
      if (!current || !pending) return false;
      current.unverified = undefined;
      if (pending.credential !== credential || current.binding) return false;
      current.binding = pending;
      return true;
    },

    invalidate,

    start: (key, request) => {
      const current = entry(key);
      if (current.job) {
        if (current.job.credential === request.credential) return "joined";
        invalidate(key);
      } else if (
        current.lastStartedAt !== undefined &&
        now() - current.lastStartedAt < MIN_REFRESH_INTERVAL_MS
      ) {
        return "throttled";
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(request.timeoutMs),
      ]);
      current.lastStartedAt = now();
      const generation = current.generation;
      // Settlement can only run after this turn, when the job is assigned.
      const created: { job?: Job } = {};
      const promise = Promise.resolve()
        .then(() => request.run(signal))
        .then(
          (result) => {
            if (created.job) finish(current, created.job, request, result);
          },
          () => {
            if (created.job)
              finish(current, created.job, request, {
                ok: false,
                failure: "error",
                modelListAttempt: "error",
              });
          },
        );
      created.job = {
        generation,
        credential: request.credential,
        controller,
        promise,
      };
      current.job = created.job;
      return "started";
    },

    settled: (key) => entries.get(key)?.job?.promise ?? Promise.resolve(),
  };
}

type StoreHolder = { [STORE_SYMBOL]?: DiscoveryStore };

/** The process-wide store, created on first use. */
export function sharedStore(): DiscoveryStore {
  const holder = globalThis as StoreHolder;
  holder[STORE_SYMBOL] ??= createStore();
  return holder[STORE_SYMBOL];
}
