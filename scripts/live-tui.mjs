#!/usr/bin/env node
// Live TUI scenarios: drives the installed `opencode --standalone` in the
// harness scratch tree through the tuistory library. Not shipped and not
// part of `npm run check`.
//
//   npm run compile:dev
//   node scripts/live-tui.mjs [--scenario <name>]... [--size 120x36|80x24]
//                             [--theme dark|light] [--screenshots <dir>] [--list]
//
// Without --scenario, --size, or --theme, every scenario runs at both sizes
// in both themes. Each run restarts the harness with `--fresh` and the
// scenario's Actualyze endpoint, connects the scenario's synthetic key (if
// any) through the server API, writes the theme to the scratch cli.json, and
// launches the TUI with the same isolated environment as the harness (`env
// -i`, HOME and XDG inside the scratch tree). The harness is stopped at the
// end; a harness that was already running is stopped first.
//
// Only synthetic `aai_pat_mock_<scenario>` keys are used: the runner refuses
// to start while ACTUALYZE_API_KEY_FILE or ACTUALYZE_BASE_URL is set. After
// a key is submitted (through setup or a `submitKey` step), every screen the
// runner reads must not contain it, and at the end of each run neither may
// the server logs, the harness server's RPC catalog payload, or the saved
// screenshots (PNG bytes and their text snapshots). A key connected during
// setup was never typed, so the TUI's whole output stream must not contain
// it either. The standalone TUI runs its own private server, which reads the
// same scratch credentials; its RPC traffic is not observable from outside,
// so the payload check reads the harness server's catalog.
//
// Adding a scenario: append an entry to SCENARIOS.
//
//   {
//     name: "kebab-case-name",
//     description: "what the scenario proves",
//     actualyze: "default" | "mock" | "refused",   // harness start mode
//     connect: "ok",                  // optional ACTUALYZE_MOCK_SCENARIOS key
//     sizes: ["120x36"],              // optional subset of SIZES
//     steps: [
//       { command: "/modelscout" },   // type a slash command and press enter
//       { wait: "Model Scout" },      // string or RegExp, optional timeout
//       { expect: /Mock compat/ },    // present on the current screen
//       { expectNot: "error" },       // absent from the current screen
//       { expectColor: { color: "brand", text: "ACTUALYZE" } },
//       { type: "abc" }, { press: "esc" }, { press: ["ctrl", "p"] },
//       { submitKey: "revoked" },     // type the synthetic key, press enter
//       { resize: "across" },         // cross 120 columns; "restore" undoes it
//       { waitGone: "Model Scout" },
//       { screenshot: "label" },      // saved only with --screenshots
//       { sleep: 500 },
//       { run: async (ctx) => {} },   // anything else; ctx.check(label, ok)
//     ],
//     catalog: (payload, ctx) => {},  // optional checks on the RPC payload
//   }
//
// Each step may carry `label` for the report and `timeout` (ms) for waits.
// `expectColor` matches screen text whose foreground is exactly `color`;
// "brand" is #a855f7 in the dark theme and #7c3aed in the light theme.

import { Buffer } from "node:buffer";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchTerminal } from "tuistory";
import { validateCatalogPayload } from "../src/catalog-evidence.ts";
import {
  ACTUALYZE_MOCK_SCENARIOS,
  CLI_CONFIG,
  LOGS,
  PROJECT,
  XDG,
  api,
  connectMockKey,
  envArgv,
  isolatedEnv,
  mockKey,
  readState,
  startHarness,
  stopHarness,
} from "./live-harness.mjs";

const PLUGIN_ID = "opencode-model-scout";
const SIZES = {
  "120x36": { cols: 120, rows: 36 },
  "80x24": { cols: 80, rows: 24 },
};
const THEMES = ["dark", "light"];
const BRAND = { dark: "#a855f7", light: "#7c3aed" };
/** The home screen's prompt placeholder; the TUI is ready once it shows. */
const READY = /Ask anything/;
const READY_TIMEOUT_MS = 45_000;
const WAIT_TIMEOUT_MS = 15_000;
const CATALOG_SETTLE_MS = 30_000;

