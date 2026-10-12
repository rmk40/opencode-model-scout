import { describe, expect, it, vi } from "vitest";

vi.mock("../src/probes/index", () => ({
  resolveProbe: vi.fn(async () => ({
    detectedServer: "atlas",
    probe: async () => ({
      models: {
        "atlas-positive": {
          modelType: "llm",
          context: 8192,
          toolCall: true,
          reasoning: false,
          vision: false,
        },
        "atlas-temperature-override": {
          modelType: "llm",
          temperature: false,
        },
        "atlas-llm-no-vision": {
          modelType: "llm",
        },
      },
    }),
  })),
}));

import { discoverModels } from "../src/discover";

function config(baseURL = "https://atlas.test/v1"): Record<string, unknown> {
  return {
    provider: {
      Atlas: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL, apiKey: "AtlasApiKey", probe: "auto" },
      },
    },
  };
}

function listResponse() {
  return {
    ok: true,
    json: async () => ({
      data: [
        { id: "atlas-positive", owned_by: "atlas" },
        { id: "atlas-temperature-override", owned_by: "atlas" },
        { id: "atlas-llm-no-vision", owned_by: "atlas" },
        { id: "atlas-fallback", owned_by: "atlas", body: "AtlasBody" },
        { id: "atlas-chat", owned_by: "atlas", error: "AtlasError" },
      ],
      headers: { Authorization: "AtlasApiKey" },
    }),
  };
}

describe("discovery evidence precedence", () => {
  it("distinguishes probe claims, fallback claims, heuristics, and temperature policy", async () => {
    mockFetch.mockResolvedValue(listResponse());
    const current = config();
    const fallback: NonNullable<Parameters<typeof discoverModels>[1]> = [
      {
        id: "atlas-positive",
        normalized: "atlas-positive",
        meta: {
          toolCall: true,
          reasoning: true,
          attachment: true,
          temperature: false,
        },
      },
      {
        id: "atlas-fallback",
        normalized: "atlas-fallback",
        meta: {
          toolCall: true,
          reasoning: true,
          attachment: true,
          temperature: true,
        },
      },
      {
        id: "atlas-llm-no-vision",
        normalized: "atlas-llm-no-vision",
        meta: {
          toolCall: false,
          reasoning: false,
          attachment: true,
          temperature: false,
        },
      },
    ];

    const [provider] = await discoverModels(current, fallback);
    const records = new Map(
      provider.models.map((record) => [record.id, record]),
    );
    expect(records.get("atlas-positive")).toMatchObject({
      modelType: { source: "provider-probe", strength: "authoritative" },
      context: { value: 8192, source: "provider-probe" },
      capabilities: {
        vision: { state: "unsupported", source: "provider-probe" },
        toolCall: { state: "supported", source: "provider-probe" },
        reasoning: { state: "unsupported", source: "provider-probe" },
        temperature: { state: "supported", source: "policy-default" },
      },
    });
    expect(
      records.get("atlas-temperature-override")?.capabilities.temperature,
    ).toEqual({
      state: "unsupported",
      source: "provider-probe",
      strength: "authoritative",
    });
    expect(records.get("atlas-fallback")).toMatchObject({
      modelType: { value: "vlm", source: "models.dev" },
      capabilities: {
        vision: { state: "supported", source: "models.dev" },
        toolCall: { state: "supported", source: "models.dev" },
        reasoning: { state: "supported", source: "models.dev" },
        temperature: { state: "supported", source: "models.dev" },
      },
    });
    expect(records.get("atlas-llm-no-vision")).toMatchObject({
      modelType: {
        value: "llm",
        source: "provider-probe",
        strength: "authoritative",
      },
      capabilities: {
        vision: {
          state: "unsupported",
          source: "provider-probe",
          strength: "authoritative",
        },
      },
    });
    const emitted = (
      current.provider as Record<string, Record<string, unknown>>
    ).Atlas.models as Record<string, Record<string, unknown>>;
    expect(emitted["atlas-positive"]).toEqual({
      id: "atlas-positive",
      name: "Atlas Positive",
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 8192 },
      tool_call: true,
      temperature: true,
    });
    expect(emitted["atlas-temperature-override"].temperature).toBe(false);
    expect(
      Object.values(emitted).some((model) =>
        Object.keys(model).some((key) => key.startsWith("_probe")),
      ),
    ).toBe(false);
  });

  it("uses heuristic type evidence when no probe or fallback claims it", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "atlas-chat", owned_by: "atlas" }],
      }),
    });

    const [provider] = await discoverModels(config());
    expect(provider.models[0].modelType).toEqual({
      state: "known",
      value: "llm",
      source: "heuristic",
      strength: "inferred",
    });
  });

  it("does not copy request secrets or unmodeled response data into evidence", async () => {
    mockFetch.mockResolvedValue(listResponse());
    const current = config(
      "https://Atlas:Atlas@atlas.test/private/v1?Atlas=Atlas#Atlas",
    );

    const providers = await discoverModels(current);
    const payload = JSON.stringify(providers);
    expect(providers[0].endpointOrigin).toMatchObject({
      state: "known",
      value: "https://atlas.test",
    });
    for (const secret of [
      "AtlasApiKey",
      "Authorization",
      "AtlasBody",
      "AtlasError",
      "/private",
      "?Atlas",
      "#Atlas",
    ]) {
      expect(payload).not.toContain(secret);
    }
  });
});
