import { describe, expect, it } from "vitest";
import {
  CATALOG_SCHEMA_VERSION,
  knownScalar,
  unknownCapability,
  unknownScalar,
  type CapabilityEvidence,
  type CatalogPayload,
  type CatalogProviderRecord,
} from "../src/catalog-evidence";
import {
  blockWindow,
  browserLayout,
  cycleFilter,
  entryWindow,
  DEFAULT_FILTERS,
  DEFAULT_NAV,
  filterSummary,
  filterFields,
  fitFooterHints,
  footerSegments,
  glyphSegments,
  hasNarrowing,
  initialSelection,
  justify,
  matchesQuery,
  modelKey,
  modelRowSegments,
  nextSort,
  paneWindow,
  projectBrowser,
  providerKey,
  providerRowSegments,
  refreshWaitSeconds,
  scrollBlocks,
  scrollEntries,
  scrollPane,
  scrollUnits,
  sortModels,
  type BrowserData,
  type NavState,
} from "../src/tui-browser";
import { providerStatus } from "../src/tui-detail";
import { routeKey, type RouteContext } from "../src/tui-keys";
import type { ModelRow, ProviderGroup } from "../src/tui-models";
import { readNav } from "../src/tui-session";

const CONFIRMED: CapabilityEvidence = {
  state: "supported",
  source: "provider-probe",
  strength: "authoritative",
};
const ASSUMED: CapabilityEvidence = {
  state: "supported",
  source: "host-default",
  strength: "assumed",
};

function model(id: string, overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id,
    name: id,
    enabled: true,
    type: "llm",
    context: 128_000,
    flags: [],
    capabilities: {
      toolCall: unknownCapability(),
      reasoning: unknownCapability(),
      temperature: unknownCapability(),
    },
    ...overrides,
  };
}

function group(id: string, models: ModelRow[], name = id): ProviderGroup {
  return { id, provider: name, hasEvidence: true, models };
}

function data(groups: ProviderGroup[], catalog?: CatalogPayload): BrowserData {
  return {
    status: "ready",
    groups,
    ...(catalog
      ? { catalog, catalogReceivedAt: Date.parse(catalog.generatedAt) }
      : {}),
    hostListed: new Set(),
  };
}

function nav(overrides: Partial<NavState> = {}): NavState {
  return { ...DEFAULT_NAV, filters: { ...DEFAULT_FILTERS }, ...overrides };
}

function record(
  id: string,
  overrides: Partial<CatalogProviderRecord> = {},
): CatalogProviderRecord {
  return {
    id,
    endpointOrigin: unknownScalar(),
    configuredProbe: unknownScalar(),
    resolvedProbe: unknownScalar(),
    lastGoodAt: "2026-10-11T08:00:00.000Z",
    failure: null,
    modelListAttempt: "ready",
    probeAttempt: "complete",
    skippedModelIds: [],
    models: [],
    discovering: false,
    lastAttemptAt: "2026-10-11T08:00:00.000Z",
    nextRefreshAt: null,
    credentialSource: "connection",
    credentialEpoch: 1,
    resultEpoch: 1,
    ...overrides,
  };
}

function catalog(providers: CatalogProviderRecord[]): CatalogPayload {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    packageVersion: "2.0.0",
    instanceID: "instance",
    generatedAt: "2026-10-11T08:00:00.000Z",
    status: "complete",
    completedAt: "2026-10-11T08:00:00.000Z",
    builtIn: { actualyze: "managed" },
    providers,
  };
}

const ALL = { kind: "all" } as const;

function keys(projection: ReturnType<typeof projectBrowser>): string[] {
  return projection.rows.map((row) =>
    row.kind === "model"
      ? `  ${row.model?.id}`
      : row.kind === "provider"
        ? row.group.id
        : "note",
  );
}

