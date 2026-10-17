#!/usr/bin/env node
// Live checks against the harness server (scripts/live-harness.mjs start).
// Not shipped and not part of `npm run check`.
//
//   node scripts/live-check.mjs [--skip-chat] [--chat-model <provider/model>]
//
// Expected Actualyze values are derived from the endpoint's own /models list,
// fetched at check time with ACTUALYZE_API_KEY_FILE (see live-harness.mjs).
// Without that file the checks expect the built-in `actualyze` provider to be
// hidden. The chat check sends one plain prompt to --chat-model, or else to
// the first listed Actualyze model.
//
// After `start --actualyze-mock` the endpoint is the harness's Actualyze
// mock, and the expected discovery outcome follows the synthetic key in
// ACTUALYZE_API_KEY_FILE (ACTUALYZE_MOCK_SCENARIOS): a failing key expects
// its failure kind and HTTP status, and no key expects the 401 the mock
// sends without one. After `start --actualyze-refused` the expected failure
// is `unreachable`. In both modes the config entry lists the provider even
// without a key.
//
// Prints only the fields it checks and PASS/FAIL. It never prints a raw
// model.list or provider.list response: both carry the plaintext apiKey.
// Failures print a fixed category and, where captured, the HTTP status, never
// an exception message: fetch errors can include a credential-bearing URL and
// JSON errors can include response text.
//
// This script imports src/catalog-evidence.ts directly, so it needs a Node
// version that strips TypeScript types by default (22.18+ or 23.6+).

import { spawn } from "node:child_process";
import { validateCatalogPayload } from "../src/catalog-evidence.ts";
import {
  ACTUALYZE_BASE_URL as BUILT_IN_BASE_URL,
  ACTUALYZE_INTEGRATION_ID,
} from "../src/constants.ts";
import {
  ACTUALYZE_BASE_URL,
  ACTUALYZE_ENABLED,
  ACTUALYZE_MOCK_SCENARIOS,
  ACTUALYZE_PROVIDER,
  MOCK_DECLARED_MODELS,
  MOCK_MODELS,
  PROJECT,
  api,
  envArgv,
  isolatedEnv,
  mockScenarioForKey,
  readActualyzeKey,
  readState,
} from "./live-harness.mjs";

const PLUGIN_ID = "opencode-model-scout";
const ACTUALYZE = ACTUALYZE_PROVIDER;
const MOCK = "mock-compat";
const HOST_DEFAULT_CONTEXT = 200_000;
/** One-minute refresh floor per store key (src/store.ts). */
const REFRESH_FLOOR_MS = 60_000;
/** Slack for comparing server timestamps with values derived from headers. */
const TIME_SLACK_MS = 5_000;

const args = process.argv.slice(2);
const skipChat = args.includes("--skip-chat");
const chatModelIndex = args.indexOf("--chat-model");
const chatModelArg = chatModelIndex >= 0 ? args[chatModelIndex + 1] : undefined;

/**
 * The Actualyze `/models` list entries, fetched directly from the endpoint.
 * Resolves to `{ list }` or `{ failure }`, where `failure` is a fixed category.
 */
