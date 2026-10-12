import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, chmod, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CATALOG_SCHEMA_VERSION = 3 as const;
export const MAX_CATALOG_SNAPSHOT_BYTES = 8 * 1024 * 1024;
/** Longer than the maximum 60-second config-hook budget. */
export const RUNNING_SNAPSHOT_STALE_MS = 2 * 60 * 1000;
/** Lock recovery is deliberately slower than the maximum config-hook budget. */
export const SNAPSHOT_LOCK_STALE_MS = 2 * 60 * 1000;
export const DISABLE_CATALOG_PERSISTENCE_ENV =
  "OPENCODE_MODEL_SCOUT_DISABLE_PERSISTENCE";

const BRIDGE_SYMBOL = Symbol.for("opencode-model-scout.catalog-snapshot.v3");
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ATTEMPT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ID_LENGTH = 4096;
const MAX_PROVIDERS = 4096;
const MAX_MODELS_PER_PROVIDER = 100_000;

export type MetadataSource =
  | "pre-existing"
  | "server-list"
  | "provider-probe"
  | "models.dev"
  | "heuristic"
  | "policy-default"
  | "unmatched-host";

export type ClaimStrength =
  | "authoritative"
  | "configured"
  | "reported"
  | "inferred"
  | "assumed"
  | "unmatched";

export type ScalarEvidence<T extends string | number> =
  | {
      state: "known";
      value: T;
      source: MetadataSource;
      strength: ClaimStrength;
    }
  | { state: "unknown" };

export type CapabilityEvidence =
  | {
      state: "supported";
      source: MetadataSource;
      strength: ClaimStrength;
    }
  | {
      state: "unsupported";
      source: "provider-probe" | "pre-existing";
      strength: "authoritative" | "configured";
    }
  | { state: "unknown" };

export interface ModelCapabilityEvidence {
  vision: CapabilityEvidence;
  toolCall: CapabilityEvidence;
  reasoning: CapabilityEvidence;
  temperature: CapabilityEvidence;
}

export interface CatalogModelRecord {
  id: string;
  origin: "discovered" | "pre-existing";
  identity: ScalarEvidence<string>;
  name: ScalarEvidence<string>;
  modelType: ScalarEvidence<"llm" | "vlm" | "embedding">;
  context: ScalarEvidence<number>;
  output: ScalarEvidence<number>;
  family: ScalarEvidence<string>;
  organizationOwner: ScalarEvidence<string>;
  parameterSize: ScalarEvidence<string>;
  quantization: ScalarEvidence<string>;
  sizeBytes: ScalarEvidence<number>;
  probeIdentity: ScalarEvidence<string>;
  capabilities: ModelCapabilityEvidence;
}

export type ProviderAttemptStatus =
  | "ready"
  | "empty"
  | "unreachable"
  | "aborted"
  | "error";

export type ModelListAttempt =
  | "ready"
  | "empty"
  | "unreachable"
  | "aborted"
  | "http-error"
  | "invalid-response"
  | "error";

export type ProbeAttempt =
  | "not-requested"
  | "unresolved"
  | "complete"
  | "empty"
  | "aborted"
  | "error";

export interface CatalogProviderRecord {
  id: string;
  endpointOrigin: ScalarEvidence<string>;
  configuredProbe: ScalarEvidence<string>;
  resolvedProbe: ScalarEvidence<string>;
  status: ProviderAttemptStatus;
  modelListAttempt: ModelListAttempt;
  probeAttempt: ProbeAttempt;
  skippedModelIds: string[];
  models: CatalogModelRecord[];
}

interface CatalogSnapshotBase {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  packageVersion: string;
  attemptId: string;
  startedAt: string;
  worktreeKey: string;
  serverKey: string;
  runtimeKey: string;
  providerFingerprint: string;
}

export interface RunningCatalogSnapshot extends CatalogSnapshotBase {
  status: "running";
}

export interface CompleteCatalogSnapshot extends CatalogSnapshotBase {
  status: "complete";
  completedAt: string;
  providers: CatalogProviderRecord[];
}

export type CatalogSnapshot = RunningCatalogSnapshot | CompleteCatalogSnapshot;

export interface ProviderFingerprintEntry {
  id: string;
  baseURL?: unknown;
  probe?: unknown;
}

export interface ExactCatalogSnapshot {
  snapshot: CompleteCatalogSnapshot;
  exactAttempt: true;
}

