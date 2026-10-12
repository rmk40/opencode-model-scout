# Contributing to opencode-model-scout

## Prerequisites

- Node.js 22.18 or later. CI runs Node 24. `scripts/live-check.mjs` imports a
  TypeScript source file directly and needs a Node version that strips types
  by default.
- npm.
- For the live harness only: an installed OpenCode 2 CLI (`opencode`), tested
  with 2.0.26.

## Setup

```bash
git clone https://github.com/rmk40/opencode-model-scout.git
cd opencode-model-scout
npm install
```

`npm install` also installs the Husky hooks:

- **pre-commit** runs `lint-staged` (ESLint `--fix` and Prettier on staged
  files).
- **pre-push** runs `npm run check`.

## Commands

```bash
npm run check         # typecheck, lint, format:check, unit, E2E, compile, check:dist (CI gate)
npm run test:e2e      # embedded-host E2E lane only
npm run fix           # eslint --fix + prettier --write
npm run lint          # ESLint only
npm run lint:fix      # ESLint with auto-fix
npm run format        # Prettier write
npm run format:check  # Prettier check only
npm run typecheck     # tsc --noEmit
npm run test          # unit tests in watch mode
npm run test:run      # unit tests once
npm run test:coverage # unit tests with coverage
npm run compile       # tsup → dist/ with type declarations
npm run compile:dev   # tsup → dist/ without declarations
npm run check:dist    # fail on runtime @opencode/* or effect imports in dist/
npm run build         # same as check
```

## Testing

There are two automated lanes, both part of `npm run check`, and one manual
lane.

### Unit tests

`npm run test:run` runs every `*.test.ts` under `test/` except `test/e2e/`.
`test/setup.ts` replaces `global.fetch` with a `vi.fn()` mock for every file,
so unit tests never reach the network. Mock responses per test:

```bash
npx vitest run test/probes/omlx.test.ts
```

### Embedded-host E2E

`npm run test:e2e` runs `test/e2e/*.e2e.test.ts` with
`vitest.e2e.config.ts`, which leaves out `test/setup.ts` so `fetch` is real.
The tests start an in-process OpenCode host through `@opencode/sdk`, load
`src/server.ts` as a plugin, serve local OpenAI-compatible and Actualyze mocks
over HTTP, and check the host's own model list and the plugin RPC. They need
no network access beyond localhost: `test/e2e/actualyze.e2e.test.ts` wraps
`fetch` so requests to the built-in Actualyze endpoint reach the local mock.

### Live harness

`scripts/live-harness.mjs` runs the installed `opencode` against the built
`dist/` in an isolated scratch tree. It is not shipped and not part of
`npm run check`. Use it before a release and whenever a change touches how the
plugin talks to the host.

```bash
npm run compile:dev                # the harness never builds
node scripts/live-harness.mjs start
node scripts/live-check.mjs
node scripts/live-harness.mjs status
node scripts/live-harness.mjs stop
```

`start` writes a project config with `plugins: ["<repo>/dist"]` and a
`mock-compat` provider backed by a local mock server, then starts
`opencode serve` on `127.0.0.1`. Every OpenCode process runs with an
environment built from scratch, with `HOME` and the four `XDG_*` variables
pointing into the scratch tree, so your real config, data, and background
service are never touched.

| Variable                  | Purpose                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SCOUT_HARNESS_DIR`       | Scratch tree. Defaults to `opencode-model-scout-harness` under the OS temp directory.                                         |
| `ACTUALYZE_API_KEY_FILE`  | File holding an inference-scoped Actualyze key. Without it, the checks expect the built-in `actualyze` provider to be hidden. |
| `ACTUALYZE_BASE_URL`      | Optional Actualyze endpoint, for example `http://localhost:3001/openai/v1`. Defaults to the built-in production endpoint.     |
| `OPENCODE_BIN`            | The `opencode` executable. Defaults to the first `opencode` on `PATH`.                                                        |
| `SCOUT_HARNESS_PORT`      | Port for `opencode serve`. Defaults to 47931.                                                                                 |
| `SCOUT_HARNESS_MOCK_PORT` | Port for the mock server. Defaults to 47932.                                                                                  |

