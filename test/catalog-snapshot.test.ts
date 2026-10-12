import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CATALOG_SCHEMA_VERSION,
  DISABLE_CATALOG_PERSISTENCE_ENV,
  MAX_CATALOG_SNAPSHOT_BYTES,
  RUNNING_SNAPSHOT_STALE_MS,
  SNAPSHOT_LOCK_STALE_MS,
  catalogSnapshotPath,
  clearCatalogBridge,
  createAttemptId,
  createProviderFingerprint,
  createRuntimeKey,
  createServerKey,
  createWorktreeKey,
  knownScalar,
  parseCatalogSnapshot,
  persistCompleteSnapshot,
  persistRunningSnapshot,
  publishCompleteSnapshot,
  publishRunningSnapshot,
  readCatalogBridge,
  readPersistedSnapshot,
  resolveExactCatalogSnapshot,
  normalizeServerBaseUrl,
  sanitizeEndpointOrigin,
  unknownCapability,
  unknownScalar,
  validateCatalogSnapshot,
  type CatalogModelRecord,
  type CompleteCatalogSnapshot,
  type RunningCatalogSnapshot,
} from "../src/catalog-snapshot";

const tempDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "model-scout-test-"));
  tempDirectories.push(directory);
  return directory;
}

function model(id = "atlas-model"): CatalogModelRecord {
  return {
    id,
    origin: "discovered",
    identity: knownScalar(id, "server-list", "reported"),
    name: knownScalar("Atlas Model", "heuristic", "inferred"),
    modelType: knownScalar("llm", "provider-probe", "authoritative"),
    context: knownScalar(8192, "provider-probe", "authoritative"),
    output: unknownScalar(),
    family: unknownScalar(),
    organizationOwner: unknownScalar(),
    parameterSize: unknownScalar(),
    quantization: unknownScalar(),
    sizeBytes: unknownScalar(),
    probeIdentity: knownScalar("atlas", "provider-probe", "reported"),
    capabilities: {
      vision: {
        state: "unsupported",
        source: "provider-probe",
        strength: "authoritative",
      },
      toolCall: unknownCapability(),
      reasoning: unknownCapability(),
      temperature: {
        state: "supported",
        source: "policy-default",
        strength: "assumed",
      },
    },
  };
}

function running(
  overrides: Partial<RunningCatalogSnapshot> = {},
): RunningCatalogSnapshot {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    packageVersion: "1.6.0",
    status: "running",
    attemptId: createAttemptId(),
    startedAt: new Date().toISOString(),
    worktreeKey: createWorktreeKey("/tmp/worktree"),
    serverKey: createServerKey("http://127.0.0.1:4096/")!,
    runtimeKey: createRuntimeKey(),
    providerFingerprint: createProviderFingerprint([
      { id: "atlas", baseURL: "https://atlas.test/v1" },
    ]),
    ...overrides,
  };
}

function complete(marker: RunningCatalogSnapshot): CompleteCatalogSnapshot {
  return {
    ...marker,
    status: "complete",
    completedAt: new Date().toISOString(),
    providers: [
      {
        id: "atlas",
        endpointOrigin: knownScalar(
          "https://atlas.test",
          "pre-existing",
          "configured",
        ),
        configuredProbe: knownScalar("atlas", "pre-existing", "configured"),
        resolvedProbe: knownScalar("atlas", "provider-probe", "reported"),
        status: "ready",
        modelListAttempt: "ready",
        probeAttempt: "complete",
        skippedModelIds: [],
        models: [model()],
      },
    ],
  };
}

function correlation(
  marker: RunningCatalogSnapshot,
  overrides: Partial<{
    serverKey: string;
    worktreeKey: string;
    providerFingerprint: string;
    runtimeKey: string;
    diskNotBeforeMs: number;
    diskNotAfterMs: number;
  }> = {},
) {
  return {
    serverKey: marker.serverKey,
    worktreeKey: marker.worktreeKey,
    providerFingerprint: marker.providerFingerprint,
    runtimeKey: marker.runtimeKey,
    diskNotBeforeMs: Date.parse(marker.startedAt),
    diskNotAfterMs: Date.parse(marker.startedAt) + 60_000,
    ...overrides,
  };
}

