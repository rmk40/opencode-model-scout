#!/usr/bin/env node
// Live harness: runs the real installed `opencode` against <repo>/dist in an
// isolated scratch tree. Not shipped and not part of `npm run check`.
//
//   npm run compile:dev           # or `npm run compile`; this script never builds
//   node scripts/live-harness.mjs start
//   node scripts/live-check.mjs
//   node scripts/live-harness.mjs status
//   node scripts/live-harness.mjs stop
//
// Environment:
//   SCOUT_HARNESS_DIR        scratch tree (default: <os tmpdir>/opencode-model-scout-harness)
//   ACTUALYZE_API_KEY_FILE   file holding an inference-scoped Actualyze key
//   ACTUALYZE_BASE_URL       optional Actualyze endpoint, e.g. http://localhost:3001/openai/v1
//                            (default: the plugin's built-in production endpoint)
//   OPENCODE_BIN             opencode executable (default: first `opencode` on PATH)
//
// The Actualyze checks use the plugin's built-in `actualyze` provider. The
// key reaches the server only as ACTUALYZE_API_KEY in its environment, so
// discovery and chat go through the integration credential; it is never
// written to the config, the state file, a log, or a command line. With
// ACTUALYZE_BASE_URL the config sets only `settings.baseURL`. Without
// ACTUALYZE_API_KEY_FILE the provider must stay hidden.
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

const XDG = {
  HOME: path.join(HARNESS, "home"),
  XDG_CONFIG_HOME: path.join(HARNESS, "xdg", "config"),
  XDG_DATA_HOME: path.join(HARNESS, "xdg", "data"),
  XDG_CACHE_HOME: path.join(HARNESS, "xdg", "cache"),
  XDG_STATE_HOME: path.join(HARNESS, "xdg", "state"),
};
const LOGS = path.join(HARNESS, "logs");
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const HOST = "127.0.0.1";
const SERVER_PORT = Number(process.env.SCOUT_HARNESS_PORT ?? 47931);
const MOCK_PORT = Number(process.env.SCOUT_HARNESS_MOCK_PORT ?? 47932);

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

/** Models served by the `mock-compat` provider (vLLM-shaped list entries). */
export const MOCK_MODELS = [
  { id: "mock-llama-3.1-8b", max_model_len: 131072 },
  { id: "mock-qwen2.5-coder-7b", max_model_len: 32768 },
  { id: "mock-nomic-embed-text", max_model_len: 8192 },
].map((model) => ({
  ...model,
  object: "model",
  created: 1_700_000_000,
  owned_by: "vllm",
  root: model.id,
}));

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

function harnessConfig() {
  return {
    $schema: "https://opencode.ai/config.json",
    plugins: [path.join(REPO, "dist")],
    providers: {
      ...(ACTUALYZE_ENABLED && ACTUALYZE_BASE_URL
        ? {
            [ACTUALYZE_PROVIDER]: { settings: { baseURL: ACTUALYZE_BASE_URL } },
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

async function start() {
  const existing = await readState();
  if (existing && (alive(existing.serverPid) || alive(existing.mockPid))) {
    console.log(`already running at ${existing.url}; run stop first`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(path.join(REPO, "dist", "server.js"))) {
    console.log("dist/server.js is missing; run `npm run compile:dev` first");
    process.exitCode = 1;
    return;
  }
  try {
    opencodeBinary();
  } catch (error) {
    console.log(error.message);
    process.exitCode = 1;
    return;
  }
  let actualyzeKey;
  if (!ACTUALYZE_ENABLED) {
    console.log(
      "note: ACTUALYZE_API_KEY_FILE is not set; the Actualyze provider stays hidden",
    );
  } else {
    actualyzeKey = await readActualyzeKey();
    if (!actualyzeKey)
      console.log(`warning: ${ACTUALYZE_API_KEY_FILE} is missing or empty`);
  }

  await rm(LOGS, { recursive: true, force: true });
  for (const directory of [...Object.values(XDG), LOGS, PROJECT]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await mkdir(path.join(PROJECT, ".opencode"), { recursive: true });
  await writeFile(
    path.join(PROJECT, ".opencode", "opencode.json"),
    `${JSON.stringify(harnessConfig(), null, 2)}\n`,
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
        console.log(`started ${state.url} (server pid ${serverPid})`);
        console.log(`mock-compat at ${state.mockUrl} (pid ${mockPid})`);
        console.log(
          actualyzeKey
            ? `actualyze key via ACTUALYZE_API_KEY, endpoint ${ACTUALYZE_BASE_URL ?? "built-in"}`
            : "actualyze has no key",
        );
        console.log(`project ${PROJECT}`);
        console.log(`logs ${LOGS}`);
        return;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  console.log(`server did not come up; see ${path.join(LOGS, "serve.log")}`);
  process.exitCode = 1;
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

async function stop() {
  const state = await readState();
  if (!state) {
    console.log("not running (no state file)");
    return;
  }
  await stopPid(state.serverPid);
  await stopPid(state.mockPid);
  await rm(STATE_FILE, { force: true });
  console.log(
    `stopped (server ${alive(state.serverPid) ? "STILL ALIVE" : "down"}, mock ${alive(state.mockPid) ? "STILL ALIVE" : "down"})`,
  );
}

/** Minimal OpenAI-compatible mock for the generic probes. */
function mock(port) {
  const server = http.createServer((request, response) => {
    const send = (code, body) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/v1/models") {
      send(200, { object: "list", data: MOCK_MODELS });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        let model = "unknown";
        try {
          model = JSON.parse(raw).model ?? model;
        } catch {
          // Leave the default.
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
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
      });
      return;
    }
    send(404, { error: { message: "not found" } });
  });
  server.listen(port, HOST);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [command, argument] = process.argv.slice(2);
  switch (command) {
    case "start":
      await start();
      break;
    case "stop":
      await stop();
      break;
    case "status":
      await status();
      break;
    case "mock":
      mock(Number(argument ?? MOCK_PORT));
      break;
    default:
      console.log(
        "usage: node scripts/live-harness.mjs <start|stop|status>\n" +
          "Build first with `npm run compile:dev` (or `npm run compile`).",
      );
      process.exitCode = command ? 1 : 0;
  }
}
