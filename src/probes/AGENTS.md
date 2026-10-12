# Probe-Specific Learnings

## Writing Probes

- Leave a value undefined when the server does not report it. Return `false`
  only for an authoritative boolean from the server: discovery treats it as
  final and it overrides models.dev (`toolCall: false` emits
  `capabilities.tools: false`, `vision: false` keeps image out of the input
  list, `reasoning: false` suppresses effort variants). `temperature` has no
  `Model.Info` field and only appears as evidence in `/modelscout`.
- Missing or wrong-type values stay unknown. `sanitizeProbeMeta()` in
  `src/discover.ts` drops anything of the wrong type, and probe metadata is
  applied only to IDs the server listed.
- `EMPTY_RESULT` is `Object.freeze()`d. Never mutate after returning it.
- **Never write to stdout/stderr** (no `console.*`). Probes run inside OpenCode's shared background service; any output leaks into its logs. Failures degrade silently (return `EMPTY_RESULT`).
- **Never read a body with raw `res.json()`/`res.text()`.** Use `readJson()`/`readBody()` from `./util`. They bound the body read with a timeout and cancel the stream. A raw read has no timeout and can hang forever if a server sends headers then stalls the body.
- `probeFetch()` returns `Response | undefined`. It does NOT check `res.ok`, so callers split: `if (!res) return EMPTY_RESULT; if (!res.ok) return EMPTY_RESULT;` then read via `readJson()`.
- Build request headers with `buildHeaders(apiKey, context?.headers)`. It sets `Authorization: Bearer <apiKey>` first and applies provider headers on top, matching names case-insensitively, so an explicit provider `Authorization` wins. Every probe request must carry these headers.
- `buildHeaders()` does NOT include Content-Type. Add it with `setHeader()` when needed (e.g., Ollama POST needs `Content-Type: application/json`, but GET does not); a plain spread would leave a provider `content-type` beside it.
- `ProbeContext.signal` carries the discovery abort signal, which fires on
  the per-provider `timeoutMs` budget or when the job is cancelled. New
  probes and probes that add external I/O should pass it to `probeFetch`.
  Actualyze does this; the other probes rely on `probeFetch` and body-read
  timeouts.
- Keep the outer try-catch around every probe: parsing can still throw on malformed bodies.

## Server Quirks

- `owned_by` is optional (`owned_by?: string`). Some servers omit it entirely. Missing is not a positive signal for any server.
- Actualyze is the Tier 1 mixed-catalog exception: any exact `owned_by` of
  `"actualyze"` or the older `"atlas"` selects the Actualyze probe. Auto mode
  inspects only that owner subset; explicit mode inspects every safe ID. The
  fingerprint and the probe share `isActualyzeOwner()`, which is exact and
  case-sensitive.
- Actualyze list entries carry the full advertisement (limits, tri-state
  capabilities, `modalities`, `cost`). An owned entry with the
  `context_window` key and a `capabilities` object is read from the list;
  only entries failing that check get a `GET /v1/models/{id}`. A missing
  `cost` or cache price means unknown and never triggers a detail request.
- Actualyze capability flags are tri-state: `null` is unknown, `false` is
  authoritative. `modalities.input` wins over the flags for input; without
  it, input modalities are derived only when `vision`, `document`, `audio`,
  and `video` are all booleans.
- KoboldCpp `jinja: true` does NOT mean tool calling support. Do not infer `toolCall` from Jinja.
- `llamacpp` and `localai` both map to the `ollama` probe via `PROBE_MAP`, because llama.cpp implements Ollama-compatible API endpoints.

## Fingerprinting

- Tier 1 (modelsResponse inspection) makes zero HTTP calls and has no timer.
- Non-Actualyze `owned_by` fingerprints require unanimous ownership. Check the
  exact Actualyze exception before that rule and before llama.cpp field
  detection.
- The `globalTimeout` timer is created after Tier 1. Early returns from Tier 1 never create it, so nothing leaks.
- `combinedSignal` composes the caller's abort signal with the fingerprint's own controller. Built once, reused across Tier 2/3 probes.
- Abort checks (`if (combinedSignal.aborted) return undefined`) are placed between each Tier 2/3 step for fast exit.

## Probe IDs

- `ProbeKey` is derived from the `PROBES` object in `index.ts`; adding a probe
  there makes its ID valid in `settings.probe`.
- Deprecated IDs live in `PROBE_ID_ALIASES` in `src/constants.ts` (`atlas` →
  `actualyze`). `canonicalProbeKey()` resolves them, and stored inventories
  record the canonical key.

## Files That Change Together

Adding a new probe requires changes in all of these:

1. `src/probes/yourserver.ts`: the probe implementation.
2. `src/probes/index.ts`: add it to the `PROBES` registry.
3. `src/probes/fingerprint.ts`: add it to `DetectedServer` and `PROBE_MAP`, plus `OWNED_BY_MAP` or a Tier 2 check for auto-detection.
4. `test/probes/yourserver.test.ts`: tests, plus `fingerprint.test.ts` cases for detection.
5. `src/discover.ts`: extend `sanitizeProbeMeta()`, only if the probe adds a new `ProbeModelMeta` field.
6. `README.md`: the Supported Servers table.
