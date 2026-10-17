/**
 * Embedded-host E2E for the catalog's status fields: failure kinds from a
 * real HTTP server, credential sources, refresh throttling, the `status`
 * event, the built-in signal, and an Actualyze key connected at runtime.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { OpenCode } from "@opencode/sdk";
import { actualyzeProviderInfo } from "../../src/actualyze";
import {
  validateCatalogPayload,
  type CatalogPayload,
  type CatalogProviderRecord,
} from "../../src/catalog-evidence";
import { ModelScoutRpc } from "../../src/rpc";
import plugin from "../../src/server";

const PRODUCTION_ORIGIN = "https://app.actualyze.ai";
const KEY_ONE = "catalog-status-key-one";
const KEY_TWO = "catalog-status-key-two";
const HEADER_KEY = "catalog-status-header-key";

const ACTUALYZE_MODELS = [
  {
    id: "claude-sonnet-4-6",
    object: "model",
    created: 1_760_000_000,
    owned_by: "actualyze",
    context_window: 1_000_000,
    max_output_tokens: 64_000,
    capabilities: { vision: true, tool_use: true, thinking: true },
    modalities: { input: ["text", "image"], output: ["text"] },
  },
];

const COMPAT_MODELS = [
  {
    id: "mock-llama",
    object: "model",
    created: 1_700_000_000,
    owned_by: "vllm",
  },
];

const authorizations: string[] = [];
let productionRequests = 0;
let server: http.Server;
let mockURL: string;
let refusedURL: string;

function startMock(): Promise<void> {
  server = http.createServer((request, response) => {
    const url = request.url ?? "";
    const authorization = String(request.headers.authorization ?? "");
    authorizations.push(authorization);
    const send = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ) => {
      response.writeHead(status, {
        "content-type": "application/json",
        ...headers,
      });
      response.end(JSON.stringify(body));
    };
    if (url === "/actualyze/openai/v1/models") {
      const header = request.headers["x-actualyze-api-key"];
      const known = [KEY_ONE, KEY_TWO].map((key) => `Bearer ${key}`);
      return known.includes(authorization) || header === HEADER_KEY
        ? send(200, { object: "list", data: ACTUALYZE_MODELS })
        : send(401, { error: { message: "invalid key" } });
    }
    if (url === "/ok/v1/models")
      return send(200, { object: "list", data: COMPAT_MODELS });
    // Accepts the request and never answers.
    if (url === "/stall/v1/models") return;
    const status = /^\/status\/(\d{3})\/v1\/models$/.exec(url);
    if (status) {
      const code = Number(status[1]);
      const headers: Record<string, string> =
        code === 429
          ? { "retry-after": "120" }
          : code === 503
            ? { "retry-after": "30" }
            : {};
      return send(code, { error: { message: "no" } }, headers);
    }
    send(404, { error: { message: "not found" } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      mockURL = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

/** A loopback URL whose port was bound and released, so it refuses. */
async function refusedPort(): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return `http://127.0.0.1:${port}`;
}

let root: string;
const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await startMock();
  refusedURL = await refusedPort();
  root = await mkdtemp(path.join(os.tmpdir(), "model-scout-status-e2e-"));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OPENCODE")) delete process.env[key];
  }
  delete process.env.ACTUALYZE_API_KEY;
  process.env.HOME = path.join(root, "home");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.XDG_DATA_HOME = path.join(root, "data");
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  process.env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  // Every scenario configures its own Actualyze base URL, so a request to
  // the production origin is a test failure, answered locally.
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(PRODUCTION_ORIGIN)) {
      productionRequests += 1;
      return Promise.resolve(new Response(null, { status: 599 }));
    }
    return realFetch(input, init);
  };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  process.env = savedEnv;
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  if (root) await rm(root, { recursive: true, force: true });
  expect(productionRequests).toBe(0);
});

/** Scout with plugin options, as `opencode.json` would pass them. */
function withOptions(options: Record<string, unknown>): Plugin.Plugin {
  return {
    id: plugin.id,
    setup: (context) =>
      plugin.setup(
        Object.create(context, { options: { value: options } }) as never,
      ),
  } as Plugin.Plugin;
}

async function createHost(
  name: string,
  providers: Record<string, unknown>,
  plugins: readonly Plugin.Plugin[] = [plugin],
): Promise<{ host: OpenCode.Interface; location: { directory: string } }> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  const { OpenCode } = await import("@opencode/sdk");
  const host = await OpenCode.create({
    plugins: [...plugins],
    models: { fetch: false },
    fs: { filewatcher: false },
    config: { project: false, content: JSON.stringify({ providers }) },
  });
  return { host, location: { directory } };
}

async function eventually<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

async function catalog(
  host: OpenCode.Interface,
  location: { directory: string },
): Promise<CatalogPayload> {
  const output: unknown = await host
    .rpc(ModelScoutRpc)
    .catalog({}, { location });
  const payload = validateCatalogPayload(output);
  expect(payload).toBeDefined();
  return payload!;
}

