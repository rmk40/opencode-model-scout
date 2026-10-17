import { describe, expect, it } from "vitest";
import type { InventoryModel, ProviderInventory } from "../src/discover";
import type { SourceModelLike } from "../src/models-dev-index";
import type { Binding } from "../src/store";
import {
  createModelTransform,
  createProviderTransform,
  createTransformState,
  eligibleTarget,
  type ModelEditor,
  type ProviderEditor,
  type ProviderLike,
  type TransformState,
} from "../src/transform";

const COMPAT = "aisdk:@ai-sdk/openai-compatible";

function provider(
  id: string,
  overrides: Partial<ProviderLike> & {
    settings?: Record<string, unknown>;
  } = {},
): ProviderLike {
  return {
    id,
    package: COMPAT,
    settings: { baseURL: `http://${id}.local/v1`, apiKey: `${id}-key` },
    ...overrides,
  };
}

describe("eligibleTarget", () => {
  const recorded = new Set(["openai", "openrouter", "groq", "collides"]);

  it("discovers a config-only openai-compatible provider", () => {
    expect(eligibleTarget(provider("my-server"), recorded)).toBeDefined();
  });

  it("leaves a connected catalog provider untouched", () => {
    expect(eligibleTarget(provider("openrouter"), recorded)).toBeUndefined();
  });

  it("leaves a canonical alias of a catalog provider untouched", () => {
    expect(
      eligibleTarget(
        provider("work-openai", { canonical: "openai" }),
        recorded,
      ),
    ).toBeUndefined();
  });

  it("needs the openai-compatible package for auto-eligibility", () => {
    expect(
      eligibleTarget(
        provider("my-server", { package: "aisdk:@ai-sdk/openai" }),
        recorded,
      ),
    ).toBeUndefined();
    expect(
      eligibleTarget(
        provider("my-server", {
          package: "@opencode/ai/providers/openai-compatible",
        }),
        recorded,
      ),
    ).toBeDefined();
  });

  it("lets settings.probe opt in any provider with a base URL", () => {
    expect(
      eligibleTarget(
        provider("collides", {
          canonical: "openai",
          package: "aisdk:@ai-sdk/openai",
          settings: { baseURL: "http://x/v1", probe: "auto" },
        }),
        recorded,
      ),
    ).toMatchObject({ providerID: "collides", probe: "auto" });
  });

  it.each(["ollama", "lmstudio", "vllm", "opencode"])(
    "always skips the built-in %s provider",
    (id) => {
      expect(
        eligibleTarget(
          provider(id, { settings: { baseURL: "http://x/v1", probe: "auto" } }),
          new Set(),
        ),
      ).toBeUndefined();
    },
  );

  it("requires a base URL", () => {
    expect(
      eligibleTarget(
        provider("my-server", { settings: { probe: "auto" } }),
        recorded,
      ),
    ).toBeUndefined();
  });

  it("does not auto-target anything before the provider set is recorded", () => {
    expect(eligibleTarget(provider("my-server"), undefined)).toBeUndefined();
  });

  it("uses the integration ID for credentials, defaulting to the provider ID", () => {
    expect(eligibleTarget(provider("my-server"), recorded)?.integrationID).toBe(
      "my-server",
    );
    expect(
      eligibleTarget(provider("my-server", { integrationID: "acme" }), recorded)
        ?.integrationID,
    ).toBe("acme");
  });

  it("shares one key between a deprecated probe alias and its current ID", () => {
    const alias = eligibleTarget(
      provider("my-server", {
        settings: { baseURL: "http://x/v1", probe: "atlas" },
      }),
      recorded,
    );
    const current = eligibleTarget(
      provider("my-server", {
        settings: { baseURL: "http://x/v1", probe: "actualyze" },
      }),
      recorded,
    );
    expect(alias?.keys).toEqual(current?.keys);
  });
});

// ── Fake host editors ────────────────────────────────────────────────────

interface SourceRecord {
  provider: ProviderLike;
  models: Map<string, SourceModelLike>;
}

type FakeModel = Record<string, unknown>;

