# opencode-model-scout

An [opencode](https://github.com/opencode-ai/opencode) plugin that solves a
fundamental problem with local AI providers: **they expose models through a
generic OpenAI-compatible API that reports almost nothing about what each model
can actually do.**

When you run Ollama, oMLX, LM Studio, or any other local inference server,
opencode discovers model IDs like `qwen3:30b-a3b` or `gemma3-12b-it` — but has
no idea whether they support tool calling, vision input, extended thinking, or
what their actual context window is. Without this metadata, opencode can't make
informed decisions about which model to use, what features to enable, or how
much context it can send.

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

### From GitHub

The quickest way to install. This uses opencode's built-in plugin command,
which downloads the package from GitHub and patches your `opencode.json`
automatically:

```bash
opencode plugin github:rmk40/opencode-model-scout
```

After installation, you still need to add provider configuration with the
`probe` field — see [Configuration](#configuration) below.

If you prefer to edit `opencode.json` manually instead of using the CLI:

```json
{
  "plugin": ["github:rmk40/opencode-model-scout"]
}
```

opencode will install the package on next startup.

### From Source

Clone the repo and install dependencies:

```bash
git clone https://github.com/rmk40/opencode-model-scout.git
cd opencode-model-scout
npm install
```

Then reference the local path in your `opencode.json`:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-model-scout"]
}
```

This is useful for development or if you want to modify the plugin.

### From npm (coming soon)

Once published to npm, installation will be:

```bash
opencode plugin opencode-model-scout
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
    }
  }
}
```

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
discovery + models.dev fallback (no probe exists for it yet — see
[CONTRIBUTING.md](CONTRIBUTING.md) for how to build one).

## Supported Probes

### oMLX

|              |                                                    |
| ------------ | -------------------------------------------------- |
| **Endpoint** | `GET /v1/models/status`                            |
| **Auth**     | API key required (sent as `Authorization: Bearer`) |
| **Timeout**  | 2 seconds                                          |

The oMLX probe calls a single endpoint that returns all model metadata at once.
It extracts:

| Field          | Source                 | Example        |
| -------------- | ---------------------- | -------------- |
| Context window | `max_context_window`   | 262,144        |
| Output limit   | `max_tokens`           | 32,768         |
| Model type     | `model_type`           | "llm" or "vlm" |
| Vision support | `model_type === "vlm"` | true           |
| Load state     | `loaded`               | true/false     |
| Disk size      | `estimated_size`       | 47 GB          |
| Temperature    | Always set             | true           |

The oMLX probe does **not** set `tool_call` — oMLX does not report this
capability in its API.

### Ollama

|               |                                                |
| ------------- | ---------------------------------------------- |
| **Endpoints** | `GET /api/tags` + `POST /api/show` (per model) |
| **Auth**      | Optional API key                               |
| **Timeout**   | 2 seconds per request                          |

The Ollama probe is a two-step process. First it lists all models via
`/api/tags`, then queries `/api/show` for each model in parallel to get
detailed capabilities. It extracts:

| Field          | Source                        | Example  |
| -------------- | ----------------------------- | -------- |
| Context length | `model_info.*.context_length` | 40,960   |
| Tool calling   | `capabilities: ["tools"]`     | true     |
| Vision         | `capabilities: ["vision"]`    | true     |
| Reasoning      | `capabilities: ["thinking"]`  | true     |
| Family         | `details.family`              | "qwen3"  |
| Parameter size | `details.parameter_size`      | "0.6B"   |
| Quantization   | `details.quantization_level`  | "Q4_K_M" |
| Disk size      | `size` (from tags)            | 504 MB   |
| Temperature    | Always set                    | true     |

If `/api/show` fails for individual models, they still get partial metadata
from the tags response. The probe never fails entirely — worst case, you get
model IDs with basic metadata.

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
```

## Timeouts and Resilience

The plugin is designed to never block opencode startup:

- **Individual fetch calls** use a 3-second timeout (model list) or 2-second
  timeout (probes)
- **The entire config hook** has a 5-second timeout — if discovery takes
  longer, opencode starts with whatever was discovered so far
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
