/**
 * Embedded-host smoke test: proves that `@opencode/sdk` can host a plugin
 * shaped like `src/server.ts` in-process under Node/vitest, that a model
 * transform can add a model under a config-defined openai-compatible
 * provider, and that the RPC contract survives the host's schema checks.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { OpenCode } from "@opencode/sdk";
import {
  CATALOG_SCHEMA_VERSION,
  knownScalar,
  unknownCapability,
  unknownScalar,
  validateCatalogPayload,
  type CatalogPayload,
} from "../../src/catalog-evidence";
import { PLUGIN_ID } from "../../src/constants";
import { ModelScoutRpc } from "../../src/rpc";

const PROVIDER_ID = "mock-compat";
const MODEL_ID = "scout-smoke-model";

function samplePayload(): CatalogPayload {
  const at = new Date(0).toISOString();
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    packageVersion: "0.0.0-smoke",
    status: "complete",
    startedAt: at,
    completedAt: at,
    providers: [
      {
        id: PROVIDER_ID,
        endpointOrigin: knownScalar(
          "http://127.0.0.1:9",
          "pre-existing",
          "configured",
        ),
        configuredProbe: unknownScalar(),
        resolvedProbe: unknownScalar(),
        lastGoodAt: at,
        failure: null,
        modelListAttempt: "ready",
        probeAttempt: "not-requested",
        skippedModelIds: [],
        models: [
          {
            id: MODEL_ID,
            origin: "discovered",
            enabled: true,
            identity: knownScalar(MODEL_ID, "server-list", "reported"),
            name: unknownScalar(),
            modelType: unknownScalar(),
            context: knownScalar(4096, "provider-probe", "authoritative"),
            output: knownScalar(32_000, "host-default", "assumed"),
            family: unknownScalar(),
            organizationOwner: unknownScalar(),
            parameterSize: unknownScalar(),
            quantization: unknownScalar(),
            sizeBytes: unknownScalar(),
            probeIdentity: unknownScalar(),
            capabilities: {
              toolCall: unknownCapability(),
              reasoning: unknownCapability(),
              temperature: unknownCapability(),
            },
            inputModalities: {
              text: {
                state: "supported",
                source: "policy-default",
                strength: "assumed",
              },
              image: unknownCapability(),
              pdf: unknownCapability(),
              audio: unknownCapability(),
              video: unknownCapability(),
            },
            cost: {
              input: knownScalar(3, "provider-probe", "reported"),
              output: knownScalar(15, "provider-probe", "reported"),
              cacheRead: unknownScalar(),
              cacheWrite: unknownScalar(),
            },
          },
        ],
      },
    ],
  };
}

const smokePlugin = {
  id: PLUGIN_ID,
  async setup(context: Plugin.Context) {
    await context.model.transform((editor) => {
      editor.update(PROVIDER_ID, MODEL_ID, (model) => {
        model.name = "Scout Smoke";
        model.limit = { context: 4096, output: 1024 };
      });
    });
    const registration = await context.rpc.register(ModelScoutRpc, {
      catalog: async () => samplePayload(),
      refresh: async () => ({ accepted: true }),
    });
    return () => registration.dispose();
  },
} satisfies Plugin.Plugin;

let root: string;
let project: string;
let host: OpenCode.Interface | undefined;
const savedEnv = { ...process.env };

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "model-scout-e2e-"));
  project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  // Isolate from the developer's real OpenCode config and data.
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
    plugins: [smokePlugin],
    models: { fetch: false },
    fs: { filewatcher: false },
    config: {
      project: false,
      content: JSON.stringify({
        providers: {
          [PROVIDER_ID]: {
            name: "Mock Compat",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { baseURL: "http://127.0.0.1:9/v1", apiKey: "smoke" },
          },
        },
      }),
    },
  });
});

afterAll(async () => {
  await host?.close();
  process.env = savedEnv;
  if (root) await rm(root, { recursive: true, force: true });
});

async function eventually<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

describe("embedded @opencode/sdk host", () => {
  it("lists a model added by a plugin transform under a config provider", async () => {
    const location = { directory: project };
    const model = await eventually(async () => {
      const result = await host!.model.list({ location });
      return result.data.find(
        (entry) => entry.providerID === PROVIDER_ID && entry.id === MODEL_ID,
      );
    });
    expect(model).toMatchObject({
      name: "Scout Smoke",
      limit: { context: 4096, output: 1024 },
    });
  });

  it("round-trips the catalog RPC through the host's schema checks", async () => {
    const client = host!.rpc(ModelScoutRpc);
    const output: unknown = await client.catalog(
      {},
      { location: { directory: project } },
    );
    expect(validateCatalogPayload(output)).toEqual(samplePayload());
    await expect(
      client.refresh({}, { location: { directory: project } }),
    ).resolves.toEqual({ accepted: true });
  });
});
