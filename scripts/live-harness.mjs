#!/usr/bin/env node
// Live harness: runs the real installed `opencode` against <repo>/dist in an
// isolated scratch tree. Not shipped and not part of `npm run check`.
//
//   npm run compile:dev           # or `npm run compile`; this script never builds
//   node scripts/live-harness.mjs start [--actualyze-mock | --actualyze-refused] [--fresh]
//   node scripts/live-check.mjs
//   node scripts/live-harness.mjs connect <scenario>
//   node scripts/live-harness.mjs status
//   node scripts/live-harness.mjs stop
//
// Start options:
//   --actualyze-mock      point providers.actualyze.settings.baseURL at the
//                         local Actualyze mock (<mock>/openai/v1)
//   --actualyze-refused   point it at a local port that refuses connections
//   --fresh               delete the scratch HOME and XDG trees first, so no
//                         connection, setting, or stored binding survives
//
// `connect <scenario>` connects the synthetic key `aai_pat_mock_<scenario>`
// to the `actualyze` integration through the server API. The mock chooses
// its behavior by that key (see ACTUALYZE_MOCK_SCENARIOS); any other key,
// or none, gets the 401 Actualyze sends for every rejected key.
//
// Environment:
//   SCOUT_HARNESS_DIR        scratch tree (default: <os tmpdir>/opencode-model-scout-harness)
//   ACTUALYZE_API_KEY_FILE   file holding an inference-scoped Actualyze key; with
//                            --actualyze-mock it must hold a synthetic aai_pat_mock_* key
//   ACTUALYZE_BASE_URL       optional Actualyze endpoint, e.g. http://localhost:3001/openai/v1
//                            (default: the plugin's built-in production endpoint;
//                            not allowed with --actualyze-mock or --actualyze-refused)
//   OPENCODE_BIN             opencode executable (default: first `opencode` on PATH)
//
// The Actualyze checks use the plugin's built-in `actualyze` provider. The
// key reaches the server only as ACTUALYZE_API_KEY in its environment, so
// discovery and chat go through the integration credential; it is never
// written to the config, the state file, a log, or a command line. With
// ACTUALYZE_BASE_URL the config sets only `settings.baseURL`. Without
// ACTUALYZE_API_KEY_FILE, and without a mock option, the provider must stay
// hidden. Any `providers.actualyze` config entry lists the provider without
// a key, so the mock options list it even before a key is connected.
//
// Every OpenCode process runs with an environment built from scratch (`env
// -i`, or the spawn `env` option for the server so the key stays off its
// command line): HOME and the four XDG variables point into the scratch
// tree, so no real config, data, or background service is touched. Its PATH
// holds only the standard system directories and the directory of the
// resolved opencode executable. Output never includes provider settings:
// `model.list` and `provider.list` can carry a plaintext apiKey.

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

export const HARNESS = path.resolve(
  process.env.SCOUT_HARNESS_DIR ??
    path.join(os.tmpdir(), "opencode-model-scout-harness"),
);
export const ACTUALYZE_BASE_URL = process.env.ACTUALYZE_BASE_URL?.replace(
  /\/+$/,
  "",
);
export const ACTUALYZE_API_KEY_FILE = process.env.ACTUALYZE_API_KEY_FILE
  ? path.resolve(process.env.ACTUALYZE_API_KEY_FILE)
  : undefined;
export const ACTUALYZE_ENABLED = Boolean(ACTUALYZE_API_KEY_FILE);
export const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const ACTUALYZE_PROVIDER = "actualyze";
export const PROJECT = path.join(HARNESS, "project");
export const STATE_FILE = path.join(HARNESS, "state.json");