describe("routeKey", () => {
  const list: RouteContext = { screen: "list", focus: "list" };

  it("leaves every key but enter and down to the focused search input", () => {
    const search: RouteContext = { screen: "list", focus: "search" };
    expect(routeKey(search, { name: "m", sequence: "m" })).toBeUndefined();
    expect(routeKey(search, { name: "?", sequence: "?" })).toBeUndefined();
    expect(routeKey(search, { name: "backspace" })).toBeUndefined();
    expect(routeKey(search, { name: "return" })).toEqual({
      type: "leave-search",
    });
    expect(routeKey(search, { name: "down" })).toEqual({
      type: "leave-search",
    });
    expect(routeKey(search, { name: "up" })).toBeUndefined();
  });

  it("runs letter actions from the list", () => {
    expect(routeKey(list, { name: "m", sequence: "m" })).toEqual({
      type: "picker",
    });
    expect(routeKey(list, { name: "f", sequence: "f" })).toEqual({
      type: "filters",
    });
    expect(routeKey(list, { name: "/", sequence: "/" })).toEqual({
      type: "focus-search",
    });
    expect(routeKey(list, { name: "left" })).toEqual({ type: "collapse" });
    expect(routeKey(list, { name: "return" })).toEqual({ type: "open" });
    expect(routeKey(list, { name: "pagedown" })).toEqual({
      type: "move",
      move: "pagedown",
    });
  });

  it("tells shifted letters apart by sequence or by the shift flag", () => {
    expect(routeKey(list, { name: "r", sequence: "R", shift: true })).toEqual({
      type: "refresh-all",
    });
    expect(routeKey(list, { name: "r", sequence: "", shift: true })).toEqual({
      type: "refresh-all",
    });
    expect(routeKey(list, { name: "y", sequence: "Y", shift: true })).toEqual({
      type: "copy",
      what: "id",
    });
    expect(routeKey(list, { name: "y", sequence: "y" })).toEqual({
      type: "copy",
      what: "qualified",
    });
  });

  it("leaves keys with command modifiers to the host", () => {
    expect(
      routeKey(list, { name: "r", sequence: "r", ctrl: true }),
    ).toBeUndefined();
    expect(
      routeKey(list, { name: "y", sequence: "y", meta: true }),
    ).toBeUndefined();
  });

  it("scrolls and goes back in the detail pane and screens, and keeps list-only keys out", () => {
    for (const context of [
      { screen: "list", focus: "pane" },
      { screen: "detail", focus: "list" },
    ] as const) {
      expect(routeKey(context, { name: "down" })).toEqual({
        type: "scroll",
        move: "down",
      });
      expect(routeKey(context, { name: "backspace" })).toEqual({
        type: "back",
      });
      expect(routeKey(context, { name: "m", sequence: "m" })).toEqual({
        type: "picker",
      });
      expect(routeKey(context, { name: "f", sequence: "f" })).toBeUndefined();
      expect(routeKey(context, { name: "return" })).toBeUndefined();
    }
    expect(
      routeKey({ screen: "list", focus: "list" }, { name: "backspace" }),
    ).toBeUndefined();
  });

  it("changes filter values with left, right, enter, and space", () => {
    const filters: RouteContext = { screen: "filters", focus: "list" };
    expect(routeKey(filters, { name: "left" })).toEqual({
      type: "filter-change",
      direction: -1,
    });
    expect(routeKey(filters, { name: "space", sequence: " " })).toEqual({
      type: "filter-change",
      direction: 1,
    });
    expect(routeKey(filters, { name: "return" })).toEqual({
      type: "filter-change",
      direction: 1,
    });
    expect(routeKey(filters, { name: "x", sequence: "x" })).toEqual({
      type: "clear",
    });
    expect(routeKey(filters, { name: "m", sequence: "m" })).toBeUndefined();
  });

  it("routes only caller-registered extra letters", () => {
    const withExtra: RouteContext = { ...list, extraKeys: new Set(["k"]) };
    expect(routeKey(withExtra, { name: "k", sequence: "k" })).toEqual({
      type: "extra",
      key: "k",
    });
    expect(routeKey(list, { name: "k", sequence: "k" })).toBeUndefined();
  });
});

describe("projectBrowser", () => {
  const embed = model("embed", { type: "embedding" });
  const chat = model("chat");

  it("hides embedding models by default and counts them", () => {
    const projection = projectBrowser(
      data([group("p", [chat, embed])]),
      nav(),
      { scope: ALL, width: 72 },
    );
    expect(keys(projection)).toEqual(["p", "  chat"]);
    expect(projection.embeddingsHidden).toBe(1);
    expect(projection.totalModels).toBe(1);
    const all = projectBrowser(
      data([group("p", [chat, embed])]),
      nav({ filters: { ...DEFAULT_FILTERS, type: "all" } }),
      { scope: ALL, width: 72 },
    );
    expect(keys(all)).toEqual(["p", "  chat", "  embed"]);
    expect(all.embeddingsHidden).toBe(0);
  });

  it("matches every search term against the model or its provider", () => {
    const groups = [
      group("atlas", [model("qwen3-coder"), model("llama")], "Atlas Cloud"),
      group("other", [model("qwen3-coder")]),
    ];
    const projection = projectBrowser(
      data(groups),
      nav({ query: "QWEN atlas" }),
      { scope: ALL, width: 72 },
    );
    expect(keys(projection)).toEqual(["atlas", "  qwen3-coder"]);
  });

  it("drops providers without matches while narrowing, but keeps an empty provider otherwise", () => {
    const groups = [group("a", [chat]), group("b", [])];
    expect(
      keys(projectBrowser(data(groups), nav(), { scope: ALL, width: 72 })),
    ).toEqual(["a", "  chat", "b", "note"]);
    expect(
      keys(
        projectBrowser(data(groups), nav({ query: "chat" }), {
          scope: ALL,
          width: 72,
        }),
      ),
    ).toEqual(["a", "  chat"]);
  });

  it("hides a collapsed group's models unless a search is active", () => {
    const groups = [group("a", [chat])];
    expect(
      keys(
        projectBrowser(data(groups), nav({ collapsed: ["a"] }), {
          scope: ALL,
          width: 72,
        }),
      ),
    ).toEqual(["a"]);
    expect(
      keys(
        projectBrowser(data(groups), nav({ collapsed: ["a"], query: "chat" }), {
          scope: ALL,
          width: 72,
        }),
      ),
    ).toEqual(["a", "  chat"]);
  });

  it("lets an assumed capability satisfy a needs filter only with uncertain matches on", () => {
    const assumed = model("assumed", {
      capabilities: {
        toolCall: ASSUMED,
        reasoning: unknownCapability(),
        temperature: unknownCapability(),
      },
    });
    const confirmed = model("confirmed", {
      capabilities: {
        toolCall: CONFIRMED,
        reasoning: unknownCapability(),
        temperature: unknownCapability(),
      },
    });
    const groups = [group("p", [assumed, confirmed])];
    const strict = nav({ filters: { ...DEFAULT_FILTERS, tools: true } });
    expect(
      keys(projectBrowser(data(groups), strict, { scope: ALL, width: 72 })),
    ).toEqual(["p", "  confirmed"]);
    const loose = nav({
      filters: { ...DEFAULT_FILTERS, tools: true, uncertain: true },
    });
    expect(
      keys(projectBrowser(data(groups), loose, { scope: ALL, width: 72 })),
    ).toEqual(["p", "  assumed", "  confirmed"]);
  });

  it("lists a single provider without a header", () => {
    const groups = [group("a", [chat]), group("b", [model("other")])];
    expect(
      keys(
        projectBrowser(data(groups), nav(), {
          scope: { kind: "provider", providerID: "b" },
          width: 72,
        }),
      ),
    ).toEqual(["  other"]);
  });

  it("counts providers whose current result is a failure", () => {
    const groups = [group("a", [chat]), group("b", [chat]), group("c", [chat])];
    const failure = {
      kind: "unauthorized" as const,
      at: "2026-10-11T08:00:00.000Z",
      httpStatus: 401,
    };
    const payload = catalog([
      record("a", { failure }),
      // A failure from an earlier credential does not count.
      record("b", { failure, credentialEpoch: 2, resultEpoch: 1 }),
      record("c"),
    ]);
    expect(
      projectBrowser(data(groups, payload), nav(), { scope: ALL, width: 72 })
        .attention,
    ).toBe(1);
  });
});

