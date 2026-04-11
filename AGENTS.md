# Agent Instructions for opencode-model-scout

## What This Project Is

An opencode plugin that auto-discovers models from OpenAI-compatible providers
and enriches them with context window sizes, capability flags (tool calling,
vision, reasoning), and model metadata. It runs during opencode's config hook
at startup and supports 9 inference servers: Ollama, oMLX, vLLM, TGI, SGLang,
LM Studio, KoboldCpp, llama.cpp, and LocalAI.

## Critical Constraints

These are non-obvious constraints that WILL cause bugs if violated:

- **Config hook deadlock**: Never call `client.provider.list()` during the
  config hook. It routes through opencode's in-process Hono server which
  depends on `InstanceState` that blocks until the config hook completes.
  Circular dependency = deadlock. Use `readFile` on the XDG cache instead
  (see `src/models-dev.ts`).

- **opencode config is immutable after init**: There is no hot-reload. The
  config hook is the one shot to add models. `Instance.dispose()` triggers
  rebuild but is not exposed to plugins.

- **`options.probe` not top-level**: The probe config field MUST be inside
  `options`, not at the provider top level. opencode's `Config.Provider` uses
  `.strict()` (rejects unknown fields) but `options` uses `.catchall(z.any())`.

- **Capability flags: only `true`, never `false`**: If a probe can't determine
  a capability, leave it `undefined`. Setting `false` means "confirmed not
  supported" which is worse than unknown.

- **No startup stderr output**: The user dislikes log noise at startup.
  `console.warn` is reserved for error conditions only.

- **`owned_by` is optional**: Some servers omit it. Typed as `owned_by?: string`.
  Missing `owned_by` is NOT a positive signal for any server.

- **KoboldCpp `jinja: true` does NOT mean toolCall**: Do not infer tool
  calling support from Jinja template support.

- **`EMPTY_RESULT` is frozen**: `Object.freeze({ models: Object.freeze({}) })`.
  Never attempt to mutate the return value after returning `EMPTY_RESULT`.

## Architecture

```
src/index.ts          → Plugin entry, config hook with AbortSignal.timeout(5s)
src/discover.ts       → Pipeline orchestrator, per-provider isolation
src/probes/util.ts    → buildHeaders(), probeFetch(), EMPTY_RESULT
src/probes/index.ts   → Probe registry, resolveProbe() with "auto" support
src/probes/fingerprint.ts → Server auto-detection (3-tier)
src/probes/*.ts       → Individual probe implementations
src/models-dev.ts     → models.dev fallback (reads XDG cache file directly)
src/command.ts        → /modelscout slash command handler
src/constants.ts      → ALL naming centralized here
```

### Signal/timeout flow

```
index.ts: AbortSignal.timeout(5000)
  → discover.ts: discoverModels(config, index, signal)
    → discover.ts: fetchModels(url, key, signal) via probeFetch(timeoutMs: 3000)
    → probes/index.ts: resolveProbe(type, url, key, ctx, signal)
      → fingerprint.ts: fingerprint(url, key, models, signal)
        → probeFetch() calls with combinedSignal + timeoutMs: 1000
    → individual probes: bounded by probeFetch 2s default (no global signal)
```

Probes do NOT receive the global abort signal. They are bounded by their own
2-second `probeFetch` timeouts. The signal only flows through `fetchModels`
and `fingerprint`.

## Development Commands

```bash
npm run check     # typecheck + lint + format:check + test (CI gate)
npm run fix       # eslint --fix + prettier --write
npm run compile   # tsup → dist/
npm run build     # check + compile
```

Git hooks enforce quality automatically:

- **pre-commit**: lint-staged (eslint --fix + prettier on staged files)
- **pre-push**: `npm run check` (full gate)

## Testing Patterns

- All network calls mocked via `vi.fn()` on `global.fetch`
- Test files use `setupFetchRouter()` pattern for URL-based mock routing
- `AbortSignal.timeout` and `AbortSignal.any` are polyfilled in test files
  for environments that don't support them
- Test relaxations in eslint.config.js: `require-await`, `no-unsafe-member-access`,
  `no-unsafe-assignment` are off for `test/**/*.ts`

## Releasing

Releases are automated via GitHub Actions. The workflow:

1. Bump version in `package.json` (or use `npm version patch/minor/major`)
2. Commit the version bump
3. Tag: `git tag vX.Y.Z`
4. Push: `git push origin main --tags`
5. CI runs: `check` → `compile` → `npm publish` (OIDC trusted publishing, no
   token needed) → GitHub Release with auto-generated notes

The rolling "Latest Snapshot" pre-release is updated on every push to `main`.

Do NOT publish manually from local — use the CI pipeline. The first publish
was manual; all subsequent publishes go through CI with provenance attestation.

## Adding a New Probe

1. Create `src/probes/yourserver.ts` implementing `ProviderProbe`
2. Use `buildHeaders()`, `probeFetch()`, `EMPTY_RESULT` from `./util`
3. Register in `src/probes/index.ts` PROBES map
4. Add fingerprint detection in `src/probes/fingerprint.ts` if supporting `"auto"`
5. Add types to `DetectedServer` and `ProbeKey` unions
6. Write tests in `test/probes/yourserver.test.ts`
7. Update README.md Supported Servers table
8. Update CONTRIBUTING.md if there are architectural changes

## Naming

All user-visible strings are in `src/constants.ts`: plugin name, log prefix,
command name, sentinel. If renaming, only that file changes.

## Key Design Decisions

- **`probeFetch` returns `Response | undefined`**: Callers decide what to do
  with non-OK responses. undefined = network error/timeout/abort.
- **Per-provider isolation**: Each provider in the discovery loop has its own
  try-catch. One provider failing never blocks others.
- **models.dev data read via direct file I/O**: Not via SDK client (deadlock).
  Path: `$XDG_CACHE_HOME/opencode/models.json` or `OPENCODE_MODELS_PATH`.
- **Probe-confirmed embeddings clear keyword-set chat modalities**: When a
  probe confirms a model is embedding-only, the `_probeEmbedding` sentinel
  pattern ensures keyword-based chat categorization is removed.
- **`limit.output` omitted when unknown**: Rather than defaulting to 0 (which
  would mean "no output allowed").

## Commit Style

Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
Summary is imperative, specific, no trailing period. Add a body when the
summary alone is ambiguous.
