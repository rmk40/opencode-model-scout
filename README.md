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

Version 2 is for OpenCode 2 and is tested against OpenCode 2.0.32. If you are
still on OpenCode 1, see [Using OpenCode 1](#using-opencode-1).

## Quick Start

### With Actualyze

Actualyze needs no provider config. The plugin adds an `actualyze` provider
for `https://app.actualyze.ai/openai/v1`, and it appears as soon as OpenCode
has your API key.

1. Install the plugin:

   ```bash
   opencode plugin add opencode-model-scout
   ```

2. Add your Actualyze API key in one of these ways:
   - In the TUI, run `/actualyze`, press `k`, and paste the key. You can also
     run `/connect` and pick **Actualyze**.
   - From a shell, run `opencode auth login actualyze`.
   - Set `ACTUALYZE_API_KEY` on the background service and restart it:

     ```bash
     opencode service set env ACTUALYZE_API_KEY <key>
     opencode service restart
     ```

     The service does not see variables exported in your shell (see
     [The background service](#the-background-service-and-environment-variables)).

3. The Actualyze models appear in the model picker once discovery finishes.
   `/actualyze` shows whether the catalog answered for your key and, if it
   did not, what to do next. See [Actualyze](#actualyze) for other
   environments and details.

### With another OpenAI-compatible server

1. Install the plugin as above.

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
service and does the discovery. The TUI half adds two commands:
[`/modelscout`](#modelscout-command), a browser of every discovered model,
and [`/actualyze`](#actualyze-command), which connects an Actualyze key and
explains the state of its catalog.

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
add for `/modelscout` and `/actualyze`.

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
| `settings.apiKey`  | Sent as `Authorization: Bearer <key>` on discovery requests when the provider has no connected key. A key connected in OpenCode (stored or from the environment) takes precedence, as it does for chat.       |
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
| `enabled`             | `false` for embedding models, which keeps them out of the picker. `/modelscout` lists them when its type filter includes embeddings.                                                                                               |

A model counts as an embedding model when the probe says so or, without probe
data, when its ID contains `embed`. Scout does not set parameter size,
quantization, file size, or temperature support on the model;
`/modelscout` shows them in its details.

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
serves is added with discovered metadata. In `/modelscout`, the Evidence
screen for `qwen3:30b` gives its origin as declared in your config.

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
each `/v1/models` entry carries the platform's full metadata.

### The built-in provider

Scout adds this provider to OpenCode's catalog:

| Field              | Value                                      |
| ------------------ | ------------------------------------------ |
| ID                 | `actualyze`                                |
| Name               | Actualyze                                  |
| `package`          | `@opencode/ai/providers/openai-compatible` |
| `settings.baseURL` | `https://app.actualyze.ai/openai/v1`       |
| `settings.probe`   | `actualyze`                                |

It also registers an Actualyze integration, which is what `/connect` and
`opencode auth login actualyze` offer. The integration takes a stored API key
or the `ACTUALYZE_API_KEY` environment variable of the background service.
Discovery and chat both use that key. The integration's ID is `actualyze`,
the same as the provider's, so a `providers.actualyze` config entry and
`opencode auth login actualyze` both reach the integration the provider reads
its key from.

Until the integration has a key, OpenCode hides the provider, so installing
the plugin without Actualyze changes nothing in the model picker.

### Another Actualyze environment

To use a different deployment, set only its base URL. Your config is merged
over the built-in provider field by field, so the name, package, probe, and
key handling stay as they are:

```json
{
  "providers": {
    "actualyze": {
      "settings": {
        "baseURL": "https://actualyze.example.com/openai/v1"
      }
    }
  }
}
```

Any `providers.actualyze` entry in your config makes OpenCode list the
provider even without a key. Discovery then runs without credentials, and
`/modelscout` and `/actualyze` show the endpoint's error until you add one.
Add the key with `/actualyze`, `/connect`, or `opencode auth login actualyze`
as usual: the entry does not create a second Actualyze integration. A `settings.apiKey` in the entry also
works, without connecting the integration. A connected key takes precedence
over `settings.apiKey` for both discovery and chat, so the two always use the
same key.

If a models.dev catalog or another plugin already defines an `actualyze`
provider, scout leaves that provider as it is and does not add its own. When
an `actualyze` integration also exists, as a catalog registers one with its
provider, scout does not register its own, so `/connect` lists Actualyze once.
Otherwise scout still registers the `actualyze` integration. A provider that
another plugin defined with `"activation": "auto"` and no integration of its
own then depends on that integration: OpenCode hides it until a key is
connected there. Scout does not discover such a provider by default, because
its ID is one OpenCode already knows; add `"probe": "actualyze"` to its
`settings` in your config to opt in.

### How the probe reads Actualyze

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
a browser of the models scout's providers serve, without sending anything to
a model. The dialog appears at once and fills in when OpenCode's model lists
and scout's discovery catalog arrive. It updates in place when a discovery
run starts or settles and when OpenCode's model catalog changes.

The list covers every provider scout discovers, plus any OpenCode provider
that looks like a discovery target: one with `settings.baseURL` and either
`settings.probe` or the openai-compatible package. Providers are sorted by
name, and models within each provider by name until you change the sort.

### Reading the list

```
 ▾ Actualyze                             4 models  ● ready
   Claude Haiku 4.5           200K  T I R            $1/$5
 ● Claude Sonnet 4.5          200K  T I R           $3/$15
   GPT OSS 120B               131K  T · R      $0.15/$0.60
   Mock Tiered Pro            400K  T I R           $3/$15+
 ▾ Studio oMLX                           2 models  ● ready
   Gemma 3 12B               ~200K  · I ·
   Qwen3 Coder 30B            262K  t · ·
 ▸ Team gateway                   3 models  ▲ key rejected
```

- **Provider headers** show the model count, as `visible/total` while search
  or filters hide some, and the discovery status: `● ready`, `○ checking`
  while discovery runs, `○ resolving` while scout looks up which key to use,
  `○ waiting` until discovery has a result for the current key, or a failure
  such as `▲ key rejected`, `▲ rate limited`, or `▲ unreachable`. A failing
  provider keeps the models from its last good discovery.
- **`●`** before a model name marks the model the prompt uses now. A colored
  band marks the selected row; while the search box has focus, a `▌` marks
  it instead.
- **Context** is the context window. `~200K`, dimmed, means no source
  reported one and OpenCode uses its default of 200,000 tokens.
- **`T I R`** stand for tool calls, image input, and reasoning. An uppercase
  letter is reported by the server, your config, or OpenCode. A lowercase
  letter is assumed from an OpenCode default or inferred from models.dev or
  the model name. `·` means not reported or not supported.
- **Prices** are USD per million tokens, input/output, and `?` marks an
  unknown side. When one side shows cents, so does the other. A trailing `+`
  means the price rises above a context size; the details list every tier.

The title line counts providers and models and says how many providers need
attention. Embedding models are hidden by default, and the filter line says
how many, for example `1 embedding hidden`.

At 120 columns and wider, a preview of the selected row's details sits
beside the list. The preview does not scroll: when it is cut off, its last
line reads `↓ N more · i`. In a narrower terminal, a one-line summary of the
selected model sits under the list instead (facts that do not fit are
counted as `+N`). At any width, `i` opens the details on their own screen,
across the whole dialog. Details and the key list that run longer than the
dialog scroll (the key list by whole entries), with `↑ N more` and
`↓ N more` at the edges. Resizing the terminal switches between the two layouts without
closing the dialog. The dialog takes at most `rows - 4` rows, so it leaves
room above and below it.

The first open selects the prompt's current model, or the first chat model
when the current one is not listed. Search, filters, sort, collapsed
providers, and the selection are kept for each project and command until the
TUI exits.

### Keys

| Key                                | Action                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `↑` `↓` `pgup` `pgdn` `home` `end` | Move through the list, or scroll the details                                                                                                                 |
| `enter` / `m`                      | Open OpenCode's model picker with the selected model highlighted (see [Choosing a model](#choosing-a-model)); `enter` on a provider header opens its details |
| `i`                                | Open the details of the selected model or provider across the whole dialog                                                                                   |
| `backspace`                        | Go back from details, Evidence, the filter screen, or the key list                                                                                           |
| `←` / `→`                          | Collapse or expand the selected provider                                                                                                                     |
| `/`                                | Search; `enter` or `↓` returns to the list                                                                                                                   |
| `f`                                | Open the filter screen                                                                                                                                       |
| `x`                                | Clear search and filters                                                                                                                                     |
| `s`                                | Change the sort order                                                                                                                                        |
| `d`                                | Open [Evidence](#evidence) for the selected model or provider                                                                                                |
| `y`                                | Copy `provider/model`; on a provider header, the provider ID                                                                                                 |
| `Y` (`Shift`+`y`)                  | Copy the raw model ID                                                                                                                                        |
| `r`                                | Refresh the selected provider's discovery                                                                                                                    |
| `R` (`Shift`+`r`)                  | Refresh every provider                                                                                                                                       |
| `a`                                | Open [`/actualyze`](#actualyze-command)                                                                                                                      |
| `?`                                | List the keys of the current view; `backspace` or `?` returns                                                                                                |
| `esc`                              | Close the browser                                                                                                                                            |

`f`, `x`, `s`, `←`, and `→` work in the list. The other keys also work in the
details, where `i` and `←` go back like `backspace`. Evidence takes the
movement keys, `y`, `Y`, `/`, `?`, and `backspace`.
While the search box has focus, every key you type goes into the search.
Keys held with `ctrl`, `alt`, or `cmd` always go to OpenCode.

The footer shows the keys of the current view and dims the ones that do not
apply to the selection. In a narrow dialog it drops hints from the right,
but `keys ?` and `close esc` always stay.

### Search, filters, and sort

Search ignores case, and every word you type must appear in the model's
name or ID, the provider's name or ID, the family, or the quantization:
`qwen q4` finds Qwen models with a Q4 quantization. Collapsed providers open
while a search is active.

`f` opens the filter screen. Filters apply as you change them: `↑` and `↓`
choose a filter, `←`, `→`, `enter`, or `space` change it, `x` clears
everything, and `backspace` or `f` returns to the list.

| Filter                                     | Effect                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Provider                                   | All providers, or one                                                                                                                    |
| Type                                       | Chat (the default), Embedding, or All types                                                                                              |
| Needs tools, Needs images, Needs reasoning | Only models with that capability                                                                                                         |
| Priced only                                | Only models with a known input or output price                                                                                           |
| Include assumed or inferred                | Let assumed and inferred capabilities (the lowercase letters) satisfy the needs filters. Off by default, so only reported support counts |

`s` cycles the sort through name, context (largest first), input price, and
output price (lowest first). Models without a value sort last, and an assumed
`~200K` context counts as no value.

### Details

Model details give the limits, the prices per million tokens (with cache
prices and every context tier), and the capabilities, grouped as supported,
assumed, inferred, not supported, and not reported. Then come the provider
and its endpoint, the family, parameter count, quantization, and size. A
value no source reported says so in words: "Not reported; OpenCode uses
200,000" for the context, and "Not reported; OpenCode fits output to the
remaining context" for the output limit.

Provider details give the discovery status and when it was last checked,
and after a failure what went wrong and what to do about it. They also show
the server type (the probe, or that it was detected automatically), the
number of chat and embedding models, how many models your config declares
and scout leaves unchanged, which key discovery uses (a connected key,
`settings.apiKey`, the provider's headers, or none), and when `r` can run
again.

### Evidence

`d` shows where each value comes from. For a model it is a table of every
field with its value and source, followed by the model's origin (discovered
by scout, declared in your config, or known to OpenCode only), the
configured and resolved probe, the endpoint origin, and any conflicts
between sources. For a provider it lists the model-list and probe attempts,
the probe, the endpoint, the key source, the last good and last attempted
discovery, the next allowed refresh, and the latest failure with its HTTP
status and retry time.

| Source             | Meaning                                                 |
| ------------------ | ------------------------------------------------------- |
| `probe`            | The server's probe                                      |
| `your config`      | Your config, or the provider's models.dev entry         |
| `server list`      | The server's model list                                 |
| `models.dev`       | A models.dev match                                      |
| `heuristic`        | Inferred from the model ID                              |
| `scout default`    | Scout's default, such as text input                     |
| `OpenCode default` | OpenCode's default value, not an observation            |
| `OpenCode`         | OpenCode's model list, for a provider without discovery |

Endpoint origins never include credentials, paths, or query strings.

### Choosing a model

`enter` on a model, or `m`, opens OpenCode's model picker in place of the
browser with its search filled in, so the model is the highlighted first
result. Press `enter` again to select it; for a model with effort variants,
OpenCode may then ask which one. The choice happens in the picker because
plugins cannot set the prompt's model.

The search is the provider's name and the model's name as the picker shows
them, for example `Actualyze GPT OSS 120B`. The picker matches provider names
only while at least one integration has a connection, so without one the
search is the model's name alone. If the picker's search field
does not appear within a second, or you press a key before scout fills it
in, the picker stays open without a search, as it would from `/models`.

`enter` and `m` are unavailable for embedding models, for a model OpenCode
does not list yet, for a deprecated model, which the picker leaves out, and
for a model hidden from the picker; the details say which applies. On a
provider header, `enter` opens the provider's details.

The picker orders its results, so check the highlighted row before you press
`enter`:

- A favorite, or a model whose input price is zero, that also matches every
  word of the search is listed first.
- Without a connected integration, a model with the same name from another
  provider also matches and can come first.
- A model whose name contains the provider's name and the model's name, such
  as `vLLM Llama 3.1 8B` from another provider when you chose `Llama 3.1 8B`
  from `vLLM`, can come first.
- With OpenCode's experimental new designs and no connected integration, the
  picker lists only free models, so the search finds nothing else.

### Copying

`y` copies `provider/model`, the form `opencode run --model` takes, and `Y`
copies the raw model ID. The text goes to the terminal through the OSC 52
escape sequence, and the notice line says `Copy sent to terminal`. Terminals
do not confirm OSC 52, and some ignore it or need it turned on. When OpenCode
reports that the terminal does not support OSC 52, the browser shows the text
in full under the notice for 30 seconds instead, so you can select it.

### Refreshing

`r` asks scout's server half to rediscover the selected provider, and `R`
every provider. Discovery for one provider and key starts at most once a
minute, and never before a time the server asked for with `Retry-After` or
`X-RateLimit-Reset` (at most one hour ahead). A refresh inside that window
is skipped with a countdown, for example
`Refresh skipped: Actualyze was checked recently. Try again in 42 s.`, and
the provider's details show the same wait.

### Other states

- **Loading.** The dialog says it is reading models from OpenCode and scout.
- **OpenCode's lists did not load.** The error is shown, and `r` reads them
  again.
- **No providers.** A card explains how to connect Actualyze (`a`) or add
  another OpenAI-compatible server.
- **No matches.** `x` clears search and filters, and `f` changes the
  filters.
- **A provider without models.** A note under its header says whether
  discovery is still checking, the model list failed, the server returned no
  models (`r` refreshes), or only hidden embedding models matched.
- **Scout's server half does not answer.** If the catalog request fails or
  times out after 3 seconds, the browser shows OpenCode's own model list
  with a notice such as
  `▲ Discovery details unavailable: scout's server half did not answer.`
  Discovery status, failure details, evidence sources, and refresh are
  missing in that mode.
- **The server half fails to load.** OpenCode does not load the TUI half
  either, so neither command appears.
- **The browser cannot be built.** The command shows a plain, scrollable list
  of the same models and reports the error in a toast.

## `/actualyze` Command

`/actualyze` takes you from no key to a working Actualyze catalog without
leaving OpenCode. Open it with `/actualyze`, pick **Actualyze** from the
command palette, or press `a` in `/modelscout`.

The header shows the Actualyze wordmark and the endpoint's host,
`app.actualyze.ai` for the built-in provider. When
`providers.actualyze.settings.baseURL` points anywhere else, the header adds
a `custom endpoint` badge, and every app link uses that endpoint's origin.
The line under the header says where things stand, and names the key in
use: the connection's label in quotes, `ACTUALYZE_API_KEY` for the
environment variable, or `settings.apiKey`.

An Actualyze inference key can read the model catalog and nothing about the
account: no identity, usage, spend, or budget. So `/actualyze` reports
"Catalog accessible" when the model list answered for the key, and never
claims that chat works. A read-only key, for example, lists models and is
refused on every chat request.

### States

| Status line                                                         | What it means                                                                                                                            | What to do                                                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `○ Not connected`                                                   | OpenCode has no Actualyze key.                                                                                                           | Create a key in the app, then press `k` and paste it. The card lists the steps.                                                          |
| `○ Saving key…`                                                     | You submitted a key and OpenCode has not confirmed it yet.                                                                               | Wait. Closing the dialog does not undo a completed save.                                                                                 |
| `▲ Save not confirmed`                                              | Saving failed or took longer than 15 seconds. OpenCode may have stored the key anyway.                                                   | Check with `c` before trying again with `k`.                                                                                             |
| `○ Checking the current connection…`                                | The key is saved and scout has no result for it yet. After 20 seconds the line reads "Still checking the current connection…".           | Wait. No inference request is sent.                                                                                                      |
| `○ Checking the connection…`                                        | A key is connected and scout is still resolving it.                                                                                      | Wait.                                                                                                                                    |
| `○ Loading models…`                                                 | The first model list for this key is on its way.                                                                                         | Wait.                                                                                                                                    |
| `● Catalog accessible · key "Work" · 11 models · checked 2 min ago` | The model list answered. The count is chat models, as in `/modelscout`; the filter row reports hidden embeddings.                        | Browse them; `enter` on a model opens the model picker with it highlighted.                                                              |
| `▲ No models for this key`                                          | The catalog answered with an empty list: the key works, but its team has no model access yet.                                            | Ask a workspace admin. `y` copies the Catalog link.                                                                                      |
| `▲ Key rejected (401)`                                              | Actualyze answers this way for a revoked or expired key, a key without the inference scope, or a key from another Actualyze environment. | `k` for another key, `y` to copy the API Keys link, `c` for connections.                                                                 |
| `▲ Access denied (403)`                                             | Actualyze refused the model list request for this key.                                                                                   | Check the key's permissions and model access with your administrator, or use `k` for another key.                                        |
| `▲ Budget or entitlement blocked (402)`                             | Actualyze did not allow the model list request. The key cannot read a balance or reset date.                                             | `y` copies the Budgets link; that page may need an admin role.                                                                           |
| `▲ Catalog rate limited (429)`                                      | The model list is rate limited. This is a catalog limit, not an inference quota. The footer shows the wait: `retry (42 s) r`.            | Retry with `r` once the wait ends; otherwise Model Scout checks again on its next scheduled refresh, or when settings or the key change. |
| `▲ Could not reach the endpoint`                                    | The connection failed. The header shows the endpoint.                                                                                    | Check the network, VPN, proxy, and `providers.actualyze.settings.baseURL`, then retry with `r`.                                          |
| `▲ Endpoint did not answer in time`                                 | The model list request timed out.                                                                                                        | Check the network or the endpoint, then retry with `r`.                                                                                  |
| `▲ Actualyze server error (503)`                                    | Actualyze failed to list its models.                                                                                                     | Retry with `r`.                                                                                                                          |
| `▲ No model list at this endpoint (404)`                            | The base URL points at the wrong path.                                                                                                   | Make `settings.baseURL` end in `/openai/v1`.                                                                                             |
| `▲ Unexpected answer (…)`                                           | Another HTTP status, or an answer that is not a model list.                                                                              | Check `settings.baseURL`.                                                                                                                |
| `▲ Discovery was interrupted` or `▲ Discovery failed`               | The check did not finish.                                                                                                                | It runs again on the next refresh; `r` retries now.                                                                                      |
| `▲ Discovery status unavailable`                                    | Scout's server half did not answer, so only the connection OpenCode reports is known.                                                    | `k` and `c` still work; `r` reads the catalog again.                                                                                     |
| `○ Not managed by Model Scout`                                      | Another plugin or a models.dev catalog defines the `actualyze` provider, so scout does not discover it.                                  | Add `"probe": "actualyze"` to `providers.actualyze.settings` to opt in.                                                                  |

The glyph carries the state's color; the words stay in the theme's text
color. When the line is too narrow, the age goes first and then the key
label, whole, so the line never ends in a cut word. Each card under the
status line starts with a title and gives the details below it.

After a failure, a key that had a good catalog before keeps it: the card sits
above the models from the last good check. When the key comes from
`settings.apiKey` or `ACTUALYZE_API_KEY`, the failure card says so, and adds
that a key connected with `k` takes precedence. When the provider's `headers` carry
the key (`Authorization` or `X-Actualyze-Api-Key`), a notice says that
discovery uses those headers, not the connected key.

### Keys in `/actualyze`

| Key   | Action                                                                              |
| ----- | ----------------------------------------------------------------------------------- |
| `k`   | Connect a key: "connect key" without a connection, "another key" with one           |
| `c`   | Open OpenCode's connections; pick Actualyze there to switch, rename, or remove keys |
| `l`   | Open the [links screen](#links)                                                     |
| `y`   | On a card, copy the link it names; in the model list, copy `provider/model`         |
| `r`   | Check the catalog again; during a wait the hint is dimmed and reads "retry (N s)"   |
| `b`   | Open `/modelscout`                                                                  |
| `?`   | List the keys                                                                       |
| `esc` | Close                                                                               |

While a card fills the dialog, only the keys it offers, `?`, and `esc` work.
The footer lists the card's keys in one order: the key action, retry, copy
link, links, connections, all providers, then keys. When the footer runs out
of room it leaves out the hints that do not fit and keeps any later one that
does; the card then lists the left-out keys in an action line at its end, in
the same order, so every key shows once. `?` lists them all. A card longer
than the dialog shows `↓ N more` and scrolls with `↑`, `↓`, `pgup`, `pgdn`,
`home`, and `end`; the footer adds `scroll ↑↓` after the card's keys when
there is room for all of them.

Once the catalog is accessible, the model list works like `/modelscout`
limited to Actualyze, without a provider header or provider filter. `r`
refreshes Actualyze; there is no `R`. The footer shows `k` and `l` when
there is room, and `?` lists `k`, `l`, `c`, and `b`.

`k` works only when the provider reads its key from the `actualyze`
integration and that integration offers a plain key method. Otherwise the
card points to `c`. Model Scout never deletes a key; removing one happens in
OpenCode's connections.

### Entering a key

`k` opens OpenCode's prompt titled **Actualyze API key**. The key is visible
while you type, because OpenCode's prompt does not mask input. Press `enter`
to submit. Model Scout trims the key, hands it once to OpenCode to store
under the Actualyze integration, and drops it; it never stores, logs, or
shows the key itself. `/actualyze` then comes back, shows "Saving key…",
and checks the catalog with the new key.

Pressing `esc` in the prompt cancels and closes `/actualyze`. Submitting an
empty prompt returns to `/actualyze` unchanged. If Model Scout reloads while
the prompt is open, the prompt closes and nothing is saved; enter the key
again with `/actualyze`. A key submitted after Model Scout reloaded, or after
the project changed, is not saved either, and a toast says so. If you close
`/actualyze` while OpenCode is still saving and the save is never confirmed,
a toast says "OpenCode did not confirm the Actualyze key was saved".

### Links

`l` lists Actualyze app pages on the provider's origin:

| Link            | Path                                 |
| --------------- | ------------------------------------ |
| API Keys        | `/account/settings?tab=security`     |
| Catalog         | `/control/catalog?tab=consume`       |
| Budgets         | `/management/budgets`                |
| Usage           | `/observability?tab=inference`       |
| Troubleshooting | `/observability?tab=troubleshooting` |

`↑`, `↓`, `home`, and `end` choose a link, `enter` or `y` copies it the same
way `/modelscout` copies (see [Copying](#copying)), and `backspace` or `l`
returns. After a failure the matching link is selected first: API Keys for
401 and 403, Budgets for 402, and Troubleshooting for the rest. Budgets may
need an admin role in Actualyze. Model Scout cannot open a browser, so copy
the link and paste it into one. When `settings.baseURL` is not an http or
https URL, there are no links, and the header says so.

## Caching and Refresh

- **Stored inventories.** Each successful discovery is saved in OpenCode's
  plugin storage, keyed by a hash of the provider ID, normalized base URL,
  probe selection, API key, and headers. Unless discovery used
  `settings.apiKey`, the key also covers the connected key scout used, or
  its absence. The stored data holds model IDs and metadata, never keys or
  headers. Scout keeps the 128 most recent entries.
- **Startup.** A provider gets its stored models once scout has looked up
  the key that project uses (the connected key, else `settings.apiKey`) and
  found the inventory discovered with it. That lookup runs right after the
  plugin loads and makes no network request.
- **Background refresh.** Scout rediscovers when the plugin loads, when
  configuration, providers, plugins, integrations, or credentials change, on
  the `refreshIntervalMs` schedule, and on `r` or `R` in `/modelscout` and
  `r` in `/actualyze`. Discovery for one provider and credential starts at
  most once a minute. Projects open at the same time share one discovery run
  per identical provider and credential.
- **Retry times.** When the model list answers 429 or 503 with
  `Retry-After`, or 429 with `X-RateLimit-Reset`, no discovery with that
  credential starts before that time, at most one hour ahead. Another key
  for the same provider is not held back. A successful run clears the wait.
- **Failures.** A failed run keeps the last good inventory. `/modelscout` and
  `/actualyze` show the failure next to it.
- **Settings edits.** Changing only `settings.probe` keeps the current models
  until the new discovery lands. Changing `baseURL`, the API key, or headers
  removes that provider's discovered models until rediscovery finishes.
- **Account switches.** When the active account for a provider changes, for
  example with `opencode auth switch`, its discovered models are removed at
  once and replaced by the inventory for the new credential, which scout
  discovers unless it already holds a fresh one. Models from one account
  never show under another.

## Troubleshooting

- **Actualyze is not in the model picker.** The built-in provider stays
  hidden until it has a key. Run `/actualyze`: it says whether a key is
  connected and whether the catalog answered for it, and `k` connects one.
  `/connect` with **Actualyze**, or `ACTUALYZE_API_KEY` on the background
  service followed by a restart, work too.
- **Copy does nothing.** `y` sends text through OSC 52, which some terminals
  ignore or keep turned off; inside tmux it needs `set-clipboard on`. Select
  the text on screen instead, or turn on clipboard access in the terminal.
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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture, the test lanes,
the live harness and TUI scenarios, and how to add a probe.

## License

MIT