describe("sortModels", () => {
  it("sorts by largest context with assumed and missing contexts last", () => {
    const assumedContext = model("assumed", {
      context: 200_000,
      provenance: { context: knownScalar(200_000, "host-default", "assumed") },
    });
    const sorted = sortModels(
      [
        model("small", { context: 8_000 }),
        assumedContext,
        model("none", { context: undefined }),
        model("big", { context: 1_000_000 }),
      ],
      "context",
    );
    expect(sorted.map((item) => item.id)).toEqual([
      "big",
      "small",
      "assumed",
      "none",
    ]);
  });

  it("sorts by input price with unpriced models last", () => {
    const priced = (id: string, input: number): ModelRow =>
      model(id, {
        cost: {
          input: knownScalar(input, "provider-probe", "authoritative"),
          output: unknownScalar(),
          cacheRead: unknownScalar(),
          cacheWrite: unknownScalar(),
        },
      });
    const sorted = sortModels(
      [model("free-text"), priced("dear", 3), priced("cheap", 0.15)],
      "input",
    );
    expect(sorted.map((item) => item.id)).toEqual([
      "cheap",
      "dear",
      "free-text",
    ]);
  });
});

describe("initialSelection", () => {
  const groups = [
    // Sorted by name, the embedding model comes first and "current" last.
    group("a", [
      model("zz-current"),
      model("first"),
      model("a-embed", { type: "embedding" }),
    ]),
  ];
  const rows = projectBrowser(
    data(groups),
    nav({ filters: { ...DEFAULT_FILTERS, type: "all" } }),
    { scope: ALL, width: 72 },
  ).rows;

  it("selects the prompt's current model when it is listed", () => {
    expect(
      initialSelection(rows, { providerID: "a", modelID: "zz-current" })?.key,
    ).toBe(modelKey("a", "zz-current"));
  });

  it("selects the first chat model otherwise, skipping the header and embeddings", () => {
    expect(initialSelection(rows, { providerID: "x", modelID: "y" })?.key).toBe(
      modelKey("a", "first"),
    );
    expect(initialSelection(rows, undefined)?.key).toBe(modelKey("a", "first"));
    expect(rows[0]?.key).toBe(providerKey("a"));
  });
});

describe("refreshWaitSeconds", () => {
  it("measures the wait on the server clock, less the time since the payload arrived", () => {
    const payload = catalog([
      record("a", { nextRefreshAt: "2026-10-11T08:01:00.000Z" }),
    ]);
    const snapshot = data([group("a", [])], payload);
    const receivedAt = Date.parse(payload.generatedAt);
    expect(
      refreshWaitSeconds(payload.providers[0], snapshot, receivedAt + 20_000),
    ).toBe(40);
    expect(
      refreshWaitSeconds(payload.providers[0], snapshot, receivedAt + 60_000),
    ).toBeUndefined();
    expect(
      refreshWaitSeconds(record("a"), snapshot, receivedAt),
    ).toBeUndefined();
  });
});

describe("providerStatus", () => {
  it("never shows an earlier credential's result", () => {
    const failure = {
      kind: "unauthorized" as const,
      at: "2026-10-11T08:00:00.000Z",
      httpStatus: 401,
    };
    expect(providerStatus(record("a", { failure }))).toEqual({
      text: "▲ key rejected",
      role: "error",
    });
    expect(
      providerStatus(record("a", { failure, credentialEpoch: 2 }))?.text,
    ).toBe("○ waiting");
    expect(
      providerStatus(record("a", { credentialSource: "unresolved" }))?.text,
    ).toBe("○ resolving");
    expect(providerStatus(record("a", { discovering: true }))?.text).toBe(
      "○ checking",
    );
    expect(providerStatus(record("a"))).toEqual({
      text: "● ready",
      role: "ok",
    });
  });
});

describe("modelRowSegments", () => {
  it("renders uncertain capabilities lowercase and OpenCode's default context with a tilde", () => {
    const row = model("m", {
      context: 200_000,
      provenance: { context: knownScalar(200_000, "host-default", "assumed") },
      capabilities: {
        toolCall: ASSUMED,
        reasoning: CONFIRMED,
        temperature: unknownCapability(),
      },
    });
    const text = modelRowSegments(row, 58, true)
      .map((segment) => segment.text)
      .join("");
    expect(text).toHaveLength(58);
    expect(text).toMatch(/^ ● m +~200K {2}t · R {2} +$/);
  });
});