The harness tests the built-in `actualyze` provider the way a user sets it
up. The key reaches the server only as `ACTUALYZE_API_KEY` in its
environment, so discovery and chat go through the integration credential.
It is passed through the spawn environment rather than the command line and
is never written to the config, the state file, or the logs. With
`ACTUALYZE_BASE_URL`, the config sets only
`providers.actualyze.settings.baseURL`.

`live-check.mjs` waits up to 60 seconds for the RPC catalog to report
`complete`, then checks that the plugin is listed and active, that exactly
one Actualyze integration exists, with the ID `actualyze` and a connection
only when a key file is set, that the `actualyze` provider is listed with
the expected endpoint and no `settings.apiKey` (or hidden, without a key
file), that the discovered models carry the expected limits, capabilities,
variants, and prices (Actualyze expectations come from the endpoint's own
`/models` list),
that the RPC catalog passes the strict validator, and that one plain chat
request succeeds against the first model in the Actualyze list, without an
effort variant. Pass `--skip-chat` to skip the chat request or
`--chat-model <provider/model>` to pick its model.

The scripts print only the fields they check. Never print a raw `model.list`
or `provider.list` response while debugging: both contain provider settings
with the plaintext API key.

`scripts/report-actualyze-model-capabilities.mjs` is a separate developer tool
that reports what an Actualyze endpoint advertises per model.

## Architecture

### Plugin lifecycle

The server half runs inside OpenCode's background service, once per open
location. The TUI half runs in the terminal client and talks to the server
half over plugin RPC.

```mermaid
sequenceDiagram
    participant OC as OpenCode service
    participant SV as server.ts setup
    participant TR as Model transform
    participant RF as Refresher
    participant ST as Shared store
    participant DP as discoverProvider
    participant TU as TUI plugin

    OC->>SV: setup(ctx)
    SV->>ST: seed bindings from ctx.storage
    SV->>OC: register provider and model transforms
    SV->>OC: register RPC (catalog, refresh)
    SV->>RF: start() without awaiting
    SV-->>OC: cleanup function
    OC->>TR: fold the model catalog
    TR-->>OC: patches from stored inventories
    loop Each trigger (startup, events, interval, refresh RPC)
        RF->>OC: provider.list()
        RF->>ST: start or join a job per target
        ST->>DP: discoverProvider(target, signal)
        DP-->>ST: inventory or failure
        ST->>OC: persist binding in ctx.storage
        ST->>RF: binding updated
        RF->>OC: model.reload()
        OC->>TR: fold again with the new inventory
        RF-->>TU: RPC event updated
    end
    TU->>OC: /modelscout reads model.list and provider.list
    TU->>SV: RPC catalog for discovery evidence
```

### Server half

- **`src/server.ts`** adapts the plugin context for the refresher, loads
  persisted bindings, registers the Actualyze integration, the two catalog
  transforms, and the RPC handlers, and starts the refresher. It awaits no
  network I/O.
- **`src/actualyze.ts`** defines the built-in Actualyze provider and its
  integration (a key method and the `ACTUALYZE_API_KEY` environment
  variable). The integration ID is `actualyze`, the provider ID, because the
  host's config provider plugin registers an integration under the provider
  ID for every `providers.<id>` entry unless one exists, and
  `opencode auth login actualyze` resolves an integration by exact ID first;
  any other ID would leave a configured provider reading keys from an
  integration nobody connects. The provider is added only when no
  `actualyze` provider exists yet, and the integration only when no
  `actualyze` integration exists, so a models.dev catalog that defines them
  keeps them. An earlier plugin's `actualyze` provider with
  `activation: "auto"` and no integration of its own is gated by this
  integration and stays hidden until it has a connection.
- **`src/transform.ts`** holds the provider transform and the model transform.
  The provider transform stores the provider IDs that exist before config
  providers load, then adds the Actualyze provider, so that provider never
  counts as pre-existing; `eligibleTarget()` uses the stored set to decide
  which providers are auto-eligible. The model transform runs in two passes:
  a pure pass maps each target's inventory to patches inside `try`/`catch`,
  then a second pass applies them with `editor.update`. Model IDs already in
  the provider's source record are skipped. Every target is served only
  through the binding the refresher made active for this instance after
  resolving its credential.