export interface CatalogCorrelation {
  serverKey: string;
  worktreeKey: string;
  runtimeKey: string;
  providerFingerprint: string;
  /** Reject records that predate the short server-to-worker handoff window. */
  diskNotBeforeMs: number;
  /** Reject completions written after the bounded startup window. */
  diskNotAfterMs: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createAttemptId(): string {
  return randomUUID();
}

export function createWorktreeKey(worktree: string): string {
  return sha256(worktree);
}

/** Hash the current process identity without persisting a raw PID. */
export function createRuntimeKey(pid = process.pid): string {
  return sha256(`opencode-model-scout:runtime:${String(pid)}`);
}

/** Canonicalize a server base URL without retaining credentials or query data. */
export function normalizeServerBaseUrl(value: unknown): string | undefined {
  if (!(typeof value === "string" || value instanceof URL)) return undefined;
  try {
    const url = new URL(value.toString());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return undefined;
  }
}

export function createServerKey(value: unknown): string | undefined {
  const normalized = normalizeServerBaseUrl(value);
  if (!normalized) return undefined;
  const url = new URL(normalized);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // The TUI uses a virtual origin while local control servers use loopback.
  // The runtime key, not a hardcoded port, separates concurrent local launches.
  const internal =
    url.protocol === "http:" &&
    (hostname === "opencode.internal" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1");
  const correlationKey = internal ? "opencode://internal" : normalized;
  return sha256(correlationKey);
}

/** Normalize a provider URL while retaining its credential-free path. */
export function normalizeProviderBaseUrl(value: unknown): string | undefined {
  return normalizeServerBaseUrl(value);
}

/** Reduce a provider URL to a credential-free origin. */
export function sanitizeEndpointOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin === "null" ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

export function createProviderFingerprint(
  entries: readonly ProviderFingerprintEntry[],
): string {
  const normalized = entries
    .map((entry) => ({
      id: entry.id,
      baseURL: normalizeProviderBaseUrl(entry.baseURL) ?? null,
      probe:
        typeof entry.probe === "string" && entry.probe.length > 0
          ? entry.probe
          : null,
    }))
    .sort(
      (a, b) =>
        a.id.localeCompare(b.id) ||
        String(a.baseURL).localeCompare(String(b.baseURL)) ||
        String(a.probe).localeCompare(String(b.probe)),
    );
  return sha256(JSON.stringify(normalized));
}

export function unknownScalar<T extends string | number>(): ScalarEvidence<T> {
  return { state: "unknown" };
}

export function unknownCapability(): CapabilityEvidence {
  return { state: "unknown" };
}

export function knownScalar<T extends string | number>(
  value: T,
  source: MetadataSource,
  strength: ClaimStrength,
): ScalarEvidence<T> {
  return { state: "known", value, source, strength };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === required.length && required.every((key) => key in value)
  );
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function isTimestamp(value: unknown): value is string {
  if (!isBoundedString(value)) return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

const SOURCES = new Set<MetadataSource>([
  "pre-existing",
  "server-list",
  "provider-probe",
  "models.dev",
  "heuristic",
  "policy-default",
  "unmatched-host",
]);
const STRENGTHS = new Set<ClaimStrength>([
  "authoritative",
  "configured",
  "reported",
  "inferred",
  "assumed",
  "unmatched",
]);

function isClaimPair(source: MetadataSource, strength: ClaimStrength): boolean {
  switch (source) {
    case "pre-existing":
      return strength === "configured";
    case "server-list":
      return strength === "reported";
    case "provider-probe":
      return strength === "authoritative" || strength === "reported";
    case "models.dev":
    case "heuristic":
      return strength === "inferred";
    case "policy-default":
      return strength === "assumed";
    case "unmatched-host":
      return strength === "unmatched";
  }
}

function isScalarEvidence(
  value: unknown,
  kind: "string" | "number" | "model-type",
): boolean {
  if (!isRecord(value) || typeof value.state !== "string") return false;
  if (value.state === "unknown") return hasExactKeys(value, ["state"]);
  if (
    value.state !== "known" ||
    !hasExactKeys(value, ["state", "value", "source", "strength"]) ||
    !SOURCES.has(value.source as MetadataSource) ||
    !STRENGTHS.has(value.strength as ClaimStrength) ||
    !isClaimPair(
      value.source as MetadataSource,
      value.strength as ClaimStrength,
    )
  )
    return false;
  if (kind === "number")
    return typeof value.value === "number" && Number.isFinite(value.value);
  if (kind === "model-type")
    return ["llm", "vlm", "embedding"].includes(String(value.value));
  return isBoundedString(value.value);
}

function isCapabilityEvidence(value: unknown): value is CapabilityEvidence {
  if (!isRecord(value) || typeof value.state !== "string") return false;
  if (value.state === "unknown") return hasExactKeys(value, ["state"]);
  if (!hasExactKeys(value, ["state", "source", "strength"])) return false;
  if (value.state === "unsupported") {
    return (
      (value.source === "provider-probe" &&
        value.strength === "authoritative") ||
      (value.source === "pre-existing" && value.strength === "configured")
    );
  }
  return (
    value.state === "supported" &&
    SOURCES.has(value.source as MetadataSource) &&
    STRENGTHS.has(value.strength as ClaimStrength) &&
    isClaimPair(value.source as MetadataSource, value.strength as ClaimStrength)
  );
}

function isModelRecord(value: unknown): value is CatalogModelRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "origin",
      "identity",
      "name",
      "modelType",
      "context",
      "output",
      "family",
      "organizationOwner",
      "parameterSize",
      "quantization",
      "sizeBytes",
      "probeIdentity",
      "capabilities",
    ]) ||
    !isBoundedString(value.id) ||
    (value.origin !== "discovered" && value.origin !== "pre-existing") ||
    !isScalarEvidence(value.identity, "string") ||
    !isScalarEvidence(value.name, "string") ||
    !isScalarEvidence(value.modelType, "model-type") ||
    !isScalarEvidence(value.context, "number") ||
    !isScalarEvidence(value.output, "number") ||
    !isScalarEvidence(value.family, "string") ||
    !isScalarEvidence(value.organizationOwner, "string") ||
    !isScalarEvidence(value.parameterSize, "string") ||
    !isScalarEvidence(value.quantization, "string") ||
    !isScalarEvidence(value.sizeBytes, "number") ||
    !isScalarEvidence(value.probeIdentity, "string") ||
    !isRecord(value.capabilities) ||
    !hasExactKeys(value.capabilities, [
      "vision",
      "toolCall",
      "reasoning",
      "temperature",
    ])
  )
    return false;
  return Object.values(value.capabilities).every(isCapabilityEvidence);
}

