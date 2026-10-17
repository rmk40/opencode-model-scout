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
  browserLayout,
  cycleFilter,
  DEFAULT_FILTERS,
  DEFAULT_NAV,
  filterSummary,
  footerSegments,
  initialSelection,
  modelKey,
  modelRowSegments,
  projectBrowser,
  providerKey,
  refreshWaitSeconds,
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

  it("leaves every key but enter, up, and down to the focused search input", () => {
    const search: RouteContext = { screen: "list", focus: "search" };
    expect(routeKey(search, { name: "m", sequence: "m" })).toBeUndefined();
    expect(routeKey(search, { name: "?", sequence: "?" })).toBeUndefined();
    expect(routeKey(search, { name: "backspace" })).toBeUndefined();
    expect(routeKey(search, { name: "return" })).toEqual({
      type: "leave-search",
    });
    expect(routeKey(search, { name: "down" })).toEqual({
      type: "leave-search",
      move: "down",
    });
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
      height: 20,
      listWidth: 72,
    });
    expect(browserLayout(119, 36).wide).toBe(false);
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
    expect(filterSummary(state, ALL, [], 2, false)).toBe(
      "chat · all providers · tools · 2 embeddings hidden",
    );
    expect(
      filterSummary(state, { kind: "provider", providerID: "a" }, [], 1, true),
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
});
