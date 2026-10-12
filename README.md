# opencode-model-scout

[![npm version](https://img.shields.io/npm/v/opencode-model-scout)](https://www.npmjs.com/package/opencode-model-scout)
[![CI](https://github.com/rmk40/opencode-model-scout/actions/workflows/release.yml/badge.svg)](https://github.com/rmk40/opencode-model-scout/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [opencode](https://github.com/opencode-ai/opencode) plugin that
auto-discovers models from OpenAI-compatible providers and enriches them with
context window sizes, capability flags, and model metadata. Supports Atlas,
Ollama, oMLX, vLLM, TGI, SGLang, LM Studio, KoboldCpp, llama.cpp, and LocalAI.

## Quick Start

```bash
opencode plugin opencode-model-scout
```

Then add `"probe": "auto"` to any provider in your `opencode.json`:

```json
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:11434/v1",
        "probe": "auto"
      }
    }
  }
}
```

Restart opencode. Every model on that provider now has accurate context window
sizes, output limits, and capability flags (tool calling, vision, reasoning)
discovered automatically.

## The Problem

Local AI providers expose models through a generic OpenAI-compatible API that
reports almost nothing about what each model can actually do. When you run
Ollama, oMLX, LM Studio, or any other inference server, opencode discovers
model IDs like `qwen3:30b-a3b` or `gemma3-12b-it` — but has no idea whether
they support tool calling, vision input, extended thinking, or what their
actual context window is. Without this metadata, opencode can't make informed
decisions about which model to use, what features to enable, or how much
context it can send.

**opencode-model-scout** fixes this by building a 3-layer metadata enrichment
pipeline that runs at startup. It discovers every available model, probes
provider-specific APIs for authoritative metadata, and falls back to the
[models.dev](https://models.dev) database for anything the probes can't reach.
The result: every discovered model gets accurate context limits, capability
flags, and modality information — automatically, with zero manual configuration.

## How It Works

The plugin runs during opencode's config hook (before any session starts) and
enriches model entries through three layers, applied in order:

1. **Discovery + keyword categorization** — Queries `GET /v1/models` on every
   OpenAI-compatible provider to get the raw model list. Model IDs are
   categorized as chat, embedding, or unknown based on name patterns.

2. **Provider-specific probes** — When a provider has `"probe": "atlas"`,
   `"probe": "omlx"`, or another supported probe in its options, a purpose-built
   probe calls provider-specific APIs that expose metadata the generic OpenAI
   API does not. Probes are the most authoritative source and override keyword
   guesses.

3. **models.dev fallback** — For any model that still has gaps after probing,
   the plugin matches the model ID against opencode's built-in
   [models.dev](https://models.dev) database (~4,000 models) using family +
   parameter size matching. This fills in capability flags like `tool_call`,
   `reasoning`, and `attachment` for models the probes don't cover.

Each layer only sets fields that aren't already present — manually configured
metadata in your `opencode.json` is never overwritten, and probes always take
priority over models.dev guesses.

## Installation

**The `opencode plugin` CLI is the recommended way to install in every case.**
It reads the package manifest and registers the plugin in **both**
`opencode.json` (the server plugin that runs model discovery) **and**
`tui.json` (the TUI plugin that provides the `/modelscout` dialog) for you. The
spec it accepts can be an npm name, a `github:` reference, or a local
`file://` path:

```bash
# From npm
opencode plugin opencode-model-scout

# From GitHub
opencode plugin github:rmk40/opencode-model-scout

# From a local checkout (development)
opencode plugin file:///absolute/path/to/opencode-model-scout
```

After installation, add provider configuration with the `probe` field — see
[Configuration](#configuration) below.

> **Why two files?** opencode loads **server** plugins from the `plugin` array
> in `opencode.json` and **TUI** plugins from a _separate_ `plugin` array in
> `tui.json`. The server side drives startup model discovery; the TUI side
> drives the `/modelscout` dialog. `opencode plugin …` writes both. If you
> configure the plugin by hand, you **must** add it to both files or the
> `/modelscout` command will not appear (see [Manual configuration](#manual-configuration)).

### Manual configuration

If you prefer to edit config by hand (or install the package yourself), add the
plugin to **both** files. Use the same spec in each — an npm name, a `github:`
reference, or a `file://` path:

`~/.config/opencode/opencode.json` (server — model discovery):

```json
{
  "plugin": ["opencode-model-scout"]
}
```

`~/.config/opencode/tui.json` (TUI — the `/modelscout` dialog):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-model-scout"]
}
```

To install the package itself from npm before referencing it:

```bash
npm install opencode-model-scout
```

For a local checkout, clone and build first, then reference the directory with a
`file://` path in both config files:

```bash
git clone https://github.com/rmk40/opencode-model-scout.git
cd opencode-model-scout
npm install
npm run compile
```

```json
{
  "plugin": ["file:///absolute/path/to/opencode-model-scout"]
}
```

## Configuration

### Basic: Discovery Only (No Probe)

Any `@ai-sdk/openai-compatible` provider gets automatic model discovery. Models
are enriched with whatever models.dev can match:

```json
{
  "provider": {
    "my-server": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:8000/v1"
      }
    }
  }
}
```

### With a Probe: Full Metadata

Add `"probe"` to the provider's `options` to enable provider-specific metadata
extraction. The probe field **must** be inside `options`, not at the provider
top level, because opencode's provider schema rejects unknown top-level fields.

You can specify an explicit probe name or use `"auto"` to let the plugin
detect the server type automatically:

```json
{
  "provider": {
    "omlx": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:8000/v1",
        "apiKey": "your-key",
        "probe": "omlx"
      }
    },
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:11434/v1",
        "probe": "ollama"
      }
    },
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:5000/v1",
        "probe": "auto"
      }
    }
  }
}
```

When `"probe": "auto"` is set, the plugin fingerprints the server using a
tiered detection strategy (see [Supported Servers](#supported-servers)) and
selects the appropriate probe automatically. If detection fails, the provider
still gets discovery + models.dev fallback enrichment.

Atlas can also be selected explicitly with `"probe": "atlas"`. In auto mode,
the plugin selects it when any valid `/v1/models` entry reports the exact owner
`atlas`. Other recognized owners still require unanimous ownership.

### Multiple Providers

The plugin processes every provider in your config independently. You can mix
probed and unprobed providers freely:

```json
{
  "provider": {
    "omlx": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:8000/v1",
        "apiKey": "strata",
        "probe": "omlx"
      }
    },
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:11434/v1",
        "probe": "ollama"
      }
    },
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:1234/v1"
      }
    }
  }
}
```

In this example, oMLX and Ollama get full probe enrichment. LM Studio gets
discovery + models.dev fallback. You could also use `"probe": "auto"` on any
of these to let the plugin detect the server type automatically.

## Supported Servers

| Server        | Probe       | Status   | What It Extracts                                                        |
| ------------- | ----------- | -------- | ----------------------------------------------------------------------- |
| **Atlas**     | `atlas`     | Tested   | Context, output limit, vision, tools, reasoning from thinking signals   |
| **oMLX**      | `omlx`      | Tested   | Context, output limit, model type, load state, size                     |
| **Ollama**    | `ollama`    | Tested   | Context, tools, vision, thinking, family, quantization                  |
| **llama.cpp** | `ollama`    | Expected | Partial Ollama metadata (API compat unverified against live instance)   |
| **LocalAI**   | `ollama`    | Expected | Partial Ollama metadata (API compat unverified against live instance)   |
| **LM Studio** | `lmstudio`  | Untested | Context, vision, tool use, architecture, quantization, size, load state |
| **TGI**       | `tgi`       | Untested | Context, output limit                                                   |
| **SGLang**    | `sglang`    | Untested | Context, model type, vision                                             |
| **vLLM**      | `vllm`      | Untested | Context                                                                 |
| **KoboldCpp** | `koboldcpp` | Untested | Context, vision                                                         |

### Support Tiers

- **Tested** -- verified against a live instance
- **Expected** -- API-compatible based on server source code review; not yet tested against a live instance
- **Untested** -- probe implemented based on API documentation; needs community verification

The Atlas probe reuses the `/v1/models` response, then fetches encoded
`/v1/models/{id}` detail endpoints with a bounded worker pool. Requests inherit
the config-hook abort signal, and one failed model does not discard metadata
from the others. Auto-selected probes request details only for Atlas-owned
entries in a mixed catalog; an explicit `"probe": "atlas"` remains an
all-model manual override. Foreign-owner entries remain discovered and use the
normal models.dev fallback. The probe is tested against a live Atlas endpoint.

### models.dev Fallback

When no probe is configured (or for capability gaps that probes don't cover),
the plugin matches discovered model IDs against opencode's built-in
[models.dev](https://models.dev) database using a 3-tier matching strategy:

1. **Exact normalized match** — `qwen3-30b-a3b` matches directly
2. **Family + size match** — `qwen3:0.6b` → family "qwen" + size "0.6b" →
   matches a qwen model with the same parameter count
3. **Family-only match** — `qwen3:14b` → family "qwen" → inherits
   capabilities from any known qwen model

The fallback only applies **capability flags** (`tool_call`, `reasoning`,
`attachment`, `temperature`, `modalities`, `family`). It does **not** apply
context or output limits — those vary too much across quantization levels and
providers to be guessed reliably.

Atlas reports capability booleans authoritatively. A reported `false` blocks a
models.dev fallback from enabling tool calling, reasoning, or attachment. Those
negative values remain internal sentinels and are not emitted as false config
flags. Temperature is a valued provider option, so an explicit probe
`temperature: false` is preserved in the final opencode config. Missing,
malformed, or otherwise unknown values remain eligible for fallback enrichment.

## `/modelscout` Command

Inspect and filter discovered models in an interactive TUI browser:

```
/modelscout    Open the interactive model and provider browser
```

Selecting `/modelscout` from slash autocomplete opens a dialog without sending
a message to the model or starting an assistant turn. The full-width result
list groups models beneath selectable provider headers. Press `enter` on a
model to inspect its metadata, or on a provider header to inspect discovery
status, probes, metadata gaps, and capability evidence. `backspace` returns to
the preserved list, search, filters, and selection.

The result list owns focus when the dialog opens, so `up` and `down` work
immediately. Press `/` to focus search; pressing an arrow from search returns to
the result list. Rows stay to one line so large catalogs remain scannable at
narrow and wide terminal widths.

| Key           | Action                                                   |
| ------------- | -------------------------------------------------------- |
| `up` / `down` | Move through results or scroll details                   |
| `enter`       | Move from search to results or open the selected details |
| `/`           | Return to the list if needed and focus search            |
| `p`           | Cycle provider when more than one provider is available  |
| `t`           | Cycle model type                                         |
| `c`           | Cycle capability                                         |
| `s`           | Cycle capability evidence state                          |
| `m`           | Cycle complete/missing core metadata                     |
| `o`           | Cycle discovered/pre-existing origin                     |
| `r`           | Reset all model filters                                  |
| `backspace`   | Return from details to the preserved list                |
| `esc`         | Close the browser                                        |

Model filter shortcuts work outside the search input. The active filter row
shows the current provider, type, capability, evidence state, metadata, and
origin values. The footer only advertises keys that work for the current
focus: while search owns input it lists the search actions, and on list or
detail screens it lists navigation plus the filter shortcuts. The facet key
hint omits `p` for single-provider catalogs and `o` when exact origin
evidence is unavailable. If a filter combination empties the results, the
shortcuts stay active so you can keep cycling or press `r` to reset while any
search query stays in place; `enter` or an arrow from search returns to those
shortcuts even with zero results.

Provider header rows carry a permanent `▸ ` marker, a `visible/total` model
count when search or filters hide some models, core coverage for the visible
models, and a `discovery <status>` cell. Searching for a provider name, ID,
or endpoint shows that provider with all of its models that match the active
filters; if a model filter excludes every model, the header hides too.
Zero-model and failed providers stay reachable while no model filter is
active. Origin filtering is unavailable when the TUI cannot correlate the
current server discovery attempt.

The detail screen uses three evidence states:

| State         | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `supported`   | A source reports or infers support                               |
| `unsupported` | A probe or pre-existing configuration explicitly reports `false` |
| `unknown`     | No authoritative value was reported; this is expected            |

Each known value includes a concise bracketed source label such as `probe`,
`config`, `server`, `models.dev`, `heuristic`, `default`, or `host`. Core
metadata coverage is type-aware. Language and vision-language models use type,
context, output, vision, tools, reasoning, and temperature. Embedding models use
type and context.

### Provenance Snapshot

opencode's public provider state does not retain all probe diagnostics or
authoritative negative evidence. The server plugin therefore writes a bounded,
versioned snapshot to:

```text
$XDG_CACHE_HOME/opencode/model-scout/<worktree-hash>.<server-hash>.json
```

The file and directory use owner-only permissions where supported. The snapshot
contains model IDs, metadata evidence, provider status, and sanitized endpoint
origins. It does not contain API keys, authorization headers, response bodies,
raw worktree paths, server URLs, URL credentials, paths, queries, fragments, or
raw errors or process IDs. Writes use a temporary file and atomic rename. The
payload carries a runtime hash derived from the process ID. The TUI computes the
same hash independently and accepts a snapshot only when its runtime, server,
worktree, provider fingerprint, schema, and lower and upper startup bounds match
the active session. A process mismatch falls back to host state.

For correlation, `http://opencode.internal` and HTTP control-server URLs on
`localhost`, `127.0.0.1`, or `::1` map to one internal server key at any port.
The runtime hash separates concurrent local launches. Direct non-loopback URLs
remain distinct. Provider fingerprints include provider ID, configured probe,
and the credential-free normalized base URL including its path. None of those
raw values are stored in the fingerprint.

Set `OPENCODE_MODEL_SCOUT_DISABLE_PERSISTENCE=1` before starting opencode to
disable disk snapshots. The browser still works from opencode's effective host
state, but origin, provider-attempt diagnostics, probe-only metadata, and exact
source labels may be unavailable. Existing cache files can be removed from the
directory above.

> **Requires a TUI-capable opencode.** The command is registered through
> opencode's TUI plugin command API; the model-discovery and enrichment that
> happen at startup work everywhere, but on a host without the TUI plugin
> runtime the `/modelscout` command simply does not appear. If exact provenance
> cannot be loaded, the command degrades to the host-state browser rather than
> hiding models or failing to open.

## Timeouts and Resilience

The plugin is designed to never block opencode startup:

- **Individual fetch calls** use a 3-second timeout (model list) or 2-second
  timeout (probes), all via the shared `probeFetch()` wrapper
- **The entire config hook** has a 5-second abort timeout. Model-list requests,
  fingerprinting, and Atlas detail requests consume that signal. Legacy probes
  remain bounded by their individual request and body-read timeouts.
- **The startup budget is configurable** with
  `OPENCODE_MODEL_SCOUT_TIMEOUT_MS`. Valid values are clamped to 10 through
  60000 milliseconds. Missing, non-numeric, or non-positive values use the
  5-second default.
- **Per-provider isolation** — each provider is wrapped in its own try-catch,
  so a failing provider never prevents discovery for other providers
- **Per-model Atlas isolation** — detail requests use bounded concurrency and
  individual timeouts; a failure only skips enrichment for that model
- **All errors are caught and isolated** — a failing probe, an offline provider,
  or a malformed response never crashes the plugin or prevents opencode from
  starting
- **Negative chat capability flags stay internal.** Authoritative false values
  for tool calling, reasoning, and attachment block fallback without becoming
  emitted false flags. An explicit `temperature: false` remains in the config
  because temperature is a valued option.
- **Provenance persistence is best-effort.** Missing, disabled, corrupt,
  mismatched, oversized, or unwritable snapshots never block startup. They only
  remove provenance-specific TUI details.

## Manually Configured Models

Models you explicitly configure in `opencode.json` are **never modified** by
the plugin. If you have:

```json
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:11434/v1",
        "probe": "ollama"
      },
      "models": {
        "qwen3:30b": {
          "name": "My Custom Qwen",
          "limit": { "context": 8192, "output": 2048 }
        }
      }
    }
  }
}
```

The plugin will discover any **other** models Ollama has available and enrich
them, but `qwen3:30b` keeps your custom name and limits untouched.

## License

MIT

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, how to build
new probes, and development workflow.