/**
 * Rows of the `/actualyze` dialog on screen: from the `● ACTUALYZE` header
 * to the footer that ends in `close esc`, and the blank rows just above the
 * footer.
 */
function dialogRows(text) {
  const lines = text.split("\n");
  const top = lines.findIndex((line) => line.includes("● ACTUALYZE"));
  const bottom = lines.findIndex(
    (line, index) => index > top && /close esc\s*$/.test(line.trimEnd()),
  );
  if (top < 0 || bottom < 0) throw new Error("no /actualyze dialog on screen");
  let blank = 0;
  for (let index = bottom - 1; index > top && !lines[index].trim(); index -= 1)
    blank += 1;
  return { span: bottom - top + 1, blank };
}

/** A card-only state takes the rows it needs: at most two blank rows before the footer. */
const COMPACT_CARD = {
  label: "the card is not padded with empty rows",
  run: async (ctx) => {
    const { blank } = dialogRows(await ctx.session.text());
    if (blank > 2) throw new Error(`${blank} blank rows above the footer`);
  },
};

/** The list views keep the full dialog height, `min(30, rows - 4)` content rows. */
const FULL_LIST = {
  label: "the list view takes the full dialog height",
  run: async (ctx) => {
    const { span } = dialogRows(await ctx.session.text());
    // Header through footer: the content rows less the bottom padding row.
    const want = Math.min(30, ctx.size.rows - 4) - 1;
    if (span !== want)
      throw new Error(`dialog spans ${span} rows, not ${want}`);
  },
};

/**
 * Every scenario the runner knows, for `/modelscout`, `/actualyze`, and
 * startup. `--scenario` selects a subset by name.
 */
