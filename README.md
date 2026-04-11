# opencode-model-scout

[![npm version](https://img.shields.io/npm/v/opencode-model-scout)](https://www.npmjs.com/package/opencode-model-scout)
[![CI](https://github.com/rmk40/opencode-model-scout/actions/workflows/release.yml/badge.svg)](https://github.com/rmk40/opencode-model-scout/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [opencode](https://github.com/opencode-ai/opencode) plugin that
auto-discovers models from OpenAI-compatible providers and enriches them with
context window sizes, capability flags, and model metadata. Supports Ollama,
oMLX, vLLM, TGI, SGLang, LM Studio, KoboldCpp, llama.cpp, and LocalAI.

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

2. **Provider-specific probes** — When a provider has `"probe": "omlx"` or
   `"probe": "ollama"` in its options, a purpose-built probe calls
   provider-specific APIs that expose metadata the generic OpenAI API does not.
   Probes are the most authoritative source and override keyword guesses.

3. **models.dev fallback** — For any model that still has gaps after probing,
   the plugin matches the model ID against opencode's built-in
   [models.dev](https://models.dev) database (~4,000 models) using family +
   parameter size matching. This fills in capability flags like `tool_call`,
   `reasoning`, and `attachment` for models the probes don't cover.

Each layer only sets fields that aren't already present — manually configured
metadata in your `opencode.json` is never overwritten, and probes always take
priority over models.dev guesses.

## Installation

### From npm

Using the opencode CLI (installs and patches `opencode.json` automatically):

```bash
opencode plugin opencode-model-scout
```

Or install with npm directly and add the plugin to your `opencode.json`
manually:

```bash
npm install opencode-model-scout
```

```json
{
  "plugin": ["opencode-model-scout"]
}
```

After installation, add provider configuration with the `probe` field — see
[Configuration](#configuration) below.

### From GitHub

```bash
opencode plugin github:rmk40/opencode-model-scout
```

Or in `opencode.json`:

```json
{
  "plugin": ["github:rmk40/opencode-model-scout"]
}
```

### From Source

For development or modification:

```bash
git clone https://github.com/rmk40/opencode-model-scout.git
cd opencode-model-scout
npm install
```

Then in `opencode.json`:

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

## `/modelscout` Command

Inspect what was discovered during startup:

```
/modelscout           Show discovered models with metadata
/modelscout --json    Show as JSON (for debugging or scripting)
```

Example output:

```
Models Discovery

omlx (probe: omlx) — 7 models
──────────────────────────────────────────────────
  qwen3-coder-next
    Context: 262,144 | Output: 32,768 | Type: llm | Temp | Size: 43.9 GB

  Qwen3.5-35B-MLX-mxfp4
    Context: 262,144 | Output: 32,768 | Type: vlm | Vision, Temp | Size: 19.2 GB

ollama (probe: ollama) — 3 models
──────────────────────────────────────────────────
  qwen3:0.6b
    Context: 40,960 | Type: llm | Tools, Reasoning, Temp | Family: qwen3 | Params: 0.6B | Quant: Q4_K_M | Size: 480.5 MB

  smollm2:135m
    Type: llm | Temp | Params: 135M | Size: 98.8 MB

  nomic-embed-text
    Temp | Family: nomic | Params: 137M

local (auto → vllm) — 2 models
──────────────────────────────────────────────────
  Qwen/Qwen3-8B
    Context: 32,768 | Type: llm | Temp
```

## Timeouts and Resilience

The plugin is designed to never block opencode startup:

- **Individual fetch calls** use a 3-second timeout (model list) or 2-second
  timeout (probes), all via the shared `probeFetch()` wrapper
- **The entire config hook** has a 5-second abort timeout — if discovery takes
  longer, in-flight HTTP requests are cancelled via abort signal propagation
  and opencode starts normally
- **Per-provider isolation** — each provider is wrapped in its own try-catch,
  so a failing provider never prevents discovery for other providers
- **All errors are caught and logged** — a failing probe, an offline provider,
  or a malformed response never crashes the plugin or prevents opencode from
  starting
- **Capability flags are only set to `true`**, never `false` — if a probe
  can't determine a capability, the field is left undefined (unknown) rather
  than incorrectly denied

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