describe("footerSegments", () => {
  const hints = [
    { title: "details", key: "enter" },
    { title: "picker", key: "m" },
    { title: "copy", key: "y" },
  ];

  it("drops hints from the right but keeps keys ? and close esc", () => {
    const text = (width: number): string =>
      footerSegments(hints, width)
        .map((segment) => segment.text)
        .join("");
    expect(text(80)).toMatch(
      /^details enter {2}picker m {2}copy y {2}keys \? +close esc$/,
    );
    expect(text(40)).toMatch(/^details enter {2}keys \? +close esc$/);
    expect(text(80)).toHaveLength(80);
  });
});

describe("browserLayout", () => {
  it("places the detail pane beside the list from 120 columns", () => {
    expect(browserLayout(120, 36)).toMatchObject({
      wide: true,
      width: 110,
      outerWidth: 116,
      height: 30,
      bodyHeight: 24,
      listWidth: 58,
      paneWidth: 49,
    });
    expect(browserLayout(80, 24)).toMatchObject({
      wide: false,
      width: 72,
      height: 19,
      listWidth: 72,
    });
    expect(browserLayout(119, 36).wide).toBe(false);
  });

  it("keeps the dialog, with the row the host adds above it, within rows - 4", () => {
    for (const rows of [24, 30, 34, 35, 36, 50]) {
      const { height } = browserLayout(120, rows);
      expect(height + 1).toBeLessThanOrEqual(rows - 4);
    }
    expect(browserLayout(120, 50).height).toBe(30);
  });
});

describe("filters", () => {
  it("cycles the provider through all and each ID, and toggles booleans", () => {
    const once = cycleFilter(DEFAULT_FILTERS, "provider", 1, ["a", "b"]);
    expect(once.provider).toBe("a");
    expect(cycleFilter(once, "provider", -1, ["a", "b"]).provider).toBe("all");
    expect(cycleFilter(DEFAULT_FILTERS, "type", -1, []).type).toBe("all");
    expect(cycleFilter(DEFAULT_FILTERS, "priced", 1, []).priced).toBe(true);
  });

  it("summarizes the active filters and hidden embeddings", () => {
    const state = nav({ filters: { ...DEFAULT_FILTERS, tools: true } });
    expect(filterSummary(state, ALL, [], 2)).toBe(
      "chat · all providers · tools · 2 embeddings hidden",
    );
    expect(
      filterSummary(state, { kind: "provider", providerID: "a" }, [], 1),
    ).toBe("chat · tools · 1 embedding hidden");
  });
});

describe("readNav", () => {
  it("falls back to defaults for anything an earlier version may have stored", () => {
    expect(readNav(undefined)).toEqual(nav());
    expect(
      readNav({
        query: 3,
        sort: "price",
        filters: { type: "vision", tools: "yes" },
        collapsed: ["a", 1],
        selected: { modelID: "m" },
      }),
    ).toEqual(nav({ collapsed: ["a"] }));
    expect(
      readNav({ selected: { providerID: "p", modelID: "m" } }).selected,
    ).toEqual({ providerID: "p", modelID: "m" });
  });

  it("reads back every valid stored field, and a provider-only selection", () => {
    const stored: NavState = {
      query: "qwen",
      filters: {
        provider: "atlas",
        type: "embedding",
        tools: true,
        images: true,
        reasoning: true,
        priced: true,
        uncertain: true,
      },
      sort: "output",
      collapsed: ["a", "b"],
      selected: { providerID: "atlas" },
    };
    expect(readNav(structuredClone(stored))).toEqual(stored);
  });

  it("copies stored values out instead of sharing them", () => {
    const stored = { collapsed: ["a"], filters: { tools: true } };
    const read = readNav(stored);
    read.collapsed.push("b");
    read.filters.tools = false;
    expect(stored).toEqual({ collapsed: ["a"], filters: { tools: true } });
  });
});

const PRICE = (value: number) =>
  knownScalar(value, "provider-probe", "authoritative");

function priced(
  id: string,
  input: number | undefined,
  output: number | undefined,
  overrides: Partial<ModelRow> = {},
): ModelRow {
  return model(id, {
    cost: {
      input: input === undefined ? unknownScalar() : PRICE(input),
      output: output === undefined ? unknownScalar() : PRICE(output),
      cacheRead: unknownScalar(),
      cacheWrite: unknownScalar(),
    },
    ...overrides,
  });
}

function withInput(
  id: string,
  image: CapabilityEvidence,
  overrides: Partial<ModelRow> = {},
): ModelRow {
  return model(id, {
    inputModalities: {
      text: unknownCapability(),
      image,
      pdf: unknownCapability(),
      audio: unknownCapability(),
      video: unknownCapability(),
    },
    ...overrides,
  });
}

const INFERRED: CapabilityEvidence = {
  state: "supported",
  source: "models.dev",
  strength: "inferred",
};
const UNSUPPORTED: CapabilityEvidence = {
  state: "unsupported",
  source: "provider-probe",
  strength: "authoritative",
};

function text(segments: readonly { text: string }[]): string {
  return segments.map((segment) => segment.text).join("");
}

describe("matchesQuery", () => {
  const atlas = group("atlas-cloud", [], "Atlas");
  const row = model("qwen3-coder-30b", {
    name: "Coder Large",
    family: "qwen3",
    quantization: "Q4_K_M",
  });

  it.each([
    ["the model ID", "coder-30b"],
    ["the provider ID", "atlas-cloud"],
    ["the provider name", "ATLAS"],
    ["the family", "qwen3"],
    ["the quantization", "q4_k"],
    ["terms spread over different fields", "large  q4_k_m atlas"],
  ])("matches %s", (_label, query) => {
    expect(matchesQuery(atlas, row, query)).toBe(true);
  });

  it("requires every term to match", () => {
    expect(matchesQuery(atlas, row, "coder llama")).toBe(false);
  });

  it("matches everything for a blank query", () => {
    expect(matchesQuery(atlas, row, "   ")).toBe(true);
  });
});

