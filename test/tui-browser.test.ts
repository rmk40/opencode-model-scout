import type {
  BaseRenderable,
  KeyEvent,
  KeyHandler,
  SelectOption,
} from "@opentui/core";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import {
  INITIAL_BROWSER_FACETS,
  INITIAL_BROWSER_STATE,
  browserFilterSummary,
  browserLayoutBudget,
  buildBrowserView,
  cycleBrowserFacet,
  projectBrowser,
  reduceBrowserState,
  resolveSelection,
  summarizeProvider,
} from "../src/tui-browser";
import type { ModelRow, ProviderGroup } from "../src/tui-models";
import { TuiRenderer, type ReconcilerBridge } from "../src/tui-renderer";

const supported = {
  state: "supported" as const,
  source: "provider-probe" as const,
  strength: "authoritative" as const,
};
const unsupported = {
  state: "unsupported" as const,
  source: "provider-probe" as const,
  strength: "authoritative" as const,
};
const unknown = { state: "unknown" as const };
const defaultSupported = {
  state: "supported" as const,
  source: "policy-default" as const,
  strength: "assumed" as const,
};

function model(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id: "atlas-chat",
    name: "Atlas Chat",
    type: "llm",
    flags: ["Tools", "Reasoning"],
    family: "atlas-family",
    parameterSize: "8B",
    quantization: "Q4",
    context: 131_072,
    output: 8_192,
    origin: "discovered",
    capabilities: {
      vision: unsupported,
      toolCall: supported,
      reasoning: supported,
      temperature: defaultSupported,
    },
    provenance: {
      identity: {
        state: "known",
        value: "atlas-chat",
        source: "server-list",
        strength: "reported",
      },
      name: {
        state: "known",
        value: "Atlas Chat",
        source: "pre-existing",
        strength: "configured",
      },
      context: {
        state: "known",
        value: 131_072,
        source: "provider-probe",
        strength: "authoritative",
      },
      output: {
        state: "known",
        value: 8_192,
        source: "models.dev",
        strength: "reported",
      },
    },
    ...overrides,
  };
}

const groups: ProviderGroup[] = [
  {
    id: "atlas-primary",
    provider: "Atlas",
    endpoint: "https://atlas.test",
    exactProvenance: true,
    status: "ready",
    modelListAttempt: "ready",
    probeAttempt: "complete",
    configuredProbe: "auto",
    resolvedProbe: "atlas",
    models: [
      model(),
      model({
        id: "atlas-vision",
        name: "Atlas Vision",
        type: "vlm",
        output: undefined,
        origin: "pre-existing",
        capabilities: {
          vision: supported,
          toolCall: unknown,
          reasoning: unknown,
          temperature: defaultSupported,
        },
      }),
    ],
  },
  {
    id: "atlas-edge",
    provider: "Atlas Edge",
    endpoint: "https://atlas.test",
    exactProvenance: true,
    status: "empty",
    modelListAttempt: "empty",
    probeAttempt: "not-requested",
    models: [
      model({
        id: "atlas-embed",
        name: "Atlas Embed",
        type: "embedding",
        output: undefined,
        capabilities: undefined,
      }),
      model({
        id: "atlas-unknown",
        name: "Atlas Unknown",
        type: undefined,
        context: undefined,
        output: undefined,
        origin: undefined,
        capabilities: {
          vision: unknown,
          toolCall: unknown,
          reasoning: unknown,
          temperature: unknown,
        },
      }),
    ],
  },
];

const singleGroup: ProviderGroup[] = [groups[0]];

const theme = {
  text: "#e0e0e0",
  textMuted: "#909090",
  primary: "#priority",
  accent: "#accent00",
  backgroundPanel: "#101014",
  backgroundElement: "#202028",
  selectedListItemText: "#ffffff",
};

interface FakeNode {
  tag: string;
  props: Record<string, unknown>;
  children: FakeNode[];
  selectedIndex: number;
  selectedIndexCalls: number[];
  setSelectedIndex: (index: number) => void;
  getSelectedIndex: () => number;
}

function browserHarness(options?: {
  height?: number;
  width?: number;
  groups?: readonly ProviderGroup[];
}) {
  const nodes: FakeNode[] = [];
  const keyListeners = new Set<(key: KeyEvent) => void>();
  const keyInput = {
    on: vi.fn((event: string, listener: (key: KeyEvent) => void) => {
      if (event === "keypress") keyListeners.add(listener);
      return keyInput;
    }),
    off: vi.fn((event: string, listener: (key: KeyEvent) => void) => {
      if (event === "keypress") keyListeners.delete(listener);
      return keyInput;
    }),
  };
  const bridge: ReconcilerBridge = {
    createElement: (tag) => {
      const node: FakeNode = {
        tag,
        props: {},
        children: [],
        selectedIndex: 0,
        selectedIndexCalls: [],
        setSelectedIndex(index) {
          this.selectedIndexCalls.push(index);
          this.selectedIndex = index;
          const onChange = this.props.onChange;
          if (typeof onChange === "function")
            (onChange as (selected: number) => void)(index);
        },
        getSelectedIndex() {
          return this.selectedIndex;
        },
      };
      nodes.push(node);
      return node as unknown as BaseRenderable;
    },
    setProp: (node, name, value) => {
      const fake = node as unknown as FakeNode;
      fake.props[name] = value;
      if (name === "selectedIndex" && typeof value === "number")
        fake.selectedIndex = value;
      return value;
    },
    insert: (parent, child) => {
      (parent as unknown as FakeNode).children.push(
        child as unknown as FakeNode,
      );
      return child;
    },
  };
  const view = buildBrowserView(new TuiRenderer(bridge), {
    groups: options?.groups ?? groups,
    theme,
    maxHeight: options?.height,
    width: options?.width,
    keyInput: keyInput as unknown as Pick<KeyHandler, "on" | "off">,
  });
  const findById = (id: string): FakeNode | undefined =>
    nodes.find((candidate) => candidate.props.id === id);
  const byId = (id: string): FakeNode => {
    const node = findById(id);
    if (!node) throw new Error(`missing node ${id}`);
    return node;
  };
  const press = (input: Partial<KeyEvent> & Pick<KeyEvent, "name">) => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const key = {
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      super: false,
      hyper: false,
      sequence: "",
      ...input,
      preventDefault,
      stopPropagation,
    } as unknown as KeyEvent;
    for (const listener of keyListeners) listener(key);
    return { preventDefault, stopPropagation };
  };
  return {
    nodes,
    view,
    byId,
    findById,
    keyInput,
    keyListeners,
    press,
  };
}