afterEach(async () => {
  clearCatalogBridge();
  delete process.env[DISABLE_CATALOG_PERSISTENCE_ENV];
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("catalog snapshot validation", () => {
  it("accepts a strict finite complete snapshot", () => {
    const snapshot = complete(running());
    expect(validateCatalogSnapshot(snapshot)).toEqual(snapshot);
    expect(parseCatalogSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("rejects unknown versions, fields, unsafe keys, and non-finite numbers", () => {
    const snapshot = complete(running());
    expect(
      validateCatalogSnapshot({ ...snapshot, schemaVersion: 99 }),
    ).toBeUndefined();
    expect(
      validateCatalogSnapshot({ ...snapshot, unexpected: true }),
    ).toBeUndefined();
    const unsafe = JSON.parse(
      JSON.stringify(snapshot).replace(
        '"providers":',
        '"__proto__":{},"providers":',
      ),
    ) as unknown;
    expect(validateCatalogSnapshot(unsafe)).toBeUndefined();
    const invalid = structuredClone(snapshot);
    invalid.providers[0].models[0].context = {
      state: "known",
      value: Number.POSITIVE_INFINITY,
      source: "provider-probe",
      strength: "authoritative",
    };
    expect(validateCatalogSnapshot(invalid)).toBeUndefined();
  });

  it("rejects duplicate provider and model keys", () => {
    const snapshot = complete(running());
    snapshot.providers.push(structuredClone(snapshot.providers[0]));
    expect(validateCatalogSnapshot(snapshot)).toBeUndefined();

    const other = complete(running());
    other.providers[0].models.push(model());
    expect(validateCatalogSnapshot(other)).toBeUndefined();
  });

  it("rejects oversized JSON before parsing", () => {
    expect(
      parseCatalogSnapshot("x".repeat(MAX_CATALOG_SNAPSHOT_BYTES + 1)),
    ).toBeUndefined();
  });

  it("permits unsupported only as authoritative provider evidence", () => {
    const snapshot = complete(running());
    const capability = snapshot.providers[0].models[0].capabilities.vision;
    expect(capability.state).toBe("unsupported");
    snapshot.providers[0].models[0].capabilities.vision = {
      state: "supported",
      source: "policy-default",
      strength: "assumed",
    };
    expect(validateCatalogSnapshot(snapshot)).toBeDefined();
  });

  it("accepts configured claims and rejects authoritative pre-existing claims", () => {
    const snapshot = complete(running());
    expect(snapshot.providers[0].configuredProbe).toMatchObject({
      source: "pre-existing",
      strength: "configured",
    });
    expect(validateCatalogSnapshot(snapshot)).toBeDefined();
    snapshot.providers[0].configuredProbe = knownScalar(
      "atlas",
      "pre-existing",
      "authoritative",
    );
    expect(validateCatalogSnapshot(snapshot)).toBeUndefined();
  });
});

describe("catalog privacy keys", () => {
  it("hashes worktrees and strips sensitive URL components", () => {
    const rawWorktree = "/Users/person/private/repository";
    const key = createWorktreeKey(rawWorktree);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("private");
    expect(
      sanitizeEndpointOrigin(
        "https://user:secret@atlas.test:8443/private/v1?apiKey=secret#models",
      ),
    ).toBe("https://atlas.test:8443");
    expect(
      createProviderFingerprint([
        {
          id: "atlas",
          baseURL: "https://user:secret@atlas.test/private?token=secret",
          probe: "atlas",
        },
      ]),
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createProviderFingerprint([
        { id: "atlas", baseURL: "https://atlas.test/private", probe: "atlas" },
      ]),
    ).not.toBe(
      createProviderFingerprint([
        { id: "atlas", baseURL: "https://atlas.test/other", probe: "atlas" },
      ]),
    );
    expect(
      createProviderFingerprint([
        { id: "atlas", baseURL: "https://atlas.test/private", probe: "auto" },
      ]),
    ).not.toBe(
      createProviderFingerprint([
        { id: "atlas", baseURL: "https://atlas.test/private", probe: "atlas" },
      ]),
    );
  });

  it("normalizes and hashes only valid HTTP server base URLs", () => {
    expect(normalizeServerBaseUrl("HTTP://Atlas.Test:80/api///")).toBe(
      "http://atlas.test/api",
    );
    expect(normalizeServerBaseUrl("https://atlas.test/")).toBe(
      "https://atlas.test",
    );
    expect(
      normalizeServerBaseUrl(
        "https://user:secret@atlas.test/api/?token=secret#fragment",
      ),
    ).toBe("https://atlas.test/api");
    expect(createServerKey("file:///tmp/server")).toBeUndefined();
    expect(createServerKey("not a URL")).toBeUndefined();
    expect(createServerKey("https://atlas.test/")).toBe(
      createServerKey("https://atlas.test"),
    );
  });

  it("canonicalizes every HTTP loopback control-server alias and port", () => {
    const internal = createServerKey("http://opencode.internal");
    expect(createServerKey("http://localhost:4096/")).toBe(internal);
    expect(createServerKey("http://localhost:5123/control")).toBe(internal);
    expect(createServerKey("http://127.0.0.1:6553")).toBe(internal);
    expect(createServerKey("http://[::1]:7331/api")).toBe(internal);
    expect(createServerKey("https://localhost:4096")).not.toBe(internal);
    expect(createServerKey("https://atlas.test")).not.toBe(internal);
    expect(createServerKey("https://atlas.test:4096")).not.toBe(
      createServerKey("https://atlas.test"),
    );
  });

  it("uses only worktree and server hashes in the persisted filename", () => {
    const rawWorktree = "/tmp/private-worktree";
    const key = createWorktreeKey(rawWorktree);
    const rawServer = "https://user:secret@atlas.test/api?token=secret";
    const serverKey = createServerKey(rawServer)!;
    const filePath = catalogSnapshotPath(key, serverKey, "/tmp/cache");
    expect(filePath).toBe(
      `/tmp/cache/opencode/model-scout/${key}.${serverKey}.json`,
    );
    expect(filePath).not.toContain("private-worktree");
    expect(filePath).not.toContain("atlas.test");
    expect(JSON.stringify(running({ serverKey }))).not.toContain(rawServer);
    expect(running().runtimeKey).not.toBe(String(process.pid));
  });
});

describe("atomic persistence ownership", () => {
  it("allows only one concurrent running-marker owner", async () => {
    const cache = await tempDirectory();
    const first = running();
    const second = running({ worktreeKey: first.worktreeKey });
    const results = await Promise.all([
      persistRunningSnapshot(first, cache),
      persistRunningSnapshot(second, cache),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await readFile(
      catalogSnapshotPath(first.worktreeKey, first.serverKey, cache)!,
      "utf8",
    );
    const parsed = parseCatalogSnapshot(stored);
    expect(parsed?.status).toBe("running");
    expect([first.attemptId, second.attemptId]).toContain(parsed?.attemptId);
  });

  it("isolates concurrent remote servers in the same worktree", async () => {
    const cache = await tempDirectory();
    const first = running();
    const second = running({
      worktreeKey: first.worktreeKey,
      serverKey: createServerKey("https://atlas.test:4097")!,
    });
    expect(
      await Promise.all([
        persistRunningSnapshot(first, cache),
        persistRunningSnapshot(second, cache),
      ]),
    ).toEqual([true, true]);
    expect(
      catalogSnapshotPath(first.worktreeKey, first.serverKey, cache),
    ).not.toBe(
      catalogSnapshotPath(second.worktreeKey, second.serverKey, cache),
    );
  });

  it("lets runtime identity arbitrate concurrent default aliases", async () => {
    const cache = await tempDirectory();
    const first = running({
      serverKey: createServerKey("http://opencode.internal")!,
      runtimeKey: createRuntimeKey(1001),
    });
    const second = running({
      worktreeKey: first.worktreeKey,
      serverKey: createServerKey("http://localhost:7331")!,
      runtimeKey: createRuntimeKey(1002),
    });
    const results = await Promise.all([
      persistRunningSnapshot(first, cache),
      persistRunningSnapshot(second, cache),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? first : second;
    const loser = results[0] ? second : first;
    expect(await persistCompleteSnapshot(complete(loser), cache)).toBe(false);
    expect(await persistCompleteSnapshot(complete(winner), cache)).toBe(true);
  });

  it("protects active markers and replaces only deterministically stale ones", async () => {
    expect(RUNNING_SNAPSHOT_STALE_MS).toBeGreaterThan(60_000);
    const cache = await tempDirectory();
    const now = Date.parse("2026-07-22T12:00:00.000Z");
    const owner = running({ startedAt: new Date(now).toISOString() });
    expect(await persistRunningSnapshot(owner, cache, now)).toBe(true);

    const contender = running({
      worktreeKey: owner.worktreeKey,
      startedAt: new Date(now + RUNNING_SNAPSHOT_STALE_MS).toISOString(),
    });
    expect(
      await persistRunningSnapshot(
        contender,
        cache,
        now + RUNNING_SNAPSHOT_STALE_MS,
      ),
    ).toBe(false);

    const replacement = running({
      worktreeKey: owner.worktreeKey,
      startedAt: new Date(now + RUNNING_SNAPSHOT_STALE_MS + 1).toISOString(),
    });
    expect(
      await persistRunningSnapshot(
        replacement,
        cache,
        now + RUNNING_SNAPSHOT_STALE_MS + 1,
      ),
    ).toBe(true);
    const stored = parseCatalogSnapshot(
      await readFile(
        catalogSnapshotPath(owner.worktreeKey, owner.serverKey, cache)!,
        "utf8",
      ),
    );
    expect(stored?.attemptId).toBe(replacement.attemptId);
  });

  it("does not let an older delayed marker replace a newer completion", async () => {
    const cache = await tempDirectory();
    const base = Date.parse("2026-07-22T12:00:00.000Z");
    const older = running({ startedAt: new Date(base).toISOString() });
    const newer = running({
      worktreeKey: older.worktreeKey,
      serverKey: older.serverKey,
      startedAt: new Date(base + 1_000).toISOString(),
    });
    expect(await persistRunningSnapshot(newer, cache, base + 1_000)).toBe(true);
    expect(await persistCompleteSnapshot(complete(newer), cache)).toBe(true);
    expect(
      await persistRunningSnapshot(
        older,
        cache,
        base + RUNNING_SNAPSHOT_STALE_MS + 10_000,
      ),
    ).toBe(false);
    expect(
      await readPersistedSnapshot(older.worktreeKey, older.serverKey, cache),
    ).toMatchObject({ status: "complete", attemptId: newer.attemptId });
  });

  it("recovers stale locks but never steals an active lock", async () => {
    expect(SNAPSHOT_LOCK_STALE_MS).toBeGreaterThan(60_000);
    const cache = await tempDirectory();
    const marker = running();
    const filePath = catalogSnapshotPath(
      marker.worktreeKey,
      marker.serverKey,
      cache,
    )!;
    await mkdir(path.dirname(filePath), { recursive: true });
    const lockPath = `${filePath}.lock`;
    await writeFile(lockPath, "", { mode: 0o600 });
    const now = Date.now();
    expect(await persistRunningSnapshot(marker, cache, now)).toBe(false);

    const staleTime = new Date(now - SNAPSHOT_LOCK_STALE_MS - 1);
    await utimes(lockPath, staleTime, staleTime);
    expect(await persistRunningSnapshot(marker, cache, now)).toBe(true);
  });

  it("recovers when both the primary and recovery locks are stale", async () => {
    const cache = await tempDirectory();
    const marker = running();
    const filePath = catalogSnapshotPath(
      marker.worktreeKey,
      marker.serverKey,
      cache,
    )!;
    await mkdir(path.dirname(filePath), { recursive: true });
    const lockPath = `${filePath}.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    await writeFile(lockPath, "", { mode: 0o600 });
    await writeFile(recoveryPath, "", { mode: 0o600 });
    const now = Date.now();
    const staleTime = new Date(now - SNAPSHOT_LOCK_STALE_MS - 1);
    await utimes(lockPath, staleTime, staleTime);
    await utimes(recoveryPath, staleTime, staleTime);

    expect(await persistRunningSnapshot(marker, cache, now)).toBe(true);
  });

  it("drops an aborted delayed write before its atomic rename", async () => {
    const cache = await tempDirectory();
    const marker = running();
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks >= 13;
      },
    } as AbortSignal;
    expect(
      await persistRunningSnapshot(marker, cache, Date.now(), signal),
    ).toBe(false);
    expect(checks).toBeGreaterThanOrEqual(13);
    expect(
      await readPersistedSnapshot(marker.worktreeKey, marker.serverKey, cache),
    ).toBeUndefined();
  });

  it("keeps the running owner when completion is aborted before rename", async () => {
    const cache = await tempDirectory();
    const marker = running();
    expect(await persistRunningSnapshot(marker, cache)).toBe(true);
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks >= 16;
      },
    } as AbortSignal;
    expect(await persistCompleteSnapshot(complete(marker), cache, signal)).toBe(
      false,
    );
    const stored = parseCatalogSnapshot(
      await readFile(
        catalogSnapshotPath(marker.worktreeKey, marker.serverKey, cache)!,
        "utf8",
      ),
    );
    expect(stored).toMatchObject({
      status: "running",
      attemptId: marker.attemptId,
    });
  });

  it("completes only its own marker and replaces prior completion on URL reuse", async () => {
    const cache = await tempDirectory();
    const owner = running();
    const intruder = running({
      worktreeKey: owner.worktreeKey,
      startedAt: new Date(Date.parse(owner.startedAt) + 1).toISOString(),
    });
    expect(await persistRunningSnapshot(owner, cache)).toBe(true);
    expect(await persistCompleteSnapshot(complete(intruder), cache)).toBe(
      false,
    );
    expect(await persistCompleteSnapshot(complete(owner), cache)).toBe(true);
    expect(await persistCompleteSnapshot(complete(owner), cache)).toBe(false);
    expect(await persistRunningSnapshot(intruder, cache)).toBe(true);
    const stored = parseCatalogSnapshot(
      await readFile(
        catalogSnapshotPath(owner.worktreeKey, owner.serverKey, cache)!,
        "utf8",
      ),
    );
    expect(stored).toMatchObject({
      status: "running",
      attemptId: intruder.attemptId,
    });
  });

  it("writes owner-only directory and file modes where supported", async () => {
    if (process.platform === "win32") return;
    const cache = await tempDirectory();
    const marker = running();
    expect(await persistRunningSnapshot(marker, cache)).toBe(true);
    const filePath = catalogSnapshotPath(
      marker.worktreeKey,
      marker.serverKey,
      cache,
    )!;
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
  });

  it("degrades on corrupt and oversized files", async () => {
    const cache = await tempDirectory();
    const marker = running();
    const filePath = catalogSnapshotPath(
      marker.worktreeKey,
      marker.serverKey,
      cache,
    )!;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{broken", { mode: 0o600 });
    expect(
      await readPersistedSnapshot(marker.worktreeKey, marker.serverKey, cache),
    ).toBeUndefined();
    await writeFile(filePath, Buffer.alloc(MAX_CATALOG_SNAPSHOT_BYTES + 1));
    expect(
      await readPersistedSnapshot(marker.worktreeKey, marker.serverKey, cache),
    ).toBeUndefined();
  });

  it("silently degrades when the cache directory is unwritable", async () => {
    if (process.platform === "win32") return;
    const cache = await tempDirectory();
    await chmod(cache, 0o500);
    const result = await persistRunningSnapshot(running(), cache);
    await chmod(cache, 0o700);
    // Root can bypass mode bits in some CI containers; either outcome is safe.
    expect(typeof result).toBe("boolean");
  });

  it("honors the persistence escape hatch without disabling the bridge", async () => {
    const cache = await tempDirectory();
    const marker = running();
    process.env[DISABLE_CATALOG_PERSISTENCE_ENV] = "1";
    publishRunningSnapshot(marker);
    expect(await persistRunningSnapshot(marker, cache)).toBe(false);
    expect(readCatalogBridge()).toEqual(marker);
    expect(
      catalogSnapshotPath(marker.worktreeKey, marker.serverKey, cache),
    ).toBeDefined();
  });
});

describe("exact-attempt bridge", () => {
  it("publishes complete only over its own active running attempt", () => {
    const marker = running();
    const other = running({ worktreeKey: marker.worktreeKey });
    publishRunningSnapshot(marker);
    expect(publishCompleteSnapshot(complete(other))).toBe(false);
    expect(readCatalogBridge()).toEqual(marker);
    expect(publishCompleteSnapshot(complete(marker))).toBe(true);
    expect(readCatalogBridge()?.status).toBe("complete");
  });

  it("uses a complete bridge only when every launch identity matches", async () => {
    const marker = running();
    const snapshot = complete(marker);
    process.env[DISABLE_CATALOG_PERSISTENCE_ENV] = "1";
    publishRunningSnapshot(marker);
    publishCompleteSnapshot(snapshot);
    await expect(
      resolveExactCatalogSnapshot(correlation(marker)),
    ).resolves.toEqual({ snapshot, exactAttempt: true });
    await expect(
      resolveExactCatalogSnapshot(
        correlation(marker, {
          providerFingerprint: createProviderFingerprint([]),
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      resolveExactCatalogSnapshot(
        correlation(marker, { runtimeKey: createRuntimeKey(process.pid + 1) }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      resolveExactCatalogSnapshot(
        correlation(marker, {
          serverKey: createServerKey("https://atlas.test:4097")!,
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      resolveExactCatalogSnapshot(
        correlation(marker, { worktreeKey: createWorktreeKey("other") }),
      ),
    ).resolves.toBeUndefined();
  });

  it("reads an exact cross-realm completion without a global marker", async () => {
    const cache = await tempDirectory();
    const marker = running();
    const snapshot = complete(marker);
    expect(await persistRunningSnapshot(marker, cache)).toBe(true);
    expect(await persistCompleteSnapshot(snapshot, cache)).toBe(true);

    expect(
      await resolveExactCatalogSnapshot(correlation(marker), cache),
    ).toEqual({ snapshot, exactAttempt: true });
  });

  it("keeps cross-realm provenance unavailable when persistence is disabled", async () => {
    const cache = await tempDirectory();
    const marker = running();
    const snapshot = complete(marker);
    await persistRunningSnapshot(marker, cache);
    await persistCompleteSnapshot(snapshot, cache);
    clearCatalogBridge();
    process.env[DISABLE_CATALOG_PERSISTENCE_ENV] = "1";
    expect(
      await resolveExactCatalogSnapshot(correlation(marker), cache),
    ).toBeUndefined();
  });

  it("rejects wrong keys and snapshots outside both startup bounds", async () => {
    const cache = await tempDirectory();
    const marker = running({ startedAt: "2026-07-22T12:00:00.000Z" });
    await persistRunningSnapshot(marker, cache);
    await persistCompleteSnapshot(complete(marker), cache);
    expect(
      await resolveExactCatalogSnapshot(
        correlation(marker, {
          serverKey: createServerKey("https://atlas.test:4097")!,
        }),
        cache,
      ),
    ).toBeUndefined();
    expect(
      await resolveExactCatalogSnapshot(
        correlation(marker, {
          runtimeKey: createRuntimeKey(process.pid + 1),
        }),
        cache,
      ),
    ).toBeUndefined();
    expect(
      await resolveExactCatalogSnapshot(
        correlation(marker, { worktreeKey: createWorktreeKey("other") }),
        cache,
      ),
    ).toBeUndefined();
    expect(
      await resolveExactCatalogSnapshot(
        correlation(marker, {
          providerFingerprint: createProviderFingerprint([]),
        }),
        cache,
      ),
    ).toBeUndefined();
    expect(
      await resolveExactCatalogSnapshot(
        correlation(marker, {
          diskNotBeforeMs: Date.parse("2026-07-22T12:00:00.001Z"),
        }),
        cache,
      ),
    ).toBeUndefined();
    expect(
      await resolveExactCatalogSnapshot(
        correlation(marker, {
          diskNotAfterMs: Date.parse("2026-07-22T11:59:59.999Z"),
        }),
        cache,
      ),
    ).toBeUndefined();
  });

  it("rejects PID-reuse history and future or post-window completions", async () => {
    const cache = await tempDirectory();
    const start = Date.parse("2026-07-22T12:00:00.000Z");
    const reused = running({
      runtimeKey: createRuntimeKey(4242),
      startedAt: new Date(start).toISOString(),
    });
    const oldCompletion = complete(reused);
    oldCompletion.completedAt = new Date(start + 1_000).toISOString();
    await persistRunningSnapshot(reused, cache, start);
    await persistCompleteSnapshot(oldCompletion, cache);
    expect(
      await resolveExactCatalogSnapshot(
        correlation(reused, {
          diskNotBeforeMs: start + 2_000,
          diskNotAfterMs: start + 62_000,
        }),
        cache,
      ),
    ).toBeUndefined();

    const future = running({
      ...reused,
      attemptId: createAttemptId(),
      startedAt: new Date(start + 120_000).toISOString(),
    });
    const futureCompletion = complete(future);
    futureCompletion.completedAt = new Date(start + 121_000).toISOString();
    const futureCache = await tempDirectory();
    await persistRunningSnapshot(future, futureCache, start + 120_000);
    await persistCompleteSnapshot(futureCompletion, futureCache);
    expect(
      await resolveExactCatalogSnapshot(
        correlation(future, {
          diskNotBeforeMs: start - 5_000,
          diskNotAfterMs: start + 60_000,
        }),
        futureCache,
      ),
    ).toBeUndefined();
  });

  it("does not accept an older completion while same-realm launch is running", async () => {
    const cache = await tempDirectory();
    const previous = running();
    await persistRunningSnapshot(previous, cache);
    await persistCompleteSnapshot(complete(previous), cache);
    const active = running({
      worktreeKey: previous.worktreeKey,
      serverKey: previous.serverKey,
    });
    publishRunningSnapshot(active);
    expect(
      await resolveExactCatalogSnapshot(correlation(active), cache),
    ).toBeUndefined();
  });
});