function defaultModel(providerID: string, id: string): FakeModel {
  return {
    id,
    modelID: id,
    providerID,
    name: id,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  };
}

/** A fold over source records: only available providers accept updates. */
function fakeModelEditor(records: SourceRecord[], available = records) {
  const candidates = new Map<string, Map<string, FakeModel>>(
    available.map((record) => [
      record.provider.id,
      new Map(
        [...record.models.keys()].map((id) => [
          id,
          { ...defaultModel(record.provider.id, id), declared: true },
        ]),
      ),
    ]),
  );
  const editor = {
    provider: {
      list: () => records,
      get: (id: string) => records.find((record) => record.provider.id === id),
    },
    update: (
      providerID: string,
      modelID: string,
      update: (model: FakeModel) => void,
    ) => {
      const models = candidates.get(providerID);
      if (!models) return;
      const model = models.get(modelID) ?? defaultModel(providerID, modelID);
      update(model);
      models.set(modelID, model);
    },
  };
  return { editor: editor as unknown as ModelEditor, candidates };
}

function run(
  state: TransformState,
  records: SourceRecord[],
  available = records,
) {
  const fake = fakeModelEditor(records, available);
  createModelTransform(state)(fake.editor);
  return fake.candidates;
}

function inventory(
  models: InventoryModel[],
  completedAt = "2026-01-01T00:00:00.000Z",
): ProviderInventory {
  return {
    modelListAttempt: "ready",
    probeAttempt: "complete",
    resolvedProbe: "omlx",
    models,
    completedAt,
  };
}

/** Make a binding the instance's active one, as the refresher does. */
function bind(
  state: TransformState,
  target: ProviderLike,
  models: InventoryModel[],
): Binding {
  const eligible = eligibleTarget(target, new Set())!;
  const binding: Binding = {
    key: eligible.keys.key,
    endpointKey: eligible.keys.endpointKey,
    providerID: target.id,
    credential: "settings",
    inventory: inventory(models),
  };
  state.active.set(target.id, binding);
  return binding;
}

function record(target: ProviderLike, declared: string[] = []): SourceRecord {
  return {
    provider: target,
    models: new Map(
      declared.map((id) => [
        id,
        { capabilities: { tools: true, input: ["text"] }, variants: [] },
      ]),
    ),
  };
}

function stateWith(recorded: string[]): TransformState {
  const state = createTransformState();
  state.recorded = new Set(recorded);
  return state;
}