const PROVIDER_STATUSES = new Set<ProviderAttemptStatus>([
  "ready",
  "empty",
  "unreachable",
  "aborted",
  "error",
]);
const LIST_ATTEMPTS = new Set<ModelListAttempt>([
  "ready",
  "empty",
  "unreachable",
  "aborted",
  "http-error",
  "invalid-response",
  "error",
]);
const PROBE_ATTEMPTS = new Set<ProbeAttempt>([
  "not-requested",
  "unresolved",
  "complete",
  "empty",
  "aborted",
  "error",
]);

function isProviderRecord(value: unknown): value is CatalogProviderRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "endpointOrigin",
      "configuredProbe",
      "resolvedProbe",
      "status",
      "modelListAttempt",
      "probeAttempt",
      "skippedModelIds",
      "models",
    ]) ||
    !isBoundedString(value.id) ||
    !isScalarEvidence(value.endpointOrigin, "string") ||
    !isScalarEvidence(value.configuredProbe, "string") ||
    !isScalarEvidence(value.resolvedProbe, "string") ||
    !PROVIDER_STATUSES.has(value.status as ProviderAttemptStatus) ||
    !LIST_ATTEMPTS.has(value.modelListAttempt as ModelListAttempt) ||
    !PROBE_ATTEMPTS.has(value.probeAttempt as ProbeAttempt) ||
    !Array.isArray(value.skippedModelIds) ||
    !value.skippedModelIds.every(isBoundedString) ||
    !Array.isArray(value.models) ||
    value.models.length > MAX_MODELS_PER_PROVIDER ||
    !value.models.every(isModelRecord)
  )
    return false;
  const modelIds = new Set(value.models.map((model) => model.id));
  const skippedIds = new Set(value.skippedModelIds);
  return (
    modelIds.size === value.models.length &&
    skippedIds.size === value.skippedModelIds.length
  );
}

function hasSafeObjectKeys(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value))
    return value.every((child) => hasSafeObjectKeys(child, seen));
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor")
      return false;
    if (!hasSafeObjectKeys(child, seen)) return false;
  }
  return true;
}

