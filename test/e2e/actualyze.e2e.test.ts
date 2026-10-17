/**
 * Embedded-host E2E for the built-in Actualyze provider. Each scenario runs
 * its own host with a different config and environment.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { OpenCode } from "@opencode/sdk";
import plugin from "../../src/server";
import { actualyzeProviderInfo } from "../../src/actualyze";

const PRODUCTION_ORIGIN = "https://app.actualyze.ai";
const PRODUCTION_BASE_URL = `${PRODUCTION_ORIGIN}/openai/v1`;
const ENV_ONLY_KEY = "actualyze-env-only-key";
const ENV_KEY = "actualyze-env-key";
const SETTINGS_KEY = "actualyze-settings-key";
const CONNECTED_KEY = "actualyze-connected-key";
const SHADOWED_SETTINGS_KEY = "actualyze-shadowed-settings-key";
const STORED_KEY = "actualyze-stored-key";
const ZERO_CONFIG_KEY = "actualyze-zero-config-key";
const INTEGRATION_ID = "actualyze";

const MODELS = [
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

const authorizations: string[] = [];
let server: http.Server;
let mockURL: string;

function startMock(): Promise<void> {
  server = http.createServer((request, response) => {
    authorizations.push(String(request.headers.authorization ?? ""));
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    // Like the real endpoint, a request without a key lists nothing, so a
    // discovered model proves which key was sent.
    if (!request.headers.authorization)
      return send(401, { error: { message: "missing key" } });
    const url = request.url ?? "";
    if (url === "/openai/v1/models")
      return send(200, { object: "list", data: MODELS });
    const detail = MODELS.find(
      (model) =>
        url === `/openai/v1/models/${encodeURIComponent(model.id)}` ||
        url === `/openai/v1/models/${model.id}`,
    );
    if (detail) return send(200, detail);
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

let root: string;
const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await startMock();
  root = await mkdtemp(path.join(os.tmpdir(), "model-scout-actualyze-e2e-"));
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
  // Requests to the production endpoint are served by the local mock, so no
  // scenario reaches the network.
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(PRODUCTION_ORIGIN)) return realFetch(input, init);
    const rewritten = `${mockURL}${url.slice(PRODUCTION_ORIGIN.length)}`;
    // A Request carries its own method, headers, and body.
    return realFetch(
      input instanceof Request ? new Request(rewritten, input) : rewritten,
      init,
    );
  };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  process.env = savedEnv;
  await new Promise((resolve) => server?.close(resolve));
  if (root) await rm(root, { recursive: true, force: true });
});

async function createHost(
  name: string,
  providers: Record<string, unknown>,
  before: readonly Plugin.Plugin[] = [],
): Promise<{ host: OpenCode.Interface; location: { directory: string } }> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  const { OpenCode } = await import("@opencode/sdk");
  const host = await OpenCode.create({
    plugins: [...before, plugin],
    models: { fetch: false },
    fs: { filewatcher: false },
    config: {
      project: false,
      content: JSON.stringify({ providers }),
    },
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

/** The listed (available) `actualyze` provider, once plugins have loaded. */
async function findProvider(
  host: OpenCode.Interface,
  location: { directory: string },
) {
  return eventually(async () =>
    (await host.provider.list({ location })).data.find(
      (entry) => entry.id === "actualyze",
    ),
  );
}

async function findModel(
  host: OpenCode.Interface,
  location: { directory: string },
) {
  return eventually(async () =>
    (await host.model.list({ location })).data.find(
      (entry) =>
        entry.providerID === "actualyze" && entry.id === "claude-sonnet-4-6",
    ),
  );
}

describe("Actualyze with only ACTUALYZE_API_KEY set", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    process.env.ACTUALYZE_API_KEY = ENV_ONLY_KEY;
    ({ host, location } = await createHost("env-only", {}));
  });

  afterAll(async () => {
    await host?.close();
    delete process.env.ACTUALYZE_API_KEY;
  });

  it("lists the provider and discovers the production endpoint's models", async () => {
    expect(await findProvider(host!, location)).toMatchObject({
      name: "Actualyze",
      integrationID: INTEGRATION_ID,
      settings: { baseURL: PRODUCTION_BASE_URL, probe: "actualyze" },
    });
    expect(await findModel(host!, location)).toBeDefined();
    expect(authorizations).toContain(`Bearer ${ENV_ONLY_KEY}`);
  });
});

describe("Actualyze with only settings.apiKey configured", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    ({ host, location } = await createHost("settings-only", {
      actualyze: { settings: { apiKey: SETTINGS_KEY } },
    }));
  });

  afterAll(async () => {
    await host?.close();
  });

  it("keeps the production base URL and the Actualyze probe", async () => {
    const provider = await findProvider(host!, location);
    expect(provider).toMatchObject({
      name: "Actualyze",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: PRODUCTION_BASE_URL, probe: "actualyze" },
    });
  });
});

describe("Actualyze with ACTUALYZE_API_KEY and a configured base URL", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    process.env.ACTUALYZE_API_KEY = ENV_KEY;
    ({ host, location } = await createHost("env-key", {
      actualyze: { settings: { baseURL: `${mockURL}/openai/v1` } },
    }));
  });

  afterAll(async () => {
    await host?.close();
    delete process.env.ACTUALYZE_API_KEY;
  });

  it("uses the configured base URL over the built-in one", async () => {
    const provider = await findProvider(host!, location);
    expect(provider).toMatchObject({
      integrationID: INTEGRATION_ID,
      settings: { baseURL: `${mockURL}/openai/v1`, probe: "actualyze" },
    });
  });

  it("discovers the served models with the environment key", async () => {
    expect(await findModel(host!, location)).toMatchObject({
      limit: { context: 1_000_000, output: 64_000 },
      capabilities: { tools: true, input: ["text", "image"] },
      variants: [],
    });
    expect(authorizations).toContain(`Bearer ${ENV_KEY}`);
  });
});

