# Agent Instructions

opencode plugin: auto-discovers models from OpenAI-compatible providers, enriches with context window sizes, capability flags, and metadata. Runs during opencode's config hook at startup.

## Architecture

```
src/index.ts       → Server plugin entry, config hook with AbortSignal.timeout(5s)
src/tui.ts         → TUI plugin entry (TuiPluginModule): /modelscout slash command + dialog
src/tui-browser.ts → Interactive browser state, facets, search, and details
src/tui-models.ts  → Host/snapshot reconciliation and core metadata coverage
src/tui-renderer.ts → Typed imperative OpenTUI reconciler adapter
src/tui-client-adapter.ts → Pinned SDK server-correlation boundary
src/catalog-snapshot.ts → Evidence schema and atomic server/TUI snapshot bridge
src/discover.ts    → Pipeline orchestrator, per-provider isolation, DiscoverySnapshot table formatter
src/models-dev.ts  → models.dev fallback (reads XDG cache file directly)
src/format.ts      → Pure formatters (model names, numbers/compact, bytes)
src/constants.ts   → ALL naming centralized here (plugin name, command)
src/probes/        → Probe implementations, fingerprinting, shared utils
```

The package ships **two entrypoints** discovered by opencode via `package.json`
`exports`: `./server` → `dist/index.js` (the config-hook discovery plugin) and
`./tui` → `dist/tui.js` (the slash-command dialog plugin, registered via
`api.command.register`).
`@opentui/{core,keymap,solid}` are **optional peer
deps** (also devDeps for local build/typecheck) and are marked `--external` at
compile time so the server path installs cleanly without them. They must be
pinned to the version opencode ships (currently `0.3.4`): opencode injects its
own `@opentui/*` into plugins at runtime, and a version skew breaks the dynamic
import.

## Non-obvious Constraints

- **Server vs TUI plugin config split**: opencode loads **server** plugins (`./server`) from the `plugin` array in `opencode.json`, but **TUI** plugins (`./tui`) from a _separate_ `plugin` array in `tui.json`. Listing the package only in `opencode.json` runs discovery but the `/modelscout` command never appears. `opencode plugin …` patches both files; manual installs must add both.
- **Shipped runtime uses `api.command.register`, not `api.keymap.registerLayer`**: 1.17.7 only surfaces third-party plugin slash commands via the (deprecated-typed but wired) `api.command.register(cb)` with `{ slash: { name }, onSelect }`. `api.keymap.registerLayer` exists in the types but is not wired for external plugins (see issues #10262/#5305).
- **TUI dialog layout.** `api.ui.dialog.replace(render)` content is wrapped by the host's centered, fixed-width `Dialog` panel. Return a _content-sized_ box (no `flexGrow`/`minHeight`) or it bleeds off-center; bound the browser from `api.renderer.terminalHeight`. Use one grouped list with selectable provider headers and indented model rows. `enter` replaces the list with details, and `backspace` restores the preserved list state. OpenTUI widths are content-box widths, so subtract explicit padding from the root width and reserve columns for Select's gutter and scrollbar. Theme normal, focused, and selected Select surfaces explicitly or the widget defaults render as a black inset panel. `replace()` resets size to `"medium"`, so call `setSize("xlarge")` _after_ `replace`. An `onClose` callback may dispose key listeners but must never call `clear()` (that recurses while the host pops the stack).
- **TUI focus is explicit.** OpenTUI 0.3.4 does not cycle plugin focus on Tab. The browser listens through `api.renderer.keyInput`, focuses the unified result list on open, routes `/` to search and arrows back to results, consumes only its own keys, and disposes the listener when the dialog closes. Do not add a top-level Models/Providers switch; provider diagnostics are opened from provider header rows.
- **Provenance can cross a runtime boundary.** The public provider state drops probe-only diagnostics and negative evidence. The server writes a bounded, owner-only XDG cache snapshot keyed by hashed worktree and server identities. The payload also carries a runtime hash derived from `process.pid`. The TUI accepts it only after exact runtime, server, worktree, provider, schema, and startup-window correlation. `http://opencode.internal` and HTTP loopback URLs at any port share one internal server key. Missing or invalid snapshots must degrade to host-only rows.
- **Config hook deadlock**: `client.provider.list()` cannot be called during the config hook — it routes through opencode's in-process Hono server to `Provider.list()` which depends on `InstanceState` that blocks on config hook completion. Circular dependency. Read `$XDG_CACHE_HOME/opencode/models.json` directly instead (see `src/models-dev.ts`).
- **Config is immutable after init**: No hot-reload. The config hook is the one shot to add models.
- **`options.probe` not top-level**: opencode's `Config.Provider` uses `.strict()` (rejects unknown fields) but `options` uses `.catchall(z.any())`. Probe config must be inside `options`.
- **No startup stderr**: `console.warn` is for error conditions only, not routine output.
- **`limit.output` omitted when unknown**: Defaulting to 0 means "no output allowed". Omit the field instead.

## Signal/Timeout Flow

```
index.ts: hard 5s default budget (OPENCODE_MODEL_SCOUT_TIMEOUT_MS: 10-60000ms)
  → discoverModels(signal) — breaks loop if aborted
    → fetchModels(signal) via probeFetch(timeoutMs: 3000)
    → resolveProbe(signal) → fingerprint(signal) via probeFetch(timeoutMs: 1000)
    → Atlas probe observes the global signal for every detail request
    → legacy probes rely on local probeFetch/body-read bounds
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