export function validateCatalogSnapshot(
  value: unknown,
): CatalogSnapshot | undefined {
  if (!hasSafeObjectKeys(value) || !isRecord(value)) return undefined;
  const baseValid =
    value.schemaVersion === CATALOG_SCHEMA_VERSION &&
    isBoundedString(value.packageVersion) &&
    isBoundedString(value.attemptId) &&
    ATTEMPT_PATTERN.test(value.attemptId) &&
    isTimestamp(value.startedAt) &&
    typeof value.worktreeKey === "string" &&
    HASH_PATTERN.test(value.worktreeKey) &&
    typeof value.serverKey === "string" &&
    HASH_PATTERN.test(value.serverKey) &&
    typeof value.runtimeKey === "string" &&
    HASH_PATTERN.test(value.runtimeKey) &&
    typeof value.providerFingerprint === "string" &&
    HASH_PATTERN.test(value.providerFingerprint);
  if (!baseValid) return undefined;

  if (value.status === "running") {
    return hasExactKeys(value, [
      "schemaVersion",
      "packageVersion",
      "status",
      "attemptId",
      "startedAt",
      "worktreeKey",
      "serverKey",
      "runtimeKey",
      "providerFingerprint",
    ])
      ? (value as unknown as RunningCatalogSnapshot)
      : undefined;
  }
  if (
    value.status !== "complete" ||
    !hasExactKeys(value, [
      "schemaVersion",
      "packageVersion",
      "status",
      "attemptId",
      "startedAt",
      "worktreeKey",
      "serverKey",
      "runtimeKey",
      "providerFingerprint",
      "completedAt",
      "providers",
    ]) ||
    !isTimestamp(value.completedAt) ||
    Date.parse(value.completedAt) < Date.parse(value.startedAt as string) ||
    !Array.isArray(value.providers) ||
    value.providers.length > MAX_PROVIDERS ||
    !value.providers.every(isProviderRecord)
  )
    return undefined;
  const providerIds = new Set(value.providers.map((provider) => provider.id));
  return providerIds.size === value.providers.length
    ? (value as unknown as CompleteCatalogSnapshot)
    : undefined;
}

export function parseCatalogSnapshot(raw: string): CatalogSnapshot | undefined {
  if (Buffer.byteLength(raw) > MAX_CATALOG_SNAPSHOT_BYTES) return undefined;
  try {
    return validateCatalogSnapshot(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function globalBridge(): { value?: CatalogSnapshot } {
  const globals = globalThis as typeof globalThis & {
    [BRIDGE_SYMBOL]?: { value?: CatalogSnapshot };
  };
  globals[BRIDGE_SYMBOL] ??= {};
  return globals[BRIDGE_SYMBOL];
}

export function publishRunningSnapshot(snapshot: RunningCatalogSnapshot): void {
  if (!validateCatalogSnapshot(snapshot)) return;
  globalBridge().value = snapshot;
}

export function publishCompleteSnapshot(
  snapshot: CompleteCatalogSnapshot,
): boolean {
  if (!validateCatalogSnapshot(snapshot)) return false;
  const bridge = globalBridge();
  if (
    bridge.value?.status !== "running" ||
    bridge.value.attemptId !== snapshot.attemptId
  )
    return false;
  bridge.value = snapshot;
  return true;
}

export function readCatalogBridge(): CatalogSnapshot | undefined {
  return validateCatalogSnapshot(globalBridge().value);
}

/** Test/process cleanup; normal plugin code never clears the bridge. */
export function clearCatalogBridge(): void {
  globalBridge().value = undefined;
}

function persistenceDisabled(): boolean {
  const value = process.env[DISABLE_CATALOG_PERSISTENCE_ENV];
  return value === "1" || value?.toLowerCase() === "true";
}

function cacheRoot(cacheHome?: string): string {
  return (
    cacheHome ?? process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  );
}

export function catalogSnapshotPath(
  worktreeKey: string,
  serverKey: string,
  cacheHome?: string,
): string | undefined {
  if (!HASH_PATTERN.test(worktreeKey) || !HASH_PATTERN.test(serverKey))
    return undefined;
  return path.join(
    cacheRoot(cacheHome),
    "opencode",
    "model-scout",
    `${worktreeKey}.${serverKey}.json`,
  );
}

function signalActive(signal?: AbortSignal): boolean {
  return signal?.aborted !== true;
}

async function readBoundedFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!signalActive(signal)) return undefined;
    handle = await open(filePath, "r");
    if (!signalActive(signal)) return undefined;
    const stat = await handle.stat();
    if (!signalActive(signal)) return undefined;
    if (!stat.isFile() || stat.size > MAX_CATALOG_SNAPSHOT_BYTES)
      return undefined;
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!signalActive(signal)) return undefined;
    if (bytesRead > stat.size || bytesRead > MAX_CATALOG_SNAPSHOT_BYTES)
      return undefined;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readPersistedSnapshot(
  worktreeKey: string,
  serverKey: string,
  cacheHome?: string,
): Promise<CompleteCatalogSnapshot | undefined> {
  if (persistenceDisabled()) return undefined;
  const filePath = catalogSnapshotPath(worktreeKey, serverKey, cacheHome);
  if (!filePath) return undefined;
  const raw = await readBoundedFile(filePath);
  if (!raw) return undefined;
  const snapshot = parseCatalogSnapshot(raw);
  return snapshot?.status === "complete" &&
    snapshot.worktreeKey === worktreeKey &&
    snapshot.serverKey === serverKey
    ? snapshot
    : undefined;
}

async function writeAtomic(
  filePath: string,
  snapshot: CatalogSnapshot,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signalActive(signal)) return false;
  let raw: string;
  try {
    raw = JSON.stringify(snapshot);
  } catch {
    return false;
  }
  if (Buffer.byteLength(raw) > MAX_CATALOG_SNAPSHOT_BYTES) return false;
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!signalActive(signal)) return false;
    handle = await open(tempPath, "wx", 0o600);
    if (!signalActive(signal)) return false;
    await handle.writeFile(raw, "utf8");
    if (!signalActive(signal)) return false;
    await handle.close();
    handle = undefined;
    // This is the commit point. A timed-out hook must never rename its temp.
    if (!signalActive(signal)) return false;
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600).catch(() => undefined);
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
  }
}

