# opencode-model-scout

[![npm version](https://img.shields.io/npm/v/opencode-model-scout)](https://www.npmjs.com/package/opencode-model-scout)
[![CI](https://github.com/rmk40/opencode-model-scout/actions/workflows/release.yml/badge.svg)](https://github.com/rmk40/opencode-model-scout/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [OpenCode](https://opencode.ai) plugin that finds the models an
OpenAI-compatible server actually serves and gives OpenCode what it needs to
use them: context and output limits, tool support, input modalities,
reasoning-effort variants, and prices where the server reports them. It has
probes for Actualyze, Ollama, oMLX, vLLM, TGI, SGLang, LM Studio, KoboldCpp,
llama.cpp, and LocalAI.

Version 2 is for OpenCode 2 and is tested against OpenCode 2.0.26. If you are
still on OpenCode 1, see [Using OpenCode 1](#using-opencode-1).

## Quick Start

1. Install the plugin:

   ```bash
   opencode plugin add opencode-model-scout
   ```

2. Add a provider with `settings.probe` to `~/.config/opencode/opencode.json`:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "providers": {
       "local-llm": {
         "name": "Local LLM",
         "package": "@opencode/ai/providers/openai-compatible",
         "settings": {
           "baseURL": "http://localhost:8080/v1",
           "probe": "auto"
         }
       }
     }
   }
   ```

3. The served models appear in the model picker once discovery finishes,
   usually within a few seconds and without a restart. Run `/modelscout` to
   see what was found and where each value came from.

## The Problem

An OpenAI-compatible `/v1/models` endpoint reports model IDs and little else.
OpenCode sees `qwen3:30b-a3b` or `gemma3-12b-it` and has no idea whether the
model can call tools, read images, or think, or how large its context window
is. Without that, OpenCode falls back to generic defaults, and the model
picker never shows models you did not type into your config by hand.

Most inference servers do publish this metadata, each through its own API.
Scout asks those APIs, fills the remaining gaps from the
[models.dev](https://models.dev) data OpenCode already has, and adds every
served model to the catalog.

## How It Works

The plugin has two halves. The server half runs inside OpenCode's background
service and does the discovery. The TUI half adds the `/modelscout` browser.

For each provider it targets (see
[Which providers are discovered](#which-providers-are-discovered)), the server
half:

1. Lists the served models with `GET <baseURL>/v1/models`. A trailing `/v1` on
   `baseURL` is accepted and not doubled.
2. Runs the probe named in `settings.probe`. With `"probe": "auto"` it
   fingerprints the server first and picks the matching probe.
3. Matches each model ID against the models.dev records OpenCode has loaded:
   exact ID first, then family plus parameter size (`qwen3:0.6b` matches a
   `qwen` model of size `0.6b`), then family alone. A match supplies tool
   support, input modalities, family, and a positive reasoning signal. It
   never supplies limits, because those vary by provider and quantization.
4. Stores the result and adds every served model that is not already declared
   for that provider.

When sources disagree, the strongest wins: probe values (including an
explicit "not supported"), then models.dev, then keyword heuristics on the
model ID, then OpenCode's defaults.

Discovery never runs during plugin setup, so it does not slow OpenCode's
startup. Inventories stored by an earlier run are served right away, before
any network request.

## Installation

```bash
opencode plugin add opencode-model-scout
```

This installs the package and adds it to your global OpenCode configuration.
`opencode plugin remove opencode-model-scout` takes it out again.

To configure it by hand, list it in the `plugins` array of `opencode.json`:

```json
{
  "plugins": ["opencode-model-scout"]
}
```

To pass [plugin options](#plugin-options), use the object form:

```json
{
  "plugins": [
    {
      "package": "opencode-model-scout",
      "options": { "refreshIntervalMs": 1800000 }
    }
  ]
}
```

The package contains a server plugin and a TUI plugin. OpenCode loads the TUI
half automatically together with the server half, so there is nothing else to
add for `/modelscout`.

### Running from a checkout

```bash
git clone https://github.com/rmk40/opencode-model-scout.git
cd opencode-model-scout
npm install
npm run compile
```

Then point `plugins` at the build output directory:

```json
{
  "plugins": ["/absolute/path/to/opencode-model-scout/dist"]
}
```

OpenCode loads a local plugin directory by looking for `server.js` and
`tui.js` inside it, so the entry is `dist`, not the repository root.

### The background service and environment variables

OpenCode 2 runs plugins in one shared background service per user, not in the
terminal where you start `opencode`. Config substitutions such as
`{env:LOCAL_LLM_KEY}` therefore read the service's environment, and a variable
exported in your shell is not visible to them. Set it on the service and
restart it:

```bash
opencode service set env LOCAL_LLM_KEY <value>
opencode service restart
```

Alternatively, read the key from a file with `{file:~/path/to/key}`. A
relative `{file:}` path resolves against the directory of the config file.

## Configuration

### Which providers are discovered

A provider is a discovery target when it has `settings.baseURL` and one of
these holds:

- **It sets `settings.probe`.** Any value opts in, including `"auto"`.
- **It is a plain provider from your config.** Its package is the
  openai-compatible package, it has no `canonical`, and its ID is not one
  OpenCode already knows from models.dev, from a built-in provider, or from a
  plugin listed before scout. Such a provider is discovered without a probe:
  scout lists its models and fills metadata from models.dev and heuristics.

Everything else needs `settings.probe`. That includes a provider whose ID
matches a models.dev provider (for example `deepseek` or `groq`) and an alias
of a catalog provider set up with `canonical`. Scout leaves those alone by
default so it never floods the picker with every ID a hosted API lists.

#### Built-in local providers

Scout never probes the provider IDs `ollama`, `lmstudio`, `vllm`, and
`opencode`, even with `settings.probe` set. OpenCode 2 has its own discovery
for Ollama, LM Studio, and vLLM on their default local ports under those IDs,
and the built-in `opencode` provider hides paid models on purpose when you
have no key.

To get scout's probes for a local server, configure it under your own
provider ID, such as `my-ollama`. If that provider points at the same port as
a built-in one, its models are listed twice, once per provider. Disable the
built-in provider plugin to avoid that:

```json
{
  "plugins": ["opencode-model-scout", "-opencode.provider.ollama"]
}
```

The other built-ins are `-opencode.provider.lmstudio` and
`-opencode.provider.vllm`.

### Provider settings

| Field              | Description                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package`          | `@opencode/ai/providers/openai-compatible`. Scout also accepts `aisdk:@ai-sdk/openai-compatible` and `@ai-sdk/openai-compatible`. The package matters for auto-eligibility and for reasoning-effort variants. |
| `settings.baseURL` | Server URL, with or without a trailing `/v1`. Required.                                                                                                                                                       |
| `settings.apiKey`  | Sent as `Authorization: Bearer <key>` on discovery requests. Without it, scout uses the provider's active API-key credential from OpenCode's credential store, if there is one.                               |
| `settings.probe`   | `auto` or a probe ID from the table below.                                                                                                                                                                    |
| `headers`          | Sent with every discovery and probe request. An `Authorization` header here replaces the one built from the API key.                                                                                          |

| `settings.probe` | Effect                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `auto`           | Fingerprint the server and run the matching probe. If nothing matches, models are still listed.         |
| `actualyze`      | Actualyze probe. `atlas` is accepted as a deprecated alias.                                             |
| `ollama`         | Ollama probe; also the right choice for llama.cpp and LocalAI.                                          |
| `omlx`           | oMLX probe.                                                                                             |
| `vllm`           | vLLM probe.                                                                                             |
| `tgi`            | Text Generation Inference probe.                                                                        |
| `sglang`         | SGLang probe.                                                                                           |
| `lmstudio`       | LM Studio probe.                                                                                        |
| `koboldcpp`      | KoboldCpp probe.                                                                                        |
| anything else    | Opts the provider in, but no probe runs. `/modelscout` shows the probe as unresolved for that provider. |

### Examples

Several local servers next to each other:

```json
{
  "providers": {
    "studio-omlx": {
      "name": "oMLX",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://localhost:8000/v1",
        "apiKey": "{file:~/.config/opencode/omlx-key}",
        "probe": "omlx"
      }
    },
    "my-ollama": {
      "name": "Ollama (scout)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://gpu-box.local:11434/v1",
        "probe": "ollama"
      }
    },
    "kobold": {
      "name": "KoboldCpp",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://localhost:5001/v1"
      }
    }
  }
}
```

`studio-omlx` and `my-ollama` get their probes. `kobold` has no probe but is a
plain config provider, so its models are listed and enriched from models.dev.

A gateway that needs an extra header:

```json
{
  "providers": {
    "team-gateway": {
      "package": "@opencode/ai/providers/openai-compatible",
      "headers": { "X-Team": "research" },
      "settings": {
        "baseURL": "https://llm.example.com/v1",
        "apiKey": "{env:TEAM_GATEWAY_KEY}",
        "probe": "auto"
      }
    }
  }
}
```

### Plugin options

Pass these through the object form of the `plugins` entry.

| Option              | Description                                                                                                    | Default                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `timeoutMs`         | Time budget for one provider's discovery: model list, fingerprinting, and probe together.                      | `15000`. Values are clamped to 1000 through 60000.                            |
| `refreshIntervalMs` | How often each provider is rediscovered in the background. `0` or a negative value turns periodic refresh off. | `600000` (10 minutes). Positive values are clamped to 60000 through 86400000. |

Values that are not numbers are ignored and the default applies.

## What Scout Sets on Each Model

Scout adds the models a server lists that are not already declared for that
provider. For each one it writes:

| Field                 | Value                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                | A readable name derived from the model ID.                                                                                                                                                                                         |
| `family`              | From the probe, otherwise from a models.dev match.                                                                                                                                                                                 |
| `limit.context`       | From the probe, otherwise OpenCode's default of 200000.                                                                                                                                                                            |
| `limit.output`        | From the probe, capped at the context limit. When no source reports it, `0`, which OpenCode reads as "unknown" and sizes the output budget to the room the prompt leaves in the context window.                                    |
| `capabilities.tools`  | From the probe, including an explicit `false`; otherwise from models.dev; otherwise `true`.                                                                                                                                        |
| `capabilities.input`  | `text`, plus `image`, `pdf`, `audio`, and `video` where the probe or models.dev reports them. A model with unknown image support stays text-only.                                                                                  |
| `capabilities.output` | `["text"]`.                                                                                                                                                                                                                        |
| `variants`            | `low`, `medium`, and `high`, each setting `reasoningEffort`, for reasoning models on the openai-compatible package. Reasoning comes from the probe or from a models.dev match that has effort variants. Actualyze models get none. |
| `cost`                | Prices the probe reports, in USD per million tokens. A missing cache price becomes `0`. Without reported prices, `cost` is empty.                                                                                                  |
| `time.released`       | The Actualyze `created` time; `0` for other servers.                                                                                                                                                                               |
| `enabled`             | `false` for embedding models, which keeps them out of the picker. `/modelscout` still lists them.                                                                                                                                  |

A model counts as an embedding model when the probe says so or, without probe
data, when its ID contains `embed`. Parameter size, quantization, file size,
and temperature support have no OpenCode field; `/modelscout` shows them.

### Declared models are never modified

A model ID that already exists for the provider, because you declared it in
config or because it comes from the provider's models.dev entry, is left
exactly as it is. Scout adds the other served models around it.

```json
{
  "providers": {
    "my-ollama": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://gpu-box.local:11434/v1",
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

Here `qwen3:30b` keeps your name and limits, and every other model the server
serves is added with discovered metadata. `/modelscout` lists `qwen3:30b` with
the origin `configured`.

## Supported Servers

| Server        | Probe       | Status   | What it reports                                                                         |
| ------------- | ----------- | -------- | --------------------------------------------------------------------------------------- |
| **Actualyze** | `actualyze` | Tested   | Context, output limit, tools, reasoning, temperature, input modalities, prices, release |
| **oMLX**      | `omlx`      | Tested   | Context, output limit, model type, vision, size                                         |
| **Ollama**    | `ollama`    | Tested   | Context, tools, vision, thinking, family, parameter size, quantization, size            |
| **llama.cpp** | `ollama`    | Expected | Partial Ollama metadata                                                                 |
| **LocalAI**   | `ollama`    | Expected | Partial Ollama metadata                                                                 |
| **LM Studio** | `lmstudio`  | Untested | Context, vision, tools, family, parameter size, quantization, size                      |
| **TGI**       | `tgi`       | Untested | Context, output limit                                                                   |
| **SGLang**    | `sglang`    | Untested | Context, model type, vision, family                                                     |
| **vLLM**      | `vllm`      | Untested | Context                                                                                 |
| **KoboldCpp** | `koboldcpp` | Untested | Context, vision                                                                         |

A Tested probe has been verified against a live instance. An Expected server
is API-compatible according to its source code but has not been run against a
live instance. An Untested probe was written from the server's API
documentation, and reports from people running those servers are welcome.

With `"probe": "auto"`, scout identifies the server in this order:

1. Any model entry whose `owned_by` is exactly `actualyze` (or `atlas`, from
   older deployments) selects the Actualyze probe.
2. Every entry reporting the same known owner selects that server: `omlx`,
   `vllm`, `sglang`, `llamacpp`, `koboldcpp`, or `library` for Ollama.
3. Entries with `aliases`, `tags`, or `status` fields point to llama.cpp.
4. `GET /info` with a `router` field means TGI; `GET /api/v1/models` with
   `key` and `type` fields means LM Studio.

An Ollama server whose models do not all report the owner `library` is not
detected. Set `"probe": "ollama"` for it.

## Actualyze

Actualyze serves its model catalog through an OpenAI-compatible endpoint, and
each `/v1/models` entry carries the platform's full metadata. A provider for
it looks like this:

```json
{
  "providers": {
    "actualyze": {
      "name": "Actualyze",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://actualyze.example.com/openai/v1",
        "apiKey": "{env:ACTUALYZE_API_KEY}",
        "probe": "auto"
      }
    }
  }
}
```

Remember that `{env:ACTUALYZE_API_KEY}` reads the background service's
environment (see
[The background service](#the-background-service-and-environment-variables)).

- **Detection.** In auto mode, one entry with `owned_by` set exactly to
  `actualyze` or `atlas` is enough to select the probe, even in a catalog
  that mixes owners. The probe then reads only the Actualyze-owned entries;
  the rest are listed and enriched from models.dev as usual. With
  `"probe": "actualyze"` every listed model is treated as an Actualyze model.
  `"probe": "atlas"` still works as a deprecated alias.
- **List first.** The probe reads metadata straight from the `/v1/models`
  entries. It requests `GET /v1/models/{id}` only for owned entries that lack
  the full metadata, which happens on older deployments.
- **Fields.** `context_window` and `max_output_tokens` become the limits.
  Capability flags (`vision`, `tool_use`, `thinking`, `thinking_adaptive`,
  `temperature`, `document`, `audio`, `video`) are three-valued: `true` and
  `false` are definitive, `null` means unknown. `modalities.input` is used
  for input modalities when present. `created` becomes the release time.
- **Cost.** `cost.input`, `cost.output`, `cost.cache_read`, and
  `cost.cache_write` are USD per million tokens. OpenCode's `cost` records a
  missing cache price as `0`, and `/modelscout` shows it as unknown. A model
  without `cost` gets no prices.
- **No effort variants.** Actualyze's chat endpoint does not pass
  `reasoning_effort` on to the upstream model, so reasoning models from
  Actualyze get no `low`/`medium`/`high` variants.

## `/modelscout` Command

Type `/modelscout`, or pick **Model Scout** from the command palette. It opens
a browser of every discovered provider and model without sending anything to
a model.

The list groups models under their provider. Each provider header shows the
model count (as `visible/total` while search or filters hide some), how many
models have complete core metadata, and the latest discovery status. Press
`enter` on a model to see its metadata, or on a provider header to see that
provider's discovery details. `backspace` returns to the list with search,
filters, and selection unchanged.

| Key               | Action                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `↑` / `↓`         | Move through the list, or scroll the details                                                                  |
| `enter`           | Open details; from the search box, move to the results                                                        |
| `/`               | Focus the search box (from details, return to the list first)                                                 |
| `backspace`       | Return from details to the list                                                                               |
| `p`               | Cycle the provider filter (only with more than one provider)                                                  |
| `t`               | Cycle the model type filter                                                                                   |
| `c`               | Cycle the capability filter                                                                                   |
| `s`               | Cycle the capability evidence state filter                                                                    |
| `m`               | Cycle complete or missing core metadata                                                                       |
| `o`               | Cycle discovered or configured origin (only when the server's discovery data is available)                    |
| `r`               | Reset all filters                                                                                             |
| `R` (`Shift`+`r`) | Ask the server to rediscover every provider; a provider whose discovery started under a minute ago is skipped |
| `esc`             | Close the browser                                                                                             |

While the search box has focus, letters go to the search; press `enter` or an
arrow key to get back to the list and its shortcuts. The footer lists only the
keys that work in the current view.

### What the details show

Each known value carries a source label:

| Label          | Source                                       |
| -------------- | -------------------------------------------- |
| `probe`        | The server's probe                           |
| `config`       | Your configuration or the models.dev entry   |
| `server`       | The server's model list                      |
| `models.dev`   | A models.dev match                           |
| `heuristic`    | Inferred from the model ID                   |
| `default`      | Scout's default, such as text input          |
| `host default` | OpenCode's default value, not an observation |
| `host`         | OpenCode's model list without discovery data |

Capabilities and input modalities show one of three states: `supported`,
`unsupported` (a source said no), or `unknown` (nothing reported, which is
common). Model details also cover prices, type, limits, size, family,
parameter count, quantization, and which core fields are missing.

Provider details show the model-list result, the probe attempt, the probe
that was configured and the one that ran, the time of the last good
inventory, the latest failure if any, and the endpoint origin. Endpoint
origins never include credentials, paths, or query strings.

The browser updates in place when a discovery run completes or OpenCode's
model catalog changes.

### When the server half is unavailable

- If `/modelscout` cannot reach the server half, or the request times out, it
  shows OpenCode's own model list with a notice such as
  `host state only: server plugin unavailable`. Origin filtering, failure
  details, and probe-only metadata are missing in that mode.
- If the server half fails to load, OpenCode does not load the TUI half
  either, so `/modelscout` does not appear.
- If the interactive browser cannot be built, the command shows a plain,
  scrollable list of the same models and reports the error in a toast.

## Caching and Refresh

- **Stored inventories.** Each successful discovery is saved in OpenCode's
  plugin storage, keyed by a hash of the provider ID, normalized base URL,
  probe selection, API key, and headers. For a provider without
  `settings.apiKey`, the key also covers the credential scout used from
  OpenCode's credential store, or its absence. The stored data holds model
  IDs and metadata, never keys or headers. Scout keeps the 128 most recent
  entries.
- **Startup.** Stored inventories for providers with `settings.apiKey` are
  served as soon as the plugin loads. Other providers get their stored
  models once scout has looked up the credential that project uses and
  found the one the inventory was discovered with.
- **Background refresh.** Scout rediscovers when the plugin loads, when
  configuration, providers, plugins, integrations, or credentials change, on
  the `refreshIntervalMs` schedule, and on `R` in `/modelscout`. Discovery for
  one provider starts at most once a minute. Projects open at the same time
  share one discovery run per identical provider and credential.
- **Failures.** A failed run keeps the last good inventory. `/modelscout`
  shows the failure next to it.
- **Settings edits.** Changing only `settings.probe` keeps the current models
  until the new discovery lands. Changing `baseURL`, the API key, or headers
  removes that provider's discovered models until rediscovery finishes.
- **Account switches.** When the active account for a provider changes, for
  example with `opencode auth switch`, its discovered models are removed at
  once and replaced by the inventory for the new credential, which scout
  discovers unless it already holds a fresh one. Models from one account
  never show under another.

## Troubleshooting

- **A provider is not discovered.** Check the rules in
  [Which providers are discovered](#which-providers-are-discovered). Adding
  `"probe": "auto"` to its `settings` is the reliable opt-in, except for the
  IDs `ollama`, `lmstudio`, `vllm`, and `opencode`, which are never probed.
- **The API key is empty.** `{env:...}` resolves in the background service.
  Set the variable with `opencode service set env` and restart the service, or
  use `{file:...}`.
- **Models are listed twice.** A scout provider and a built-in local provider
  point at the same server. Disable the built-in one with
  `-opencode.provider.<name>` in `plugins`.
- **The output limit is 0.** No source reported one. OpenCode treats `0` as
  unknown and sizes the output to the remaining context.

## Using OpenCode 1

Version 2 of this plugin does not load in OpenCode 1, and an unpinned install
on OpenCode 1 picks up version 2 and fails. Pin the last 1.x release instead:

```bash
opencode plugin opencode-model-scout@1.6.0
```

Or add it by hand to both config files, `opencode.json`:

```json
{
  "plugin": ["opencode-model-scout@1.6.0"]
}
```

and `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-model-scout@1.6.0"]
}
```

Version 1.6.0 predates support for the `actualyze` model owner, so Actualyze
users on OpenCode 1 should install `opencode-actualyze@1.7.0` instead. The
1.x documentation is on the
[`v1.6.0` tag](https://github.com/rmk40/opencode-model-scout/tree/v1.6.0#readme).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture, the test lanes
and live harness, and how to add a probe.

## License

MIT