export const XDG = {
  HOME: path.join(HARNESS, "home"),
  XDG_CONFIG_HOME: path.join(HARNESS, "xdg", "config"),
  XDG_DATA_HOME: path.join(HARNESS, "xdg", "data"),
  XDG_CACHE_HOME: path.join(HARNESS, "xdg", "cache"),
  XDG_STATE_HOME: path.join(HARNESS, "xdg", "state"),
};
export const LOGS = path.join(HARNESS, "logs");
/** The TUI's settings file; only terminal clients read it. */
export const CLI_CONFIG = path.join(
  XDG.XDG_CONFIG_HOME,
  "opencode",
  "cli.json",
);
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const HOST = "127.0.0.1";
const SERVER_PORT = Number(process.env.SCOUT_HARNESS_PORT ?? 47931);
const MOCK_PORT = Number(process.env.SCOUT_HARNESS_MOCK_PORT ?? 47932);
const REFUSED_PORT = Number(process.env.SCOUT_HARNESS_REFUSED_PORT ?? 47933);

/** Every synthetic Actualyze key starts with this; real keys start with `aai_pat_`. */
export const MOCK_KEY_PREFIX = "aai_pat_mock_";

/**
 * Behavior of the Actualyze mock per synthetic key `aai_pat_mock_<name>`,
 * with the failure the plugin is expected to record for it (null: none).
 * `slow` sends no headers until after the 10 s model-list header timeout;
 * `slow_body` sends headers, then stalls the body past the body-read timeout.
 */
export const ACTUALYZE_MOCK_SCENARIOS = {
  ok: { failure: null },
  empty: { failure: null },
  revoked: { failure: { kind: "unauthorized", httpStatus: 401 } },
  forbidden: { failure: { kind: "forbidden", httpStatus: 403 } },
  budget: { failure: { kind: "payment-required", httpStatus: 402 } },
  throttled: {
    failure: { kind: "rate-limited", httpStatus: 429 },
    retryAfterSeconds: 90,
  },
  throttled_short: {
    failure: { kind: "rate-limited", httpStatus: 429 },
    retryAfterSeconds: 30,
  },
  "5xx": { failure: { kind: "server-error", httpStatus: 503 } },
  slow: { failure: { kind: "timeout" } },
  slow_body: { failure: { kind: "timeout" } },
  readonly: { failure: null, chatStatus: 403 },
};

/** The synthetic key for a mock scenario. */
export function mockKey(scenario) {
  if (!Object.hasOwn(ACTUALYZE_MOCK_SCENARIOS, scenario))
    throw new Error(`unknown Actualyze mock scenario: ${scenario}`);
  return `${MOCK_KEY_PREFIX}${scenario}`;
}

/** The mock scenario a key selects, or undefined for any other key. */
export function mockScenarioForKey(key) {
  if (typeof key !== "string" || !key.startsWith(MOCK_KEY_PREFIX))
    return undefined;
  const name = key.slice(MOCK_KEY_PREFIX.length);
  return Object.hasOwn(ACTUALYZE_MOCK_SCENARIOS, name) ? name : undefined;
}

/** The mock's Actualyze mount, and the endpoint of the refused-port option. */
export const ACTUALYZE_MOCK_BASE_URL = `http://${HOST}:${MOCK_PORT}/openai/v1`;
export const ACTUALYZE_REFUSED_BASE_URL = `http://${HOST}:${REFUSED_PORT}/openai/v1`;

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Absolute path of the `opencode` executable: OPENCODE_BIN when set,
 * otherwise the first match on the caller's PATH. `env -i` clears PATH, so
 * the binary is resolved before entering it.
 */
function resolveOpencode() {
  const override = process.env.OPENCODE_BIN;
  if (override) {
    const file = path.resolve(override);
    if (isExecutable(file)) return file;
    throw new Error(`OPENCODE_BIN=${override} is not an executable file`);
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const file = path.join(directory, "opencode");
    if (isExecutable(file)) return file;
  }
  throw new Error(
    "no executable `opencode` found on PATH; install OpenCode or set OPENCODE_BIN",
  );
}

let opencodeBin;
/** Resolved lazily so `stop` and `status` work without OpenCode installed. */
export function opencodeBinary() {
  opencodeBin ??= resolveOpencode();
  return opencodeBin;
}