describe("projectBrowser filters", () => {
  const scope = { scope: ALL, width: 72 };

  it("shows only embeddings with the embedding type and hides no count", () => {
    const projection = projectBrowser(
      data([group("p", [model("chat"), model("vec", { type: "embedding" })])]),
      nav({ filters: { ...DEFAULT_FILTERS, type: "embedding" } }),
      scope,
    );
    expect(keys(projection)).toEqual(["p", "  vec"]);
    expect(projection.embeddingsHidden).toBe(0);
    expect(projection.totalModels).toBe(1);
  });

  it("counts only the hidden embeddings that match the search", () => {
    const projection = projectBrowser(
      data([
        group("p", [
          model("nomic-embed", { type: "embedding" }),
          model("bge", { type: "embedding" }),
          model("nomic-chat"),
        ]),
      ]),
      nav({ query: "nomic" }),
      scope,
    );
    expect(keys(projection)).toEqual(["p", "  nomic-chat"]);
    expect(projection.embeddingsHidden).toBe(1);
  });

  it("keeps a needs filter for images, letting inferred support count only with uncertain on", () => {
    const groups = [
      group("p", [
        withInput("seen", CONFIRMED),
        withInput("guessed", INFERRED),
        withInput("blind", UNSUPPORTED),
      ]),
    ];
    const strict = nav({ filters: { ...DEFAULT_FILTERS, images: true } });
    expect(keys(projectBrowser(data(groups), strict, scope))).toEqual([
      "p",
      "  seen",
    ]);
    const loose = nav({
      filters: { ...DEFAULT_FILTERS, images: true, uncertain: true },
    });
    expect(keys(projectBrowser(data(groups), loose, scope))).toEqual([
      "p",
      "  guessed",
      "  seen",
    ]);
  });

  it("keeps a needs filter for reasoning", () => {
    const thinker = model("thinker", {
      capabilities: {
        toolCall: unknownCapability(),
        reasoning: CONFIRMED,
        temperature: unknownCapability(),
      },
    });
    const projection = projectBrowser(
      data([group("p", [thinker, model("plain")])]),
      nav({ filters: { ...DEFAULT_FILTERS, reasoning: true } }),
      scope,
    );
    expect(keys(projection)).toEqual(["p", "  thinker"]);
  });

  it("keeps models with either price known under priced only", () => {
    const projection = projectBrowser(
      data([
        group("p", [
          priced("in-only", 1, undefined),
          priced("out-only", undefined, 2),
          model("free"),
        ]),
      ]),
      nav({ filters: { ...DEFAULT_FILTERS, priced: true } }),
      scope,
    );
    expect(keys(projection)).toEqual(["p", "  in-only", "  out-only"]);
  });

  it("limits the list to the chosen provider and keeps it with a note when nothing matches", () => {
    const groups = [group("a", [model("one")]), group("b", [model("two")])];
    const filtered = nav({
      query: "zzz",
      filters: { ...DEFAULT_FILTERS, provider: "b" },
    });
    const projection = projectBrowser(data(groups), filtered, scope);
    expect(keys(projection)).toEqual(["b", "note"]);
    expect(projection.providerCount).toBe(1);
  });

  it("shows narrowed counts in the provider header", () => {
    const projection = projectBrowser(
      data([group("p", [model("alpha"), model("beta")])]),
      nav({ query: "alpha" }),
      scope,
    );
    expect(text(projection.rows[0]?.segments ?? [])).toMatch(/1\/2 models $/);
  });

  it("marks the current model in its row", () => {
    const projection = projectBrowser(
      data([group("p", [model("alpha"), model("beta")])]),
      nav(),
      { ...scope, current: { providerID: "p", modelID: "beta" } },
    );
    const marked = projection.rows
      .filter((row) => row.kind === "model")
      .map((row) => row.segments[1]?.text);
    expect(marked).toEqual([" ", "●"]);
  });

  it("ignores the provider filter and collapse in a single-provider scope", () => {
    const groups = [group("a", [model("one")]), group("b", [])];
    const projection = projectBrowser(
      data(groups),
      nav({
        collapsed: ["a"],
        filters: { ...DEFAULT_FILTERS, provider: "b" },
      }),
      { scope: { kind: "provider", providerID: "a" }, width: 72 },
    );
    expect(keys(projection)).toEqual(["  one"]);
  });

  it("adds no note row for an empty single-provider scope", () => {
    expect(
      projectBrowser(data([group("a", [])]), nav(), {
        scope: { kind: "provider", providerID: "a" },
        width: 72,
      }).rows,
    ).toEqual([]);
  });

  it("counts providers that are discovering", () => {
    const payload = catalog([record("a", { discovering: true }), record("b")]);
    expect(
      projectBrowser(
        data([group("a", []), group("b", [])], payload),
        nav(),
        scope,
      ).discovering,
    ).toBe(1);
  });
});