describe("model transform", () => {
  it("adds served models and leaves declared ones untouched", () => {
    const state = stateWith([]);
    const target = provider("local");
    bind(state, target, [
      { id: "new-model", meta: { context: 8192 } },
      { id: "declared", meta: { context: 1 } },
    ]);
    const models = run(state, [record(target, ["declared"])]);
    expect(models.get("local")?.get("new-model")).toMatchObject({
      limit: { context: 8192, output: 0 },
      capabilities: { input: ["text"] },
    });
    expect(models.get("local")?.get("declared")).toMatchObject({
      declared: true,
      limit: { context: 200_000, output: 32_000 },
    });
    expect(state.view.get("local")?.declared).toEqual(new Set(["declared"]));
  });

  it("does nothing for a target whose provider record is missing on this fold", () => {
    const state = stateWith([]);
    const target = provider("local");
    bind(state, target, [{ id: "m" }]);
    expect([...run(state, []).keys()]).toEqual([]);
    expect(state.view.size).toBe(0);
  });

  it("does not add models to an unavailable provider", () => {
    const state = stateWith([]);
    const target = provider("local");
    bind(state, target, [{ id: "m" }]);
    expect(run(state, [record(target)], []).size).toBe(0);
  });

  it("serves a target with settings.apiKey nothing until the refresher sets its active binding", () => {
    const state = stateWith([]);
    const target = provider("local");
    expect(run(state, [record(target)]).get("local")?.size).toBe(0);
    expect(state.view.get("local")?.inventory).toBeUndefined();
  });

  it("keeps serving the active binding across a probe-only edit", () => {
    const state = stateWith([]);
    const before = provider("local", {
      settings: { baseURL: "http://local/v1", probe: "omlx" },
    });
    bind(state, before, [{ id: "m" }]);
    const after = provider("local", {
      settings: { baseURL: "http://local/v1", probe: "vllm" },
    });
    expect(
      run(state, [record(after)])
        .get("local")
        ?.has("m"),
    ).toBe(true);
  });

  it("serves nothing after an endpoint change until rediscovery", () => {
    const state = stateWith([]);
    const before = provider("local", {
      settings: { baseURL: "http://local/v1" },
    });
    bind(state, before, [{ id: "m" }]);
    const after = provider("local", {
      settings: { baseURL: "http://elsewhere/v1" },
    });
    expect(run(state, [record(after)]).get("local")?.size).toBe(0);
  });

  it("isolates a provider whose patches cannot be computed", () => {
    const state = stateWith([]);
    const broken = provider("broken");
    const good = provider("good");
    const binding = bind(state, broken, []);
    // A malformed inventory makes the pure mapping pass throw.
    (binding.inventory as { models: unknown }).models = null;
    bind(state, good, [{ id: "m" }]);
    const models = run(state, [record(broken), record(good)]);
    expect(models.get("broken")?.size).toBe(0);
    expect(models.get("good")?.has("m")).toBe(true);
    expect(state.view.get("broken")?.failed).toBe(true);
  });

  it("keeps separate recorded sets for two locations with different provider plugins", () => {
    const recorderA = createTransformState();
    const recorderB = createTransformState();
    createProviderTransform(recorderA)(
      fakeProviderEditor([provider("plugin-provider")]).editor,
    );
    createProviderTransform(recorderB)(fakeProviderEditor([]).editor);
    const target = provider("plugin-provider");
    expect(eligibleTarget(target, recorderA.recorded)).toBeUndefined();
    expect(eligibleTarget(target, recorderB.recorded)).toBeDefined();
  });

  it("replaces the recorded set on every fold", () => {
    const state = createTransformState();
    const transform = createProviderTransform(state);
    transform(fakeProviderEditor([provider("a"), provider("b")]).editor);
    transform(fakeProviderEditor([provider("c")]).editor);
    expect(state.recorded).toEqual(new Set(["c"]));
  });
});

// ── Built-in Actualyze provider ──────────────────────────────────────────

function fakeProviderEditor(initial: readonly ProviderLike[]) {
  const records = new Map(
    initial.map((info) => [info.id, { provider: info, models: new Map() }]),
  );
  const editor = {
    list: () => [...records.values()],
    get: (id: string) => records.get(id),
    add: ({ info }: { info: ProviderLike }) => {
      records.set(info.id, { provider: info, models: new Map() });
    },
  } as unknown as ProviderEditor;
  return { editor, records };
}

describe("provider transform", () => {
  it("adds a discoverable Actualyze provider that does not count as pre-existing", () => {
    const state = createTransformState();
    const { editor, records } = fakeProviderEditor([provider("openrouter")]);
    createProviderTransform(state)(editor);

    expect(state.recorded).toEqual(new Set(["openrouter"]));
    const added = records.get("actualyze")?.provider;
    expect(added).toEqual({
      id: "actualyze",
      integrationID: "actualyze",
      name: "Actualyze",
      activation: "auto",
      package: "@opencode/ai/providers/openai-compatible",
      settings: {
        baseURL: "https://app.actualyze.ai/openai/v1",
        probe: "actualyze",
      },
    });
    expect(eligibleTarget(added!, state.recorded)).toMatchObject({
      providerID: "actualyze",
      integrationID: "actualyze",
      baseURL: "https://app.actualyze.ai/openai/v1",
      probe: "actualyze",
    });
  });

  it("keeps an existing actualyze provider, which stays out of auto-discovery", () => {
    const state = createTransformState();
    const catalog = provider("actualyze", {
      package: "@ai-sdk/openai-compatible",
      settings: { baseURL: "https://catalog.example/v1" },
    });
    const { editor, records } = fakeProviderEditor([catalog]);
    createProviderTransform(state)(editor);

    expect(records.get("actualyze")?.provider).toBe(catalog);
    expect(state.recorded?.has("actualyze")).toBe(true);
    expect(eligibleTarget(catalog, state.recorded)).toBeUndefined();
  });

  it("still records providers when adding Actualyze fails", () => {
    const state = createTransformState();
    const { editor } = fakeProviderEditor([provider("a")]);
    (editor as { add: unknown }).add = () => {
      throw new Error("rejected");
    };
    expect(() => createProviderTransform(state)(editor)).not.toThrow();
    expect(state.recorded).toEqual(new Set(["a"]));
    expect(state.actualyze).toBe("failed");
  });

  it("records on every fold whether it added Actualyze or found another", () => {
    const state = createTransformState();
    expect(state.actualyze).toBeUndefined();
    const transform = createProviderTransform(state);
    transform(fakeProviderEditor([provider("actualyze")]).editor);
    expect(state.actualyze).toBe("existing");
    transform(fakeProviderEditor([]).editor);
    expect(state.actualyze).toBe("added");
  });
});