/**
 * Models the harness config declares on `mock-compat`. Scout leaves declared
 * models untouched, so these carry exactly the configured values. The tiered
 * model prices prompts above 200 000 tokens of context higher; the host picks
 * the untiered entry below that size.
 */
export const MOCK_DECLARED_MODELS = {
  "mock-tiered-pro": {
    name: "Mock Tiered Pro",
    limit: { context: 400_000, output: 32_000 },
    cost: [
      { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      {
        tier: { type: "context", size: 200_000 },
        input: 6,
        output: 22.5,
        cache: { read: 0.6, write: 7.5 },
      },
    ],
  },
};

/** Models served by the `mock-compat` provider (vLLM-shaped list entries). */
export const MOCK_MODELS = [
  { id: "mock-llama-3.1-8b", max_model_len: 131072 },
  { id: "mock-qwen2.5-coder-7b", max_model_len: 32768 },
  { id: "mock-nomic-embed-text", max_model_len: 8192 },
  { id: "mock-tiered-pro", max_model_len: 400_000 },
].map((model) => ({
  ...model,
  object: "model",
  created: 1_700_000_000,
  owned_by: "vllm",
  root: model.id,
}));

const CAPABILITY_FLAGS = [
  "vision",
  "video",
  "tool_use",
  "thinking",
  "thinking_adaptive",
  "structured_output",
  "streaming",
  "caching",
  "audio",
  "document",
  "temperature",
];

/** All eleven tri-state flags: listed ones true, `unknown` ones null, the rest false. */
function capabilityFlags(supported, unknown = []) {
  return Object.fromEntries(
    CAPABILITY_FLAGS.map((flag) => [
      flag,
      supported.includes(flag) ? true : unknown.includes(flag) ? null : false,
    ]),
  );
}

/**
 * Model objects the Actualyze mock serves for `aai_pat_mock_ok`, in the shape
 * of `GET /openai/v1/models` entries: sorted by ID, `owned_by` "actualyze",
 * `max_model_len` equal to `context_window`, `modalities` always with text,
 * and `cost` only when input and output prices are both known (an absent
 * cache price means unknown). `team-coder` is a Virtual Model whose output
 * limit, prices, and several flags the platform does not know.
 */
export const ACTUALYZE_MOCK_MODELS = [
  {
    id: "claude-haiku-4-5",
    created: 1_760_486_400,
    context_window: 200_000,
    max_output_tokens: 64_000,
    capabilities: capabilityFlags([
      "vision",
      "tool_use",
      "thinking",
      "structured_output",
      "streaming",
      "caching",
      "document",
      "temperature",
    ]),
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  },
  {
    id: "claude-sonnet-4-5",
    created: 1_759_104_000,
    context_window: 200_000,
    max_output_tokens: 64_000,
    capabilities: capabilityFlags([
      "vision",
      "tool_use",
      "thinking",
      "structured_output",
      "streaming",
      "caching",
      "document",
      "temperature",
    ]),
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  {
    id: "gpt-5",
    created: 1_754_524_800,
    context_window: 400_000,
    max_output_tokens: 128_000,
    capabilities: capabilityFlags([
      "vision",
      "tool_use",
      "thinking",
      "structured_output",
      "streaming",
      "caching",
    ]),
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 1.25, output: 10, cache_read: 0.125 },
  },
  {
    id: "gpt-oss-120b",
    created: 1_754_438_400,
    context_window: 131_072,
    max_output_tokens: 32_768,
    capabilities: capabilityFlags([
      "tool_use",
      "thinking",
      "structured_output",
      "streaming",
      "temperature",
    ]),
    modalities: { input: ["text"], output: ["text"] },
    cost: { input: 0.15, output: 0.6 },
  },
  {
    id: "team-coder",
    created: 0,
    context_window: 262_144,
    max_output_tokens: null,
    capabilities: capabilityFlags(
      ["tool_use", "streaming"],
      ["thinking", "thinking_adaptive", "caching", "temperature"],
    ),
    modalities: { input: ["text"], output: ["text"] },
    base_models_disclosed: false,
  },
  {
    id: "text-embedding-3-small",
    created: 1_705_968_000,
    context_window: 8_191,
    max_output_tokens: null,
    // Unknown chat flags: the probe classifies a model with `vision: false`
    // as an LLM, which would override the embedding name heuristic.
    capabilities: capabilityFlags([], CAPABILITY_FLAGS),
    modalities: { input: ["text"], output: ["embedding"] },
    cost: { input: 0.02, output: 0 },
  },
].map((model) => ({
  id: model.id,
  object: "model",
  created: model.created,
  owned_by: "actualyze",
  context_window: model.context_window,
  max_output_tokens: model.max_output_tokens,
  max_model_len: model.context_window,
  capabilities: model.capabilities,
  modalities: model.modalities,
  ...(model.cost ? { cost: model.cost } : {}),
  ...(model.base_models_disclosed === undefined
    ? {}
    : { base_models_disclosed: model.base_models_disclosed }),
}));

/**
 * The `settings.baseURL` the config sets for the `actualyze` provider in a
 * start mode (`default`, `mock`, or `refused`), or undefined for none. The
 * default mode sets ACTUALYZE_BASE_URL only together with a key file.
 */
export function actualyzeConfigBaseURL(mode) {
  if (mode === "mock") return ACTUALYZE_MOCK_BASE_URL;
  if (mode === "refused") return ACTUALYZE_REFUSED_BASE_URL;
  return ACTUALYZE_ENABLED ? ACTUALYZE_BASE_URL : undefined;
}

/** The isolated environment every OpenCode process runs with (`env -i`). */
export function isolatedEnv(extra = {}) {
  // The binary's own directory stays on PATH so a launcher script can find
  // an interpreter installed beside it.
  const binDirectory = path.dirname(opencodeBinary());
  const searchPath = SYSTEM_PATH.includes(binDirectory)
    ? SYSTEM_PATH
    : [...SYSTEM_PATH, binDirectory];
  return {
    PATH: searchPath.join(path.delimiter),
    ...XDG,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    TERM: "dumb",
    ...extra,
  };
}

/** argv for `env -i KEY=VALUE ... <opencode> <args>`. */
export function envArgv(env, args) {
  return [
    "-i",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    opencodeBinary(),
    ...args,
  ];
}

function harnessConfig(mode) {
  const actualyzeBaseURL = actualyzeConfigBaseURL(mode);
  return {
    $schema: "https://opencode.ai/config.json",
    plugins: [path.join(REPO, "dist")],
    providers: {
      ...(actualyzeBaseURL
        ? {
            [ACTUALYZE_PROVIDER]: { settings: { baseURL: actualyzeBaseURL } },
          }
        : {}),
      "mock-compat": {
        name: "Mock compat",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: {
          baseURL: `http://${HOST}:${MOCK_PORT}/v1`,
          apiKey: "mock-key",
          probe: "auto",
        },
        models: MOCK_DECLARED_MODELS,
      },
    },
  };
}

/** The trimmed Actualyze key, or undefined when the file is unset, unreadable, or empty. */
export async function readActualyzeKey() {
  if (!ACTUALYZE_API_KEY_FILE) return undefined;
  try {
    const key = (await readFile(ACTUALYZE_API_KEY_FILE, "utf8")).trim();
    return key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

export async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return undefined;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Fetch a JSON API path on the harness server with Basic auth. */
export async function api(state, method, apiPath, body) {
  const url = new URL(apiPath, state.url);
  if (!url.searchParams.has("location[directory]"))
    url.searchParams.set("location[directory]", state.project);
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

function spawnDetached(command, args, logName, options = {}) {
  const fd = openSync(path.join(LOGS, logName), "a", 0o600);
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      ...options,
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/** Resolves true when nothing accepts connections on `port`. */
function portRefuses(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => resolve(error.code === "ECONNREFUSED"));
  });
}

/**
 * Start the mock and `opencode serve`. `actualyze` is `default`, `mock`, or
 * `refused`; `fresh` deletes the scratch HOME and XDG trees first. Resolves
 * true when the server answers; messages go through `log`.
 */
export async function startHarness({
  actualyze = "default",
  fresh = false,
  log = console.log,
} = {}) {
  const existing = await readState();
  if (existing && (alive(existing.serverPid) || alive(existing.mockPid))) {
    log(`already running at ${existing.url}; run stop first`);
    return false;
  }
  if (!existsSync(path.join(REPO, "dist", "server.js"))) {
    log("dist/server.js is missing; run `npm run compile:dev` first");
    return false;
  }
  try {
    opencodeBinary();
  } catch (error) {
    log(error.message);
    return false;
  }
  if (actualyze !== "default" && ACTUALYZE_BASE_URL) {
    log(`ACTUALYZE_BASE_URL cannot be combined with the ${actualyze} endpoint`);
    return false;
  }
  if (actualyze === "refused" && !(await portRefuses(REFUSED_PORT))) {
    log(
      `port ${REFUSED_PORT} accepts connections; set SCOUT_HARNESS_REFUSED_PORT to a closed port`,
    );
    return false;
  }
  let actualyzeKey;
  if (!ACTUALYZE_ENABLED) {
    log(
      actualyze === "default"
        ? "note: ACTUALYZE_API_KEY_FILE is not set; the Actualyze provider stays hidden"
        : "note: ACTUALYZE_API_KEY_FILE is not set; actualyze starts without a key",
    );
  } else {
    actualyzeKey = await readActualyzeKey();
    if (!actualyzeKey)
      log(`warning: ${ACTUALYZE_API_KEY_FILE} is missing or empty`);
    // A real key never goes to a local endpoint the harness controls.
    if (
      actualyzeKey &&
      actualyze !== "default" &&
      mockScenarioForKey(actualyzeKey) === undefined
    ) {
      log(
        `the ${actualyze} endpoint takes only a synthetic ${MOCK_KEY_PREFIX}<scenario> key`,
      );
      return false;
    }
  }

  await rm(LOGS, { recursive: true, force: true });
  if (fresh) {
    for (const directory of Object.values(XDG))
      await rm(directory, { recursive: true, force: true });
  }
  for (const directory of [...Object.values(XDG), LOGS, PROJECT]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await mkdir(path.join(PROJECT, ".opencode"), { recursive: true });
  await writeFile(
    path.join(PROJECT, ".opencode", "opencode.json"),
    `${JSON.stringify(harnessConfig(actualyze), null, 2)}\n`,
  );

  const password = randomBytes(24).toString("hex");
  const mockPid = spawnDetached(
    process.execPath,
    [fileURLToPath(import.meta.url), "mock", String(MOCK_PORT)],
    "mock.log",
  );
  // The spawn `env` option replaces the whole environment like `env -i`,
  // without putting the key on a command line.
  const serverPid = spawnDetached(
    opencodeBinary(),
    ["serve", "--hostname", HOST, "--port", String(SERVER_PORT)],
    "serve.log",
    {
      cwd: PROJECT,
      env: isolatedEnv({
        OPENCODE_SERVER_PASSWORD: password,
        ...(actualyzeKey ? { ACTUALYZE_API_KEY: actualyzeKey } : {}),
      }),
    },
  );
  const state = {
    url: `http://${HOST}:${SERVER_PORT}`,
    password,
    project: PROJECT,
    serverPid,
    mockPid,
    mockUrl: `http://${HOST}:${MOCK_PORT}/v1`,
    // Endpoints the harness itself serves or refuses; null otherwise, so a
    // configured ACTUALYZE_BASE_URL is never written here.
    actualyze: {
      mode: actualyze,
      baseURL:
        actualyze === "default" ? null : actualyzeConfigBaseURL(actualyze),
    },
    startedAt: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(STATE_FILE, 0o600);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!alive(serverPid)) break;
    try {
      const { status } = await api(state, "GET", "/api/plugin");
      if (status === 200) {
        log(`started ${state.url} (server pid ${serverPid})`);
        log(`mock-compat at ${state.mockUrl} (pid ${mockPid})`);
        const endpoint =
          actualyze === "default"
            ? (ACTUALYZE_BASE_URL ?? "built-in")
            : `${actualyze} ${state.actualyze.baseURL}`;
        log(
          actualyzeKey
            ? `actualyze key via ACTUALYZE_API_KEY, endpoint ${endpoint}`
            : `actualyze has no key, endpoint ${endpoint}`,
        );
        log(`project ${PROJECT}`);
        log(`logs ${LOGS}`);
        return true;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  log(`server did not come up; see ${path.join(LOGS, "serve.log")}`);
  return false;
}

/**
 * Connect a synthetic mock key to the `actualyze` integration through the
 * server API. Refuses any key that is not `aai_pat_mock_<scenario>`.
 * Resolves to the HTTP status (204 on success).
 */
export async function connectMockKey(state, key, label = "Harness mock") {
  if (mockScenarioForKey(key) === undefined)
    throw new Error(`refusing a key that is not ${MOCK_KEY_PREFIX}<scenario>`);
  // `integration.list` waits for plugin activation; `connect.key` does not,
  // and answers 404 until the plugin has registered the integration.
  const listed = await api(state, "GET", "/api/integration");
  if (listed.status !== 200) return listed.status;
  const { status } = await api(
    state,
    "POST",
    `/api/integration/${ACTUALYZE_PROVIDER}/connect/key`,
    { key, label },
  );
  return status;
}

async function status() {
  const state = await readState();
  if (!state) {
    console.log("not running (no state file)");
    return;
  }
  console.log(
    `server ${state.url} pid ${state.serverPid} ${alive(state.serverPid) ? "alive" : "dead"}`,
  );
  console.log(
    `mock ${state.mockUrl} pid ${state.mockPid} ${alive(state.mockPid) ? "alive" : "dead"}`,
  );
  console.log(
    `actualyze ${state.actualyze?.mode ?? "default"}${state.actualyze?.baseURL ? ` ${state.actualyze.baseURL}` : ""}`,
  );
  if (!alive(state.serverPid)) return;
  try {
    const { status: code, json } = await api(state, "GET", "/api/plugin");
    const plugins = (Array.isArray(json?.data) ? json.data : []).filter(
      (plugin) => plugin?.source?.type !== "builtin",
    );
    console.log(`plugin.list HTTP ${code} (non-builtin plugins)`);
    for (const plugin of plugins) {
      console.log(
        `  ${plugin.id} ${plugin.state?.status} features=${JSON.stringify(plugin.features ?? {})}`,
      );
    }
  } catch (error) {
    console.log(`plugin.list failed: ${error.message}`);
  }
}

async function stopPid(pid) {
  if (!alive(pid)) return;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        return;
      }
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && alive(pid)) await sleep(100);
    if (!alive(pid)) return;
  }
}

/** Stop the server and the mock. Resolves true when both are down. */
export async function stopHarness({ log = console.log } = {}) {
  const state = await readState();
  if (!state) {
    log("not running (no state file)");
    return true;
  }
  await stopPid(state.serverPid);
  await stopPid(state.mockPid);
  await rm(STATE_FILE, { force: true });
  const serverDown = !alive(state.serverPid);
  const mockDown = !alive(state.mockPid);
  log(
    `stopped (server ${serverDown ? "down" : "STILL ALIVE"}, mock ${mockDown ? "down" : "STILL ALIVE"})`,
  );
  return serverDown && mockDown;
}

function readRequestBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => resolve(raw));
    request.on("error", () => resolve(raw));
  });
}