const SCENARIOS = [
  {
    name: "startup",
    description:
      "zero config: the TUI starts with the plugin, no key is connected, and discovery never tries actualyze",
    actualyze: "default",
    steps: [{ expect: READY }, { screenshot: "home" }],
    catalog: (payload, ctx) => {
      ctx.check(
        "catalog has no actualyze record",
        !payload.providers.some((provider) => provider.id === "actualyze"),
      );
      ctx.check(
        "catalog has a mock-compat record",
        payload.providers.some((provider) => provider.id === "mock-compat"),
      );
    },
  },
  {
    name: "modelscout-mock-compat",
    description:
      "/modelscout opens, lists mock-compat with its declared tiered model, survives a resize across 120 columns, and closes",
    actualyze: "default",
    steps: [
      { command: "/modelscout" },
      { wait: "Model Scout" },
      { wait: "Mock compat" },
      { wait: "Mock Llama 3.1 8B" },
      { expect: "Mock Tiered Pro" },
      { screenshot: "open" },
      { resize: "across" },
      { wait: "Model Scout", label: "dialog still open after resize" },
      { expect: "Mock compat" },
      { screenshot: "resized" },
      { resize: "restore" },
      { wait: "Model Scout" },
      { press: "esc" },
      { waitGone: "Model Scout" },
      { expect: READY },
    ],
  },
  {
    name: "modelscout-actualyze-mock",
    description:
      "with the mock's ok key connected, /modelscout lists the Actualyze catalog and the key never surfaces",
    actualyze: "mock",
    connect: "ok",
    steps: [
      { command: "/modelscout" },
      { wait: "Model Scout" },
      { wait: "Actualyze" },
      { wait: "Claude Haiku" },
      { expect: "GPT OSS 120B" },
      { screenshot: "open" },
      { press: "esc" },
      { waitGone: "Model Scout" },
    ],
    catalog: (payload, ctx) => {
      const record = payload.providers.find(
        (provider) => provider.id === "actualyze",
      );
      ctx.check(
        "catalog actualyze record discovered with the connection",
        record?.credentialSource === "connection" &&
          record.failure === null &&
          record.models.length > 0,
      );
    },
  },
  {
    name: "actualyze-no-key",
    description:
      "zero config: /actualyze shows the connect card on the built-in origin with the brand wordmark, opens the links screen, and probes nothing",
    actualyze: "default",
    steps: [
      { command: "/actualyze" },
      { wait: "ACTUALYZE" },
      { wait: "Not connected" },
      { expect: "app.actualyze.ai" },
      { expectNot: "custom endpoint" },
      { expectColor: { color: "brand", text: "ACTUALYZE" } },
      { expect: "Connect an Actualyze API key" },
      COMPACT_CARD,
      { expect: /connect key k/ },
      { screenshot: "no-key" },
      { press: "l" },
      { wait: "Links ·" },
      {
        expect: "https://app.actualyze.ai/account/settings?tab=security",
      },
      { expect: "Budgets may need an admin role" },
      { press: "down" },
      { press: "y" },
      {
        // At 80 columns the notice ends in "…" after the path.
        wait: /Copy sent to terminal: https:\/\/app\.actualyze\.ai\/control\/catalog|OSC 52\) is unavailable/,
        label: "y copies the selected Catalog link",
      },
      { screenshot: "links" },
      { press: "backspace" },
      { wait: "Connect an Actualyze API key" },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
      { expect: READY },
    ],
    catalog: (payload, ctx) => {
      ctx.check(
        "catalog has no actualyze record",
        !payload.providers.some((provider) => provider.id === "actualyze"),
      );
      ctx.check(
        "catalog reports the built-in actualyze as managed",
        payload.builtIn.actualyze === "managed",
      );
    },
  },
  {
    name: "actualyze-connect-key",
    description:
      "the k flow: the prompt opens empty, the synthetic key is submitted, and the dialog returns ready with the catalog",
    actualyze: "mock",
    steps: [
      { command: "/actualyze" },
      { wait: "ACTUALYZE" },
      { wait: "Not connected" },
      COMPACT_CARD,
      { press: "k" },
      { wait: "Actualyze API key" },
      { expect: "The key is visible while you type" },
      { expectNot: /aai_pat_/, label: "the key prompt opens empty" },
      { submitKey: "ok" },
      { wait: "ACTUALYZE", label: "the dialog shows again after submit" },
      { wait: "Catalog accessible", timeout: 45_000 },
      { wait: "Claude Haiku" },
      { ...FULL_LIST, label: "the dialog grows from the card to the list" },
      { expect: /another key k/ },
      { screenshot: "ready" },
      { press: "b" },
      { wait: "Model Scout", label: "b opens /modelscout" },
      { press: "a" },
      { wait: "ACTUALYZE", label: "a returns to /actualyze" },
      { wait: "Catalog accessible" },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
    ],
    // The key went to the standalone TUI's own server; the harness server
    // read its credentials before, so its catalog says nothing about it.
  },
  {
    name: "actualyze-connect-checking",
    description:
      "a key submitted through the TUI shows the saved-and-checking card until the catalog answers for it, here with a timeout",
    actualyze: "mock",
    steps: [
      { command: "/actualyze" },
      { wait: "Not connected" },
      { press: "k" },
      { wait: "Actualyze API key" },
      { submitKey: "slow" },
      { wait: "Key saved. Checking the current connection" },
      { expect: "no inference request" },
      { screenshot: "checking" },
      { wait: "did not answer in time", timeout: 45_000 },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
    ],
  },
  {
    name: "actualyze-revoked",
    description: "a revoked key: the 401 card with the key and link actions",
    actualyze: "mock",
    connect: "revoked",
    steps: [
      { command: "/actualyze" },
      { wait: "ACTUALYZE" },
      { wait: "Key rejected (401)", timeout: 30_000 },
      COMPACT_CARD,
      { expect: "Actualyze did not accept this key" },
      { expect: /another key k/ },
      { expect: /copy API keys link y/ },
      { expect: /connections c/ },
      { expectColor: { color: "brand", text: "ACTUALYZE" } },
      { screenshot: "revoked" },
      { press: "l" },
      { wait: "Links ·" },
      { screenshot: "links-after-401" },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
    ],
  },
  {
    name: "actualyze-forbidden",
    description: "a 403 answer: the access-denied card",
    actualyze: "mock",
    connect: "forbidden",
    steps: [
      { command: "/actualyze" },
      { wait: "Access denied (403)", timeout: 30_000 },
      { expect: "refused the model list request" },
      { expectNot: /read-only/i },
      { screenshot: "forbidden" },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
    ],
  },
  {
    name: "actualyze-budget",
    description:
      "a 402 answer: the budget card, with no balance or reset claimed",
    actualyze: "mock",
    connect: "budget",
    steps: [
      { command: "/actualyze" },
      { wait: "Budget or entitlement blocked (402)", timeout: 30_000 },
      { expect: "No balance or reset date" },
      { expect: /copy Budgets link y/ },
      { screenshot: "budget" },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
    ],
  },
  {
    name: "actualyze-throttled",
    description:
      "a 429 with Retry-After 90: a catalog rate-limit card whose countdown runs",
    actualyze: "mock",
    connect: "throttled",
    steps: [
      { command: "/actualyze" },
      { wait: /Catalog rate limited · retry in \d+ s/, timeout: 30_000 },
      { expect: "not inference" },
      { screenshot: "throttled" },
      {
        label: "the countdown decreases",
        run: async (ctx) => {
          const read = async () =>
            Number(
              /retry in (\d+) s/.exec(await ctx.session.text())?.[1] ?? NaN,
            );
          const first = await read();
          await sleep(3_000);
          const second = await read();
          if (!(first > second && first - second <= 5))
            throw new Error(`countdown ${first} → ${second}`);
        },
      },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
    ],
  },
  {
    name: "actualyze-server-error",
    description: "a 503 answer: the server-error card",
    actualyze: "mock",
    connect: "5xx",
    steps: [
      { command: "/actualyze" },
      { wait: "Actualyze server error (503)", timeout: 30_000 },
      { expect: /retry( in \d+ s)? r/ },
      { screenshot: "server-error" },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
    ],
  },
  {
    name: "actualyze-slow",
    description:
      "no response headers within the list timeout: the timeout card, not a refused connection",
    actualyze: "mock",
    connect: "slow",
    steps: [
      { command: "/actualyze" },
      { wait: "did not answer in time", timeout: 45_000 },
      { expectNot: "Can't reach" },
      { screenshot: "slow" },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
    ],
  },
  {
    name: "actualyze-unreachable",
    description: "a refused port: the can't-reach card",
    actualyze: "refused",
    connect: "ok",
    steps: [
      { command: "/actualyze" },
      { wait: "Can't reach", timeout: 30_000 },
      { expect: "custom endpoint" },
      { screenshot: "unreachable" },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
    ],
  },
  {
    name: "actualyze-empty",
    description: "an empty catalog: accessible, no models for this key",
    actualyze: "mock",
    connect: "empty",
    steps: [
      { command: "/actualyze" },
      { wait: "no models for this key", timeout: 30_000 },
      { expect: "Catalog accessible" },
      { screenshot: "empty" },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
    ],
  },
  {
    name: "actualyze-readonly",
    description:
      "a read-only key lists models: the ready view says catalog accessible and never claims inference works",
    actualyze: "mock",
    connect: "readonly",
    steps: [
      { command: "/actualyze" },
      { wait: "Catalog accessible", timeout: 30_000 },
      { wait: "Claude Haiku" },
      { expectNot: /Connected|inference works/ },
      { expect: /another key k/ },
      {
        label: "the status line lists k, l, c, and b where they fit",
        run: async (ctx) => {
          if (ctx.size.cols < 120) return;
          const text = await ctx.session.text();
          for (const hint of ["links l", "connections c", "all providers b"])
            if (!text.includes(hint)) throw new Error(`no "${hint}"`);
        },
      },
      { screenshot: "readonly" },
      { press: "?" },
      { wait: "Keys · Actualyze" },
      { expect: "connect a key through OpenCode's key prompt" },
      { expect: "OpenCode's connections (pick Actualyze)" },
      { expect: "every provider (/modelscout)" },
      { screenshot: "keys" },
      { press: "backspace" },
      { wait: "Claude Haiku" },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
    ],
  },
  {
    name: "actualyze-custom-endpoint",
    description:
      "--actualyze-mock: the header shows the custom endpoint badge and the mock origin, and links use that origin",
    actualyze: "mock",
    connect: "ok",
    steps: [
      { command: "/actualyze" },
      { wait: "ACTUALYZE" },
      { wait: "custom endpoint" },
      { expect: "http://127.0.0.1:" },
      { wait: "Catalog accessible", timeout: 30_000 },
      { wait: "Claude Haiku" },
      FULL_LIST,
      { expectColor: { color: "brand", text: "ACTUALYZE" } },
      { screenshot: "custom-endpoint" },
      { press: "l" },
      { wait: "Links ·" },
      { ...COMPACT_CARD, label: "the dialog shrinks from the list to links" },
      { expect: /http:\/\/127\.0\.0\.1:\d+\/account\/settings\?tab=security/ },
      { expectNot: "https://app.actualyze.ai" },
      { screenshot: "links" },
      { press: "backspace" },
      { wait: "Claude Haiku" },
      { ...FULL_LIST, label: "the dialog grows back from links to the list" },
      { press: "esc" },
      { waitGone: "ACTUALYZE" },
    ],
  },
];