describe("unified browser projection", () => {
  it("emits one provider header followed by its model rows, in order", () => {
    const projection = projectBrowser(groups, "");
    expect(projection.items.map((item) => [item.kind, item.name])).toEqual([
      ["provider", "Atlas"],
      ["model", "Atlas Chat"],
      ["model", "Atlas Vision"],
      ["provider", "Atlas Edge"],
      ["model", "Atlas Embed"],
      ["model", "Atlas Unknown"],
    ]);
  });

  it.each([
    ["atlas-chat", "model ID"],
    ["Atlas Chat", "model name"],
    ["Atlas", "provider"],
    ["llm", "type"],
    ["atlas-family", "family"],
    ["8B", "parameter size"],
    ["Q4", "quantization"],
    ["Reasoning", "capability"],
  ])("searches %s through the %s field", (query) => {
    expect(
      projectBrowser(groups, query).items.map((item) => item.name),
    ).toContain("Atlas Chat");
  });

  it("keeps the provider header visible when a child model matches search", () => {
    const projection = projectBrowser(groups, "vision");
    expect(projection.items.map((item) => [item.kind, item.name])).toEqual([
      ["provider", "Atlas"],
      ["model", "Atlas Vision"],
    ]);
  });

  it("cascades a provider-own search hit to its facet-matching children", () => {
    // Endpoints are provider-only search fields; models never contain
    // "https". The provider hit now includes each provider's children that
    // satisfy the (default) model facets instead of showing bare headers.
    const projection = projectBrowser(groups, "https");
    expect(projection.items.map((item) => [item.kind, item.name])).toEqual([
      ["provider", "Atlas"],
      ["model", "Atlas Chat"],
      ["model", "Atlas Vision"],
      ["provider", "Atlas Edge"],
      ["model", "Atlas Embed"],
      ["model", "Atlas Unknown"],
    ]);
  });

  it("intersects provider-name search with active model facets", () => {
    // "Atlas Edge" only matches provider-own fields of atlas-edge. With
    // type=embedding active, only the embedding child survives beneath it.
    const projection = projectBrowser(groups, "Atlas Edge", {
      ...INITIAL_BROWSER_FACETS,
      type: "embedding",
    });
    expect(projection.items.map((item) => [item.kind, item.name])).toEqual([
      ["provider", "Atlas Edge"],
      ["model", "Atlas Embed"],
    ]);
  });

  it("hides a directly searched provider when model facets exclude every child", () => {
    // atlas-edge has no llm children; a non-default model facet with no
    // surviving child must hide the header rather than imply llm results.
    const projection = projectBrowser(groups, "Atlas Edge", {
      ...INITIAL_BROWSER_FACETS,
      type: "llm",
    });
    expect(projection.items).toEqual([]);
    expect(projection.summary.providerCount).toBe(0);
  });

  it("keeps the provider facet authoritative over provider-name search", () => {
    const projection = projectBrowser(groups, "Atlas Edge", {
      ...INITIAL_BROWSER_FACETS,
      provider: "atlas-primary",
    });

    expect(projection.items).toEqual([]);
    expect(projection.summary.providerCount).toBe(0);
    expect(projection.emptyMessage).toContain("provider atlas-primary");
  });

  it("keeps zero-model and error providers reachable without search or filters", () => {
    const unreachable: ProviderGroup = {
      id: "atlas-down",
      provider: "Atlas Down",
      exactProvenance: false,
      status: "unreachable",
      models: [],
    };
    const catalog = [...groups, unreachable];
    const all = projectBrowser(catalog, "");
    expect(all.items.map((item) => item.name)).toContain("Atlas Down");
    expect(all.summary.providerCount).toBe(3);

    const filtered = projectBrowser(catalog, "", {
      ...INITIAL_BROWSER_FACETS,
      type: "llm",
    });
    expect(filtered.items.map((item) => item.name)).not.toContain("Atlas Down");

    const searched = projectBrowser(catalog, "down");
    expect(searched.items.map((item) => [item.kind, item.name])).toEqual([
      ["provider", "Atlas Down"],
    ]);
  });

  it("omits the provider name from indented columnar model rows", () => {
    const distinct: ProviderGroup[] = [
      { ...groups[0], provider: "Nimbus Cloud", models: [model()] },
    ];
    const projection = projectBrowser(distinct, "");
    const modelItem = projection.items.find((item) => item.kind === "model");
    expect(modelItem?.displayRow).not.toContain("Nimbus");
    expect(modelItem?.displayRow.startsWith("  ")).toBe(true);
    expect(modelItem?.displayRow).toContain("Atlas Chat");
    expect(modelItem?.displayRow).toContain("llm");
    expect(modelItem?.displayRow).toContain("ctx 131K");
    expect(modelItem?.displayRow).toContain("core 7/7");
  });

  it("keeps logical names stable while rendering bounded one-line rows", () => {
    const projection = projectBrowser(groups, "");
    expect(projection.items[1]?.name).toBe("Atlas Chat");
    expect(
      projection.items.every((item) => !item.displayRow.includes("\n")),
    ).toBe(true);

    const harness = browserHarness({ width: 44 });
    const options = harness.byId("modelscout-results").props
      .options as SelectOption[];
    // width 44 → text width 36, minus the 4-column Select chrome reserve.
    expect(options.every((option) => stringWidth(option.name) <= 32)).toBe(
      true,
    );
    expect(options.every((option) => option.description === "")).toBe(true);
    expect(harness.byId("modelscout-results").props.showDescription).toBe(
      false,
    );
  });

  it("caps the name column on wide terminals instead of absorbing spare width", () => {
    // 160-column terminal → 120-column content → 112-column text width →
    // 108-column option rows after the Select chrome reserve. The name column
    // must stay at its readable maximum (40) so type/context/core remain
    // adjacent; the row may end before the right edge.
    const harness = browserHarness({ width: 160 });
    const options = harness.byId("modelscout-results").props
      .options as SelectOption[];
    const row = options.find((option) => option.name.includes("Atlas Chat"));
    expect(row).toBeDefined();
    // indent(2) + name(40) + gap(2) puts the type column at index 44.
    expect(row?.name.indexOf("llm")).toBe(44);
    // The row ends after the core column, well before the 112-column edge.
    expect(stringWidth(row?.name ?? "")).toBeLessThanOrEqual(73);
    expect(row?.name.trimEnd()).toBe(row?.name);
  });

  it("truncates long names grapheme-safely at the wide-width name cap", () => {
    const longName = `Atlas ${"界".repeat(30)} Ultra Long Model Name`;
    const harness = browserHarness({
      width: 160,
      groups: [{ ...groups[0], models: [model({ name: longName })] }],
    });
    const options = harness.byId("modelscout-results").props
      .options as SelectOption[];
    const row = options.find((option) => option.name.startsWith("  "));
    expect(row).toBeDefined();
    const nameCell = row?.name.slice(2, row.name.indexOf("  llm")) ?? "";
    expect(stringWidth(nameCell)).toBeLessThanOrEqual(40);
    expect(nameCell).toContain("…");
    // No split full-width grapheme: every non-ASCII segment is intact.
    for (const { segment } of new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(nameCell))
      expect(
        ["界", "…"].includes(segment) || /^[\x20-\x7e]$/u.test(segment),
      ).toBe(true);
  });

  it("keeps the 8-column name minimum on narrow terminals", () => {
    // width 44 → text width 36 → 32-column option rows; fixed columns exceed
    // the row budget, so the name column pins to its minimum.
    const harness = browserHarness({
      width: 44,
      groups: [
        { ...groups[0], models: [model({ name: "Atlas Chat Extended" })] },
      ],
    });
    const options = harness.byId("modelscout-results").props
      .options as SelectOption[];
    const row = options.find((option) => option.name.startsWith("  "));
    expect(row).toBeDefined();
    // indent(2) + name(8) + gap(2) puts the type column at index 12.
    expect(row?.name.indexOf("llm")).toBe(12);
    expect(stringWidth(row?.name ?? "")).toBeLessThanOrEqual(32);
  });

  it("keeps the full core column inside Select chrome at 80-column runtime width", () => {
    // An 80-column terminal reaches the browser as width 72 (tui.ts subtracts
    // 8 dialog columns) → text width 64 → 60-column option rows. Before the
    // 4-column Select chrome reserve, rows were budgeted to the full 64 and
    // the Select gutter/padding/scrollbar clipped the trailing `k/n` value
    // (rendering `… ctx 131K core`). Every model row must now carry its
    // complete `core k/n` cell within the reserved row budget.
    const harness = browserHarness({ width: 72 });
    const options = harness.byId("modelscout-results").props
      .options as SelectOption[];
    const modelRows = options.filter((option) => option.name.startsWith("  "));
    expect(modelRows.length).toBeGreaterThan(0);
    for (const row of modelRows) {
      expect(row.name).toMatch(/core \d\/\d$/);
      expect(stringWidth(row.name)).toBeLessThanOrEqual(60);
    }
    const chat = modelRows.find((row) => row.name.includes("Atlas Chat"));
    expect(chat?.name).toContain("ctx 131K");
    expect(chat?.name.endsWith("core 7/7")).toBe(true);
  });

  it("bounds rows by terminal columns for full-width names", () => {
    const fullWidthName = "界".repeat(24);
    const harness = browserHarness({
      width: 44,
      groups: [
        {
          ...groups[0],
          provider: fullWidthName,
          models: [model({ name: fullWidthName })],
        },
      ],
    });
    const options = harness.byId("modelscout-results").props
      .options as SelectOption[];
    expect(
      Math.max(...options.map((option) => stringWidth(option.name))),
    ).toBeLessThanOrEqual(32);
  });

  it("sanitizes controls and line separators from bounded rows", () => {
    const harness = browserHarness({
      groups: [
        {
          ...groups[0],
          provider: "Atlas\n\t\u001b[31m\u2028Unsafe",
          models: [model({ name: "Chat\r\n\u0007Model" })],
        },
      ],
    });
    const options = harness.byId("modelscout-results").props
      .options as SelectOption[];
    for (const option of options)
      expect(option.name).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
    expect(options[1]?.name).toContain("Chat Model");
  });

  it("bounds emoji and CJK rows without splitting grapheme clusters", () => {
    const family = "👩🏽‍💻";
    const flag = "🇯🇵";
    const combining = "e\u0301";
    const harness = browserHarness({
      width: 28,
      groups: [
        {
          ...groups[0],
          provider: `${family}${flag}界界界`,
          models: [model({ name: `${family}${flag}${combining}界`.repeat(5) })],
        },
      ],
    });
    const row = (
      harness.byId("modelscout-results").props.options as SelectOption[]
    )[1]?.name;
    expect(row).toBeDefined();
    // width 28 → text width 20 → 16-column option rows after chrome reserve.
    expect(stringWidth(row ?? "")).toBeLessThanOrEqual(16);
    // Model rows carry columnar ASCII (type, ctx, core) after the name, so
    // assert the Unicode invariant directly: every non-ASCII grapheme in the
    // bounded row is either an intact source cluster or the column-truncation
    // ellipsis — never a fragment (a bare ZWJ half, a single regional
    // indicator, or a lone combiner).
    const renderedGraphemes = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        row ?? "",
      ),
    ].map(({ segment }) => segment);
    const nonAscii = renderedGraphemes.filter(
      (segment) => !/^[\x20-\x7e]$/u.test(segment),
    );
    expect(nonAscii.length).toBeGreaterThan(0);
    expect(
      nonAscii.every((segment) =>
        [family, flag, combining, "界", "…"].includes(segment),
      ),
    ).toBe(true);
  });

  it("renders provider header rows with marker, count, coverage, and discovery status", () => {
    const item = projectBrowser(groups, "").items.find(
      (candidate) => candidate.name === "Atlas Edge",
    );
    expect(item?.kind).toBe("provider");
    expect(item?.displayRow).toBe(
      "▸ Atlas Edge · 2 models · core 1/2 · discovery empty",
    );
    expect(item?.detail).toContain("Discovery");
    expect(item?.detail).toContain("Capabilities");
    expect(item?.detail).toContain("Evidence: correlated server snapshot");
  });

  it("prefixes every provider header row with the ▸ marker", () => {
    const projection = projectBrowser(groups, "");
    for (const item of projection.items) {
      if (item.kind === "provider")
        expect(item.displayRow.startsWith("▸ ")).toBe(true);
      else expect(item.displayRow.startsWith("  ")).toBe(true);
    }
  });

  it("shows visible/total header counts and visible-child core coverage when filtered", () => {
    const byName = (items: readonly { name: string; displayRow: string }[]) =>
      new Map(items.map((item) => [item.name, item.displayRow]));

    // Unfiltered: plain totals with full-catalog coverage.
    const all = byName(projectBrowser(groups, "").items);
    expect(all.get("Atlas")).toContain("2 models");
    expect(all.get("Atlas")).toContain("core 1/2");

    // Type facet: atlas-primary keeps only its llm child (complete core).
    const typed = byName(
      projectBrowser(groups, "", {
        ...INITIAL_BROWSER_FACETS,
        type: "llm",
      }).items,
    );
    expect(typed.get("Atlas")).toContain("1/2 models");
    expect(typed.get("Atlas")).toContain("core 1/1");

    // Search: only Atlas Vision (missing output → incomplete core) survives.
    const searched = byName(projectBrowser(groups, "vision").items);
    expect(searched.get("Atlas")).toContain("1/2 models");
    expect(searched.get("Atlas")).toContain("core 0/1");

    // Search plus facet composition narrows the same way.
    const composed = byName(
      projectBrowser(groups, "atlas", {
        ...INITIAL_BROWSER_FACETS,
        metadata: "complete-core",
      }).items,
    );
    expect(composed.get("Atlas")).toContain("1/2 models");
    expect(composed.get("Atlas")).toContain("core 1/1");
    expect(composed.get("Atlas Edge")).toContain("1/2 models");
  });

  it("keeps provider detail on full-catalog diagnostics while headers are filtered", () => {
    const item = projectBrowser(groups, "", {
      ...INITIAL_BROWSER_FACETS,
      type: "llm",
    }).items.find((candidate) => candidate.name === "Atlas");
    expect(item?.displayRow).toContain("1/2 models");
    expect(item?.detail).toContain("2 models · core 1/2");
  });

  it("uses human filter summaries and a plain default", () => {
    expect(browserFilterSummary(INITIAL_BROWSER_FACETS, true)).toBe(
      "Filters: none",
    );
    expect(
      browserFilterSummary(
        {
          ...INITIAL_BROWSER_FACETS,
          provider: "atlas-primary",
          type: "vlm",
          capability: "vision",
          capabilityState: "supported",
          metadata: "missing-core",
          origin: "pre-existing",
        },
        true,
      ),
    ).toContain("provider atlas-primary · type vlm · capability vision");
  });

  it("groups compact evidence without repeating raw source-strength pairs", () => {
    const detail = projectBrowser(groups, "atlas-chat").items.find(
      (item) => item.kind === "model",
    )?.detail;
    expect(detail).toContain("Capabilities");
    expect(detail).toContain("Tools: supported [probe]");
    expect(detail).toContain("Temperature: supported [default]");
    expect(detail).toContain("Type: llm");
    expect(detail).toContain("Model ID: atlas-chat [server]");
    expect(detail).toContain("Max output: 8K [models.dev]");
    expect(detail).toContain("Sources: probe · config · server");
    expect(detail).not.toContain("provider-probe");
    expect(detail).not.toContain("authoritative");
  });

  it("keeps externally supplied model detail values on their structured lines", () => {
    const maliciousGroup: ProviderGroup = {
      ...groups[0],
      provider: "Atlas\nForged Model Heading",
      endpoint: "https://atlas.test\u2028Forged Model Heading",
      warnings: ["provider warning\u2029Forged Model Heading"],
      models: [
        model({
          id: "atlas-chat\r\nForged Model Heading",
          name: "Atlas ☕️ Chat\nForged Model Heading",
          type: "llm\u202aForged Model Heading" as ModelRow["type"],
          origin: "discovered\u2066Forged Model Heading" as ModelRow["origin"],
          flags: ["Tools\u0007Forged Model Heading"],
          family: "atlas-family\u202eForged Model Heading",
          parameterSize: "8B\u001bForged Model Heading",
          quantization: "Q4\u2028Forged Model Heading",
          probeIdentity: "atlas\u2069Forged Model Heading",
          capabilities: undefined,
          warnings: ["model warning\nForged Model Heading"],
        }),
      ],
    };

    const detail = projectBrowser([maliciousGroup], "").items.find(
      (item) => item.kind === "model",
    )?.detail;
    expect(detail).toBeDefined();
    expect(detail?.replaceAll("\n", "")).not.toMatch(
      /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u,
    );
    expect(detail?.split("\n")).not.toContain("Forged Model Heading");
    expect(detail).toContain("Atlas ☕️ Chat Forged Model Heading");
  });

  it("keeps externally supplied provider detail values on their structured lines", () => {
    const maliciousGroup: ProviderGroup = {
      ...groups[0],
      id: "atlas-primary\nForged Provider Heading",
      provider: "Atlas\u2028Forged Provider Heading",
      endpoint: "https://atlas.test\u2029Forged Provider Heading",
      status: "ready\u202aForged Provider Heading" as ProviderGroup["status"],
      modelListAttempt:
        "ready\u2066Forged Provider Heading" as ProviderGroup["modelListAttempt"],
      probeAttempt:
        "complete\u202eForged Provider Heading" as ProviderGroup["probeAttempt"],
      configuredProbe: "auto\u0007Forged Provider Heading",
      resolvedProbe: "atlas\u2069Forged Provider Heading",
      warnings: ["provider warning\nForged Provider Heading"],
      models: [
        model({
          type: "llm\r\nForged Provider Heading" as ModelRow["type"],
          family: "atlas-family\u001bForged Provider Heading",
        }),
      ],
    };

    const detail = projectBrowser([maliciousGroup], "").items.find(
      (item) => item.kind === "provider",
    )?.detail;
    expect(detail).toBeDefined();
    expect(detail?.replaceAll("\n", "")).not.toMatch(
      /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u,
    );
    expect(detail?.split("\n")).not.toContain("Forged Provider Heading");
    expect(detail).toContain("Families: atlas-family Forged Provider Heading");
  });

  it("filters every model facet, composes them, and hides childless headers", () => {
    const names = (facets: Partial<typeof INITIAL_BROWSER_FACETS>) =>
      projectBrowser(groups, "", {
        ...INITIAL_BROWSER_FACETS,
        ...facets,
      }).items.map((item) => item.name);
    expect(names({ provider: "atlas-edge" })).toEqual([
      "Atlas Edge",
      "Atlas Embed",
      "Atlas Unknown",
    ]);
    expect(names({ type: "llm" })).toEqual(["Atlas", "Atlas Chat"]);
    expect(names({ type: "vlm" })).toEqual(["Atlas", "Atlas Vision"]);
    expect(names({ type: "embedding" })).toEqual(["Atlas Edge", "Atlas Embed"]);
    expect(names({ type: "unknown" })).toEqual(["Atlas Edge", "Atlas Unknown"]);
    expect(
      names({ capability: "vision", capabilityState: "unsupported" }),
    ).toEqual(["Atlas", "Atlas Chat"]);
    expect(names({ metadata: "complete-core" })).toEqual([
      "Atlas",
      "Atlas Chat",
      "Atlas Edge",
      "Atlas Embed",
    ]);
    expect(names({ origin: "pre-existing" })).toEqual([
      "Atlas",
      "Atlas Vision",
    ]);
  });

  it("treats absent chat capability evidence as unknown but skips embeddings", () => {
    const absentEvidence: ProviderGroup[] = [
      {
        ...groups[0],
        models: [
          model({
            id: "chat-unknown",
            name: "Chat Unknown",
            capabilities: undefined,
          }),
          model({
            id: "embed-na",
            name: "Embed N/A",
            type: "embedding",
            capabilities: undefined,
          }),
        ],
      },
    ];
    const items = projectBrowser(absentEvidence, "", {
      ...INITIAL_BROWSER_FACETS,
      capability: "tools",
      capabilityState: "unknown",
    }).items;
    expect(items.map((item) => item.name)).toEqual(["Atlas", "Chat Unknown"]);
    expect(summarizeProvider(absentEvidence[0]).capabilities.tools).toEqual({
      applicable: 1,
      supported: 0,
      unsupported: 0,
      unknown: 1,
    });
  });

  it("cycles facets and disables unavailable origin evidence", () => {
    let facets = INITIAL_BROWSER_FACETS;
    facets = cycleBrowserFacet(facets, "provider", groups, true);
    facets = cycleBrowserFacet(facets, "type", groups, true);
    facets = cycleBrowserFacet(facets, "origin", groups, true);
    expect(facets).toMatchObject({
      provider: "atlas-primary",
      type: "llm",
      origin: "discovered",
    });

    const hostOnly = groups.map((group) => ({
      ...group,
      exactProvenance: false,
      models: group.models.map((item) => ({ ...item, origin: undefined })),
    }));
    const projection = projectBrowser(hostOnly, "", {
      ...INITIAL_BROWSER_FACETS,
      origin: "discovered",
    });
    expect(projection.items).toHaveLength(6);
    expect(projection.originFilterAvailable).toBe(false);
    expect(projection.filterSummary).toBe("Filters: none");
  });

  it("distinguishes filtered-empty from catalog-empty results", () => {
    const filtered = projectBrowser(groups, "missing");
    expect(filtered.emptyMessage).toContain("No matches.");
    expect(projectBrowser([], "").emptyMessage).toBe("No models available.");
  });

  it("aggregates provider origins, core coverage, and capability states", () => {
    const summary = summarizeProvider(groups[0]);
    expect(summary).toMatchObject({
      modelCount: 2,
      origins: { discovered: 1, "pre-existing": 1, unknown: 0 },
      completeCore: 1,
      missingCore: 1,
    });
    expect(summary.capabilities.vision).toEqual({
      applicable: 2,
      supported: 1,
      unsupported: 1,
      unknown: 0,
    });
  });

  it("keeps stable keys and resolves a missing selection to the first row", () => {
    const all = projectBrowser(groups, "");
    const remembered = all.items[2]?.key;
    expect(resolveSelection(all, remembered).item?.key).toBe(remembered);
    expect(
      resolveSelection(projectBrowser(groups, "chat"), remembered),
    ).toMatchObject({ index: 0, item: { name: "Atlas" } });
  });
});

