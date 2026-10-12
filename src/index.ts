import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { discoverModels, discoverableProviderEntries } from "./discover";
import { fetchModelsDevIndex } from "./models-dev";
import packageJson from "../package.json";
import {
  CATALOG_SCHEMA_VERSION,
  createAttemptId,
  createProviderFingerprint,
  createRuntimeKey,
  createServerKey,
  createWorktreeKey,
  persistCompleteSnapshot,
  persistRunningSnapshot,
  publishCompleteSnapshot,
  publishRunningSnapshot,
  type CompleteCatalogSnapshot,
  type RunningCatalogSnapshot,
} from "./catalog-snapshot";

/**
 * Hard upper bound (ms) on the entire config-hook discovery work. Overridable
 * via `OPENCODE_MODEL_SCOUT_TIMEOUT_MS` (bounded to a sane range) — primarily so
 * tests can use a short budget, but also a usable escape hatch.
 */
function configHookBudgetMs(): number {
  const raw = Number(process.env.OPENCODE_MODEL_SCOUT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0)
    return Math.min(Math.max(raw, 10), 60000);
  return 5000;
}

/**
 * Resolve `promise`, or resolve with `fallback` after `ms` — whichever comes
 * first. The timer is always cleared. This is a *hard* bound: even if `promise`
 * never settles (e.g. a provider hangs while streaming a response body and the
 * work does not observe an abort signal), this returns so the caller is never
 * blocked. `signal.abort()` still fires so in-flight fetches that *do* observe
 * it get cancelled.
 */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(fallback);
    }, ms);
  });

  try {
    return await Promise.race([
      work(controller.signal).catch(() => fallback),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
const plugin: Plugin = async (input: PluginInput) => {
  const { client } = input;

  if (!client || typeof client !== "object") {
    return {
      config: async () => {},
    };
  }

  const hooks: Hooks = {
    config: async (config) => {
      const hookStartedAt = Date.now();
      const hookBudgetMs = configHookBudgetMs();
      const configRecord = config as unknown as Record<string, unknown>;
      const attemptId = createAttemptId();
      const startedAt = new Date(hookStartedAt).toISOString();
      const hasWorktree =
        typeof input.worktree === "string" && input.worktree.length > 0;
      const worktreeKey = createWorktreeKey(hasWorktree ? input.worktree : "");
      const serverKey = createServerKey(input.serverUrl);
      const runtimeKey = createRuntimeKey();
      const providerFingerprint = createProviderFingerprint(
        discoverableProviderEntries(configRecord),
      );
      const discover = (signal: AbortSignal) =>
        fetchModelsDevIndex().then((modelsDevIndex) =>
          discoverModels(configRecord, modelsDevIndex, signal),
        );
      if (!serverKey) {
        await withTimeout(discover, hookBudgetMs, undefined);
        return;
      }
      const running: RunningCatalogSnapshot = {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        packageVersion: packageJson.version,
        status: "running",
        attemptId,
        startedAt,
        worktreeKey,
        serverKey,
        runtimeKey,
        providerFingerprint,
      };
      publishRunningSnapshot(running);

      // The whole hook is bounded so it can NEVER block opencode startup. The
      // race resolves after the configured budget (see configHookBudgetMs)
      // regardless of what happens inside, and the abort signal cancels
      // in-flight fetches that observe it. All internal failures are swallowed
      // (no stdout/stderr) — a failed or slow provider must never break opencode.
      const result = await withTimeout(
        async (signal) => {
          // Establish disk ownership before discovery so a reused server URL
          // cannot expose its prior completion during this launch. This work
          // remains inside the same hard hook budget.
          const ownsDisk = hasWorktree
            ? await persistRunningSnapshot(
                running,
                undefined,
                Date.now(),
                signal,
              )
            : false;
          if (signal.aborted) return undefined;
          const providers = await discover(signal);
          return { ownsDisk, providers };
        },
        hookBudgetMs,
        undefined,
      );
      if (!result) return;

      const complete: CompleteCatalogSnapshot = {
        ...running,
        status: "complete",
        completedAt: new Date().toISOString(),
        providers: result.providers,
      };
      if (!publishCompleteSnapshot(complete)) return;
      if (result.ownsDisk) {
        const remainingMs = hookBudgetMs - (Date.now() - hookStartedAt);
        if (remainingMs > 0)
          await withTimeout(
            (signal) => persistCompleteSnapshot(complete, undefined, signal),
            remainingMs,
            false,
          );
      }
    },
  };

  return hooks;
};

export default plugin;
