import type { BaseRenderable, TextChunk } from "@opentui/core";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import {
  SELECTION_BAR,
  createRowList,
  fitText,
  keyMove,
  moveSelection,
  nearestSelectable,
  padText,
  revealSelection,
  rowSpans,
  sanitizeInline,
  sliceColumns,
  type ListPosition,
  type ListRow,
  type RowListOptions,
} from "../src/tui-list";
import {
  TuiRenderer,
  type ReconcilerBridge,
  type StyleBridge,
  type StyledSpan,
} from "../src/tui-renderer";
import type { RolePalette, ThemeRole } from "../src/tui-theme";

const ROLES: readonly ThemeRole[] = [
  "base",
  "muted",
  "faint",
  "selected",
  "selectedBg",
  "current",
  "group",
  "ok",
  "warn",
  "error",
  "info",
  "field",
  "fieldBg",
  "key",
  "disabled",
  "rule",
  "brand",
];

/** Each role's color is its own name, so spans show which role painted them. */
function namedPalette(prefix = ""): RolePalette {
  return Object.fromEntries(
    ROLES.map((role) => [role, `${prefix}${role}`]),
  ) as unknown as RolePalette;
}

const PALETTE = namedPalette();

function spansWidth(spans: readonly StyledSpan[]): number {
  return spans.reduce((sum, span) => sum + stringWidth(span.text), 0);
}

function spansText(spans: readonly StyledSpan[]): string {
  return spans.map((span) => span.text).join("");
}

describe("text cells", () => {
  describe("sanitizeInline", () => {
    it.each([
      ["line breaks", "a\r\nb", "a b"],
      ["tabs", "a\tb", "a b"],
      ["C1 controls", "a\u0085b", "a b"],
      ["line and paragraph separators", "a\u2028\u2029b", "a b"],
      ["bidi overrides", "a\u202Eb\u202Cc", "a b c"],
      ["bidi isolates", "a\u2066b\u2069c", "a b c"],
    ])("replaces a run of %s with one space", (_label, input, expected) => {
      expect(sanitizeInline(input)).toBe(expected);
    });

    it("keeps joiners and variation selectors that names rely on", () => {
      const family = "👨\u200D👩\u200D👧";
      const heart = "❤\uFE0F";
      expect(sanitizeInline(`${family} ${heart}`)).toBe(`${family} ${heart}`);
    });
  });

  describe("sliceColumns", () => {
    it("never splits a wide character across the limit", () => {
      expect(sliceColumns("日本語", 3)).toBe("日");
      expect(sliceColumns("日本語", 4)).toBe("日本");
    });

    it("keeps a grapheme with combining marks together", () => {
      const accented = "e\u0301";
      expect(sliceColumns(`${accented}${accented}x`, 2)).toBe(
        `${accented}${accented}`,
      );
    });
  });

  describe("fitText", () => {
    it("returns text that fits unchanged apart from sanitizing", () => {
      expect(fitText("Atlas", 5)).toBe("Atlas");
      expect(fitText("At\nlas", 6)).toBe("At las");
    });

    it("cuts overflowing text and ends it with an ellipsis within the width", () => {
      expect(fitText("Atlas Chat", 6)).toBe("Atlas…");
    });

    it("measures by terminal columns, not code units", () => {
      const cut = fitText("日本語テキスト", 6);
      expect(cut).toBe("日本…");
      expect(stringWidth(cut)).toBeLessThanOrEqual(6);
    });

    it.each([0, -3, 0.9])("returns an empty cell for width %s", (width) => {
      expect(fitText("Atlas", width)).toBe("");
    });

    it("floors a fractional width", () => {
      expect(fitText("Atlas Chat", 3.9)).toBe("At…");
    });
  });

  describe("padText", () => {
    it("pads on the right by default and on the left when right-aligned", () => {
      expect(padText("ab", 5)).toBe("ab   ");
      expect(padText("ab", 5, "right")).toBe("   ab");
    });

    it("cuts overflowing text to exactly the width", () => {
      expect(padText("Atlas Chat", 6)).toBe("Atlas…");
    });

    it("fills the column a wide character could not use", () => {
      const cell = padText("日本語", 4);
      expect(cell).toBe("日… ");
      expect(stringWidth(cell)).toBe(4);
    });
  });
});