describe("projectBrowser notes for empty providers", () => {
  const note = (
    providerGroup: ProviderGroup,
    providerRecord?: CatalogProviderRecord,
    state: NavState = nav(),
  ): string | undefined =>
    projectBrowser(
      data(
        [providerGroup],
        providerRecord ? catalog([providerRecord]) : undefined,
      ),
      state,
      { scope: ALL, width: 72 },
    )
      .rows.find((row) => row.kind === "note")
      ?.segments[0]?.text.trim();

  it.each([
    [
      "hidden embeddings",
      group("p", [model("vec", { type: "embedding" })]),
      undefined,
      "1 embedding model hidden; f shows them",
    ],
    [
      "a running discovery",
      group("p", []),
      record("p", { discovering: true, lastGoodAt: null }),
      "Checking the model list…",
    ],
    [
      "a failure before any success",
      group("p", []),
      record("p", {
        lastGoodAt: null,
        failure: { kind: "unreachable", at: "2026-10-11T08:00:00.000Z" },
      }),
      "No models yet; the model list failed",
    ],
    [
      "a successful empty list",
      group("p", []),
      record("p"),
      "No models returned; r refreshes",
    ],
    ["evidence without a record", group("p", []), undefined, "No models yet"],
    [
      "no evidence at all",
      { ...group("p", []), hasEvidence: false },
      undefined,
      "No models listed",
    ],
  ])("explains %s", (_label, providerGroup, providerRecord, expected) => {
    expect(note(providerGroup, providerRecord)).toBe(expected);
  });

  it("is not selectable", () => {
    const row = projectBrowser(data([group("p", [])]), nav(), {
      scope: ALL,
      width: 72,
    }).rows.find((item) => item.kind === "note");
    expect(row?.selectable).toBe(false);
  });
});

