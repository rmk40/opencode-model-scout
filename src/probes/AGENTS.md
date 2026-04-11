# Probe-Specific Learnings

## Writing Probes

- Capability flags: only set to `true`, never `false`. Undefined = unknown, which is better than wrong.
- `EMPTY_RESULT` is `Object.freeze()`d. Never mutate after returning it.
- `probeFetch()` returns `Response | undefined`. It does NOT check `res.ok` — callers split: `if (!res) return EMPTY_RESULT; if (!res.ok) { warn; return EMPTY_RESULT; }`.
- `buildHeaders()` does NOT include Content-Type. Add locally when needed (e.g., Ollama POST needs `Content-Type: application/json`, but GET does not).
- Probes don't receive the global abort signal. They're bounded by `probeFetch`'s 2s default timeout.
- Outer try-catch must stay even after switching to `probeFetch` — `res.json()` can still throw on malformed bodies.

## Server Quirks

- `owned_by` is optional (`owned_by?: string`). Some servers omit it entirely. Missing is not a positive signal for any server.
- KoboldCpp `jinja: true` does NOT mean tool calling support. Do not infer `toolCall` from Jinja.
- `llamacpp` and `localai` both map to the `ollama` probe via `PROBE_MAP` — llama.cpp implements Ollama-compatible API endpoints.

## Fingerprinting

- Tier 1 (modelsResponse inspection) makes zero HTTP calls and has no timer.
- The `globalTimeout` timer is created after Tier 1. Early returns from Tier 1 never create it — no leak.
- `combinedSignal` composes the caller's abort signal with the fingerprint's own controller. Built once, reused across Tier 2/3 probes.
- Abort checks (`if (combinedSignal.aborted) return undefined`) are placed between each Tier 2/3 step for fast exit.

## Files That Change Together

Adding a new probe requires changes in all of these:

1. `src/probes/yourserver.ts` — probe implementation
2. `src/probes/index.ts` — add to `PROBES` registry
3. `src/probes/fingerprint.ts` — add to `DetectedServer` type, `ProbeKey` type, `PROBE_MAP`, and add tier detection logic
4. `test/probes/yourserver.test.ts` — tests
5. `README.md` — Supported Servers table