- **`src/refresher.ts`** turns host events, the refresh interval, and RPC
  `refresh` calls into debounced syncs. A sync resolves each target's
  credential in the order the host uses for chat (the integration's active
  connection, then `settings.apiKey`, then none), activates a stored binding
  for it, subscribes to the target's store entry, starts discovery for
  stale or changed targets, and reloads the catalog when a served binding
  changes. It also builds the RPC `catalog` payload.
- **`src/store.ts`** is the process-wide store on `globalThis`. It owns
  bindings and jobs keyed by the full target fingerprint plus, unless the
  target resolved to its `settings.apiKey`, the fingerprint of its resolved
  credential. It
  throttles starts to one per minute per target (a job aborted because its
  last subscriber left does not count), and bumps a generation on
  invalidation so stale job results are dropped.
- **`src/discover.ts`** contains `discoverProvider()`, which fetches
  `/v1/models`, resolves and runs the probe, and returns an inventory, and
  `toModelInfo()`, the pure mapping from an inventory to `Model.Info` patches
  and evidence records.

### Enrichment pipeline

```mermaid
flowchart TD
    A["GET /v1/models"] --> B{"settings.probe?"}
    B -->|"probe ID"| D["Provider probe"]
    B -->|"auto"| G["Fingerprint server"]
    B -->|"none"| E["Inventory"]
    G -->|"Detected"| H["PROBE_MAP lookup"]
    G -->|"Not detected"| E
    H --> D
    D --> E
    E --> M["toModelInfo"]
    I["models.dev index"] --> M
    K["Keyword heuristics"] --> M
    M --> P["Model.Info patches"]
    M --> V["Evidence for /modelscout"]
```

`toModelInfo()` resolves each field from the strongest source that has it:
probe evidence (including authoritative negatives), then a models.dev match,
then keyword heuristics on the model ID, then OpenCode's defaults. Each value
is recorded with its source and strength in a `CatalogModelRecord`, which the
TUI shows as source labels.

Mapping rules worth knowing:

- An unknown output limit is emitted as `0`, which the host reads as
  "unknown". A known output limit is capped at the known context.
- Image input is added only on image evidence. Unknown image support stays
  text-only rather than taking the host's text-and-image default.
- Reasoning models on an openai-compatible package get `low`, `medium`, and
  `high` variants with `settings.reasoningEffort`. Actualyze models and
  embedding models get none.
- Embedding models are emitted with `enabled: false`.
- Parameter size, quantization, disk size, and temperature support have no
  `Model.Info` field. They exist only as evidence.

### models.dev matching

`src/models-dev-index.ts` builds the matcher from `editor.provider.list()`
inside the model transform. It uses the provider records that existed before
config providers loaded (models.dev templates and built-ins), minus discovery
targets and the never-probed providers. The index is memoized on the
identities of the provider records.

```mermaid
flowchart TD
    A["Model ID qwen3:0.6b"] --> B["Normalize to qwen3-0.6b"]
    B --> C{"Exact match?"}
    C -->|Yes| D["Use match"]
    C -->|No| E["Family qwen, size 0.6b"]
    E --> F{"Family and size match?"}
    F -->|Yes| D
    F -->|No| G{"Family match?"}
    G -->|Yes| D
    G -->|No| H["No match"]
```

Normalization strips an owner prefix (`qwen/qwen3-30b` becomes `qwen3-30b`),
replaces `:` with `-`, and lowercases. The family is the leading run of
letters. Size matching uses digit boundaries so `4b` does not match inside
`14b`.

OpenCode normalizes models.dev before plugins see it, so a match can supply
only these values:

| From a match                                   | Not from a match |
| ---------------------------------------------- | ---------------- |
| tool support                                   | context limit    |
| image, PDF, audio, and video input             | output limit     |
| family                                         | temperature      |
| reasoning, when the record has effort variants | prices           |