/** Answer a chat completion with a streamed "pong". */
async function streamPong(request, response, headers = {}) {
  const raw = await readRequestBody(request);
  let model = "unknown";
  try {
    model = JSON.parse(raw).model ?? model;
  } catch {
    // Leave the default.
  }
  response.writeHead(200, { ...headers, "content-type": "text/event-stream" });
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id: "mock",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    })}\n\n`;
  response.write(chunk({ role: "assistant", content: "pong" }));
  response.write(chunk({}, "stop"));
  response.end("data: [DONE]\n\n");
}

/** Past the model-list header timeout and the body-read timeout (10 s each). */
const ACTUALYZE_STALL_MS = 12_000;

/** The bearer or `x-actualyze-api-key` key; the dedicated header wins, as on Actualyze. */
function actualyzeKeyOf(request) {
  const dedicated = request.headers["x-actualyze-api-key"];
  if (typeof dedicated === "string" && dedicated.length > 0) return dedicated;
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "");
  return match?.[1];
}

/**
 * Status, body, and extra headers for a scenario whose requests fail, in the
 * shapes Actualyze sends; undefined for scenarios that serve requests.
 * Unknown and missing keys get the opaque 401 of every rejected key.
 */
function actualyzeFailure(scenario, requestId) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  switch (scenario) {
    case undefined:
    case "revoked":
      return { status: 401, body: { error: "Authentication failed" } };
    case "forbidden":
      return {
        status: 403,
        body: {
          error: {
            message: "Access denied",
            type: "invalid_request_error",
            code: null,
            request_id: requestId,
          },
        },
      };
    case "budget":
      return {
        status: 402,
        body: {
          error: {
            message: "Budget required",
            type: "insufficient_quota",
            code: "insufficient_quota",
            request_id: requestId,
          },
        },
      };
    case "throttled":
    case "throttled_short": {
      const seconds = ACTUALYZE_MOCK_SCENARIOS[scenario].retryAfterSeconds;
      return {
        status: 429,
        headers: {
          "retry-after": String(seconds),
          "x-ratelimit-limit": "1000000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(nowSeconds + seconds),
        },
        body: {
          error: { message: "Rate limit exceeded", type: "rate_limit_error" },
        },
      };
    }
    case "5xx":
      return {
        status: 503,
        body: {
          error: {
            message: "Service temporarily unavailable",
            type: "server_error",
            request_id: requestId,
          },
        },
      };
    default:
      return undefined;
  }
}

/** The Actualyze `/openai/v1` mount; behavior is chosen by the request's key. */
async function serveActualyze(request, response, route) {
  const requestId = `req_mock_${randomBytes(6).toString("hex")}`;
  const scenario = mockScenarioForKey(actualyzeKeyOf(request));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const rateHeaders = {
    "x-ratelimit-limit": "1000000",
    "x-ratelimit-remaining": "999999",
    "x-ratelimit-reset": String(nowSeconds + 60),
  };
  const send = (code, body, headers = {}) => {
    response.writeHead(code, {
      "content-type": "application/json",
      "x-request-id": requestId,
      ...headers,
    });
    response.end(JSON.stringify(body));
  };
  const failure = actualyzeFailure(scenario, requestId);
  if (failure) {
    send(failure.status, failure.body, {
      ...(failure.status === 401 ? {} : rateHeaders),
      ...failure.headers,
    });
    return;
  }
  const models = scenario === "empty" ? [] : ACTUALYZE_MOCK_MODELS;

  if (request.method === "GET" && route === "/models") {
    const list = { object: "list", data: models };
    if (scenario === "slow") {
      await sleep(ACTUALYZE_STALL_MS);
      if (!response.destroyed) send(200, list, rateHeaders);
      return;
    }
    if (scenario === "slow_body") {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": requestId,
        ...rateHeaders,
      });
      const body = JSON.stringify(list);
      const half = Math.floor(body.length / 2);
      response.write(body.slice(0, half));
      await sleep(ACTUALYZE_STALL_MS);
      if (!response.destroyed) response.end(body.slice(half));
      return;
    }
    send(200, list, rateHeaders);
    return;
  }
  if (request.method === "GET" && route.startsWith("/models/")) {
    let id;
    try {
      id = decodeURIComponent(route.slice("/models/".length));
    } catch {
      id = "";
    }
    const model = models.find((entry) => entry.id === id);
    if (model) send(200, model, rateHeaders);
    else
      send(
        404,
        {
          error: {
            message: `The model '${id}' does not exist`,
            type: "invalid_request_error",
            param: "model",
            code: "model_not_found",
            request_id: requestId,
          },
        },
        rateHeaders,
      );
    return;
  }
  if (request.method === "POST" && route === "/chat/completions") {
    if (ACTUALYZE_MOCK_SCENARIOS[scenario].chatStatus === 403) {
      await readRequestBody(request);
      send(
        403,
        {
          error: {
            message: "This API key does not have write permission",
            type: "invalid_request_error",
            code: null,
            request_id: requestId,
          },
        },
        rateHeaders,
      );
      return;
    }
    await streamPong(request, response, {
      "x-request-id": requestId,
      ...rateHeaders,
    });
    return;
  }
  send(404, { error: { message: "not found", request_id: requestId } });
}

/**
 * One local server for both mocks: a minimal OpenAI-compatible server for
 * the generic probes under `/v1`, and the Actualyze mock under
 * `/openai/v1`. It writes nothing, so its log never holds a key.
 */
function mock(port) {
  const server = http.createServer((request, response) => {
    const send = (code, body) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const route = new URL(request.url ?? "/", `http://${HOST}`).pathname;
    if (route === "/openai/v1" || route.startsWith("/openai/v1/")) {
      serveActualyze(request, response, route.slice("/openai/v1".length)).catch(
        () => {
          if (!response.headersSent) send(500, { error: "mock failure" });
          else response.destroy();
        },
      );
      return;
    }
    if (request.method === "GET" && route === "/v1/models") {
      send(200, { object: "list", data: MOCK_MODELS });
      return;
    }
    if (request.method === "POST" && route === "/v1/chat/completions") {
      streamPong(request, response).catch(() => response.destroy());
      return;
    }
    send(404, { error: { message: "not found" } });
  });
  server.listen(port, HOST);
}