/** The provider's record once `settled` accepts it. */
async function recordWhen(
  host: OpenCode.Interface,
  location: { directory: string },
  id: string,
  settled: (record: CatalogProviderRecord) => boolean,
  timeoutMs?: number,
): Promise<CatalogProviderRecord | undefined> {
  return eventually(async () => {
    const found = (await catalog(host, location)).providers.find(
      (entry) => entry.id === id,
    );
    return found && settled(found) ? found : undefined;
  }, timeoutMs);
}

const current = (record: CatalogProviderRecord) =>
  record.resultEpoch === record.credentialEpoch && !record.discovering;

describe("failure kinds and credential sources from a real server", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };
  const compat = (base: string, extra: Record<string, unknown> = {}) => ({
    package: "aisdk:@ai-sdk/openai-compatible",
    ...extra,
    settings: {
      baseURL: base,
      ...((extra.settings as Record<string, unknown> | undefined) ?? {}),
    },
  });
  const withKey = { settings: { apiKey: "listed-key" } };

  beforeAll(async () => {
    ({ host, location } = await createHost("kinds", {
      s401: compat(`${mockURL}/status/401/v1`, withKey),
      s402: compat(`${mockURL}/status/402/v1`, withKey),
      s403: compat(`${mockURL}/status/403/v1`, withKey),
      s404: compat(`${mockURL}/status/404/v1`, withKey),
      s418: compat(`${mockURL}/status/418/v1`, withKey),
      s429: compat(`${mockURL}/status/429/v1`, withKey),
      s503: compat(`${mockURL}/status/503/v1`, withKey),
      refused: compat(`${refusedURL}/v1`, withKey),
      "source-settings": compat(`${mockURL}/ok/v1`, withKey),
      "source-none": compat(`${mockURL}/ok/v1`),
      "source-headers": compat(`${mockURL}/ok/v1`, {
        ...withKey,
        headers: { "X-Api-Key": "header-key" },
      }),
      actualyze: {
        settings: { baseURL: `${mockURL}/actualyze/openai/v1` },
        headers: { "X-Actualyze-Api-Key": HEADER_KEY },
      },
    }));
  });

  afterAll(async () => {
    await host?.close();
  });

  it.each([
    ["s401", "unauthorized", 401],
    ["s402", "payment-required", 402],
    ["s403", "forbidden", 403],
    ["s404", "not-found", 404],
    ["s418", "http-error", 418],
  ] as const)(
    "reports %s as %s with its status",
    async (id, kind, httpStatus) => {
      const record = await recordWhen(host!, location, id, (entry) =>
        Boolean(entry.failure),
      );
      expect(record?.failure).toEqual({
        kind,
        httpStatus,
        at: expect.any(String),
      });
      expect(record).toMatchObject({
        credentialSource: "settings",
        resultEpoch: 0,
        lastGoodAt: null,
      });
    },
  );

  it.each([
    ["s429", "rate-limited", 429, 120_000],
    ["s503", "server-error", 503, 30_000],
  ] as const)(
    "reports %s as %s with the server's retry time",
    async (id, kind, httpStatus, delay) => {
      const record = await recordWhen(host!, location, id, (entry) =>
        Boolean(entry.failure),
      );
      expect(record?.failure).toMatchObject({ kind, httpStatus });
      const at = Date.parse(record!.failure!.at);
      const retryAt = Date.parse(record!.failure!.retryAt!);
      // The hint is relative to the response, read a moment before `at`.
      expect(retryAt).toBeGreaterThan(at + delay - 5_000);
      expect(retryAt).toBeLessThanOrEqual(at + delay);
      const throttle = Date.parse(record!.lastAttemptAt!) + 60_000;
      expect(record?.nextRefreshAt).toBe(
        new Date(Math.max(throttle, retryAt)).toISOString(),
      );
    },
  );

  it("throttles a manual refresh while the retry time is ahead", async () => {
    await recordWhen(host!, location, "s429", (entry) =>
      Boolean(entry.failure),
    );
    const result = await host!
      .rpc(ModelScoutRpc)
      .refresh({ providerID: "s429" }, { location });
    expect(result).toEqual({ accepted: false, reason: "throttled" });
  });

  it("reports a refused connection as unreachable", async () => {
    const record = await recordWhen(host!, location, "refused", (entry) =>
      Boolean(entry.failure),
    );
    expect(record?.failure).toEqual({
      kind: "unreachable",
      at: expect.any(String),
    });
  });

  it.each([
    ["source-settings", "settings"],
    ["source-none", "none"],
    ["source-headers", "headers"],
  ] as const)("reports %s as %s", async (id, source) => {
    const record = await recordWhen(host!, location, id, current);
    expect(record).toMatchObject({ credentialSource: source, failure: null });
    expect(record?.models.map((model) => model.id)).toContain("mock-llama");
  });

  it("reports an x-actualyze-api-key header as the source next to a different connected key", async () => {
    await recordWhen(host!, location, "actualyze", current);
    await host!.integration.connect.key({
      integrationID: "actualyze",
      key: KEY_ONE,
      location,
    });
    const record = await recordWhen(
      host!,
      location,
      "actualyze",
      (entry) => entry.credentialEpoch > 0 && current(entry),
    );
    expect(record).toMatchObject({
      credentialSource: "headers",
      failure: null,
    });
  });
});

