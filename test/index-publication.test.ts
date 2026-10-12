import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/models-dev", () => ({
  fetchModelsDevIndex: vi.fn(async () => []),
}));

import plugin from "../src/index";
import {
  DISABLE_CATALOG_PERSISTENCE_ENV,
  clearCatalogBridge,
  readCatalogBridge,
} from "../src/catalog-snapshot";

const input = {
  client: {},
  worktree: "/tmp/model-scout-publication-test",
  serverUrl: new URL("http://127.0.0.1:4096/"),
} as unknown as Parameters<typeof plugin>[0];

beforeEach(() => {
  clearCatalogBridge();
  process.env[DISABLE_CATALOG_PERSISTENCE_ENV] = "1";
  delete process.env.OPENCODE_MODEL_SCOUT_TIMEOUT_MS;
});

afterEach(() => {
  clearCatalogBridge();
  delete process.env[DISABLE_CATALOG_PERSISTENCE_ENV];
  delete process.env.OPENCODE_MODEL_SCOUT_TIMEOUT_MS;
});

describe("server launch publication", () => {
  it("publishes one cryptographically shaped attempt and completes it", async () => {
    const hooks = await plugin(input);
    await (hooks.config as (config: Record<string, unknown>) => Promise<void>)(
      {},
    );
    const snapshot = readCatalogBridge();
    expect(snapshot?.status).toBe("complete");
    expect(snapshot?.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(snapshot?.runtimeKey).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot?.runtimeKey).not.toBe(String(process.pid));
  });

  it("leaves a running marker when the hard timeout wins", async () => {
    process.env.OPENCODE_MODEL_SCOUT_TIMEOUT_MS = "20";
    mockFetch.mockImplementation(() => new Promise(() => {}));
    const hooks = await plugin(input);
    const config = {
      provider: {
        atlas: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://atlas.test/v1" },
        },
      },
    };

    await (hooks.config as (value: Record<string, unknown>) => Promise<void>)(
      config,
    );
    const marker = readCatalogBridge();
    expect(marker?.status).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readCatalogBridge()).toEqual(marker);
    expect(
      (config.provider.atlas as Record<string, unknown>).models,
    ).toBeUndefined();
  });

  it("replaces a prior launch marker with a new attempt", async () => {
    const hooks = await plugin(input);
    await (hooks.config as (config: Record<string, unknown>) => Promise<void>)(
      {},
    );
    const first = readCatalogBridge()?.attemptId;
    await (hooks.config as (config: Record<string, unknown>) => Promise<void>)(
      {},
    );
    expect(readCatalogBridge()?.attemptId).not.toBe(first);
  });
});