describe("browser state and layout", () => {
  it("returns to the list for search and facet changes", () => {
    const detail = reduceBrowserState(INITIAL_BROWSER_STATE, {
      type: "show",
      screen: "detail",
    });
    expect(
      reduceBrowserState(detail, { type: "search", query: "atlas" }).screen,
    ).toBe("list");
    expect(
      reduceBrowserState(detail, {
        type: "facets",
        facets: INITIAL_BROWSER_FACETS,
      }).screen,
    ).toBe("list");
  });

  it.each([40, 30, 24, 18, 14])(
    "never exceeds the %i-row terminal budget",
    (terminalRows) => {
      const availableHeight = Math.max(1, terminalRows - 6);
      const budget = browserLayoutBudget(availableHeight);
      expect(budget.rootHeight).toBeLessThanOrEqual(availableHeight);
      expect(budget.listHeight).toBeLessThanOrEqual(budget.rootHeight);
      expect(
        budget.summaryRows +
          budget.searchRows +
          budget.filterRows +
          budget.footerRows +
          budget.viewportHeight,
      ).toBe(budget.rootHeight);

      const harness = browserHarness({ height: availableHeight });
      const root = harness.byId("modelscout-browser").props;
      expect(root.height).toBeLessThanOrEqual(availableHeight);
      expect(root.maxHeight).toBeLessThanOrEqual(availableHeight);
    },
  );

  it("reallocates the removed tab rows to the results viewport", () => {
    // The former layout spent 2 rows on the Models/Providers tab_select;
    // at 18 total rows the viewport was 12 and is now 14.
    expect(browserLayoutBudget(18).viewportHeight).toBe(14);
  });

  it("defaults safely when dimensions are unavailable", () => {
    expect(browserLayoutBudget(undefined).rootHeight).toBe(18);
    const harness = browserHarness();
    expect(harness.byId("modelscout-browser").props).toMatchObject({
      width: 76,
      height: 18,
      maxHeight: 18,
    });
  });

  it("hides optional filter and footer rows before a short root can overflow", () => {
    expect(browserLayoutBudget(3)).toMatchObject({
      filterRows: 0,
      footerRows: 0,
      rootHeight: 3,
    });
    const harness = browserHarness({ height: 3 });
    expect(harness.byId("modelscout-filter-row").props.visible).toBe(false);
    expect(harness.byId("modelscout-footer-row").props.visible).toBe(false);
  });

  it("reveals optional chrome only when each height threshold fits", () => {
    const expectations = [
      [1, { searchRows: 0, summaryRows: 0, filterRows: 0, footerRows: 0 }],
      [2, { searchRows: 1, summaryRows: 0, filterRows: 0, footerRows: 0 }],
      [3, { searchRows: 1, summaryRows: 1, filterRows: 0, footerRows: 0 }],
      [4, { searchRows: 1, summaryRows: 1, filterRows: 1, footerRows: 0 }],
      [5, { searchRows: 1, summaryRows: 1, filterRows: 1, footerRows: 1 }],
    ] as const;

    for (const [height, expected] of expectations)
      expect(browserLayoutBudget(height)).toMatchObject(expected);
  });
});