async function withSnapshotLock(
  filePath: string,
  work: () => Promise<boolean>,
  signal?: AbortSignal,
  nowMs = Date.now(),
): Promise<boolean> {
  const directory = path.dirname(filePath);
  const lockPath = `${filePath}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!signalActive(signal)) return false;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!signalActive(signal)) return false;
    await chmod(directory, 0o700).catch(() => undefined);
    if (!signalActive(signal)) return false;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch {
      const recoveryPath = `${lockPath}.recovery`;
      let recovery: Awaited<ReturnType<typeof open>> | undefined;
      try {
        try {
          recovery = await open(recoveryPath, "wx", 0o600);
        } catch {
          const recoveryStat = await stat(recoveryPath).catch(() => undefined);
          const recoveryAgeMs = recoveryStat ? nowMs - recoveryStat.mtimeMs : 0;
          if (
            !recoveryStat ||
            recoveryAgeMs <= SNAPSHOT_LOCK_STALE_MS ||
            !signalActive(signal)
          )
            return false;
          await unlink(recoveryPath).catch(() => undefined);
          if (!signalActive(signal)) return false;
          recovery = await open(recoveryPath, "wx", 0o600);
        }
        if (!signalActive(signal)) return false;
        const lockStat = await stat(lockPath).catch(() => undefined);
        if (!signalActive(signal)) return false;
        const ageMs = lockStat ? nowMs - lockStat.mtimeMs : 0;
        if (!lockStat || ageMs <= SNAPSHOT_LOCK_STALE_MS) return false;
        await unlink(lockPath).catch(() => undefined);
      } catch {
        return false;
      } finally {
        await recovery?.close().catch(() => undefined);
        if (recovery) await unlink(recoveryPath).catch(() => undefined);
      }
      // Retry the primary lock exactly once after conservative recovery.
      if (!signalActive(signal)) return false;
      lock = await open(lockPath, "wx", 0o600);
    }
    if (!signalActive(signal)) return false;
    return await work();
  } catch {
    return false;
  } finally {
    await lock?.close().catch(() => undefined);
    if (lock) await unlink(lockPath).catch(() => undefined);
  }
}

export async function persistRunningSnapshot(
  snapshot: RunningCatalogSnapshot,
  cacheHome?: string,
  nowMs = Date.now(),
  signal?: AbortSignal,
): Promise<boolean> {
  if (
    persistenceDisabled() ||
    !signalActive(signal) ||
    !validateCatalogSnapshot(snapshot)
  )
    return false;
  const filePath = catalogSnapshotPath(
    snapshot.worktreeKey,
    snapshot.serverKey,
    cacheHome,
  );
  if (!filePath) return false;
  return withSnapshotLock(
    filePath,
    async () => {
      if (!signalActive(signal)) return false;
      const currentRaw = await readBoundedFile(filePath, signal);
      if (!signalActive(signal)) return false;
      const current = currentRaw ? parseCatalogSnapshot(currentRaw) : undefined;
      if (current) {
        const currentStartedAt = Date.parse(current.startedAt);
        const incomingStartedAt = Date.parse(snapshot.startedAt);
        // A delayed older marker must never replace a newer marker/completion.
        if (currentStartedAt >= incomingStartedAt) return false;
        if (
          current.status === "running" &&
          nowMs - currentStartedAt <= RUNNING_SNAPSHOT_STALE_MS
        )
          return false;
      }
      return writeAtomic(filePath, snapshot, signal);
    },
    signal,
    nowMs,
  );
}

export async function persistCompleteSnapshot(
  snapshot: CompleteCatalogSnapshot,
  cacheHome?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (
    persistenceDisabled() ||
    !signalActive(signal) ||
    !validateCatalogSnapshot(snapshot)
  )
    return false;
  const filePath = catalogSnapshotPath(
    snapshot.worktreeKey,
    snapshot.serverKey,
    cacheHome,
  );
  if (!filePath) return false;
  return withSnapshotLock(
    filePath,
    async () => {
      if (!signalActive(signal)) return false;
      const currentRaw = await readBoundedFile(filePath, signal);
      if (!signalActive(signal)) return false;
      const current = currentRaw ? parseCatalogSnapshot(currentRaw) : undefined;
      if (
        current?.status !== "running" ||
        current.attemptId !== snapshot.attemptId ||
        current.startedAt !== snapshot.startedAt ||
        current.runtimeKey !== snapshot.runtimeKey
      )
        return false;
      return writeAtomic(filePath, snapshot, signal);
    },
    signal,
  );
}

function matchesCorrelation(
  snapshot: CatalogSnapshot,
  correlation: CatalogCorrelation,
): boolean {
  return (
    snapshot.serverKey === correlation.serverKey &&
    snapshot.worktreeKey === correlation.worktreeKey &&
    snapshot.runtimeKey === correlation.runtimeKey &&
    snapshot.providerFingerprint === correlation.providerFingerprint
  );
}

function isWithinStartupWindow(
  snapshot: CompleteCatalogSnapshot,
  correlation: CatalogCorrelation,
): boolean {
  const startedAt = Date.parse(snapshot.startedAt);
  const completedAt = Date.parse(snapshot.completedAt);
  return (
    startedAt >= correlation.diskNotBeforeMs &&
    startedAt <= correlation.diskNotAfterMs &&
    completedAt >= startedAt &&
    completedAt <= correlation.diskNotAfterMs
  );
}

/** Resolve provenance from same-realm authority or the exact server/worktree file. */
export async function resolveExactCatalogSnapshot(
  correlation: CatalogCorrelation,
  cacheHome?: string,
): Promise<ExactCatalogSnapshot | undefined> {
  if (
    !Number.isFinite(correlation.diskNotBeforeMs) ||
    !Number.isFinite(correlation.diskNotAfterMs) ||
    correlation.diskNotAfterMs < correlation.diskNotBeforeMs
  )
    return undefined;
  const bridge = readCatalogBridge();
  if (
    bridge?.status === "complete" &&
    matchesCorrelation(bridge, correlation) &&
    isWithinStartupWindow(bridge, correlation)
  )
    return { snapshot: bridge, exactAttempt: true };

  const persisted = await readPersistedSnapshot(
    correlation.worktreeKey,
    correlation.serverKey,
    cacheHome,
  );
  if (
    !persisted ||
    !matchesCorrelation(persisted, correlation) ||
    !isWithinStartupWindow(persisted, correlation)
  )
    return undefined;
  if (
    bridge?.status === "running" &&
    matchesCorrelation(bridge, correlation) &&
    bridge.attemptId !== persisted.attemptId
  )
    return undefined;
  return { snapshot: persisted, exactAttempt: true };
}