// ── Arguments ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { scenarios: [], sizes: [], themes: [], screenshots: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--scenario":
        options.scenarios.push(value);
        index += 1;
        break;
      case "--size":
        if (!Object.hasOwn(SIZES, value ?? ""))
          throw new Error(`--size takes ${Object.keys(SIZES).join(" or ")}`);
        options.sizes.push(value);
        index += 1;
        break;
      case "--theme":
        if (!THEMES.includes(value))
          throw new Error(`--theme takes ${THEMES.join(" or ")}`);
        options.themes.push(value);
        index += 1;
        break;
      case "--screenshots":
        if (!value) throw new Error("--screenshots takes a directory");
        options.screenshots = path.resolve(value);
        index += 1;
        break;
      case "--list":
        options.list = true;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return options;
}

// ── Reporting ───────────────────────────────────────────────────────────

let passes = 0;
let failures = 0;

function check(label, ok, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? ` ${detail}` : ""}`,
  );
  return ok;
}

/** Replace every synthetic key with a placeholder before printing. */
function redact(text, keys) {
  let result = text;
  for (const key of keys) result = result.split(key).join("[synthetic key]");
  return result;
}

function describePattern(pattern) {
  return pattern instanceof RegExp ? String(pattern) : JSON.stringify(pattern);
}

function matches(text, pattern) {
  return pattern instanceof RegExp
    ? pattern.test(text)
    : text.includes(pattern);
}

function stepLabel(step) {
  if (step.label) return step.label;
  const [kind] = Object.keys(step).filter(
    (key) => key !== "label" && key !== "timeout",
  );
  const value = step[kind];
  if (kind === "run") return "run";
  if (kind === "submitKey") return `submitKey ${value}`;
  if (kind === "expectColor")
    return `expectColor ${value.color} ${describePattern(value.text)}`;
  return `${kind} ${typeof value === "string" || value instanceof RegExp ? describePattern(value) : JSON.stringify(value)}`;
}

// ── Environment ─────────────────────────────────────────────────────────

/** The TUI settings for a run: a fixed theme mode and no startup extras. */
async function writeCliConfig(theme) {
  await mkdir(path.dirname(CLI_CONFIG), { recursive: true, mode: 0o700 });
  await writeFile(
    CLI_CONFIG,
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/v2/cli.json",
        theme: { mode: theme },
        highlights: false,
        animations: false,
        attention: { notifications: false, sound: false },
      },
      null,
      2,
    )}\n`,
  );
}