describe("a discovery that exceeds its time budget", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    ({ host, location } = await createHost(
      "timeout",
      {
        stall: {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: `${mockURL}/stall/v1`, apiKey: "k" },
        },
      },
      [withOptions({ timeoutMs: 1_000 })],
    ));
  });

  afterAll(async () => {
    await host?.close();
  });

  it("is reported as timeout", async () => {
    const record = await recordWhen(host!, location, "stall", (entry) =>
      Boolean(entry.failure),
    );
    expect(record?.failure).toEqual({
      kind: "timeout",
      at: expect.any(String),
    });
  });
});

describe("an actualyze provider that an earlier plugin defined", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  const earlier = {
    id: "earlier-actualyze-provider",
    async setup(context: Plugin.Context) {
      const builtIn = actualyzeProviderInfo();
      await context.provider.transform((editor) => {
        editor.add({
          info: {
            id: builtIn.id,
            name: "Actualyze (earlier plugin)",
            activation: "auto",
            package: builtIn.package,
            settings: { baseURL: `${mockURL}/actualyze/openai/v1` },
          },
          models: [],
        });
      });
    },
  } satisfies Plugin.Plugin;

  beforeAll(async () => {
    ({ host, location } = await createHost("foreign", {}, [earlier, plugin]));
  });

  afterAll(async () => {
    await host?.close();
  });

  it("is reported as foreign and gets no record", async () => {
    const payload = await eventually(async () => {
      const value = await catalog(host!, location);
      return value.status === "pending" ? undefined : value;
    });
    expect(payload?.builtIn).toEqual({ actualyze: "foreign" });
    expect(payload?.providers.some((entry) => entry.id === "actualyze")).toBe(
      false,
    );
  });
});

describe("an Actualyze key connected at runtime", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    ({ host, location } = await createHost("runtime-connect", {
      actualyze: { settings: { baseURL: `${mockURL}/actualyze/openai/v1` } },
    }));
  });

  afterAll(async () => {
    await host?.close();
  });

  it("keeps the record across each switch until the new key's result is current", async () => {
    const client = host!.rpc(ModelScoutRpc);
    const statuses: unknown[] = [];
    const stopStatus = client.events.on("status", (event) => {
      statuses.push(event.data);
    });

    // Without a key the endpoint answers 401.
    const keyless = await recordWhen(host!, location, "actualyze", current);
    expect(keyless).toMatchObject({
      credentialSource: "none",
      credentialEpoch: 0,
      resultEpoch: 0,
      failure: { kind: "unauthorized", httpStatus: 401 },
    });
    const first = await catalog(host!, location);
    expect(first.builtIn).toEqual({ actualyze: "managed" });

    // Poll throughout both switches.
    const seen: CatalogPayload[] = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        seen.push(await catalog(host!, location));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();

    try {
      const statusesBefore = statuses.length;
      await host!.integration.connect.key({
        integrationID: "actualyze",
        key: KEY_ONE,
        location,
      });
      const one = await recordWhen(
        host!,
        location,
        "actualyze",
        (entry) =>
          entry.credentialEpoch > 0 &&
          current(entry) &&
          entry.models.length > 0,
      );
      expect(one).toMatchObject({
        credentialSource: "connection",
        failure: null,
      });
      expect(one?.models.map((model) => model.id)).toEqual([
        "claude-sonnet-4-6",
      ]);
      expect(authorizations).toContain(`Bearer ${KEY_ONE}`);
      expect(statuses.length).toBeGreaterThan(statusesBefore);

      await host!.integration.connect.key({
        integrationID: "actualyze",
        key: KEY_TWO,
        location,
      });
      const two = await recordWhen(
        host!,
        location,
        "actualyze",
        (entry) =>
          entry.credentialEpoch > one!.credentialEpoch &&
          current(entry) &&
          entry.models.length > 0,
      );
      expect(two).toMatchObject({
        credentialSource: "connection",
        failure: null,
      });
      expect(authorizations).toContain(`Bearer ${KEY_TWO}`);
    } finally {
      polling = false;
      await poller;
      stopStatus();
    }

    for (const data of statuses)
      expect(data).toEqual({ at: expect.stringMatching(/Z$/) });
    expect(seen.length).toBeGreaterThan(0);
    let epoch = 0;
    for (const payload of seen) {
      expect(payload.instanceID).toBe(first.instanceID);
      const record = payload.providers.find(
        (entry) => entry.id === "actualyze",
      );
      expect(record).toBeDefined();
      expect(record!.credentialEpoch).toBeGreaterThanOrEqual(epoch);
      epoch = record!.credentialEpoch;
      // A record not yet current carries nothing from the previous key.
      if (record!.resultEpoch !== record!.credentialEpoch) {
        expect(record).toMatchObject({
          models: [],
          failure: null,
          lastGoodAt: null,
        });
      }
    }
  });
});
