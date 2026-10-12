/**
 * Embedded-host E2E for the server plugin: the real `src/server.ts` runs in
 * an `@opencode/sdk` host against local OpenAI-compatible mocks, and the
 * checks read the host's own model list and the plugin RPC.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenCode } from "@opencode/sdk";
import { validateCatalogPayload } from "../../src/catalog-evidence";
import { ModelScoutRpc } from "../../src/rpc";
import plugin from "../../src/server";

const COMPAT = "mock-compat";
const ACTUALYZE = "actualyze-mock";
const ALIAS = "work-openai";
const ALIAS_KEY = "alias-key-must-not-be-sent";

const COMPAT_MODELS = [
  { id: "mock-llama-3.1-8b", max_model_len: 131072 },
  { id: "mock-declared-7b", max_model_len: 4096 },
  { id: "mock-nomic-embed-text", max_model_len: 8192 },
].map((model) => ({
  ...model,
  object: "model",
  created: 1_700_000_000,
  owned_by: "vllm",
  root: model.id,
}));

const ACTUALYZE_MODELS = [
  {
    id: "claude-sonnet-4-6",
    object: "model",
    created: 1_760_000_000,
    owned_by: "actualyze",
    context_window: 1_000_000,
    max_output_tokens: 64_000,
    capabilities: {
      vision: true,
      tool_use: true,
      thinking: true,
      thinking_adaptive: null,
      temperature: null,
      document: true,
    },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    cost: { input: 3, output: 15, cache_read: 0.3 },
  },
  {
    id: "z-ai/glm-4.5",
    object: "model",
    created: 1_750_000_000,
    owned_by: "actualyze",
    context_window: 131_072,
    max_output_tokens: null,
    capabilities: {
      vision: false,
      tool_use: true,
      // Both false: an authoritative "no reasoning" that models.dev cannot override.
      thinking: false,
      thinking_adaptive: false,
      temperature: null,
    },
    modalities: { input: ["text"], output: ["text"] },
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
    const url = request.url ?? "";
    if (url === "/compat/v1/models")
      return send(200, { object: "list", data: COMPAT_MODELS });
    if (url === "/actualyze/v1/models")
      return send(200, { object: "list", data: ACTUALYZE_MODELS });
    const detail = ACTUALYZE_MODELS.find(
      (model) =>
        url === `/actualyze/v1/models/${encodeURIComponent(model.id)}` ||
        url === `/actualyze/v1/models/${model.id}`,
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
let project: string;
let host: OpenCode.Interface | undefined;
const savedEnv = { ...process.env };

beforeAll(async () => {
  await startMock();
  root = await mkdtemp(path.join(os.tmpdir(), "model-scout-server-e2e-"));
  project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OPENCODE")) delete process.env[key];
  }
  process.env.HOME = path.join(root, "home");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.XDG_DATA_HOME = path.join(root, "data");
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  process.env.OPENCODE_DISABLE_AUTOUPDATE = "1";

  const { OpenCode } = await import("@opencode/sdk");
  host = await OpenCode.create({
    plugins: [plugin],
    models: { fetch: false },
    fs: { filewatcher: false },
    config: {
      project: false,
      content: JSON.stringify({
        providers: {
          [COMPAT]: {
            name: "Mock Compat",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: {
              baseURL: `${mockURL}/compat/v1`,
              apiKey: "compat-secret-key",
            },
            models: {
              "mock-declared-7b": {
                name: "User Declared",
                limit: { context: 1234, output: 123 },
              },
            },
          },
          [ACTUALYZE]: {
            name: "Actualyze Mock",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: {
              baseURL: `${mockURL}/actualyze/v1`,
              apiKey: "actualyze",
              probe: "auto",
            },
          },
          [ALIAS]: {
            name: "Work OpenAI",
            canonical: "openai",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { baseURL: `${mockURL}/compat/v1`, apiKey: ALIAS_KEY },
          },
        },
      }),
    },
  });
});

afterAll(async () => {
  await host?.close();
  process.env = savedEnv;
  await new Promise((resolve) => server?.close(resolve));
  if (root) await rm(root, { recursive: true, force: true });
});

const location = () => ({ directory: project });

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

async function models() {
  return (await host!.model.list({ location: location() })).data;
}

async function findModel(providerID: string, id: string) {
  return eventually(async () =>
    (await models()).find(
      (model) => model.providerID === providerID && model.id === id,
    ),
  );
}

describe("server plugin in an embedded host", () => {
  it("adds served models under a config-only openai-compatible provider", async () => {
    const model = await findModel(COMPAT, "mock-llama-3.1-8b");
    expect(model).toMatchObject({
      name: "Mock Llama 3.1 8B",
      limit: { context: 200_000, output: 0 },
      capabilities: { input: ["text"], output: ["text"] },
      variants: [],
      cost: [],
      enabled: true,
    });
  });

  it("keeps a declared model's user values", async () => {
    await findModel(COMPAT, "mock-llama-3.1-8b");
    const declared = (await models()).find(
      (model) => model.providerID === COMPAT && model.id === "mock-declared-7b",
    );
    expect(declared).toMatchObject({
      name: "User Declared",
      limit: { context: 1234, output: 123 },
    });
  });

  it("keeps embedding models out of the available list", async () => {
    await findModel(COMPAT, "mock-llama-3.1-8b");
    expect(
      (await models()).some((model) => model.id === "mock-nomic-embed-text"),
    ).toBe(false);
  });

  it("maps Actualyze list evidence into Model.Info", async () => {
    const claude = await findModel(ACTUALYZE, "claude-sonnet-4-6");
    expect(claude).toMatchObject({
      limit: { context: 1_000_000, output: 64_000 },
      capabilities: {
        tools: true,
        input: ["text", "image", "pdf"],
        output: ["text"],
      },
      cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 0 } }],
      time: { released: 1_760_000_000_000 },
    });
    expect(claude?.variants).toEqual([]);

    const glm = await findModel(ACTUALYZE, "z-ai/glm-4.5");
    expect(glm).toMatchObject({
      limit: { context: 131_072, output: 0 },
      capabilities: { input: ["text"] },
      variants: [],
      cost: [],
    });
  });

  it("never probes a canonical alias of a catalog provider", async () => {
    await findModel(COMPAT, "mock-llama-3.1-8b");
    expect(authorizations).not.toContain(`Bearer ${ALIAS_KEY}`);
    expect((await models()).some((model) => model.providerID === ALIAS)).toBe(
      false,
    );
  });

  it("serves validated evidence for both targets over RPC", async () => {
    await findModel(ACTUALYZE, "claude-sonnet-4-6");
    await findModel(COMPAT, "mock-llama-3.1-8b");
    const client = host!.rpc(ModelScoutRpc);
    const output: unknown = await client.catalog({}, { location: location() });
    const payload = validateCatalogPayload(output);
    expect(payload).toBeDefined();
    const byID = new Map(payload!.providers.map((entry) => [entry.id, entry]));
    expect([...byID.keys()].sort()).toEqual([ACTUALYZE, COMPAT]);

    const actualyze = byID.get(ACTUALYZE)!;
    expect(actualyze.resolvedProbe).toMatchObject({ value: "actualyze" });
    expect(actualyze.failure).toBeNull();
    expect(actualyze.lastGoodAt).not.toBeNull();

    const compat = byID.get(COMPAT)!;
    expect(compat.skippedModelIds).toEqual(["mock-declared-7b"]);
    expect(
      compat.models.find((model) => model.id === "mock-nomic-embed-text"),
    ).toMatchObject({ enabled: false, origin: "discovered" });
    expect(
      compat.models.find((model) => model.id === "mock-declared-7b")?.origin,
    ).toBe("pre-existing");
    expect(JSON.stringify(output)).not.toContain("compat-secret-key");
    expect(JSON.stringify(output)).not.toContain(ALIAS_KEY);
  });

  it("declines a refresh for a provider that is not a target", async () => {
    const client = host!.rpc(ModelScoutRpc);
    const result = await client.refresh(
      { providerID: "unknown-provider" },
      { location: location() },
    );
    expect(result).toEqual({ accepted: false, reason: "no-targets" });
  });
});
