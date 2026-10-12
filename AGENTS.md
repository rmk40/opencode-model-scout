# Agent Instructions

OpenCode 2 plugin: discovers the models served by OpenAI-compatible providers, enriches them with limits, capabilities, input modalities, effort variants, and prices, and adds them to the model catalog through a model transform. A TUI half adds the `/modelscout` browser.

## Architecture

```
src/server.ts           → Server entry ({ id, setup }): loads stored bindings, registers transforms and RPC, starts the refresher
src/refresher.ts        → Per-instance driver: targets, triggers, periodic refresh, reloads, RPC catalog payload, plugin options
src/store.ts            → Process-wide discovery store on globalThis: bindings, jobs, generations, refresh throttle
src/actualyze.ts        → Built-in Actualyze provider record and its `actualyze` integration (key + ACTUALYZE_API_KEY)
src/transform.ts        → Provider transform (recorder + Actualyze provider), eligibility rule, two-pass model transform, Model.Info patching
src/discover.ts         → discoverProvider (network I/O for one target) and toModelInfo (pure mapping to patches + evidence)
src/models-dev-index.ts → models.dev matcher built from the host's provider source records
src/catalog-evidence.ts → Evidence schema (version 4) and strict validator shared by server and TUI
src/rpc.ts              → Plugin RPC contract: catalog, refresh, `updated` event
src/tui.ts              → TUI entry ({ id, setup }): /modelscout command, dialog session, RPC reads, fallback view
src/tui-browser.ts      → Browser state, facets, search, keys, list and detail rendering
src/tui-models.ts       → Reconciles host model/provider rows with RPC evidence; core metadata coverage
src/tui-renderer.ts     → Typed imperative adapter over the host's @opentui/solid reconciler
src/format.ts           → Pure formatters (model names, compact counts, bytes)
src/constants.ts        → Plugin ID, command name, Actualyze provider constants, probe ID aliases, never-probed provider IDs, openai-compatible packages
src/probes/             → Probe implementations, registry, fingerprinting, shared HTTP helpers (see src/probes/AGENTS.md)
scripts/check-dist.mjs  → Fails when dist/*.js imports @opencode/* or effect at runtime
scripts/live-harness.mjs, scripts/live-check.mjs → Live checks against the installed opencode (not shipped, not in CI)
test/                   → Unit tests (vitest, global fetch mocked by test/setup.ts)
test/e2e/               → Embedded-host tests through @opencode/sdk (separate vitest config, real fetch)
```

The package exports `.` and `./server` → `dist/server.js`, `./tui` → `dist/tui.js`, and `./rpc` → `dist/rpc.js`. The host resolves `<package>/server` before `<package>` and loads `<package>/tui` automatically alongside the server half; there is no separate TUI config entry. `./rpc` exports the RPC contract for other clients. Both halves and the RPC contract share the ID `opencode-model-scout` (`PLUGIN_ID`); the host dedupes a package listed in both `opencode.json` and `cli.json` by that ID.

`@opentui/core` and `@opentui/solid` are optional peers and dev dependencies pinned to the version the host injects (0.5.17 for OpenCode 2.0.26). `@opencode/plugin` and `@opencode/sdk` are exact-pinned dev dependencies used for types and the E2E lane.

## Non-obvious Constraints