A match without effort variants leaves reasoning unknown, not unsupported,
because the host derives variants per provider package.

### Server to TUI

`src/rpc.ts` defines the RPC contract as a plain object:

- `catalog({})` returns the evidence payload defined in
  `src/catalog-evidence.ts` (schema version 4): status, timestamps, and one
  record per target provider with its endpoint origin, probe selection, last
  good inventory time, latest failure, and per-model evidence.
- `refresh({ providerID? })` starts discovery for one target or all of them
  and returns `{ accepted, reason? }`. It joins an in-flight job and respects
  the one-minute floor per target. When nothing starts or joins, `reason` is
  `throttled` or `no-targets`.
- The `updated` event carries `{ completedAt }` after a discovery cycle, and
  after a sync first resolves the targets or changes the bindings they
  serve. The status is `pending` only until that first sync; with no job
  running it is `complete` as of the newest served inventory.

The TUI captures one location when the dialog opens and passes it in every
RPC call. It validates every `catalog` response with
`validateCatalogPayload()` before use. If the call fails, the browser falls
back to the host's model and provider lists with a notice.

### Server auto-detection

`fingerprint()` in `src/probes/fingerprint.ts` identifies the server when
`settings.probe` is `"auto"`:

```mermaid
flowchart TD
    A["Start"] --> B["Tier 1: inspect /v1/models entries"]
    B --> BA{"Any owner actualyze or atlas?"}
    BA -->|Yes| RA["actualyze"]
    BA -->|No| B1{"Unanimous owner<br/>in OWNED_BY_MAP?"}
    B1 -->|Yes| R2["Matched server"]
    B1 -->|No| B2{"aliases, tags,<br/>or status fields?"}
    B2 -->|Yes| R1["llamacpp"]
    B2 -->|No| C["Tier 2: endpoint probes"]
    C --> C1{"GET /info has router?"}
    C1 -->|Yes| R3["tgi"]
    C1 -->|No| C2{"GET /api/v1/models<br/>has key and type?"}
    C2 -->|Yes| R4["lmstudio"]
    C2 -->|No| D["Tier 3: Ollama banner or /api/tags"]
    D --> R5["undefined"]
```

- **Tier 1** reads the already-fetched model list and makes no requests. An
  exact `owned_by` of `actualyze` or `atlas` on any entry selects Actualyze,
  even in a mixed catalog. Other owners (`omlx`, `vllm`, `sglang`,
  `llamacpp`, `koboldcpp`, and `library` for Ollama) must be unanimous.
- **Tier 2** probes server-specific endpoints in sequence under a 2-second
  budget.
- **Tier 3** recognizes Ollama by its banner or `/api/tags` but returns
  `undefined`, so an Ollama server without unanimous `library` owners needs an
  explicit `"probe": "ollama"`.

`PROBE_MAP` maps each detected server to its probe. `llamacpp` maps to the
`ollama` probe, because llama.cpp serves Ollama-compatible endpoints.

## Adding a Probe

Probes are the most useful contribution: if your inference server has a
metadata API, a probe makes its models first-class in OpenCode. Read
[`src/probes/AGENTS.md`](src/probes/AGENTS.md) before you start; it lists the
rules every probe follows.

### Probe contract

```typescript
type ProviderProbe = (
  baseURL: string, // normalized, without a trailing /v1
  apiKey?: string,
  context?: ProbeContext,
) => Promise<ProbeResult>;

interface ProbeContext {
  /** The /v1/models entries discovery already fetched */
  modelsResponse?: OpenAIModelEntry[];
  /** Whether the probe was chosen by auto-detection or named explicitly */
  probeSelection?: "auto" | "explicit";
  /** Discovery cancellation signal */
  signal?: AbortSignal;
  /** Provider headers to send on every probe request */
  headers?: Readonly<Record<string, string>>;
}

interface ProbeResult {
  models: Record<string, ProbeModelMeta>;
}
```

Every probe must:

1. Make HTTP calls with `probeFetch()` from `./util` and pass
   `context.signal` to it.
2. Build headers with `buildHeaders(apiKey, context?.headers)`, so the API key
   and the provider's headers reach the server.