describe("rowSpans", () => {
  const row: ListRow = {
    key: "atlas/chat",
    segments: [
      { text: " ● ", role: "current" },
      { text: "Atlas Chat", role: "base" },
      { text: "  200K", role: "faint" },
    ],
  };
  const unselected = { selected: false, focused: true, bar: true };
  const focusedSelection = { selected: true, focused: true, bar: true };
  const unfocusedSelection = { selected: true, focused: false, bar: true };

  it("paints an unselected row in each segment's role without padding", () => {
    expect(rowSpans(row, PALETTE, 40, unselected)).toEqual([
      { text: " ● ", fg: "current" },
      { text: "Atlas Chat", fg: "base" },
      { text: "  200K", fg: "faint" },
    ]);
  });

  it("renders group and brand roles bold", () => {
    const spans = rowSpans(
      {
        key: "h",
        segments: [
          { text: "Actualyze", role: "group" },
          { text: " ACTUALYZE", role: "brand" },
          { text: " ok", role: "ok" },
        ],
      },
      PALETTE,
      40,
      unselected,
    );
    expect(spans.map((span) => span.bold ?? false)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("drops empty segments and sanitizes segment text", () => {
    expect(
      rowSpans(
        {
          key: "k",
          segments: [
            { text: "", role: "muted" },
            { text: "a\nb", role: "base" },
          ],
        },
        PALETTE,
        10,
        unselected,
      ),
    ).toEqual([{ text: "a b", fg: "base" }]);
  });

  it("cuts an overflowing row in the overflowing segment's role and drops the rest", () => {
    const spans = rowSpans(row, PALETTE, 8, unselected);
    expect(spans).toEqual([
      { text: " ● ", fg: "current" },
      { text: "Atla…", fg: "base" },
    ]);
    expect(spansWidth(spans)).toBe(8);
  });

  it("marks a focused selection with a band across the full width and no bar", () => {
    const spans = rowSpans(row, PALETTE, 24, focusedSelection);
    expect(spansText(spans)).toBe(" ● Atlas Chat  200K     ");
    expect(spans.some((span) => span.text === SELECTION_BAR)).toBe(false);
    expect(spansWidth(spans)).toBe(24);
    for (const span of spans) expect(span.bg).toBe("selectedBg");
    for (const span of spans.slice(0, -1)) expect(span.fg).toBe("selected");
  });

  it("shows only a muted bar on a selection in an unfocused list", () => {
    const spans = rowSpans(row, PALETTE, 24, unfocusedSelection);
    expect(spans).toEqual([
      { text: SELECTION_BAR, fg: "muted" },
      { text: "● ", fg: "current" },
      { text: "Atlas Chat", fg: "base" },
      { text: "  200K", fg: "faint" },
    ]);
  });

  it("keeps the first column and still bands the row when the bar is off", () => {
    const spans = rowSpans(row, PALETTE, 24, {
      selected: true,
      focused: true,
      bar: false,
    });
    expect(spansText(spans)).toBe(" ● Atlas Chat  200K     ");
    expect(spans.some((span) => span.text === SELECTION_BAR)).toBe(false);
    for (const span of spans) expect(span.bg).toBe("selectedBg");
  });

  it("fills the column of a wide character the bar covers half of", () => {
    const spans = rowSpans(
      { key: "k", segments: [{ text: "日本", role: "base" }] },
      PALETTE,
      4,
      unfocusedSelection,
    );
    expect(spansText(spans)).toBe(`${SELECTION_BAR} 本`);
    expect(spansWidth(spans)).toBe(4);
  });

  it("keeps the bar and the ellipsis inside the width when a selected row overflows", () => {
    const spans = rowSpans(
      { key: "k", segments: [{ text: " Atlas Chat Model", role: "base" }] },
      PALETTE,
      10,
      unfocusedSelection,
    );
    expect(spansText(spans)).toBe(`${SELECTION_BAR}Atlas Ch…`);
    expect(spansWidth(spans)).toBe(10);
  });

  it.each([0, 1, 2, 5])(
    "never paints wider than a width of %s columns",
    (width) => {
      for (const state of [unselected, focusedSelection, unfocusedSelection])
        expect(
          spansWidth(rowSpans(row, PALETTE, width, state)),
        ).toBeLessThanOrEqual(width);
    },
  );
});

// ── Navigation ────────────────────────────────────────────────────────────

/** A model-like row: its first column is the gutter the bar replaces. */
function item(key: string): ListRow {
  return { key, segments: [{ text: ` ${key}`, role: "base" }] };
}

function header(key: string): ListRow {
  return { key, segments: [{ text: key, role: "group" }], selectable: false };
}

/** H0 a b H1 c d */
const GROUPED: readonly ListRow[] = [
  header("H0"),
  item("a"),
  item("b"),
  header("H1"),
  item("c"),
  item("d"),
];

function at(selected: number, offset = 0): ListPosition {
  return { selected, offset };
}

describe("keyMove", () => {
  it.each(["up", "down", "pageup", "pagedown", "home", "end"] as const)(
    "maps %s to its move",
    (name) => {
      expect(keyMove(name)).toBe(name);
    },
  );

  it.each(["left", "j", "return", "constructor", "toString", "__proto__"])(
    "ignores %s",
    (name) => {
      expect(keyMove(name)).toBeUndefined();
    },
  );
});

describe("nearestSelectable", () => {
  it("returns the index itself when it is selectable", () => {
    expect(nearestSelectable(GROUPED, 2, 1)).toBe(2);
  });

  it("searches in the given direction first", () => {
    expect(nearestSelectable(GROUPED, 3, 1)).toBe(4);
    expect(nearestSelectable(GROUPED, 3, -1)).toBe(2);
  });

  it("turns around when nothing is selectable in the given direction", () => {
    expect(nearestSelectable(GROUPED, 0, -1)).toBe(1);
    expect(
      nearestSelectable([item("a"), header("H"), header("H2")], 2, 1),
    ).toBe(0);
  });

  it("clamps an index outside the rows", () => {
    expect(nearestSelectable(GROUPED, -5, 1)).toBe(1);
    expect(nearestSelectable(GROUPED, 99, -1)).toBe(5);
  });

  it("returns -1 when no row is selectable", () => {
    expect(nearestSelectable([header("H")], 0, 1)).toBe(-1);
    expect(nearestSelectable([], 0, 1)).toBe(-1);
  });
});

describe("revealSelection", () => {
  const ten = Array.from({ length: 10 }, (_, index) => item(`r${index}`));

  it("scrolls up to a selection above the window", () => {
    expect(revealSelection(ten, at(2, 5), 3)).toEqual(at(2, 2));
  });

  it("scrolls down so a selection below the window is the last visible row", () => {
    expect(revealSelection(ten, at(7, 0), 3)).toEqual(at(7, 5));
  });

  it("leaves the window alone when the selection is visible", () => {
    expect(revealSelection(ten, at(4, 3), 3)).toEqual(at(4, 3));
  });

  it("keeps the window inside the rows", () => {
    expect(revealSelection(ten, at(-1, 50), 3)).toEqual(at(-1, 7));
    expect(revealSelection(ten, at(-1, -4), 3)).toEqual(at(-1, 0));
    expect(revealSelection(ten.slice(0, 2), at(1, 1), 5)).toEqual(at(1, 0));
  });

  it("shows the leading header when the first selectable row is selected", () => {
    expect(revealSelection(GROUPED, at(1, 1), 3)).toEqual(at(1, 0));
  });

  it("treats a height below one as a single visible row", () => {
    expect(revealSelection(ten, at(4, 0), 0)).toEqual(at(4, 4));
  });
});

describe("moveSelection", () => {
  it("selects the first selectable row when nothing is selected", () => {
    expect(moveSelection(GROUPED, at(-1), "down", 10).selected).toBe(1);
  });

  it("skips header rows moving down and up", () => {
    expect(moveSelection(GROUPED, at(2), "down", 10).selected).toBe(4);
    expect(moveSelection(GROUPED, at(4), "up", 10).selected).toBe(2);
  });

  it("stays put at either end instead of landing on a header", () => {
    expect(moveSelection(GROUPED, at(1), "up", 10)).toEqual(at(1, 0));
    expect(moveSelection(GROUPED, at(5), "down", 10).selected).toBe(5);
    expect(
      moveSelection([item("a"), header("H")], at(0), "down", 10).selected,
    ).toBe(0);
  });

  it("pages by one less than the height", () => {
    const ten = Array.from({ length: 10 }, (_, index) => item(`r${index}`));
    expect(moveSelection(ten, at(0), "pagedown", 4)).toEqual(at(3, 0));
    expect(moveSelection(ten, at(3), "pagedown", 4)).toEqual(at(6, 3));
    expect(moveSelection(ten, at(6, 3), "pageup", 4)).toEqual(at(3, 3));
  });

  it("moves a page by at least one row", () => {
    expect(moveSelection(GROUPED, at(1), "pagedown", 1).selected).toBe(2);
  });

  it("clamps a page move to the first and last selectable rows", () => {
    expect(moveSelection(GROUPED, at(2), "pageup", 10)).toEqual(at(1, 0));
    expect(moveSelection(GROUPED, at(1), "pagedown", 10).selected).toBe(5);
  });

  it("moves off a header a page lands on, forward for pagedown and back for pageup", () => {
    // page = 2: a(1) + 2 lands on H1(3).
    expect(moveSelection(GROUPED, at(1), "pagedown", 3).selected).toBe(4);
    // c(4) - 2 is b(2); b(2) - 2 lands on H0(0), which has no row above.
    expect(moveSelection(GROUPED, at(4), "pageup", 3).selected).toBe(2);
    expect(moveSelection(GROUPED, at(2), "pageup", 3).selected).toBe(1);
  });

  it("goes home to the first selectable row with the header shown", () => {
    expect(moveSelection(GROUPED, at(5, 3), "home", 3)).toEqual(at(1, 0));
  });

  it("goes to the last selectable row on end and scrolls to it", () => {
    expect(moveSelection([...GROUPED, header("H2")], at(1), "end", 3)).toEqual(
      at(5, 3),
    );
  });

  it("keeps no selection when no row is selectable", () => {
    expect(moveSelection([header("H")], at(-1), "down", 3)).toEqual(at(-1, 0));
  });
});

// ── Recycled list ─────────────────────────────────────────────────────────

interface FakeNode {
  tag: string;
  props: Record<string, unknown>;
  children: FakeNode[];
  content?: unknown;
}

class FakeStyledText {
  constructor(readonly chunks: TextChunk[]) {}
}

function harness() {
  const created: FakeNode[] = [];
  const bridge: ReconcilerBridge = {
    createElement: (tag) => {
      const node: FakeNode = { tag, props: {}, children: [] };
      created.push(node);
      return node as unknown as BaseRenderable;
    },
    setProp: (node, name, value) => {
      (node as unknown as FakeNode).props[name] = value;
      return value;
    },
    insert: (parent, child) => {
      (parent as unknown as FakeNode).children.push(
        child as unknown as FakeNode,
      );
      return child;
    },
  };
  const style: StyleBridge = {
    StyledText: FakeStyledText as unknown as StyleBridge["StyledText"],
    // Colors in these tests are role names; keep them readable.
    parseColor: (color) =>
      color as unknown as ReturnType<StyleBridge["parseColor"]>,
    TextAttributes: { BOLD: 1 },
  };
  const renderer = new TuiRenderer(bridge, style);
  const node = (id: string): FakeNode => {
    const found = created.find((candidate) => candidate.props.id === id);
    if (!found) throw new Error(`no node ${id}`);
    return found;
  };
  const chunks = (id: string): TextChunk[] => {
    const content = node(id).content;
    return content instanceof FakeStyledText ? content.chunks : [];
  };
  const line = (slot: number, id = "list"): string =>
    chunks(`${id}-row-${slot}`)
      .map((chunk) => chunk.text)
      .join("");
  return { renderer, created, node, chunks, line };
}

function options(overrides: Partial<RowListOptions> = {}): RowListOptions {
  return {
    id: "list",
    capacity: 4,
    width: 12,
    height: 3,
    palette: () => PALETTE,
    ...overrides,
  };
}

const FIVE = ["a", "b", "c", "d", "e"].map(item);

describe("createRowList", () => {
  it("refuses a renderer without styled text", () => {
    const plain = new TuiRenderer({
      createElement: () => ({}) as BaseRenderable,
      setProp: () => undefined,
      insert: () => undefined,
    });
    expect(() => createRowList(plain, options())).toThrow();
  });

  it("creates one slot per capacity under the root and shows only the viewport height", () => {
    const h = harness();
    const list = createRowList(h.renderer, options());
    const root = h.node("list");
    expect(h.renderer.raw(list.root)).toBe(root);
    expect(root.children.map((child) => child.props.id)).toEqual([
      "list-row-0",
      "list-row-1",
      "list-row-2",
      "list-row-3",
    ]);
    expect(root.children.map((child) => child.props.visible)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(root.props).toMatchObject({ width: 12, height: 3 });
  });

  it("names nodes row-list by default and caps the height at the capacity", () => {
    const h = harness();
    createRowList(h.renderer, {
      capacity: 4,
      width: 12,
      height: 9,
      palette: () => PALETTE,
    });
    expect(h.node("row-list").props.height).toBe(4);
    expect(h.node("row-list-row-3").props.visible).toBe(true);
  });

  it("selects the first selectable row and paints the window", () => {
    const h = harness();
    const onSelect = vi.fn();
    const list = createRowList(h.renderer, options({ onSelect }));
    list.setRows(GROUPED);

    expect(list.selected()).toEqual({ row: GROUPED[1], index: 1 });
    expect(onSelect).toHaveBeenCalledWith(GROUPED[1], 1);
    expect(h.line(0)).toBe("H0");
    expect(h.line(1)).toBe(" a".padEnd(12));
    expect(h.chunks("list-row-1")[0]).toMatchObject({
      fg: "selected",
      bg: "selectedBg",
    });
    expect(h.line(2)).toBe(" b");
  });

  it("paints slots past the last row empty", () => {
    const h = harness();
    const list = createRowList(h.renderer, options());
    list.setRows(FIVE);
    list.setRows([item("a")]);
    expect(h.line(1)).toBe("");
    expect(h.line(2)).toBe("");
  });

  it("scrolls the window with the selection and reuses the same slots", () => {
    const h = harness();
    const list = createRowList(h.renderer, options());
    list.setRows(FIVE);
    const nodes = h.created.length;
    list.move("down");
    list.move("down");
    list.move("down");

    expect(list.position()).toEqual(at(3, 1));
    expect([h.line(0), h.line(2)]).toEqual([" b", " d".padEnd(12)]);
    expect(h.created.length).toBe(nodes);
  });

  it("handles list keys and reports which keys it consumed", () => {
    const h = harness();
    const list = createRowList(h.renderer, options());
    list.setRows(FIVE);

    expect(list.handleKey("end")).toBe(true);
    expect(list.selected()?.row.key).toBe("e");
    expect(list.handleKey("x")).toBe(false);
    expect(list.selected()?.row.key).toBe("e");
  });

  describe("replacing rows", () => {
    it("keeps the selection on the same key when it moves", () => {
      const h = harness();
      const list = createRowList(h.renderer, options());
      list.setRows(FIVE);
      list.select("c");
      list.setRows([item("z"), ...FIVE]);
      expect(list.selected()).toEqual({ row: FIVE[2], index: 3 });
    });

    it("does not report a selection change when the same rows come back", () => {
      const h = harness();
      const onSelect = vi.fn();
      const list = createRowList(h.renderer, options({ onSelect }));
      list.setRows(FIVE);
      list.select("b");
      onSelect.mockClear();
      list.setRows([...FIVE]);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("selects the nearest row at the old index when the selected key is gone", () => {
      const h = harness();
      const onSelect = vi.fn();
      const list = createRowList(h.renderer, options({ onSelect }));
      list.setRows(FIVE);
      list.select("c");
      onSelect.mockClear();
      list.setRows([item("a"), item("b"), header("H"), item("d")]);
      expect(list.selected()?.row.key).toBe("d");
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ key: "d" }),
        3,
      );
    });

    it("moves off the selected key when it became a header", () => {
      const h = harness();
      const list = createRowList(h.renderer, options());
      list.setRows(FIVE);
      list.select("b");
      list.setRows([item("a"), header("b"), item("c")]);
      expect(list.selected()?.row.key).toBe("c");
    });

    it("reports the selection cleared when no row is left", () => {
      const h = harness();
      const onSelect = vi.fn();
      const list = createRowList(h.renderer, options({ onSelect }));
      list.setRows(FIVE);
      onSelect.mockClear();
      list.setRows([]);
      expect(list.selected()).toBeUndefined();
      expect(onSelect).toHaveBeenCalledWith(undefined, -1);
    });
  });

  describe("select", () => {
    it("selects and reveals a selectable row by key", () => {
      const h = harness();
      const onSelect = vi.fn();
      const list = createRowList(h.renderer, options({ onSelect }));
      list.setRows(FIVE);
      expect(list.select("e")).toBe(true);
      expect(list.position()).toEqual(at(4, 2));
      expect(onSelect).toHaveBeenLastCalledWith(FIVE[4], 4);
    });

    it("refuses an absent or non-selectable key and keeps the selection", () => {
      const h = harness();
      const list = createRowList(h.renderer, options());
      list.setRows(GROUPED);
      list.select("b");
      expect(list.select("missing")).toBe(false);
      expect(list.select("H1")).toBe(false);
      expect(list.selected()?.row.key).toBe("b");
    });
  });

  describe("viewport", () => {
    it("resizes the root, toggles slot visibility, and repaints at the new width", () => {
      const h = harness();
      const list = createRowList(h.renderer, options());
      list.setRows(FIVE);
      list.setViewport(6, 2);

      expect(h.node("list").props).toMatchObject({ width: 6, height: 2 });
      expect(h.node("list-row-1").props.visible).toBe(true);
      expect(h.node("list-row-2").props.visible).toBe(false);
      expect(h.line(0)).toBe(" a".padEnd(6));
    });

    it("caps a larger viewport at the capacity", () => {
      const h = harness();
      const list = createRowList(h.renderer, options());
      list.setViewport(12, 10);
      expect(h.node("list").props.height).toBe(4);
      expect(h.node("list-row-3").props.visible).toBe(true);
    });

    it("scrolls to keep the selection visible when the viewport shrinks", () => {
      const h = harness();
      const list = createRowList(h.renderer, options());
      list.setRows(FIVE);
      list.select("c");
      list.setViewport(12, 1);
      expect(list.position()).toEqual(at(2, 2));
      expect(h.line(0)).toBe(" c".padEnd(12));
    });
  });

  describe("focus and theme", () => {
    it("paints the selection unfocused when the list loses focus", () => {
      const h = harness();
      const list = createRowList(h.renderer, options());
      list.setRows(FIVE);
      list.setFocused(false);
      const chunks = h.chunks("list-row-0");
      expect(chunks).toEqual([
        expect.objectContaining({ text: SELECTION_BAR, fg: "muted" }),
        expect.objectContaining({ text: "a", fg: "base" }),
      ]);
      for (const chunk of chunks) expect(chunk).not.toHaveProperty("bg");
    });

    it("starts unfocused when asked", () => {
      const h = harness();
      const list = createRowList(h.renderer, options({ focused: false }));
      list.setRows(FIVE);
      expect(h.chunks("list-row-0")[0]).toMatchObject({ fg: "muted" });
    });

    it("omits the bar when the selection bar is off", () => {
      const h = harness();
      const list = createRowList(h.renderer, options({ selectionBar: false }));
      list.setRows([{ key: "a", segments: [{ text: " a", role: "base" }] }]);
      expect(h.line(0)).toBe(" a".padEnd(12));
    });

    it("uses the palette current at each repaint", () => {
      const h = harness();
      let palette = PALETTE;
      const list = createRowList(
        h.renderer,
        options({ palette: () => palette }),
      );
      list.setRows(FIVE);
      palette = namedPalette("light-");
      list.repaint();
      expect(h.chunks("list-row-1")[0]).toMatchObject({ fg: "light-base" });
    });
  });
});