describe("unified browser interactions", () => {
  it("opens with results focused and never constructs a tab_select", () => {
    const harness = browserHarness({ height: 18, width: 100 });
    expect(harness.view.state()).toMatchObject({
      screen: "list",
      focus: "list",
    });
    expect(harness.byId("modelscout-results").props.focused).toBe(true);
    expect(harness.nodes.every((node) => node.tag !== "tab_select")).toBe(true);
    expect(harness.findById("modelscout-mode")).toBeUndefined();
    expect(harness.findById("modelscout-mode-row")).toBeUndefined();
    expect(harness.byId("modelscout-detail-screen").props.visible).toBe(false);
  });

  it("themes the select as one surface with the host dialog", () => {
    const harness = browserHarness();
    expect(harness.byId("modelscout-results").props).toMatchObject({
      backgroundColor: theme.backgroundPanel,
      focusedBackgroundColor: theme.backgroundPanel,
      selectedBackgroundColor: theme.primary,
      textColor: theme.text,
      focusedTextColor: theme.text,
      selectedTextColor: theme.selectedListItemText,
    });
  });

  it("keeps the padded root's outer width at the requested content width", () => {
    // width 100 → contentWidth 100; the root carries 2-column left/right
    // padding, so its numeric (content-box) width must be contentWidth - 4 or
    // the select viewport and scrollbar overhang the dialog on the right.
    const harness = browserHarness({ width: 100 });
    expect(harness.byId("modelscout-browser").props).toMatchObject({
      width: 96,
      paddingLeft: 2,
      paddingRight: 2,
    });
  });

  it("includes the provider count in multi-provider summaries only", () => {
    const multi = browserHarness();
    expect(multi.byId("modelscout-summary").props.content).toContain(
      "2 providers",
    );

    const single = browserHarness({ groups: singleGroup });
    expect(single.byId("modelscout-summary").props.content).not.toContain(
      "provider",
    );
    expect(single.byId("modelscout-summary").props.content).toContain(
      "2/2 models",
    );
  });

  it("opens provider diagnostics from a header row and restores the list", () => {
    const harness = browserHarness();
    const results = harness.byId("modelscout-results");
    (results.props.onSelect as (index: number) => void)(0);
    expect(harness.view.state()).toMatchObject({
      screen: "detail",
      focus: "detail",
    });
    expect(harness.byId("modelscout-detail-text").props.content).toContain(
      "Provider ID: atlas-primary",
    );
    expect(harness.byId("modelscout-detail-text").props.content).toContain(
      "Discovery",
    );

    const back = harness.press({ name: "backspace", sequence: "\x7f" });
    expect(harness.view.state()).toMatchObject({
      screen: "list",
      focus: "list",
      selected: expect.stringMatching(/^provider:atlas-primary$/),
    });
    expect(results.props.selectedIndex).toBe(0);
    expect(back.preventDefault).toHaveBeenCalledOnce();
  });

  it("opens model details from a model row", () => {
    const harness = browserHarness();
    const results = harness.byId("modelscout-results");
    (results.props.onSelect as (index: number) => void)(1);
    expect(harness.byId("modelscout-detail-text").props.content).toContain(
      "Model ID: atlas-chat [server]",
    );
  });

  it("opens full-width details and Backspace restores list state", () => {
    const harness = browserHarness();
    const results = harness.byId("modelscout-results");
    const search = harness.byId("modelscout-search");
    (results.props.onChange as (index: number) => void)(2);
    harness.press({ name: "t", sequence: "t" });
    harness.press({ name: "t", sequence: "t" });
    (search.props.onInput as (query: string) => void)("vision");
    (results.props.onSelect as (index: number) => void)(1);

    expect(harness.view.state()).toMatchObject({
      screen: "detail",
      focus: "detail",
      query: "vision",
      facets: { type: "vlm" },
      selected: expect.stringContaining("atlas-vision"),
    });
    expect(harness.byId("modelscout-list-screen").props.visible).toBe(false);
    expect(harness.byId("modelscout-detail-screen").props).toMatchObject({
      visible: true,
      width: "100%",
    });
    expect(harness.byId("modelscout-detail-text").props.content).toContain(
      "Atlas Vision",
    );

    const back = harness.press({ name: "backspace", sequence: "\x7f" });
    expect(harness.view.state()).toMatchObject({
      screen: "list",
      focus: "list",
      query: "vision",
      facets: { type: "vlm" },
      selected: expect.stringContaining("atlas-vision"),
    });
    expect(results.props.selectedIndex).toBe(1);
    expect(back.preventDefault).toHaveBeenCalledOnce();
  });

  it("preserves a visible model selection across search, facets, and detail", () => {
    const harness = browserHarness();
    const results = harness.byId("modelscout-results");
    const search = harness.byId("modelscout-search");
    (results.props.onChange as (index: number) => void)(1);

    harness.press({ name: "t", sequence: "t" });
    (search.props.onInput as (query: string) => void)("chat");
    expect(harness.view.state().selected).toContain("atlas-chat");
    expect(results.props.selectedIndex).toBe(1);

    (results.props.onSelect as (index: number) => void)(
      results.props.selectedIndex as number,
    );
    harness.press({ name: "backspace", sequence: "\x7f" });
    expect(harness.view.state()).toMatchObject({
      screen: "list",
      focus: "list",
      selected: expect.stringContaining("atlas-chat"),
      query: "chat",
      facets: { type: "llm" },
    });
    expect(results.props.selectedIndex).toBe(1);
  });

  it.each([84, 85, 86])(
    "uses a complete footer variant at %i text columns",
    (textColumns) => {
      const harness = browserHarness({ width: textColumns + 8 });
      const footer = harness.byId("modelscout-footer-text");
      expect(stringWidth(footer.props.content as string)).toBeLessThanOrEqual(
        textColumns,
      );
      expect(footer.props.content).toContain("esc close");
      expect(footer.props.content).not.toContain("…");

      const results = harness.byId("modelscout-results");
      (results.props.onSelect as (index: number) => void)(0);
      expect(stringWidth(footer.props.content as string)).toBeLessThanOrEqual(
        textColumns,
      );
      expect(footer.props.content).toContain("↑/↓ scroll");
      expect(footer.props.content).toContain("backspace list");
      expect(footer.props.content).not.toContain("…");
    },
  );

  it("fits the medium footer variant in the 64-column budget of an 80-column terminal", () => {
    // An 80-column terminal reaches the browser as width 72 → text width 64.
    const harness = browserHarness({ width: 72 });
    const footer = harness.byId("modelscout-footer-text");
    const listFooter = footer.props.content as string;
    expect(stringWidth(listFooter)).toBeLessThanOrEqual(64);
    expect(listFooter).toContain("p/t/c/s/m/o");
    expect(listFooter).toContain("r reset");
    expect(listFooter).toContain("esc close");
    expect(listFooter).not.toContain("…");

    const results = harness.byId("modelscout-results");
    (results.props.onSelect as (index: number) => void)(0);
    const detailFooter = footer.props.content as string;
    expect(stringWidth(detailFooter)).toBeLessThanOrEqual(64);
    expect(detailFooter).toContain("↑/↓ scroll");
    expect(detailFooter).toContain("p/t/c/s/m/o");
    expect(detailFooter).toContain("r reset");
    expect(detailFooter).not.toContain("…");
  });

  it("drops the p key from the medium footer for single-provider catalogs", () => {
    const harness = browserHarness({ width: 72, groups: singleGroup });
    const footer = harness.byId("modelscout-footer-text").props
      .content as string;
    expect(footer).toContain("t/c/s/m/o");
    expect(footer).not.toContain("p/t/c/s/m/o");
  });

  it("uses complete compact footers instead of clipping essential hints", () => {
    const harness = browserHarness({ width: 60 });
    const footer = harness.byId("modelscout-footer-text");
    expect(footer.props.content).toContain("esc close");
    expect(footer.props.content).not.toContain("…");

    const results = harness.byId("modelscout-results");
    (results.props.onSelect as (index: number) => void)(0);
    expect(footer.props.content).toContain("backspace list");
    expect(footer.props.content).toContain("esc close");
    expect(footer.props.content).not.toContain("…");
  });

  it("advertises only working search actions while search owns focus", () => {
    const harness = browserHarness();
    harness.press({ name: "/", sequence: "/" });
    expect(harness.view.state().focus).toBe("search");
    expect(harness.byId("modelscout-footer-text").props.content).toBe(
      "enter results · ↑/↓ results · esc close",
    );

    // Returning focus to the list restores the list hints.
    harness.press({ name: "down" });
    expect(harness.view.state().focus).toBe("list");
    expect(harness.byId("modelscout-footer-text").props.content).toContain(
      "enter open",
    );
  });

  it("advertises only esc while search owns focus over an empty catalog", () => {
    const harness = browserHarness({ groups: [] });
    expect(harness.view.state().focus).toBe("search");
    expect(harness.byId("modelscout-footer-text").props.content).toBe(
      "esc close",
    );
  });

  it("advertises only recovery actions when facets empty the list", () => {
    const onlyVision: ProviderGroup[] = [
      {
        ...groups[0],
        models: [
          model({ id: "only-vision", name: "Only Vision", type: "vlm" }),
        ],
      },
    ];
    const harness = browserHarness({ groups: onlyVision });
    harness.press({ name: "t", sequence: "t" });
    expect(harness.view.state()).toMatchObject({
      focus: "list",
      facets: { type: "llm" },
    });
    const footer = harness.byId("modelscout-footer-text").props
      .content as string;
    expect(footer).toContain("r reset");
    expect(footer).not.toContain("enter open");
    expect(footer).not.toContain("↑/↓");
  });

  it("advertises the provider facet key only for multi-provider catalogs", () => {
    const multi = browserHarness({ width: 100 });
    expect(multi.byId("modelscout-footer-text").props.content).toContain(
      "p/t/c/s/m/o",
    );

    const single = browserHarness({ width: 100, groups: singleGroup });
    const footer = single.byId("modelscout-footer-text").props
      .content as string;
    expect(footer).toContain("t/c/s/m/o");
    expect(footer).not.toContain("p/t/c/s/m/o");
  });

  it("cycles the provider facet with p only when several providers exist", () => {
    const multi = browserHarness();
    const consumed = multi.press({ name: "p", sequence: "p" });
    expect(multi.view.state().facets.provider).toBe("atlas-primary");
    expect(consumed.preventDefault).toHaveBeenCalledOnce();

    const single = browserHarness({ groups: singleGroup });
    const ignored = single.press({ name: "p", sequence: "p" });
    expect(single.view.state().facets).toEqual(INITIAL_BROWSER_FACETS);
    expect(ignored.preventDefault).not.toHaveBeenCalled();
  });

  it("applies p from details only when several providers exist", () => {
    const multi = browserHarness();
    const multiResults = multi.byId("modelscout-results");
    (multiResults.props.onSelect as (index: number) => void)(0);
    const applied = multi.press({ name: "p", sequence: "p" });
    expect(multi.view.state()).toMatchObject({
      screen: "list",
      focus: "list",
      facets: { provider: "atlas-primary" },
    });
    expect(applied.preventDefault).toHaveBeenCalledOnce();

    const single = browserHarness({ groups: singleGroup });
    const singleResults = single.byId("modelscout-results");
    (singleResults.props.onSelect as (index: number) => void)(0);
    const ignored = single.press({ name: "p", sequence: "p" });
    expect(single.view.state()).toMatchObject({
      screen: "detail",
      focus: "detail",
      facets: INITIAL_BROWSER_FACETS,
    });
    expect(ignored.preventDefault).not.toHaveBeenCalled();
  });

  it("cycles the origin facet with o only when exact origin evidence exists", () => {
    const exact = browserHarness();
    const consumed = exact.press({ name: "o", sequence: "o" });
    expect(exact.view.state().facets.origin).toBe("discovered");
    expect(consumed.preventDefault).toHaveBeenCalledOnce();

    const hostOnly = browserHarness({
      groups: groups.map((group) => ({ ...group, exactProvenance: false })),
    });
    const ignored = hostOnly.press({ name: "o", sequence: "o" });
    expect(hostOnly.view.state().facets).toEqual(INITIAL_BROWSER_FACETS);
    expect(ignored.preventDefault).not.toHaveBeenCalled();
  });

  it("applies o from details only when exact origin evidence exists", () => {
    const exact = browserHarness();
    const exactResults = exact.byId("modelscout-results");
    (exactResults.props.onSelect as (index: number) => void)(0);
    const applied = exact.press({ name: "o", sequence: "o" });
    expect(exact.view.state()).toMatchObject({
      screen: "list",
      focus: "list",
      facets: { origin: "discovered" },
    });
    expect(applied.preventDefault).toHaveBeenCalledOnce();

    const hostOnly = browserHarness({
      groups: groups.map((group) => ({ ...group, exactProvenance: false })),
    });
    const hostResults = hostOnly.byId("modelscout-results");
    (hostResults.props.onSelect as (index: number) => void)(0);
    const ignored = hostOnly.press({ name: "o", sequence: "o" });
    expect(hostOnly.view.state()).toMatchObject({
      screen: "detail",
      focus: "detail",
      facets: INITIAL_BROWSER_FACETS,
    });
    expect(ignored.preventDefault).not.toHaveBeenCalled();
  });

  it("never consumes Tab from list, search, or detail", () => {
    const harness = browserHarness();
    const assertTabPassesThrough = () => {
      const before = harness.view.state();
      const tab = harness.press({ name: "tab", sequence: "\t" });
      expect(harness.view.state()).toEqual(before);
      expect(tab.preventDefault).not.toHaveBeenCalled();
      expect(tab.stopPropagation).not.toHaveBeenCalled();
    };

    assertTabPassesThrough();
    harness.press({ name: "/", sequence: "/" });
    expect(harness.view.state().focus).toBe("search");
    assertTabPassesThrough();
    const results = harness.byId("modelscout-results");
    (results.props.onSelect as (index: number) => void)(0);
    expect(harness.view.state().focus).toBe("detail");
    assertTabPassesThrough();
  });

  it("routes slash from details back to the list search", () => {
    const harness = browserHarness();
    const results = harness.byId("modelscout-results");
    (results.props.onSelect as (index: number) => void)(0);
    const slash = harness.press({ name: "/", sequence: "/" });
    expect(harness.view.state()).toMatchObject({
      screen: "list",
      focus: "search",
    });
    expect(harness.byId("modelscout-search").props.focused).toBe(true);
    expect(slash.preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves detail arrows to the focused scroll pane", () => {
    const harness = browserHarness();
    const results = harness.byId("modelscout-results");
    (results.props.onSelect as (index: number) => void)(0);

    for (const name of ["up", "down"] as const) {
      const arrow = harness.press({ name });
      expect(arrow.preventDefault).not.toHaveBeenCalled();
      expect(arrow.stopPropagation).not.toHaveBeenCalled();
    }
    expect(harness.view.state()).toMatchObject({
      screen: "detail",
      focus: "detail",
    });
  });

  it("moves from search relative to the painted fallback and submits to results", () => {
    const harness = browserHarness();
    const search = harness.byId("modelscout-search");
    const results = harness.byId("modelscout-results");
    (results.props.onChange as (index: number) => void)(2);
    harness.press({ name: "/", sequence: "/" });
    (search.props.onInput as (query: string) => void)("chat");

    expect(results.props.selectedIndex).toBe(0);
    expect(harness.view.state().selected).toContain("atlas-primary");
    const down = harness.press({ name: "down" });
    expect(results.selectedIndexCalls).toEqual([1]);
    expect(harness.view.state()).toMatchObject({ focus: "list" });
    expect(harness.view.state().selected).toContain("atlas-chat");
    expect(down.preventDefault).toHaveBeenCalledOnce();

    harness.press({ name: "/", sequence: "/" });
    (search.props.onSubmit as () => void)();
    expect(harness.view.state().focus).toBe("list");
  });

  it("moves Up and Down from search around the current painted selection", () => {
    const harness = browserHarness();
    const results = harness.byId("modelscout-results");
    (results.props.onChange as (index: number) => void)(1);
    harness.press({ name: "/", sequence: "/" });
    harness.press({ name: "up" });
    expect(results.selectedIndex).toBe(0);
    expect(harness.view.state().selected).toMatch(/provider:atlas-primary$/);

    harness.press({ name: "/", sequence: "/" });
    harness.press({ name: "down" });
    expect(results.selectedIndex).toBe(1);
    expect(harness.view.state().selected).toContain("atlas-chat");
  });

  it("returns facet/reset shortcuts from details to non-input focus", () => {
    const harness = browserHarness();
    const results = harness.byId("modelscout-results");
    (results.props.onSelect as (index: number) => void)(1);
    harness.press({ name: "t", sequence: "t" });
    expect(harness.view.state()).toMatchObject({
      screen: "list",
      focus: "list",
      facets: { type: "llm" },
    });

    (results.props.onSelect as (index: number) => void)(1);
    harness.press({ name: "r", sequence: "r" });
    expect(harness.view.state()).toMatchObject({
      screen: "list",
      focus: "list",
      facets: INITIAL_BROWSER_FACETS,
    });
  });

  it("keeps shortcuts usable when a facet empties the whole list", () => {
    const onlyVision: ProviderGroup[] = [
      {
        ...groups[0],
        models: [
          model({ id: "atlas-vision", name: "Atlas Vision", type: "vlm" }),
        ],
      },
    ];
    const harness = browserHarness({ groups: onlyVision });
    const results = harness.byId("modelscout-results");
    (results.props.onSelect as (index: number) => void)(1);
    harness.press({ name: "t", sequence: "t" });
    expect(harness.view.state()).toMatchObject({
      screen: "list",
      focus: "list",
      facets: { type: "llm" },
    });
    expect(results.props.visible).toBe(false);

    const consecutive = harness.press({ name: "t", sequence: "t" });
    expect(harness.view.state()).toMatchObject({
      focus: "list",
      facets: { type: "vlm" },
    });
    expect(results.props.visible).toBe(true);
    expect(consecutive.preventDefault).toHaveBeenCalledOnce();
  });

  it("keeps shortcuts usable when facets empty the list under an active query", () => {
    const harness = browserHarness();
    const search = harness.byId("modelscout-search");
    const results = harness.byId("modelscout-results");
    harness.press({ name: "/", sequence: "/" });
    (search.props.onInput as (query: string) => void)("chat");
    harness.press({ name: "down" });
    expect(harness.view.state().focus).toBe("list");

    // "chat" only matches the llm model; cycling type to vlm empties the
    // intersection. Focus must stay on the list so cycling can continue.
    harness.press({ name: "t", sequence: "t" });
    const emptied = harness.press({ name: "t", sequence: "t" });
    expect(harness.view.state()).toMatchObject({
      focus: "list",
      query: "chat",
      facets: { type: "vlm" },
    });
    expect(results.props.visible).toBe(false);
    expect(emptied.preventDefault).toHaveBeenCalledOnce();

    // Continued cycling from the empty intersection still works…
    const next = harness.press({ name: "t", sequence: "t" });
    expect(harness.view.state().facets.type).toBe("embedding");
    expect(next.preventDefault).toHaveBeenCalledOnce();

    // …and r recovers while the query stays active.
    const reset = harness.press({ name: "r", sequence: "r" });
    expect(harness.view.state()).toMatchObject({
      focus: "list",
      query: "chat",
      facets: INITIAL_BROWSER_FACETS,
    });
    expect(results.props.visible).toBe(true);
    expect(reset.preventDefault).toHaveBeenCalledOnce();
  });

  it("returns Enter from search to the facet-empty list so r can reset", () => {
    const onlyVision: ProviderGroup[] = [
      {
        ...groups[0],
        models: [
          model({ id: "only-vision", name: "Only Vision", type: "vlm" }),
        ],
      },
    ];
    const harness = browserHarness({ groups: onlyVision });
    const search = harness.byId("modelscout-search");
    harness.press({ name: "t", sequence: "t" });
    expect(harness.byId("modelscout-results").props.visible).toBe(false);

    harness.press({ name: "/", sequence: "/" });
    expect(harness.view.state().focus).toBe("search");
    // The search-focused facet-empty footer must advertise the exit.
    expect(harness.byId("modelscout-footer-text").props.content).toBe(
      "enter filters · ↑/↓ filters · esc close",
    );

    (search.props.onSubmit as () => void)();
    expect(harness.view.state().focus).toBe("list");

    const reset = harness.press({ name: "r", sequence: "r" });
    expect(harness.view.state()).toMatchObject({
      focus: "list",
      facets: INITIAL_BROWSER_FACETS,
    });
    expect(harness.byId("modelscout-results").props.visible).toBe(true);
    expect(reset.preventDefault).toHaveBeenCalledOnce();
  });

  it.each(["up", "down"] as const)(
    "returns %s from search to the facet-empty list so r can reset",
    (arrow) => {
      const onlyVision: ProviderGroup[] = [
        {
          ...groups[0],
          models: [
            model({ id: "only-vision", name: "Only Vision", type: "vlm" }),
          ],
        },
      ];
      const harness = browserHarness({ groups: onlyVision });
      harness.press({ name: "t", sequence: "t" });
      harness.press({ name: "/", sequence: "/" });
      expect(harness.view.state().focus).toBe("search");

      const moved = harness.press({ name: arrow });
      expect(harness.view.state().focus).toBe("list");
      expect(moved.preventDefault).toHaveBeenCalledOnce();
      // No item exists to highlight; the painted selection is untouched.
      expect(harness.byId("modelscout-results").selectedIndexCalls).toEqual([]);

      const reset = harness.press({ name: "r", sequence: "r" });
      expect(harness.view.state()).toMatchObject({
        focus: "list",
        facets: INITIAL_BROWSER_FACETS,
      });
      expect(harness.byId("modelscout-results").props.visible).toBe(true);
      expect(reset.preventDefault).toHaveBeenCalledOnce();
    },
  );

  it("keeps search focus captive only when no query match exists to recover", () => {
    // Default facets with a no-match query: the empty list is not a facet
    // recovery target, so Enter/arrows stay in search and only esc applies.
    const harness = browserHarness();
    const search = harness.byId("modelscout-search");
    harness.press({ name: "/", sequence: "/" });
    (search.props.onInput as (query: string) => void)("zzz-no-match");
    expect(harness.byId("modelscout-footer-text").props.content).toBe(
      "esc close",
    );
    (search.props.onSubmit as () => void)();
    expect(harness.view.state().focus).toBe("search");
    const down = harness.press({ name: "down" });
    expect(harness.view.state().focus).toBe("search");
    expect(down.preventDefault).not.toHaveBeenCalled();
  });

  it("treats a query match hidden only by facets as recoverable", () => {
    // "vision" matches Atlas Vision, but the llm type facet hides it.
    // Resetting facets would reveal the match, so the zero-item list stays
    // the recovery target: Enter exits search and r resets.
    const harness = browserHarness();
    const search = harness.byId("modelscout-search");
    harness.press({ name: "t", sequence: "t" });
    expect(harness.view.state().facets.type).toBe("llm");
    harness.press({ name: "/", sequence: "/" });
    (search.props.onInput as (query: string) => void)("vision");
    expect(harness.byId("modelscout-results").props.visible).toBe(false);
    expect(harness.byId("modelscout-footer-text").props.content).toBe(
      "enter filters · ↑/↓ filters · esc close",
    );

    (search.props.onSubmit as () => void)();
    expect(harness.view.state().focus).toBe("list");

    const reset = harness.press({ name: "r", sequence: "r" });
    expect(harness.view.state()).toMatchObject({
      focus: "list",
      query: "vision",
      facets: INITIAL_BROWSER_FACETS,
    });
    expect(harness.byId("modelscout-results").props.visible).toBe(true);
    expect(reset.preventDefault).toHaveBeenCalledOnce();
  });

  it("keeps an unrelated no-match query search-owned despite active facets", () => {
    // Active facets plus a query that matches nothing even with facets
    // reset: r cannot reveal anything, so the list is not a recovery
    // target and the footer advertises only esc.
    const harness = browserHarness();
    const search = harness.byId("modelscout-search");
    harness.press({ name: "t", sequence: "t" });
    expect(harness.view.state().facets.type).toBe("llm");
    harness.press({ name: "/", sequence: "/" });
    (search.props.onInput as (query: string) => void)("zzz-no-match");
    expect(harness.byId("modelscout-footer-text").props.content).toBe(
      "esc close",
    );

    (search.props.onSubmit as () => void)();
    expect(harness.view.state().focus).toBe("search");
    const down = harness.press({ name: "down" });
    expect(harness.view.state().focus).toBe("search");
    expect(down.preventDefault).not.toHaveBeenCalled();
  });

  it("omits the o facet key from footers when exact origin evidence is unavailable", () => {
    const hostOnly = groups.map((group) => ({
      ...group,
      exactProvenance: false,
    }));
    const multi = browserHarness({ width: 100, groups: hostOnly });
    const multiFooter = multi.byId("modelscout-footer-text").props
      .content as string;
    expect(multiFooter).toContain("p/t/c/s/m");
    expect(multiFooter).not.toContain("/o");

    const single = browserHarness({
      width: 100,
      groups: [{ ...groups[0], exactProvenance: false }],
    });
    const singleFooter = single.byId("modelscout-footer-text").props
      .content as string;
    expect(singleFooter).toContain("t/c/s/m");
    expect(singleFooter).not.toContain("p/");
    expect(singleFooter).not.toContain("/o");

    // Exact origin evidence restores the o key hint.
    const exact = browserHarness({ width: 100 });
    expect(exact.byId("modelscout-footer-text").props.content).toContain(
      "p/t/c/s/m/o",
    );
  });

  it("does not steal typed facet letters while search owns an emptying query", () => {
    const harness = browserHarness();
    const search = harness.byId("modelscout-search");
    harness.press({ name: "t", sequence: "t" });
    harness.press({ name: "/", sequence: "/" });
    (search.props.onInput as (query: string) => void)("zzz-no-match");
    expect(harness.view.state().focus).toBe("search");

    const typed = harness.press({ name: "r", sequence: "r" });
    expect(typed.preventDefault).not.toHaveBeenCalled();
    expect(harness.view.state()).toMatchObject({
      focus: "search",
      facets: { type: "llm" },
    });
  });

  it.each([2, 3])(
    "keeps facet-empty results recoverable at height %i without search owning r",
    (height) => {
      const onlyVision: ProviderGroup[] = [
        {
          ...groups[0],
          models: [
            model({ id: "only-vision", name: "Only Vision", type: "vlm" }),
          ],
        },
      ];
      const harness = browserHarness({ height, groups: onlyVision });
      const facet = harness.press({ name: "t", sequence: "t" });
      expect(harness.view.state()).toMatchObject({
        focus: "list",
        facets: { type: "llm" },
      });
      expect(harness.byId("modelscout-results").props.visible).toBe(false);
      expect(facet.preventDefault).toHaveBeenCalledOnce();

      const reset = harness.press({ name: "r", sequence: "r" });
      expect(harness.view.state()).toMatchObject({
        focus: "list",
        facets: INITIAL_BROWSER_FACETS,
      });
      expect(harness.byId("modelscout-results").props.visible).toBe(true);
      expect(reset.preventDefault).toHaveBeenCalledOnce();
    },
  );

  it.each(["ctrl", "meta", "option", "super", "hyper"] as const)(
    "does not consume %s-modified shortcuts",
    (modifier) => {
      const harness = browserHarness();
      const before = harness.view.state();
      const event = harness.press({
        name: "t",
        sequence: "t",
        [modifier]: true,
      });
      expect(harness.view.state()).toEqual(before);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    },
  );

  it("leaves slash and shortcuts unconsumed while search owns input", () => {
    const harness = browserHarness();
    harness.press({ name: "/", sequence: "/" });
    const slash = harness.press({ name: "/", sequence: "/" });
    const facet = harness.press({ name: "t", sequence: "t" });
    expect(slash.preventDefault).not.toHaveBeenCalled();
    expect(facet.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps empty catalogs focused on search without consuming shortcuts", () => {
    const harness = browserHarness({ groups: [] });
    expect(harness.view.state().focus).toBe("search");
    const reset = harness.press({ name: "r", sequence: "r" });
    expect(reset.preventDefault).not.toHaveBeenCalled();
    expect(harness.view.state().focus).toBe("search");
  });

  it("removes its explicit global listener exactly once", () => {
    const harness = browserHarness();
    expect(harness.keyListeners.size).toBe(1);
    harness.view.dispose();
    harness.view.dispose();
    expect(harness.keyListeners.size).toBe(0);
    expect(harness.keyInput.off).toHaveBeenCalledTimes(1);
  });

  it("never inserts primitive text below container intrinsics", () => {
    const harness = browserHarness();
    for (const node of harness.nodes)
      expect(node.children.every((child) => typeof child === "object")).toBe(
        true,
      );
  });
});