// ── Replay idempotence ───────────────────────────────────────────────────

function random(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function randomScenario(seed: number) {
  const next = random(seed);
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(next() * values.length)];
  const maybe = <T>(value: T): T | undefined =>
    next() < 0.5 ? value : undefined;
  const providers = Array.from({ length: 1 + Math.floor(next() * 3) }, (_, i) =>
    provider(`p${i}`, {
      ...(next() < 0.3 ? { package: "aisdk:@ai-sdk/openai" } : {}),
      settings: {
        baseURL: `http://p${i}/v1`,
        apiKey: `p${i}-key`,
        ...(next() < 0.5 ? { probe: pick(["auto", "omlx", "actualyze"]) } : {}),
      },
    }),
  );
  const ids = ["llama-3-8b", "qwen3-vl", "nomic-embed", "z/glm-4.5", "x"];
  const inventories = providers.map(() =>
    ids
      .filter(() => next() < 0.7)
      .map((id) => ({
        id,
        ...(next() < 0.5 ? { created: 1_700_000_000 } : {}),
        ...(next() < 0.8
          ? {
              meta: {
                context: maybe(1 + Math.floor(next() * 200_000)),
                maxTokens: maybe(1 + Math.floor(next() * 50_000)),
                toolCall: maybe(next() < 0.5),
                reasoning: maybe(next() < 0.5),
                vision: maybe(next() < 0.5),
                modelType: maybe(pick(["llm", "vlm", "embedding"] as const)),
                inputModalities: maybe(
                  (["text", "image", "pdf", "audio", "video"] as const).filter(
                    () => next() < 0.5,
                  ),
                ),
                cost: maybe({
                  input: next() * 10,
                  output: next() * 10,
                  cacheRead: maybe(next()),
                }),
                family: maybe("fam"),
              },
            }
          : {}),
      })),
  );
  const declared = providers.map(() => ids.filter(() => next() < 0.2));
  return { providers, inventories, declared };
}

function stripUndefined(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("replay", () => {
  it("produces the same catalog and evidence on every replay", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const scenario = randomScenario(seed);
      const state = stateWith([]);
      scenario.providers.forEach((target, index) => {
        if (!eligibleTarget(target, state.recorded)) return;
        const models = stripUndefined(
          scenario.inventories[index],
        ) as InventoryModel[];
        bind(state, target, models);
      });
      const records = scenario.providers.map((target, index) =>
        record(target, scenario.declared[index]),
      );

      const first = run(state, records);
      const firstView = state.view;
      const second = run(state, records);
      expect(second, `seed ${seed}`).toEqual(first);
      expect(state.view, `seed ${seed}`).toEqual(firstView);

      // Applying the transform twice within one fold equals applying it once.
      const fake = fakeModelEditor(records);
      const transform = createModelTransform(state);
      transform(fake.editor);
      transform(fake.editor);
      expect(fake.candidates, `seed ${seed}`).toEqual(first);
    }
  });
});