3. Read bodies with `readJson()` or `readBody()`, never raw `res.json()` or
   `res.text()`. The helpers bound the body read and cancel the stream.
4. Never throw. Catch everything and return `EMPTY_RESULT`.
5. Never write to stdout or stderr. Probes run inside OpenCode's shared
   background service.
6. Leave unknown values undefined. Return `false` only when the server
   reports it; a `false` is authoritative and overrides models.dev.

### Step by step

1. Create `src/probes/yourserver.ts`:

   ```typescript
   import type { ProbeModelMeta, ProbeResult, ProviderProbe } from "./types";
   import { buildHeaders, EMPTY_RESULT, probeFetch, readJson } from "./util";

   export const probeYourServer: ProviderProbe = async (
     baseURL,
     apiKey,
     context,
   ): Promise<ProbeResult> => {
     try {
       const res = await probeFetch(`${baseURL}/api/model-info`, {
         headers: buildHeaders(apiKey, context?.headers),
         signal: context?.signal,
       });
       if (!res) return EMPTY_RESULT;
       if (!res.ok) return EMPTY_RESULT;

       const data = await readJson<{ models?: unknown[] }>(res);
       if (!data || !Array.isArray(data.models)) return EMPTY_RESULT;

       const models: Record<string, ProbeModelMeta> = {};
       for (const raw of data.models) {
         const entry = raw as Record<string, unknown>;
         if (typeof entry.id !== "string") continue;
         models[entry.id] = {
           context:
             typeof entry.context_window === "number"
               ? entry.context_window
               : undefined,
           vision: entry.supports_vision === true ? true : undefined,
           toolCall: entry.supports_tools === true ? true : undefined,
         };
       }
       return { models };
     } catch {
       return EMPTY_RESULT;
     }
   };
   ```

   If the server's `/v1/models` entries already carry the metadata (vLLM's
   `max_model_len`, for example), read `context.modelsResponse` instead of
   making another request.

2. Register it in `PROBES` in `src/probes/index.ts`. `ProbeKey` derives from
   that object, so the new ID becomes a valid `settings.probe` value.
3. For auto-detection, update `src/probes/fingerprint.ts` (see below).
4. Add `test/probes/yourserver.test.ts`. Mock `fetch` and cover the success
   path, HTTP errors, malformed bodies, and partial data. The existing probe
   tests are good templates.
5. Add the server to the Supported Servers table in `README.md`.

### `ProbeModelMeta` fields

All fields are optional. `discover.ts` runs every probe result through
`sanitizeProbeMeta()`, which drops values of the wrong type, so a new field
also needs a line there.

| Field             | Type                                                   | Description                                              |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `context`         | `number`                                               | Context window in tokens                                 |
| `maxTokens`       | `number`                                               | Maximum output tokens                                    |
| `modelType`       | `"llm" \| "vlm" \| "embedding"`                        | Model classification                                     |
| `toolCall`        | `boolean`                                              | Tool calling support                                     |
| `reasoning`       | `boolean`                                              | Reasoning or thinking support                            |
| `temperature`     | `boolean`                                              | Temperature control support                              |
| `vision`          | `boolean`                                              | Image input support                                      |
| `inputModalities` | `("text" \| "image" \| "pdf" \| "audio" \| "video")[]` | Authoritative input list; replaces `vision` when present |
| `cost`            | `{ input, output, cacheRead?, cacheWrite? }`           | Prices in USD per million tokens                         |
| `loaded`          | `boolean`                                              | Currently loaded in memory                               |
| `sizeBytes`       | `number`                                               | Model file size on disk                                  |
| `parameterSize`   | `string`                                               | Parameter count, such as `"30.5B"`                       |
| `family`          | `string`                                               | Model family, such as `"qwen3"`                          |
| `quantization`    | `string`                                               | Quantization level, such as `"Q4_K_M"`                   |

### What makes a good probe

- **Fast.** Finish well inside the discovery budget (15 seconds by default)
  even with many models.
- **Parallel and bounded.** For per-model calls, use a bounded worker pool or
  `Promise.allSettled()`.