describe("Actualyze with ACTUALYZE_API_KEY and settings.apiKey", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    process.env.ACTUALYZE_API_KEY = CONNECTED_KEY;
    ({ host, location } = await createHost("connected-and-settings", {
      actualyze: { settings: { apiKey: SHADOWED_SETTINGS_KEY } },
    }));
  });

  afterAll(async () => {
    await host?.close();
    delete process.env.ACTUALYZE_API_KEY;
  });

  it("discovers with the connected key, as inference does", async () => {
    expect(await findModel(host!, location)).toBeDefined();
    expect(authorizations).toContain(`Bearer ${CONNECTED_KEY}`);
    expect(authorizations).not.toContain(`Bearer ${SHADOWED_SETTINGS_KEY}`);
  });
});

/** Every integration that `/connect` would show as Actualyze. */
async function actualyzeIntegrations(
  host: OpenCode.Interface,
  location: { directory: string },
) {
  return (await host.integration.list({ location })).data
    .filter(
      (entry) =>
        entry.id === INTEGRATION_ID || entry.name.toLowerCase() === "actualyze",
    )
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      connections: entry.connections.length,
    }));
}

// Credentials persist in the data directory that every host in this file
// shares, so scenarios that need `actualyze` without a stored key run before
// the ones that store a key, and a scenario that stores a key before another
// one removes it again.
describe("an actualyze provider defined by an earlier plugin without an integration", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  // Defines `actualyze` with `activation: "auto"` and no `integrationID`,
  // which the host gates on the integration with the ID `actualyze`.
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
            settings: { baseURL: `${mockURL}/openai/v1` },
          },
          models: [],
        });
      });
    },
  } satisfies Plugin.Plugin;

  beforeAll(async () => {
    ({ host, location } = await createHost("earlier-plugin", {}, [earlier]));
  });

  afterAll(async () => {
    await host?.close();
  });

  it("is hidden while the actualyze integration has no connection", async () => {
    // The integration exists once scout has loaded.
    expect(
      await eventually(async () => {
        const listed = await actualyzeIntegrations(host!, location);
        return listed.length > 0 ? listed : undefined;
      }),
    ).toEqual([{ id: INTEGRATION_ID, name: "Actualyze", connections: 0 }]);
    const providers = (await host!.provider.list({ location })).data;
    expect(providers.some((entry) => entry.id === "actualyze")).toBe(false);
  });
});

describe("Actualyze with no config and a key stored through the host", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    ({ host, location } = await createHost("zero-config", {}));
  });

  afterAll(async () => {
    // Later scenarios start without a stored Actualyze key.
    if (host) {
      for (const credential of await host.credential.list()) {
        if (credential.integrationID === INTEGRATION_ID)
          await host.credential.remove({ credentialID: credential.id });
      }
    }
    await host?.close();
  });

  it("appears with the production endpoint and its models once a key is connected", async () => {
    expect(
      await eventually(async () => {
        const listed = await actualyzeIntegrations(host!, location);
        return listed.length > 0 ? listed : undefined;
      }),
    ).toEqual([{ id: INTEGRATION_ID, name: "Actualyze", connections: 0 }]);
    const before = (await host!.provider.list({ location })).data;
    expect(before.some((entry) => entry.id === "actualyze")).toBe(false);

    await host!.integration.connect.key({
      integrationID: INTEGRATION_ID,
      key: ZERO_CONFIG_KEY,
      location,
    });

    expect(await findProvider(host!, location)).toMatchObject({
      name: "Actualyze",
      integrationID: INTEGRATION_ID,
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: PRODUCTION_BASE_URL, probe: "actualyze" },
    });
    expect(await findModel(host!, location)).toMatchObject({
      limit: { context: 1_000_000, output: 64_000 },
      capabilities: { tools: true, input: ["text", "image"] },
    });
    expect(authorizations).toContain(`Bearer ${ZERO_CONFIG_KEY}`);
  });
});

describe("Actualyze with a configured base URL and a key stored through the host", () => {
  let host: OpenCode.Interface | undefined;
  let location: { directory: string };

  beforeAll(async () => {
    ({ host, location } = await createHost("stored-key", {
      actualyze: { settings: { baseURL: `${mockURL}/openai/v1` } },
    }));
  });

  afterAll(async () => {
    await host?.close();
  });

  it("stores the key on the provider's integration and discovers with it", async () => {
    // The config entry lists the provider before any key exists.
    expect(await findProvider(host!, location)).toMatchObject({
      integrationID: INTEGRATION_ID,
      settings: { baseURL: `${mockURL}/openai/v1`, probe: "actualyze" },
    });
    await host!.integration.connect.key({
      integrationID: INTEGRATION_ID,
      key: STORED_KEY,
      location,
    });

    expect(await actualyzeIntegrations(host!, location)).toEqual([
      { id: INTEGRATION_ID, name: "Actualyze", connections: 1 },
    ]);
    expect(await findModel(host!, location)).toMatchObject({
      limit: { context: 1_000_000, output: 64_000 },
    });
    expect(authorizations).toContain(`Bearer ${STORED_KEY}`);
  });
});