describe("sortModels ties and directions", () => {
  it("breaks equal names by ID under the name sort", () => {
    const sorted = sortModels(
      [model("b", { name: "Same" }), model("a", { name: "Same" })],
      "name",
    );
    expect(sorted.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("sorts by output price ascending with ties by name and unknowns last", () => {
    const sorted = sortModels(
      [
        priced("zeta", 9, 2),
        model("unpriced"),
        priced("alpha", 1, 2),
        priced("cheap", 5, 0.5),
      ],
      "output",
    );
    expect(sorted.map((item) => item.id)).toEqual([
      "cheap",
      "alpha",
      "zeta",
      "unpriced",
    ]);
  });

  it("counts an inferred context as known", () => {
    const sorted = sortModels(
      [
        model("reported", { context: 100_000 }),
        model("inferred", {
          context: 300_000,
          provenance: {
            context: knownScalar(300_000, "models.dev", "inferred"),
          },
        }),
      ],
      "context",
    );
    expect(sorted.map((item) => item.id)).toEqual(["inferred", "reported"]);
  });

  it("orders the unknowns by name too", () => {
    const sorted = sortModels(
      [model("z", { context: undefined }), model("a", { context: undefined })],
      "context",
    );
    expect(sorted.map((item) => item.id)).toEqual(["a", "z"]);
  });

  it("leaves the input array as it was", () => {
    const input = [model("b"), model("a")];
    sortModels(input, "name");
    expect(input.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("nextSort and hasNarrowing", () => {
  it("cycles name, context, input price, output price, then name", () => {
    expect(nextSort("name")).toBe("context");
    expect(nextSort("context")).toBe("input");
    expect(nextSort("input")).toBe("output");
    expect(nextSort("output")).toBe("name");
  });

  it("counts a non-blank query or any non-default filter as narrowing", () => {
    expect(hasNarrowing(nav())).toBe(false);
    expect(hasNarrowing(nav({ query: "  " }))).toBe(false);
    expect(hasNarrowing(nav({ query: "x" }))).toBe(true);
    expect(
      hasNarrowing(nav({ filters: { ...DEFAULT_FILTERS, provider: "a" } })),
    ).toBe(true);
    expect(
      hasNarrowing(nav({ filters: { ...DEFAULT_FILTERS, uncertain: true } })),
    ).toBe(true);
    // Sort and collapse are not narrowing.
    expect(hasNarrowing(nav({ sort: "context", collapsed: ["a"] }))).toBe(
      false,
    );
  });
});

describe("refreshWaitSeconds edge cases", () => {
  const payload = catalog([
    record("a", { nextRefreshAt: "2026-10-11T08:00:10.500Z" }),
  ]);

  it("rounds a partial second up", () => {
    const snapshot = data([group("a", [])], payload);
    expect(
      refreshWaitSeconds(
        payload.providers[0],
        snapshot,
        Date.parse(payload.generatedAt),
      ),
    ).toBe(11);
  });

  it("is unknown without a catalog", () => {
    expect(
      refreshWaitSeconds(payload.providers[0], data([]), Date.now()),
    ).toBeUndefined();
  });

  it("uses the payload offset alone when the receipt time is missing", () => {
    const snapshot: BrowserData = { ...data([]), catalog: payload };
    expect(refreshWaitSeconds(payload.providers[0], snapshot, Date.now())).toBe(
      11,
    );
  });
});

describe("initialSelection fallbacks", () => {
  it("selects the provider header when no model is listed, and nothing for no rows", () => {
    const rows = projectBrowser(data([group("a", [])]), nav(), {
      scope: ALL,
      width: 72,
    }).rows;
    expect(initialSelection(rows, undefined)?.key).toBe(providerKey("a"));
    expect(initialSelection([], undefined)).toBeUndefined();
  });
});

describe("row segments", () => {
  it("shows an embedding model without capabilities and with a muted name", () => {
    const segments = modelRowSegments(
      model("vec", {
        type: "embedding",
        capabilities: {
          toolCall: CONFIRMED,
          reasoning: CONFIRMED,
          temperature: unknownCapability(),
        },
      }),
      72,
      false,
    );
    expect(text(segments)).toMatch(/^ {3}vec +128K {2}· · · +$/);
    expect(segments[3]?.role).toBe("muted");
  });

  it("mutes a model hidden from the picker and leaves an unreported context blank", () => {
    const segments = modelRowSegments(
      model("off", { enabled: false, context: undefined }),
      72,
      false,
    );
    expect(segments[3]?.role).toBe("muted");
    expect(segments[4]?.text.trim()).toBe("");
  });

  it("ends provider headers at the same right edge as model rows", () => {
    const failure = {
      kind: "unauthorized" as const,
      at: "2026-10-11T08:00:00.000Z",
      httpStatus: 401,
    };
    for (const width of [58, 72]) {
      const header = text(
        providerRowSegments(
          group("p", [], "Team gateway"),
          record("p", { failure }),
          { visible: 3, total: 3 },
          true,
          width,
        ),
      );
      expect(header).toHaveLength(width);
      expect(header).toMatch(/^ ▸ Team gateway +3 models {2}▲ key rejected $/);
      // The last column of the price cell is reserved for the tier "+".
      expect(text(modelRowSegments(priced("m", 3, 15), width, false))).toMatch(
        new RegExp(`^.{${width - 7}}\\$3/\\$15 $`),
      );
    }
  });

  it("lines up price digits whether or not a row has tiers", () => {
    const plain = text(modelRowSegments(priced("m", 3, 15), 58, false));
    const tiered = text(
      modelRowSegments(
        { ...priced("t", 3, 15), priceTiers: [{ above: 200_000, input: 6 }] },
        58,
        false,
      ),
    );
    expect(plain.endsWith("$3/$15 ")).toBe(true);
    expect(tiered.endsWith("$3/$15+")).toBe(true);
    expect(plain.indexOf("$3/$15")).toBe(tiered.indexOf("$3/$15"));
  });

  it("shows a singular count and no status without a record", () => {
    expect(
      text(
        providerRowSegments(
          group("p", []),
          undefined,
          { visible: 1, total: 1 },
          false,
          40,
        ),
      ),
    ).toMatch(/^ ▾ p +1 model $/);
  });
});

describe("filter screen helpers", () => {
  it("offers the provider field only across every provider", () => {
    expect(filterFields(ALL)[0]).toBe("provider");
    expect(filterFields({ kind: "provider", providerID: "a" })).not.toContain(
      "provider",
    );
  });

  it("cycles the type forward through chat, embedding, and all", () => {
    let filters = DEFAULT_FILTERS;
    const seen: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      filters = cycleFilter(filters, "type", 1, []);
      seen.push(filters.type);
    }
    expect(seen).toEqual(["embedding", "all", "chat"]);
  });

  it("wraps the provider from the last ID back to all, and from an unknown ID to all", () => {
    const last = { ...DEFAULT_FILTERS, provider: "b" };
    expect(cycleFilter(last, "provider", 1, ["a", "b"]).provider).toBe("all");
    const gone = { ...DEFAULT_FILTERS, provider: "removed" };
    expect(cycleFilter(gone, "provider", 1, ["a", "b"]).provider).toBe("all");
  });

  it("names the chosen provider, every flag, and the type in the summary", () => {
    const state = nav({
      filters: {
        provider: "atlas",
        type: "all",
        tools: true,
        images: true,
        reasoning: true,
        priced: true,
        uncertain: true,
      },
    });
    expect(
      filterSummary(state, ALL, [group("atlas", [], "Atlas Cloud")], 0),
    ).toBe(
      "all types · Atlas Cloud · tools · images · reasoning · priced · incl. assumed",
    );
    expect(filterSummary(state, ALL, [], 0)).toMatch(/^all types · atlas/);
    expect(filterSummary(nav(), ALL, [], 0)).toBe("chat · all providers");
  });
});

describe("footer and justify", () => {
  it("drops keys ? when asked and shows disabled hints in the disabled role", () => {
    const segments = footerSegments(
      [{ title: "picker", key: "m", enabled: false }],
      40,
      false,
    );
    expect(text(segments)).toMatch(/^picker m +close esc$/);
    expect(segments[0]).toEqual({ text: "picker", role: "disabled" });
    expect(segments[2]).toEqual({ text: "m", role: "disabled" });
  });

  it("keeps keys ? and close esc when no hint fits", () => {
    expect(
      text(footerSegments([{ title: "a very long hint title", key: "z" }], 20)),
    ).toMatch(/^keys \? +close esc$/);
  });

  it("leaves at least four columns before close esc", () => {
    // "aa x  keys ?" is 12 columns and "close esc" 9: 25 leaves a 4-column gap.
    const hints = [{ title: "aa", key: "x" }];
    expect(text(footerSegments(hints, 25))).toBe("aa x  keys ?    close esc");
    expect(text(footerSegments(hints, 24))).toMatch(/^keys \? +close esc$/);
  });

  it("skips a hint that does not fit and keeps later ones that do, in order", () => {
    const hints = [
      { title: "first", key: "1" },
      { title: "a much longer second", key: "2" },
      { title: "third", key: "3" },
    ];
    const line = text(footerSegments(hints, 45));
    expect(line).toMatch(/^first 1 {2}third 3 {2}keys \? +close esc$/);
    expect(line).toHaveLength(45);
  });

  it("fits hints by priority: earlier first, the required one always", () => {
    expect([...fitFooterHints([5, 20, 5], 12)]).toEqual([0, 2]);
    expect([...fitFooterHints([5, 5, 5], 12, 2)].sort()).toEqual([0, 2]);
    expect([...fitFooterHints([30], 10, 0)]).toEqual([0]);
  });

  it("cuts the left side with an ellipsis to keep the right side whole", () => {
    const line = text(
      justify(
        [{ text: "Model Scout with a long title", role: "base" }],
        [{ text: "3 models", role: "muted" }],
        20,
      ),
    );
    expect(line).toHaveLength(20);
    expect(line).toMatch(/^Model Scou…\s+3 models$/);
  });
});

describe("status glyphs", () => {
  it("colors only a leading status glyph and keeps the words in base", () => {
    expect(glyphSegments({ text: "▲ key rejected", role: "error" })).toEqual([
      { text: "▲", role: "error" },
      { text: " key rejected", role: "base" },
    ]);
    expect(glyphSegments({ text: "● ready", role: "ok" })[0]).toEqual({
      text: "●",
      role: "ok",
    });
  });

  it("leaves text without a status glyph in its role", () => {
    expect(glyphSegments({ text: "Refresh skipped", role: "muted" })).toEqual([
      { text: "Refresh skipped", role: "muted" },
    ]);
  });
});

describe("text pane blocks", () => {
  // Entries of 1, 2, 1, 3, and 2 lines: 9 lines.
  const sizes = [1, 2, 1, 3, 2];

  it("shows only whole blocks and counts hidden blocks, not lines", () => {
    // 6 rows: blocks 0-2 take 4 lines; block 3 (3 lines) does not fit with ↓.
    expect(blockWindow(sizes, 6, 0)).toEqual({
      offset: 0,
      rows: 4,
      above: 0,
      below: 2,
    });
    // From block 1: ↑ row, blocks 1-2 (3 lines), ↓ row; block 3 would not fit.
    expect(blockWindow(sizes, 6, 1)).toEqual({
      offset: 1,
      rows: 3,
      above: 1,
      below: 2,
    });
  });

  it("stops at the first offset from which the rest fits under the ↑ row", () => {
    // Blocks 3-4 take 5 lines, which fit under ↑ in 6 rows.
    expect(blockWindow(sizes, 6, 99)).toEqual({
      offset: 3,
      rows: 5,
      above: 3,
      below: 0,
    });
  });

  it("shows a block taller than the room alone rather than nothing", () => {
    expect(blockWindow([5, 1], 3, 0)).toMatchObject({
      offset: 0,
      above: 0,
      below: 1,
    });
  });

  it("scrolls by whole blocks", () => {
    expect(scrollBlocks(sizes, 6, 0, "down")).toBe(1);
    expect(scrollBlocks(sizes, 6, 1, "up")).toBe(0);
    expect(scrollBlocks(sizes, 6, 0, "end")).toBe(3);
    // A page moves by the blocks shown less one, keeping one in view.
    expect(scrollBlocks(sizes, 6, 0, "pagedown")).toBe(2);
  });
});

describe("text pane entries taller than the window", () => {
  // 5 rows leave 3 between the indicators; the 4-line entry cannot fit whole.
  const sizes = [1, 4, 1];

  it("splits only entries taller than the room between the indicators", () => {
    expect(scrollUnits(sizes, 5)).toEqual({
      units: [1, 1, 1, 1, 1, 1],
      entryOf: [0, 1, 1, 1, 1, 2],
    });
    expect(scrollUnits([1, 3, 1], 5).units).toEqual([1, 3, 1]);
  });

  it("reaches every line of a tall entry and counts whole entries only", () => {
    const seen = new Set<number>();
    let offset = 0;
    for (let step = 0; step < 10; step += 1) {
      const view = entryWindow(sizes, 5, offset);
      for (let line = 0; line < view.rows; line += 1)
        seen.add(view.offset + line);
      offset = scrollEntries(sizes, 5, offset, "down");
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    // The entry partly in view is not counted: only entry 0 is hidden above.
    expect(entryWindow(sizes, 5, 2)).toMatchObject({
      top: true,
      above: 1,
      bottom: false,
    });
    // Scrolled into a tall first entry, nothing whole is hidden above, yet
    // the indicator shows.
    expect(entryWindow([4, 1, 1], 5, 1)).toMatchObject({
      top: true,
      above: 0,
    });
  });
});

describe("text pane window", () => {
  it("shows everything without indicators when the lines fit", () => {
    expect(paneWindow(5, 8, 3)).toEqual({
      offset: 0,
      rows: 8,
      above: 0,
      below: 0,
    });
  });

  it("gives the last row to a ↓ indicator at the top of long text", () => {
    expect(paneWindow(20, 8, 0)).toEqual({
      offset: 0,
      rows: 7,
      above: 0,
      below: 13,
    });
  });

  it("shows both indicators in the middle and only ↑ at the end", () => {
    expect(paneWindow(20, 8, 5)).toEqual({
      offset: 5,
      rows: 6,
      above: 5,
      below: 9,
    });
    // At the end the last line shows under the ↑ row.
    expect(paneWindow(20, 8, 99)).toEqual({
      offset: 13,
      rows: 7,
      above: 13,
      below: 0,
    });
  });

  it("scrolls by line and by page, within the text", () => {
    expect(scrollPane(20, 8, 0, "down")).toBe(1);
    expect(scrollPane(20, 8, 0, "up")).toBe(0);
    expect(scrollPane(20, 8, 0, "pagedown")).toBe(6);
    expect(scrollPane(20, 8, 6, "pageup")).toBe(1);
    expect(scrollPane(20, 8, 3, "end")).toBe(13);
    expect(scrollPane(20, 8, 13, "home")).toBe(0);
    expect(scrollPane(5, 8, 0, "down")).toBe(0);
  });
});

describe("browserLayout bounds", () => {
  it("falls back to 80x24 for a terminal size it cannot read", () => {
    expect(browserLayout(Number.NaN, 0)).toEqual(browserLayout(80, 24));
  });

  it("caps the dialog at 116 columns and 30 content rows", () => {
    expect(browserLayout(300, 100)).toMatchObject({
      width: 110,
      outerWidth: 116,
      height: 30,
      paneWidth: 49,
    });
  });

  it("keeps a minimum height on a very short terminal", () => {
    const layout = browserLayout(80, 5);
    expect(layout.height).toBe(8);
    expect(layout.bodyHeight).toBe(2);
  });
});