/** Every log file the server, the standalone TUI, and the mock write. */
async function logFiles() {
  const roots = [LOGS, XDG.XDG_DATA_HOME, XDG.XDG_STATE_HOME];
  const files = [];
  const walk = async (directory, inLogDirectory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full, inLogDirectory || /^logs?$/.test(entry.name));
      } else if (inLogDirectory || entry.name.endsWith(".log")) {
        files.push(full);
      }
    }
  };
  for (const root of roots) await walk(root, root === LOGS);
  return files;
}

let renderImage;
/** ghostty-opentui's PNG renderer, resolved through tuistory's own dependency. */
async function imageRenderer() {
  if (!renderImage) {
    const require = createRequire(
      fileURLToPath(import.meta.resolve("tuistory")),
    );
    const module = await import(
      pathToFileURL(require.resolve("ghostty-opentui/image")).href
    );
    renderImage = module.renderTerminalToImage;
  }
  return renderImage;
}

/** The dominant cell background on screen, as a 0..1 relative luminance. */
function backgroundLuminance(session) {
  const counts = new Map();
  for (const line of session.getTerminalData().lines) {
    for (const span of line.spans) {
      if (typeof span.bg !== "string") continue;
      counts.set(span.bg, (counts.get(span.bg) ?? 0) + span.width);
    }
  }
  const [dominant] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(
    dominant ?? "",
  );
  if (!match) return undefined;
  const [r, g, b] = match.slice(1).map((hex) => parseInt(hex, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function readCatalog(state) {
  const { status, json } = await api(
    state,
    "POST",
    `/api/rpc/${PLUGIN_ID}/catalog`,
    { input: {} },
  );
  return { status, json, payload: validateCatalogPayload(json?.output) };
}

/** Wait until the harness server's catalog is complete, so checks see settled records. */
async function settledCatalog(state) {
  const deadline = Date.now() + CATALOG_SETTLE_MS;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await readCatalog(state);
      if (last.payload?.status === "complete") return last;
    } catch {
      // Not answering yet.
    }
    await sleep(500);
  }
  return last;
}

// ── Steps ───────────────────────────────────────────────────────────────

async function waitGone(session, pattern, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!matches(await session.text(), pattern)) return;
    await sleep(100);
  }
  throw new Error(`still visible after ${timeout} ms`);
}