- **Resilient.** One model's failed request must not discard the others.
- **Accurate.** Report only what the server's API states.

### Adding a server fingerprint

To make a new server detectable with `"probe": "auto"`, edit
`src/probes/fingerprint.ts`:

1. Add the server to the `DetectedServer` union and to `PROBE_MAP`. Map it to
   an existing probe key if the server is API-compatible with one.
2. If the server sets a distinctive `owned_by`, add it to `OWNED_BY_MAP`.
   That costs no requests.
3. Otherwise add a Tier 2 check before the Tier 3 section:

   ```typescript
   // Step N: GET /your/unique/endpoint → yourserver
   if (combinedSignal.aborted) return undefined;
   try {
     const res = await probeFetch(`${baseURL}/your/unique/endpoint`, {
       headers,
       signal: combinedSignal,
       timeoutMs: 1000,
     });
     if (res?.ok) {
       const data = await readJson<Record<string, unknown>>(res, 1000);
       if (data && typeof data.server_name === "string") return "yourserver";
     }
   } catch {
     // Malformed body; continue with the next check.
   }
   ```

4. Add cases to `test/probes/fingerprint.test.ts`.

## Project Structure

```
opencode-model-scout/
├── src/
│   ├── server.ts             # Server plugin entry
│   ├── refresher.ts          # Triggers, sync, refresh interval, RPC catalog
│   ├── store.ts              # Shared discovery store and fingerprints
│   ├── actualyze.ts          # Built-in Actualyze provider and integration
│   ├── transform.ts          # Provider transform, eligibility, model transform
│   ├── discover.ts           # discoverProvider and toModelInfo
│   ├── models-dev-index.ts   # models.dev matcher
│   ├── catalog-evidence.ts   # Evidence schema and validator
│   ├── rpc.ts                # RPC contract
│   ├── tui.ts                # TUI plugin entry and /modelscout dialog
│   ├── tui-browser.ts        # Browser state, keys, rendering
│   ├── tui-models.ts         # Host and evidence reconciliation
│   ├── tui-renderer.ts       # Imperative OpenTUI adapter
│   ├── format.ts             # Name, count, and byte formatting
│   ├── constants.ts          # IDs and shared constant sets
│   └── probes/
│       ├── AGENTS.md         # Probe rules
│       ├── types.ts          # ProbeModelMeta, ProbeContext, ProviderProbe
│       ├── util.ts           # probeFetch, readJson, buildHeaders, EMPTY_RESULT
│       ├── index.ts          # Registry and resolveProbe
│       ├── fingerprint.ts    # Auto-detection
│       ├── actualyze.ts
│       ├── omlx.ts
│       ├── ollama.ts
│       ├── vllm.ts
│       ├── tgi.ts
│       ├── sglang.ts
│       ├── lmstudio.ts
│       └── koboldcpp.ts
├── test/
│   ├── setup.ts              # Global fetch mock for unit tests
│   ├── probes/               # One test file per probe, plus registry and headers
│   ├── e2e/                  # Embedded-host tests
│   └── *.test.ts             # Server, transform, store, TUI, and format tests
├── scripts/
│   ├── check-dist.mjs
│   ├── live-harness.mjs
│   ├── live-check.mjs
│   └── report-actualyze-model-capabilities.mjs
├── tsup.config.ts            # Builds a flat dist/ (server.js, tui.js, rpc.js)
├── vitest.config.ts          # Unit lane
├── vitest.e2e.config.ts      # E2E lane
├── eslint.config.js
├── .husky/
└── .github/workflows/
    ├── release.yml           # Tag → check, compile, npm publish, GitHub Release
    └── latest.yml            # Push to main → check and rolling snapshot release
```

All naming strings live in `src/constants.ts`. `PLUGIN_ID` must stay
identical for the server half, the TUI half, and the RPC contract.

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add LM Studio probe
fix: size matching false-positive on 4b/14b
docs: update probe comparison table
test: cover an empty model list
```

## Pull Requests

Run `npm run check` before opening a pull request. For
changes to discovery, the transforms, or the TUI, also run the live harness
and say in the pull request which checks you ran.