- **`@opencode/*` imports are type-only.** The host serves `@opencode/plugin` and `effect` to plugins and throws if a plugin loads either from its own `node_modules`. Never import a runtime value from `@opencode/*` (for example `Rpc.define`); `src/rpc.ts` is a plain object that `satisfies Rpc.PortableDefinition`. tsup keeps `@opencode/*`, `effect`, `@opentui/*`, and `solid-js` external, and `npm run check:dist` fails on any runtime import of the first two.
- **No network I/O in `setup`.** Plugins activate one at a time, so an awaited fetch in `setup` delays every later plugin, including the config provider plugin. `setup` reads storage, registers transforms and RPC, starts the refresher without awaiting it, and returns its cleanup.
- **Transforms are synchronous, pure, and must not throw.** A throwing transform disables every registration of the plugin. The model transform computes every patch inside `try`/`catch` first and only then calls `editor.update`, because editor updates mutate the candidate immediately and a failure halfway through would leave partial edits. `applyPatch` assigns every field scout controls, starting from a fresh default, so a replay on a fresh candidate yields the same model. Both callbacks replace what they record on each run, never accumulate, because the host can abandon a candidate and restart the fold.
- **Built-in Actualyze provider.** Every instance registers the integration `actualyze` (name "Actualyze", key method plus env `ACTUALYZE_API_KEY`) and adds an `actualyze` provider: `activation: "auto"`, `integrationID: "actualyze"`, package `@opencode/ai/providers/openai-compatible`, `settings.baseURL` `https://app.actualyze.ai/openai/v1`, `settings.probe` `actualyze`, no models. The host hides it until the integration has a connection, and the refresher only sees available providers, so nothing is probed without a key. The integration ID must equal the provider ID: the host's config provider plugin registers an integration under the provider ID for every `providers.<id>` entry unless one exists, and `opencode auth login actualyze` resolves by exact ID before name, so any other ID would give a configured `actualyze` provider a second integration that receives the key while the provider reads none. Accepted edge case: an `actualyze` provider that an earlier plugin defined with `activation: "auto"` and no `integrationID` is gated by the `actualyze` integration (the host hides such a provider while an integration with its ID exists and has no connection), so it stays hidden until a key is connected. Integrations and providers are folded separately, so the two guards are independent: the provider is skipped when an `actualyze` provider already exists (a models.dev catalog from `OPENCODE_MODELS_PATH`, or an earlier plugin), and the integration is skipped when an `actualyze` integration exists (a catalog registers one with its provider when it lists env vars), so `/connect` never shows two Actualyze entries. A pre-existing provider is in the recorded set and has no `settings.probe`, so it is not discovered unless config adds one. The config provider plugin runs after external plugins and merges settings key-wise over this record, so a configured `settings.baseURL` wins; any config entry also sets `activation: "enabled"`, which lists the provider without a key. The provider transform records the provider set before adding Actualyze, so the added provider never counts as pre-existing.
- **The provider recorder is per instance.** It records the provider IDs present before config providers load (models.dev templates, built-ins, earlier plugins). That set drives auto-eligibility. It lives in each instance's `TransformState`, never at module level, because provider state is per location. On a fresh process the first fold runs before config-only providers exist; a missing provider is normal and gets no patches.
- **The discovery store lives on `globalThis`.** The host evaluates the plugin module once per location in the same process, so module-level state is not shared. `sharedStore()` uses a versioned `Symbol.for` key. Jobs belong to the store, are keyed by the full target fingerprint (provider ID, normalized base URL, probe, API key hash, headers hash) plus, unless the target resolved to its `settings.apiKey`, the resolved credential fingerprint (`credentialKeys`: an integration connection hash, or `none`, hashed with the sync key into a separate key), and are aborted when their last subscriber leaves. (`invalidate` and the credential-mismatch branch of `start` also abort, but are defensive paths: a store key maps to one credential fingerprint.) Locations with different integration credentials therefore never share a job or a binding. An abort because the last subscriber left also resets the start throttle. A job result is accepted only while its generation is current.
- **Credential precedence matches inference.** The host's model resolver prefers the integration's active connection over `settings.apiKey`, so the refresher resolves each target in that order: the connection of `integrationID ?? providerID`, then `settings.apiKey`, then no key. A failed lookup keeps the previous integration or keyless resolution for that target, else falls back to `settings.apiKey`, else skips the target for that sync; it never falls back to `none`. A `credential.switched` event revokes every resolution of the affected integration, including `settings.apiKey` ones, so a newly connected key takes over.
- **Serving goes only through the active binding.** The model transform cannot look up connections, so every target, with or without `settings.apiKey`, is served only through the instance's active binding (`TransformState.active`), which the refresher sets after resolving this instance's credential. At startup the first sync finds a persisted binding for the resolved key and activates it without discovery.
- **`ctx.storage` is global per plugin ID, not per location.** Persisted bindings are keyed by the same store key and hold hashes and inventories only, never keys or headers. `loadPersisted` keeps the newest 128 and removes malformed entries. Bindings from an integration credential stay unverified until the refresher confirms the same credential.
- **Eligibility.** A target needs `settings.baseURL` plus either `settings.probe`, or the auto rule: absent from the recorded set, no `canonical`, and an openai-compatible package (`OPENAI_COMPATIBLE_PACKAGES`). `ollama`, `lmstudio`, `vllm`, and `opencode` are never targets (`NEVER_PROBED_PROVIDER_IDS`). The absence check is a heuristic: a provider plugin listed after scout also looks absent.
- **Declared models are never patched.** Any model ID already in the provider's source record (config or models.dev) is reported as `pre-existing` evidence and left untouched.
- **Credential changes rekey.** OpenCode does not publish `provider.updated` when an account switch leaves provider availability unchanged, so `credential.switched` and `credential.updated` are triggers. `credential.switched` is published without a location; the event filter passes unlocated events. A switch revokes this instance's credential resolution for each affected target at once: it drops the active binding and unsubscribes from the old store key, so the target serves nothing until a sync resolves the new credential, and a failed lookup after a switch skips the target instead of reusing the old account. It never invalidates store entries: each is keyed by its credential and other locations may still use it; an old-credential job is aborted only if this instance was its last subscriber. Notifications for a key the instance no longer resolves to are ignored, and a sync drops any integration resolution that a switch arriving during its lookup may have superseded. The next sync resolves the new credential, which selects a different store key. A reload publishes only `model.updated`, which is not a trigger, so reloads cannot loop.
- **`limit.output: 0` means unknown.** `Model.Info` requires both limits. Scout emits the probe's output limit (capped at context) or `0`, which the host treats as "fit to the remaining context". Unknown context uses the host default of 200 000 and is labeled `host default` in evidence.
- **Effort variants.** Reasoning models on an openai-compatible package get `low`/`medium`/`high` with `settings.reasoningEffort`. Actualyze models get none: its chat endpoint does not forward `reasoning_effort`.
- **Never dump `model.list` or `provider.list` responses.** Both include provider settings with the plaintext `apiKey`. Scripts and tests print only the fields they check. RPC payloads carry endpoint origins only, never credentials, paths, or queries.
- **`dist/` must stay flat.** Local directory plugins ignore `package.json` `exports` and look for `server.js`, `index.js`, and `tui.js` directly in the directory, so local development points `plugins` at `<repo>/dist`.
- **TUI keys go through `context.renderer.keyInput`.** The host keymap attaches first, so `esc` and `ctrl+c` close the dialog before the browser's listener runs, and `preventDefault` in the browser only stops the focused select or input. The browser ignores keys with ctrl, meta, option, super, or hyper, consumes only its own keys, and removes its listener when the dialog closes. A modal keymap layer does not work here: its commands receive no `KeyEvent` and swallow typing.
- **Dialog order is `show` then `set`.** `context.ui.dialog.show(render, onClose)` resets the size, and `set` resets every option it omits, so call `context.ui.dialog.set({ size: "xlarge" })` after `show`. Renderables must be created inside the render callback; the reconciler's `createElement` throws outside it. `TuiRenderer.set` only mutates existing nodes and works anywhere. The TUI cleanup closes an open dialog, because a plugin reload would otherwise leave it on screen.
- **Dialog layout.** Return a content-sized root (no `flexGrow`/`minHeight`) bounded by `context.renderer.terminalHeight`. OpenTUI widths are content-box widths: subtract explicit padding from the root width and reserve columns for the select's gutter and scrollbar.
- **Theme from the dialog surface.** Map colors from `context.theme.surface("dialog")`, matching the host's own select dialog, and set the select's normal, focused, and selected backgrounds explicitly; the widget defaults render as a dark inset panel.
- **RPC errors are plain objects.** Failures reject with `{ type, message }`, not `Error` instances (`rpc.unavailable`, `rpc.internal`, `rpc.invalid_input`). Pass the dialog's captured location in every RPC call's options; without it the server falls back to its own directory. RPC and bus event subscriptions filter by type only, so the TUI filters events by location itself.
- **No startup output.** Nothing writes to stdout or stderr. `console.warn` is for error conditions only.

## Commands

```
npm run check       # typecheck + lint + format:check + unit + E2E + compile + check:dist (CI gate, pre-push hook)
npm run test:run    # unit tests only
npm run test:e2e    # embedded-host E2E lane only
npm run fix         # eslint --fix + prettier --write
npm run compile     # tsup → dist/ with type declarations
npm run compile:dev # tsup → dist/ without declarations
npm run check:dist  # fail on runtime @opencode/* or effect imports in dist/
npm run build       # same as check
```

Pre-commit runs lint-staged (eslint --fix + prettier on staged files).

## Releasing

1. Bump the version in `package.json`.
2. Run `npm run check` and the live harness (see CONTRIBUTING.md).
3. Commit, tag (`git tag vX.Y.Z`), push with tags.
4. CI: check → compile → npm publish (OIDC, provenance) → GitHub Release.

Do NOT publish manually.

## Commit Style

Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`. Imperative summary, no trailing period.