async function runStep(step, ctx) {
  const { session } = ctx;
  const timeout = step.timeout ?? WAIT_TIMEOUT_MS;
  if ("command" in step) {
    await session.type(step.command);
    await session.waitIdle();
    await session.press("enter");
  } else if ("type" in step) {
    await session.type(step.type);
  } else if ("press" in step) {
    await session.press(step.press);
  } else if ("wait" in step) {
    await session.waitForText(step.wait, { timeout });
  } else if ("waitGone" in step) {
    await waitGone(session, step.waitGone, timeout);
  } else if ("expect" in step) {
    if (!matches(await session.text(), step.expect))
      throw new Error("not on screen");
  } else if ("expectNot" in step) {
    if (matches(await session.text(), step.expectNot))
      throw new Error("on screen");
  } else if ("expectColor" in step) {
    const { color, text } = step.expectColor;
    const foreground = color === "brand" ? BRAND[ctx.theme] : color;
    const colored = await session.text({ only: { foreground } });
    if (!matches(colored, text))
      throw new Error(`no ${foreground} text matches`);
  } else if ("submitKey" in step) {
    const key = mockKey(step.submitKey);
    ctx.keys.add(key);
    await session.type(key);
    await session.press("enter");
    ctx.submitted.add(key);
  } else if ("resize" in step) {
    const size =
      step.resize === "restore"
        ? ctx.size
        : step.resize === "across"
          ? {
              cols: ctx.size.cols >= 120 ? 100 : 130,
              rows: ctx.size.rows,
            }
          : step.resize;
    session.resize(size);
    await session.waitIdle();
  } else if ("screenshot" in step) {
    await saveScreenshot(ctx, step.screenshot);
  } else if ("sleep" in step) {
    await sleep(step.sleep);
  } else if ("run" in step) {
    await step.run(ctx);
  } else {
    throw new Error("unknown step");
  }
}

