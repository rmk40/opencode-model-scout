import { describe, expect, it } from "vitest";
import { discoverModels } from "../src/discover";

function atlasConfig(
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    provider: {
      atlas: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://atlas.test/v1", probe: "atlas" },
        ...(existing ? { models: existing } : {}),
      },
    },
  };
}

function listResponse(ids: string[]) {
  return {
    ok: true,
    json: async () => ({
      data: ids.map((id) => ({ id, owned_by: "atlas" })),
    }),
  };
}

describe("discovery provenance ledger", () => {
  it("records authoritative negatives before sentinels are removed", async () => {
    const id = "atlas-disabled";
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/v1/models")) return listResponse([id]);
      return {
        ok: true,
        json: async () => ({
          id,
          object: "model",
          created: 1,
          owned_by: "atlas",
          context_window: 8192,
          max_output_tokens: 1024,
          capabilities: {
            vision: false,
            tool_use: false,
            thinking: false,
            thinking_adaptive: false,
          },
        }),
      };
    });
    const fallback = [
      {
        id,
        normalized: id,
        meta: {
          toolCall: true,
          reasoning: true,
          attachment: true,
          temperature: true,
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      },
    ];
    const config = atlasConfig();

    const providers = await discoverModels(config, fallback);
    const record = providers[0].models[0];
    expect(record.capabilities.vision).toEqual({
      state: "unsupported",
      source: "provider-probe",
      strength: "authoritative",
    });
    expect(record.capabilities.toolCall.state).toBe("unsupported");
    expect(record.capabilities.reasoning.state).toBe("unsupported");
    expect(record.capabilities.temperature).toEqual({
      state: "supported",
      source: "policy-default",
      strength: "assumed",
    });

    const emitted = (config.provider as Record<string, Record<string, unknown>>)
      .atlas.models as Record<string, Record<string, unknown>>;
    expect(emitted[id]).toEqual({
      id,
      name: "Atlas Disabled",
      modalities: { input: ["text"], output: ["text"] },
      temperature: true,
      limit: { context: 8192, output: 1024 },
    });
    expect(
      Object.keys(emitted[id]).some((key) => key.startsWith("_probe")),
    ).toBe(false);
  });

  it("labels pre-existing host values and preserves their object identity", async () => {
    const id = "atlas-existing";
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/v1/models")) return listResponse([id]);
      return { ok: false, status: 404 };
    });
    const existing = {
      id,
      name: "Existing Atlas",
      limit: { context: 4096 },
      temperature: true,
      reasoning: false,
    };
    const config = atlasConfig({ [id]: existing });

    const providers = await discoverModels(config);
    const record = providers[0].models[0];
    expect(record.origin).toBe("pre-existing");
    expect(record.name).toMatchObject({
      state: "known",
      source: "pre-existing",
      strength: "configured",
      value: "Existing Atlas",
    });
    expect(record.context).toMatchObject({
      state: "known",
      source: "pre-existing",
      strength: "configured",
      value: 4096,
    });
    expect(record.capabilities.temperature).toMatchObject({
      state: "supported",
      source: "pre-existing",
      strength: "configured",
    });
    expect(record.capabilities.reasoning).toEqual({
      state: "unsupported",
      source: "pre-existing",
      strength: "configured",
    });
    expect(
      (config.provider as Record<string, Record<string, unknown>>).atlas.models,
    ).toEqual({ [id]: existing });
  });

  it("catalogs every configured model while skipping only server-returned IDs", async () => {
    const listed = "atlas-listed";
    const localOnly = "atlas-local-only";
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/v1/models"))
        return listResponse([listed, listed, "atlas-new"]);
      return { ok: false, status: 404 };
    });
    const config = atlasConfig({
      [listed]: { id: listed, name: "Atlas Listed" },
      [localOnly]: { id: localOnly, name: "Atlas Local" },
    });

    const [provider] = await discoverModels(config);
    expect(provider.skippedModelIds).toEqual([listed]);
    expect(provider.models.map((model) => model.id).sort()).toEqual([
      listed,
      localOnly,
      "atlas-new",
    ]);
    expect(provider.models.filter((model) => model.id === listed)).toHaveLength(
      1,
    );
    expect(
      provider.models.find((model) => model.id === localOnly)?.origin,
    ).toBe("pre-existing");
  });

  it("retains configured models in the catalog when the model list is unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("offline"));
    const config = atlasConfig({
      "atlas-configured": {
        id: "atlas-configured",
        name: "Atlas Configured",
      },
    });

    const [provider] = await discoverModels(config);
    expect(provider.modelListAttempt).toBe("unreachable");
    expect(provider.skippedModelIds).toEqual([]);
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0]).toMatchObject({
      id: "atlas-configured",
      origin: "pre-existing",
      name: { strength: "configured" },
    });
  });

  it("classifies an empty probe result conservatively instead of as failure", async () => {
    const id = "atlas-no-detail";
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/v1/models")) return listResponse([id]);
      return { ok: false, status: 404 };
    });

    const [provider] = await discoverModels(atlasConfig());
    expect(provider).toMatchObject({
      status: "ready",
      modelListAttempt: "ready",
      probeAttempt: "empty",
    });
  });

  it("retains typed empty, unreachable, and aborted list outcomes", async () => {
    mockFetch.mockResolvedValueOnce(listResponse([]));
    const [empty] = await discoverModels(atlasConfig());
    expect(empty).toMatchObject({ status: "empty", modelListAttempt: "empty" });

    mockFetch.mockRejectedValueOnce(new Error("offline"));
    const [offline] = await discoverModels(atlasConfig());
    expect(offline).toMatchObject({
      status: "unreachable",
      modelListAttempt: "unreachable",
    });

    const controller = new AbortController();
    mockFetch.mockImplementationOnce(async () => {
      controller.abort();
      return listResponse([]);
    });
    const [aborted] = await discoverModels(
      atlasConfig(),
      undefined,
      controller.signal,
    );
    expect(aborted).toMatchObject({
      status: "aborted",
      modelListAttempt: "aborted",
    });
  });
});