async function fetchActualyzeList() {
  const key = await readActualyzeKey();
  if (!key) return { failure: "key file unreadable or empty" };
  let response;
  try {
    response = await fetch(`${actualyzeEndpoint}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { failure: "request failed" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { failure: `HTTP ${response.status}` };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { failure: "response is not JSON" };
  }
  return { list: Array.isArray(body?.data) ? body.data : [] };
}

let failures = 0;
let passes = 0;

function show(value) {
  return JSON.stringify(value);
}

function check(label, ok, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  // Details are printed only for failures, and never include raw responses.
  console.log(
    `${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? ` ${detail}` : ""}`,
  );
  return ok;
}

function equalField(label, actual, expected) {
  const ok = show(actual) === show(expected);
  return check(
    label,
    ok,
    ok ? "" : `expected ${show(expected)} got ${show(actual)}`,
  );
}

function sorted(values) {
  return Array.isArray(values) ? [...values].sort() : values;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Expected `Model.Info` fields for a model discovered from an Actualyze list
 * entry. No effort variants: the Actualyze chat endpoint ignores
 * `reasoning_effort`. An unreported context is the host default, and an
 * unreported output limit is 0 ("fit to the remaining context").
 */
function expectedFromActualyze(entry) {
  const capabilities = entry.capabilities ?? {};
  const input = Array.isArray(entry.modalities?.input)
    ? entry.modalities.input
    : capabilities.vision === true
      ? ["text", "image"]
      : ["text"];
  const context = isPositiveInteger(entry.context_window)
    ? entry.context_window
    : HOST_DEFAULT_CONTEXT;
  return {
    limit: {
      context,
      output: isPositiveInteger(entry.max_output_tokens)
        ? Math.min(entry.max_output_tokens, context)
        : 0,
    },
    tools: capabilities.tool_use === false ? false : true,
    input: sorted(input),
    output: ["text"],
    variants: [],
    cost: entry.cost
      ? [
          {
            input: entry.cost.input,
            output: entry.cost.output,
            cache: {
              read: entry.cost.cache_read ?? 0,
              write: entry.cost.cache_write ?? 0,
            },
          },
        ]
      : [],
    released: typeof entry.created === "number" ? entry.created * 1000 : 0,
    enabled: true,
  };
}

function isEmbeddingId(id) {
  return id.includes("embed");
}

/** Cost entries with a fixed key order, so equal tiers compare equal. */
function canonicalCosts(costs) {
  if (!Array.isArray(costs)) return costs;
  return costs.map((cost) => ({
    tier: cost.tier ? { type: cost.tier.type, size: cost.tier.size } : null,
    input: cost.input,
    output: cost.output,
    cache: { read: cost.cache?.read ?? 0, write: cost.cache?.write ?? 0 },
  }));
}

function actualFields(model) {
  return {
    limit: { context: model.limit?.context, output: model.limit?.output },
    tools: model.capabilities?.tools,
    input: sorted(model.capabilities?.input),
    output: model.capabilities?.output,
    variants: Array.isArray(model.variants)
      ? model.variants.map((variant) => ({
          id: variant.id,
          reasoningEffort: variant.settings?.reasoningEffort,
        }))
      : model.variants,
    cost: Array.isArray(model.cost)
      ? model.cost.map((cost) => ({
          input: cost.input,
          output: cost.output,
          cache: { read: cost.cache?.read, write: cost.cache?.write },
        }))
      : model.cost,
    released: model.time?.released,
    enabled: model.enabled,
  };
}

async function checkPlugins(state) {
  console.log("== plugin.list");
  const { status, json } = await api(state, "GET", "/api/plugin");
  if (!check("plugin.list HTTP 200", status === 200, `(HTTP ${status})`))
    return;
  const plugin = (Array.isArray(json?.data) ? json.data : []).find(
    (entry) => entry?.id === PLUGIN_ID,
  );
  if (!check(`${PLUGIN_ID} listed`, plugin !== undefined)) return;
  equalField(`${PLUGIN_ID} state`, plugin.state?.status, "active");
  for (const feature of ["server", "tui", "rpc"]) {
    equalField(
      `${PLUGIN_ID} feature ${feature}`,
      plugin.features?.[feature],
      true,
    );
  }
}

/**
 * The built-in provider is listed only with a key or a config entry (the
 * mock modes write one). When listed, its key must come from the integration
 * (no `settings.apiKey`), and the endpoint is the configured one or the
 * built-in one.
 */
async function checkActualyzeProvider(state) {
  console.log("== provider.list");
  const { status, json } = await api(state, "GET", "/api/provider");
  if (!check("provider.list HTTP 200", status === 200, `(HTTP ${status})`))
    return;
  const provider = (Array.isArray(json?.data) ? json.data : []).find(
    (entry) => entry?.id === ACTUALYZE,
  );
  if (!ACTUALYZE_ENABLED && mode === "default") {
    check(`${ACTUALYZE} hidden without a key`, provider === undefined);
    return;
  }
  if (!check(`${ACTUALYZE} listed`, provider !== undefined)) return;
  equalField(
    `${ACTUALYZE} integrationID`,
    provider.integrationID,
    ACTUALYZE_INTEGRATION_ID,
  );
  equalField(
    `${ACTUALYZE} settings.baseURL`,
    provider.settings?.baseURL,
    actualyzeEndpoint,
  );
  equalField(
    `${ACTUALYZE} settings.probe`,
    provider.settings?.probe,
    "actualyze",
  );
  check(
    `${ACTUALYZE} has no settings.apiKey`,
    provider.settings?.apiKey === undefined,
  );
}

/**
 * `/connect` offers exactly one Actualyze integration, the one the provider
 * reads its key from, even when config has a `providers.actualyze` entry. It
 * has a connection only when the harness passed a key.
 */
async function checkActualyzeIntegration(state) {
  console.log("== integration.list");
  const { status, json } = await api(state, "GET", "/api/integration");
  if (!check("integration.list HTTP 200", status === 200, `(HTTP ${status})`))
    return;
  const listed = (Array.isArray(json?.data) ? json.data : []).filter(
    (entry) =>
      entry?.id === ACTUALYZE_INTEGRATION_ID ||
      String(entry?.name).toLowerCase() === "actualyze",
  );
  equalField(
    "one Actualyze integration",
    listed.map((entry) => entry.id),
    [ACTUALYZE_INTEGRATION_ID],
  );
  const connected = (listed[0]?.connections?.length ?? 0) > 0;
  equalField(
    `${ACTUALYZE_INTEGRATION_ID} connected`,
    connected,
    ACTUALYZE_ENABLED,
  );
}

async function checkModels(state) {
  console.log("== model.list");
  const listed = actualyzeList ?? [];
  const { status, json } = await api(state, "GET", "/api/model");
  if (!check("model.list HTTP 200", status === 200, `(HTTP ${status})`)) return;
  const models = Array.isArray(json?.data) ? json.data : [];
  const byKey = new Map(
    models.map((model) => [`${model.providerID}/${model.id}`, model]),
  );

  for (const entry of listed) {
    const key = `${ACTUALYZE}/${entry.id}`;
    const model = byKey.get(key);
    if (isEmbeddingId(entry.id)) {
      check(
        `${key} not offered as a chat model`,
        model === undefined || model.enabled === false,
      );
      continue;
    }
    if (!check(`${key} listed`, model !== undefined)) continue;
    const expected = expectedFromActualyze(entry);
    const actual = actualFields(model);
    for (const field of Object.keys(expected)) {
      equalField(`${key} ${field}`, actual[field], expected[field]);
    }
  }
  const extra = models
    .filter((model) => model.providerID === ACTUALYZE)
    .map((model) => model.id)
    .filter((id) => !listed.some((entry) => entry.id === id));
  if (actualyzeList) {
    equalField(`${ACTUALYZE} has no unexpected models`, extra, []);
  } else if (!ACTUALYZE_ENABLED) {
    equalField(`${ACTUALYZE} has no models without a key`, extra, []);
  } else if (expectedFailure) {
    equalField(`${ACTUALYZE} has no models after a failure`, extra, []);
  }

  for (const entry of MOCK_MODELS) {
    const key = `${MOCK}/${entry.id}`;
    const model = byKey.get(key);
    const declared = MOCK_DECLARED_MODELS[entry.id];
    if (declared) {
      // Scout never patches a declared model: every value is the config's.
      if (!check(`${key} listed`, model !== undefined)) continue;
      equalField(`${key} name`, model.name, declared.name);
      equalField(
        `${key} limit`,
        { context: model.limit?.context, output: model.limit?.output },
        declared.limit,
      );
      equalField(
        `${key} cost tiers`,
        canonicalCosts(model.cost),
        canonicalCosts(declared.cost),
      );
      continue;
    }
    if (isEmbeddingId(entry.id)) {
      check(
        `${key} not offered as a chat model`,
        model === undefined || model.enabled === false,
      );
      continue;
    }
    if (!check(`${key} listed`, model !== undefined)) continue;
    equalField(
      `${key} limit.context`,
      model.limit?.context,
      entry.max_model_len,
    );
  }
}

function readCatalog(state) {
  return api(state, "POST", `/api/rpc/${PLUGIN_ID}/catalog`, { input: {} });
}

const SETTLE_TIMEOUT_MS = 60_000;
const SETTLE_POLL_MS = 500;

/**
 * Wait until discovery has finished (status "complete"), so the model and
 * RPC checks do not race the first sync or a discovery job still running.
 */
async function waitForCatalog(state) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const { status, json } = await readCatalog(state);
      const payload =
        status === 200 ? validateCatalogPayload(json?.output) : undefined;
      if (payload && payload.status === "complete") return;
      last = payload ? payload.status : `HTTP ${status}`;
    } catch {
      last = "request failed";
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
  check(
    `catalog completes within ${SETTLE_TIMEOUT_MS / 1000} s`,
    false,
    `(${last})`,
  );
}

async function checkRpc(state) {
  console.log("== rpc catalog");
  const { status, json } = await readCatalog(state);
  if (
    !check(
      "rpc catalog HTTP 200",
      status === 200,
      status === 200
        ? ""
        : `(HTTP ${status} ${show(json?.type ?? json?.error?.type ?? "")})`,
    )
  )
    return;
  const payload = validateCatalogPayload(json?.output);
  if (!check("catalog payload passes the strict v5 validator", payload)) return;
  equalField("catalog builtIn.actualyze", payload.builtIn.actualyze, "managed");
  for (const [id, count] of [
    ...(actualyzeList ? [[ACTUALYZE, actualyzeList.length]] : []),
    [MOCK, MOCK_MODELS.length],
  ]) {
    const provider = payload.providers.find((entry) => entry.id === id);
    if (!check(`catalog has evidence for ${id}`, provider !== undefined))
      continue;
    check(`${id} lastGoodAt set`, provider.lastGoodAt !== null);
    equalField(`${id} failure`, provider.failure, null);
    equalField(`${id} model evidence count`, provider.models.length, count);
    checkSettledRecord(id, provider);
  }
  const mockRecord = payload.providers.find((entry) => entry.id === MOCK);
  if (mockRecord) {
    equalField(
      `${MOCK} credentialSource`,
      mockRecord.credentialSource,
      "settings",
    );
    for (const id of Object.keys(MOCK_DECLARED_MODELS)) {
      equalField(
        `${MOCK}/${id} evidence origin`,
        mockRecord.models.find((model) => model.id === id)?.origin,
        "pre-existing",
      );
    }
  }
  const actualyze = payload.providers.find((entry) => entry.id === ACTUALYZE);
  if (!ACTUALYZE_ENABLED && mode === "default")
    check(`catalog has no evidence for ${ACTUALYZE}`, actualyze === undefined);
  if (actualyze) {
    const probeValue = (evidence) =>
      evidence.state === "known" ? evidence.value : "unknown";
    equalField(
      `${ACTUALYZE} configuredProbe`,
      probeValue(actualyze.configuredProbe),
      "actualyze",
    );
    // The probe resolves only after a non-empty model list arrives.
    if (!expectedFailure && (actualyzeList?.length ?? 0) > 0)
      equalField(
        `${ACTUALYZE} resolvedProbe`,
        probeValue(actualyze.resolvedProbe),
        "actualyze",
      );
    equalField(
      `${ACTUALYZE} credentialSource`,
      actualyze.credentialSource,
      ACTUALYZE_ENABLED ? "connection" : "none",
    );
    if (expectedFailure) checkFailureRecord(actualyze, payload.generatedAt);
  } else if (expectedFailure) {
    check(`catalog has evidence for ${ACTUALYZE}`, false);
  }
}

/** A record whose job settled: not discovering, and its result is current. */
function checkSettledRecord(id, record) {
  equalField(`${id} discovering`, record.discovering, false);
  check(`${id} lastAttemptAt set`, record.lastAttemptAt !== null);
  equalField(
    `${id} resultEpoch equals credentialEpoch`,
    record.resultEpoch,
    record.credentialEpoch,
  );
}

/**
 * The `actualyze` record after a failing discovery: the expected kind and
 * HTTP status, no models, and for a 429 a `retryAt` from `Retry-After` with
 * `nextRefreshAt` at the later of it and the one-minute floor.
 */
function checkFailureRecord(record, generatedAtIso) {
  const { kind, httpStatus } = expectedFailure;
  checkSettledRecord(ACTUALYZE, record);
  equalField(`${ACTUALYZE} failure kind`, record.failure?.kind, kind);
  equalField(
    `${ACTUALYZE} failure httpStatus`,
    record.failure?.httpStatus,
    httpStatus,
  );
  equalField(`${ACTUALYZE} lastGoodAt`, record.lastGoodAt, null);
  equalField(`${ACTUALYZE} model evidence count`, record.models.length, 0);
  const retryAfterSeconds = mockScenario
    ? ACTUALYZE_MOCK_SCENARIOS[mockScenario].retryAfterSeconds
    : undefined;
  if (retryAfterSeconds === undefined) {
    equalField(
      `${ACTUALYZE} failure retryAt`,
      record.failure?.retryAt,
      undefined,
    );
    return;
  }
  const at = Date.parse(record.failure?.at ?? "");
  const retryAt = Date.parse(record.failure?.retryAt ?? "");
  const expectedRetryAt = at + retryAfterSeconds * 1000;
  check(
    `${ACTUALYZE} retryAt is Retry-After (${retryAfterSeconds} s) after the attempt`,
    Math.abs(retryAt - expectedRetryAt) <= TIME_SLACK_MS,
    `(retryAt ${show(record.failure?.retryAt)}, at ${show(record.failure?.at)})`,
  );
  const lastAttempt = Date.parse(record.lastAttemptAt ?? "");
  const expectedNext = Math.max(lastAttempt + REFRESH_FLOOR_MS, retryAt);
  const generatedAt = Date.parse(generatedAtIso);
  if (expectedNext <= generatedAt) {
    equalField(
      `${ACTUALYZE} nextRefreshAt after it passed`,
      record.nextRefreshAt,
      null,
    );
    return;
  }
  check(
    `${ACTUALYZE} nextRefreshAt is max(lastAttemptAt + 60 s, retryAt)`,
    Math.abs(Date.parse(record.nextRefreshAt ?? "") - expectedNext) <=
      TIME_SLACK_MS,
    `(nextRefreshAt ${show(record.nextRefreshAt)}, lastAttemptAt ${show(record.lastAttemptAt)})`,
  );
}

function runChat(state, model) {
  return new Promise((resolve) => {
    const child = spawn(
      "env",
      envArgv(isolatedEnv({ OPENCODE_PASSWORD: state.password }), [
        "run",
        "--server",
        state.url,
        "--model",
        model,
        "--format",
        "json",
        "Reply with the single word: pong",
      ]),
      { cwd: PROJECT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    // stderr is drained and discarded: it may echo provider details.
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const errorTypes = [];
      for (const line of stdout.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (/error/i.test(String(event?.type))) {
            errorTypes.push(
              String(event.error?.name ?? event.error?.type ?? event.type),
            );
          }
        } catch {
          // Non-JSON line.
        }
      }
      resolve({ code, signal, errorTypes });
    });
  });
}

async function checkChat(state) {
  console.log("== chat");
  const firstEntry = actualyzeList?.[0];
  const model =
    chatModelArg ?? (firstEntry ? `${ACTUALYZE}/${firstEntry.id}` : undefined);
  if (!model) {
    console.log("skip: no Actualyze model to test; pass --chat-model");
    return;
  }
  const { code, signal, errorTypes } = await runChat(state, model);
  const succeeded = code === 0 && errorTypes.length === 0;
  // A read-only key lists models, but every inference call gets a 403.
  const expectSuccess =
    chatModelArg !== undefined ||
    ACTUALYZE_MOCK_SCENARIOS[mockScenario]?.chatStatus === undefined;
  check(
    expectSuccess ? `chat ${model}` : `chat ${model} is refused`,
    succeeded === expectSuccess,
    succeeded
      ? "(succeeded)"
      : `(exit ${code ?? signal}${errorTypes.length ? `, errors ${show(errorTypes)}` : ""})`,
  );
}

const state = await readState();
if (!state) {
  console.log(
    "harness is not running; run `node scripts/live-harness.mjs start`",
  );
  process.exit(1);
}
/** `default`, or the harness's own Actualyze endpoint: `mock` or `refused`. */
const mode = state.actualyze?.mode ?? "default";
const actualyzeEndpoint =
  state.actualyze?.baseURL ?? ACTUALYZE_BASE_URL ?? BUILT_IN_BASE_URL;
const actualyzeKey = await readActualyzeKey();
const mockScenario =
  mode === "mock" ? mockScenarioForKey(actualyzeKey) : undefined;
/** The failure discovery must record for `actualyze`, or null for none. */
const expectedFailure =
  mode === "refused"
    ? { kind: "unreachable" }
    : mode === "mock"
      ? mockScenario
        ? ACTUALYZE_MOCK_SCENARIOS[mockScenario].failure
        : { kind: "unauthorized", httpStatus: 401 }
      : null;
console.log(
  `note: actualyze endpoint ${mode === "default" ? "default" : `${mode} ${actualyzeEndpoint}`}${mockScenario ? `, mock key "${mockScenario}"` : ""}`,
);
let actualyzeList;
if (ACTUALYZE_ENABLED && !expectedFailure) {
  const { list, failure } = await fetchActualyzeList();
  if (check("fetch Actualyze /models", failure === undefined, `(${failure})`))
    actualyzeList = list;
} else if (!ACTUALYZE_ENABLED && mode === "default") {
  console.log(
    "note: ACTUALYZE_API_KEY_FILE not set; checking that Actualyze stays hidden",
  );
}
await waitForCatalog(state);
for (const step of [
  checkPlugins,
  checkActualyzeIntegration,
  checkActualyzeProvider,
  checkModels,
  checkRpc,
]) {
  try {
    await step(state);
  } catch {
    check(step.name, false, "(threw an exception)");
  }
}
if (!skipChat) await checkChat(state);
console.log(`\n${passes} passed, ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
