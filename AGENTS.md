# Agent Instructions

opencode plugin: auto-discovers models from OpenAI-compatible providers, enriches with context window sizes, capability flags, and metadata. Runs during opencode's config hook at startup.

## Architecture

```
src/index.ts       → Plugin entry, config hook with AbortSignal.timeout(5s)
src/discover.ts    → Pipeline orchestrator, per-provider try-catch isolation
src/models-dev.ts  → models.dev fallback (reads XDG cache file directly)
src/command.ts     → /modelscout slash command
src/constants.ts   → ALL naming centralized here (plugin name, log prefix, command)
src/probes/        → Probe implementations, fingerprinting, shared utils
```

## Non-obvious Constraints

- **Config hook deadlock**: `client.provider.list()` cannot be called during the config hook — it routes through opencode's in-process Hono server to `Provider.list()` which depends on `InstanceState` that blocks on config hook completion. Circular dependency. Read `$XDG_CACHE_HOME/opencode/models.json` directly instead (see `src/models-dev.ts`).
- **Config is immutable after init**: No hot-reload. The config hook is the one shot to add models.
- **`options.probe` not top-level**: opencode's `Config.Provider` uses `.strict()` (rejects unknown fields) but `options` uses `.catchall(z.any())`. Probe config must be inside `options`.
- **No startup stderr**: `console.warn` is for error conditions only, not routine output.
- **`limit.output` omitted when unknown**: Defaulting to 0 means "no output allowed". Omit the field instead.

## Signal/Timeout Flow

```
index.ts: AbortSignal.timeout(5000)
  → discoverModels(signal) — breaks loop if aborted
    → fetchModels(signal) via probeFetch(timeoutMs: 3000)
    → resolveProbe(signal) → fingerprint(signal) via probeFetch(timeoutMs: 1000)
    → individual probes: no global signal, bounded by probeFetch 2s default
```

## Commands

```
npm run check     # typecheck + lint + format:check + test (CI gate, pre-push hook)
npm run fix       # eslint --fix + prettier --write
npm run compile   # tsup → dist/
npm run build     # check + compile
```

Pre-commit hook runs lint-staged (eslint --fix + prettier on staged files).

## Releasing

1. Bump version in `package.json`
2. Commit, tag (`git tag vX.Y.Z`), push with tags
3. CI: check → compile → npm publish (OIDC) → GitHub Release

Do NOT publish manually — CI handles it with provenance attestation.

## Commit Style

Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`. Imperative summary, no trailing period.