async function saveScreenshot(ctx, label) {
  if (!ctx.screenshotsDir) return;
  const base = path.join(ctx.screenshotsDir, `${ctx.runName}-${label}`);
  const text = await ctx.session.text({ trimEnd: true });
  const render = await imageRenderer();
  const image = await render(ctx.session.getTerminalData(), {
    fontSize: 14,
    lineHeight: 1.5,
    paddingX: 16,
    paddingY: 16,
  });
  await writeFile(`${base}.txt`, `${text}\n`);
  await writeFile(`${base}.png`, image);
  ctx.screenshots.push(`${base}.txt`, `${base}.png`);
}

/** No submitted key on the current screen. */
async function checkScreen(ctx, where) {
  if (ctx.submitted.size === 0) return true;
  const text = await ctx.session.text();
  const leaked = [...ctx.submitted].some((key) => text.includes(key));
  if (leaked) check(`${ctx.runName}: no key on screen ${where}`, false);
  return !leaked;
}

// ── Runs ────────────────────────────────────────────────────────────────

async function runScenario(scenario, sizeName, theme, screenshotsDir) {
  const runName = `${scenario.name}-${sizeName}-${theme}`;
  const size = SIZES[sizeName];
  console.log(`== ${runName}: ${scenario.description}`);
  const quiet = [];
  await stopHarness({ log: () => {} });
  const started = await startHarness({
    actualyze: scenario.actualyze ?? "default",
    fresh: true,
    log: (line) => quiet.push(line),
  });
  if (!check(`${runName}: harness starts`, started, `(${quiet.at(-1)})`))
    return;
  const state = await readState();
  await writeCliConfig(theme);

  const ctx = {
    runName,
    scenario,
    size,
    theme,
    state,
    screenshotsDir,
    screenshots: [],
    keys: new Set(),
    submitted: new Set(),
    /** Keys that were never typed: the whole output stream must lack them. */
    untyped: new Set(),
    check: (label, ok, detail) => check(`${runName}: ${label}`, ok, detail),
  };
  if (scenario.connect) {
    const key = mockKey(scenario.connect);
    ctx.keys.add(key);
    const status = await connectMockKey(state, key);
    if (
      !check(
        `${runName}: connect mock key "${scenario.connect}"`,
        status === 204,
        `(HTTP ${status})`,
      )
    )
      return;
    ctx.submitted.add(key);
    ctx.untyped.add(key);
  }

  const session = await launchTerminal({
    command: "/usr/bin/env",
    args: envArgv(
      isolatedEnv({ TERM: "xterm-256color", COLORTERM: "truecolor" }),
      ["--standalone", PROJECT],
    ),
    cols: size.cols,
    rows: size.rows,
    cwd: PROJECT,
  });
  ctx.session = session;
  try {
    let ok = true;
    try {
      await session.waitForText(READY, { timeout: READY_TIMEOUT_MS });
      check(`${runName}: TUI ready`, true);
    } catch {
      ok = check(`${runName}: TUI ready`, false);
    }
    if (ok) {
      const luminance = backgroundLuminance(session);
      check(
        `${runName}: ${theme} theme applied`,
        luminance !== undefined &&
          (theme === "dark" ? luminance < 0.5 : luminance >= 0.5),
        `(background luminance ${luminance?.toFixed(2)})`,
      );
      ok = await checkScreen(ctx, "at start");
    }
    for (const step of ok ? scenario.steps : []) {
      const label = redact(stepLabel(step), ctx.keys);
      try {
        await runStep(step, ctx);
        ok = await checkScreen(ctx, `after ${label}`);
        if (!ok) break;
      } catch (error) {
        const screen = redact(await session.text({ trimEnd: true }), ctx.keys);
        const reason = redact(String(error?.message ?? error), ctx.keys);
        check(`${runName}: ${label}`, false, `(${reason})\n${screen}`);
        ok = false;
        break;
      }
    }
    if (ok) check(`${runName}: ${scenario.steps.length} steps`, true);
    const stream = session.readAll();
    for (const key of ctx.untyped)
      check(
        `${runName}: connected key never in TUI output`,
        !stream.includes(key),
      );
  } finally {
    session.close();
  }
  await session.waitForExit?.(5_000);

  const settled = await settledCatalog(state);
  if (
    check(
      `${runName}: harness catalog passes the v5 validator`,
      settled?.payload !== undefined,
      `(HTTP ${settled?.status})`,
    )
  ) {
    if (scenario.catalog) scenario.catalog(settled.payload, ctx);
  }
  if (ctx.keys.size > 0) {
    const raw = JSON.stringify(settled?.json ?? null);
    check(
      `${runName}: no key in the RPC catalog payload`,
      ![...ctx.keys].some((key) => raw.includes(key)),
    );
    const leakedIn = [];
    for (const file of [...(await logFiles()), ...ctx.screenshots]) {
      const content = await readFile(file).catch(() => Buffer.alloc(0));
      if ([...ctx.keys].some((key) => content.includes(key)))
        leakedIn.push(path.relative(path.dirname(LOGS), file));
    }
    check(
      `${runName}: no key in server logs or screenshots`,
      leakedIn.length === 0,
      `(${leakedIn.join(", ")})`,
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────────

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.log(error.message);
  process.exit(1);
}
if (options.list) {
  for (const scenario of SCENARIOS)
    console.log(`${scenario.name}: ${scenario.description}`);
  process.exit(0);
}
if (process.env.ACTUALYZE_API_KEY_FILE || process.env.ACTUALYZE_BASE_URL) {
  console.log(
    "unset ACTUALYZE_API_KEY_FILE and ACTUALYZE_BASE_URL: TUI scenarios use only synthetic mock keys",
  );
  process.exit(1);
}
for (const scenario of SCENARIOS) {
  if (
    scenario.connect &&
    !Object.hasOwn(ACTUALYZE_MOCK_SCENARIOS, scenario.connect)
  ) {
    console.log(`${scenario.name}: unknown mock key "${scenario.connect}"`);
    process.exit(1);
  }
}
const unknown = options.scenarios.filter(
  (name) => !SCENARIOS.some((scenario) => scenario.name === name),
);
if (unknown.length > 0) {
  console.log(`unknown scenario: ${unknown.join(", ")} (see --list)`);
  process.exit(1);
}
const selected = SCENARIOS.filter(
  (scenario) =>
    options.scenarios.length === 0 || options.scenarios.includes(scenario.name),
);
if (options.screenshots) await mkdir(options.screenshots, { recursive: true });
const existing = await readState();
if (existing) console.log("note: stopping the running harness first");
try {
  for (const scenario of selected) {
    const sizes = (
      options.sizes.length > 0 ? options.sizes : Object.keys(SIZES)
    ).filter((size) => !scenario.sizes || scenario.sizes.includes(size));
    const themes = options.themes.length > 0 ? options.themes : THEMES;
    for (const size of sizes)
      for (const theme of themes)
        await runScenario(scenario, size, theme, options.screenshots);
  }
} finally {
  await stopHarness({ log: () => {} });
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