const USAGE =
  "usage: node scripts/live-harness.mjs <command>\n" +
  "  start [--actualyze-mock | --actualyze-refused] [--fresh]\n" +
  "  connect <scenario>   connect aai_pat_mock_<scenario> to the actualyze integration\n" +
  "  status\n" +
  "  stop\n" +
  `scenarios: ${Object.keys(ACTUALYZE_MOCK_SCENARIOS).join(", ")}\n` +
  "Build first with `npm run compile:dev` (or `npm run compile`).";

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "start": {
      const known = new Set([
        "--actualyze-mock",
        "--actualyze-refused",
        "--fresh",
      ]);
      const unknown = rest.filter((flag) => !known.has(flag));
      if (
        unknown.length > 0 ||
        (rest.includes("--actualyze-mock") &&
          rest.includes("--actualyze-refused"))
      ) {
        console.log(USAGE);
        process.exitCode = 1;
        break;
      }
      const ok = await startHarness({
        actualyze: rest.includes("--actualyze-mock")
          ? "mock"
          : rest.includes("--actualyze-refused")
            ? "refused"
            : "default",
        fresh: rest.includes("--fresh"),
      });
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case "connect": {
      const state = await readState();
      const scenario = rest[0];
      if (!state || !alive(state.serverPid)) {
        console.log("harness is not running; run start first");
        process.exitCode = 1;
      } else if (!Object.hasOwn(ACTUALYZE_MOCK_SCENARIOS, scenario ?? "")) {
        console.log(USAGE);
        process.exitCode = 1;
      } else {
        const code = await connectMockKey(state, mockKey(scenario));
        console.log(`connect mock key "${scenario}": HTTP ${code}`);
        process.exitCode = code >= 200 && code < 300 ? 0 : 1;
      }
      break;
    }
    case "stop":
      process.exitCode = (await stopHarness()) ? 0 : 1;
      break;
    case "status":
      await status();
      break;
    case "mock":
      mock(Number(rest[0] ?? MOCK_PORT));
      break;
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}
