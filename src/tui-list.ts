import stringWidth from "string-width";
import { BOLD_ROLES, type ForegroundRole, type RolePalette } from "./tui-theme";
import type { StyledSpan, TuiNode, TuiRenderer } from "./tui-renderer";

// ── Text cells ──────────────────────────────────────────────────────────

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/**
 * Replace characters that would break a one-line cell with spaces: C0/C1
 * controls, line and paragraph separators, and bidi embedding and isolate
 * controls. Joiners and variation selectors that names rely on pass through.
 */
export function sanitizeInline(value: string): string {
  return value.replace(
    /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+/gu,
    " ",
  );
}

/** Terminal columns `value` occupies. */
export function textWidth(value: string): number {
  return stringWidth(value);
}

/** The longest prefix of `value` that fits in `columns`, by grapheme. */
export function sliceColumns(value: string, columns: number): string {
  let used = 0;
  let result = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const next = stringWidth(segment);
    if (used + next > columns) break;
    result += segment;
    used += next;
  }
  return result;
}

/** Sanitize `value` and cut it to `columns`, ending a cut value with "…". */
export function fitText(value: string, columns: number): string {
  const width = Math.max(0, Math.floor(columns));
  if (width === 0) return "";
  const safe = sanitizeInline(value);
  if (stringWidth(safe) <= width) return safe;
  return `${sliceColumns(safe, width - 1)}…`;
}

/** `fitText`, then pad with spaces to exactly `columns`; `align` picks the side. */
export function padText(
  value: string,
  columns: number,
  align: "left" | "right" = "left",
): string {
  const cell = fitText(value, columns);
  const fill = " ".repeat(Math.max(0, Math.floor(columns) - stringWidth(cell)));
  return align === "left" ? cell + fill : fill + cell;
}

// ── Rows ────────────────────────────────────────────────────────────────

/** A run of text in one role. */
export interface Segment {
  readonly text: string;
  readonly role: ForegroundRole;
}

/** One list line: a stable key and its segments, left to right. */
export interface ListRow {
  /** Identifies the row across `setRows` calls, so selection survives them. */
  readonly key: string;
  readonly segments: readonly Segment[];
  /** False for rows the selection skips, such as spacers. Defaults to true. */
  readonly selectable?: boolean;
}

/** How the row being painted relates to the list's selection and focus. */
export interface RowPaintState {
  readonly selected: boolean;
  readonly focused: boolean;
  /** Draw `▌` over the first column of the selected row. */
  readonly bar: boolean;
}

/** The selection bar; it replaces the first column of the selected row. */
export const SELECTION_BAR = "▌";

/** Cut segments to `width` columns; the segment that overflows ends in "…". */
function fitSegments(
  segments: readonly Segment[],
  width: number,
): { text: string; role: ForegroundRole }[] {
  const safe = segments
    .map((segment) => ({ ...segment, text: sanitizeInline(segment.text) }))
    .filter((segment) => segment.text.length > 0);
  const total = safe.reduce(
    (sum, segment) => sum + stringWidth(segment.text),
    0,
  );
  if (total <= width) return safe;
  if (width < 1) return [];
  const fitted: { text: string; role: ForegroundRole }[] = [];
  let remaining = width - 1;
  for (const segment of safe) {
    const columns = stringWidth(segment.text);
    if (columns <= remaining) {
      fitted.push(segment);
      remaining -= columns;
      continue;
    }
    fitted.push({
      text: `${sliceColumns(segment.text, remaining)}…`,
      role: segment.role,
    });
    break;
  }
  return fitted;
}

/** Remove the first `columns` columns from a run of segments. */
function dropColumns(
  segments: readonly { text: string; role: ForegroundRole }[],
  columns: number,
): { text: string; role: ForegroundRole }[] {
  const result: { text: string; role: ForegroundRole }[] = [];
  let drop = columns;
  for (const segment of segments) {
    if (drop <= 0) {
      result.push(segment);
      continue;
    }
    let rest = "";
    let dropped = 0;
    for (const { segment: grapheme } of GRAPHEME_SEGMENTER.segment(
      segment.text,
    )) {
      if (dropped < drop) dropped += stringWidth(grapheme);
      else rest += grapheme;
    }
    // A wide grapheme cut in half leaves a column to fill.
    const overshoot = dropped - drop;
    drop = Math.max(0, drop - dropped);
    const text = " ".repeat(Math.max(0, overshoot)) + rest;
    if (text.length > 0) result.push({ text, role: segment.role });
  }
  return result;
}

/**
 * Spans for one row at `width` columns. A selected row in a focused list
 * takes the `selected` color on a `selectedBg` band across the full width,
 * which marks it without the bar; in an unfocused list it keeps its colors
 * and shows the bar, in `muted`.
 */
export function rowSpans(
  row: ListRow,
  palette: RolePalette,
  width: number,
  state: RowPaintState,
): StyledSpan[] {
  const columns = Math.max(0, Math.floor(width));
  let segments = fitSegments(row.segments, columns);
  const highlighted = state.selected && state.focused;
  const showBar = state.selected && !highlighted && state.bar && columns > 0;
  if (showBar) segments = dropColumns(segments, 1);

  const spans: StyledSpan[] = [];
  if (showBar) spans.push({ text: SELECTION_BAR, fg: palette.muted });
  for (const segment of segments)
    spans.push({
      text: segment.text,
      fg: highlighted ? palette.selected : palette[segment.role],
      ...(highlighted ? { bg: palette.selectedBg } : {}),
      ...(BOLD_ROLES.has(segment.role) ? { bold: true } : {}),
    });
  if (highlighted) {
    const used = spans.reduce((sum, span) => sum + stringWidth(span.text), 0);
    if (used < columns)
      spans.push({
        text: " ".repeat(columns - used),
        bg: palette.selectedBg,
      });
  }
  return spans;
}

// ── Navigation ──────────────────────────────────────────────────────────

/** Selected row index (-1 with no selectable row) and the first visible row. */
export interface ListPosition {
  readonly selected: number;
  readonly offset: number;
}

export type ListMove = "up" | "down" | "pageup" | "pagedown" | "home" | "end";

const KEY_MOVES: Readonly<Record<string, ListMove>> = {
  up: "up",
  down: "down",
  pageup: "pageup",
  pagedown: "pagedown",
  home: "home",
  end: "end",
};

/** The list move a key name maps to, if any. */
export function keyMove(name: string): ListMove | undefined {
  return Object.hasOwn(KEY_MOVES, name) ? KEY_MOVES[name] : undefined;
}

function isSelectable(row: ListRow | undefined): boolean {
  return row !== undefined && row.selectable !== false;
}

/**
 * The selectable row nearest `index`, searching in `direction` first and
 * then the other way; -1 when no row is selectable.
 */
export function nearestSelectable(
  rows: readonly ListRow[],
  index: number,
  direction: 1 | -1,
): number {
  const start = Math.min(Math.max(index, 0), rows.length - 1);
  for (let i = start; i >= 0 && i < rows.length; i += direction)
    if (isSelectable(rows[i])) return i;
  for (let i = start - direction; i >= 0 && i < rows.length; i -= direction)
    if (isSelectable(rows[i])) return i;
  return -1;
}

/**
 * Keep `selected` inside the visible window and the window inside the rows.
 * With a selection at the first selectable row, the window starts at 0 so
 * leading non-selectable rows stay visible.
 */
export function revealSelection(
  rows: readonly ListRow[],
  position: ListPosition,
  height: number,
): ListPosition {
  const visible = Math.max(1, Math.floor(height));
  const maxOffset = Math.max(0, rows.length - visible);
  let offset = Math.min(Math.max(position.offset, 0), maxOffset);
  const { selected } = position;
  if (selected >= 0) {
    if (selected === nearestSelectable(rows, 0, 1)) offset = 0;
    else if (selected < offset) offset = selected;
    else if (selected >= offset + visible) offset = selected - visible + 1;
  }
  return { selected, offset: Math.min(offset, maxOffset) };
}

/** Apply one navigation move. Rows the selection cannot hold are skipped. */
export function moveSelection(
  rows: readonly ListRow[],
  position: ListPosition,
  move: ListMove,
  height: number,
): ListPosition {
  const page = Math.max(1, Math.floor(height) - 1);
  const current = position.selected;
  let selected = current;
  if (current < 0) {
    selected = nearestSelectable(rows, 0, 1);
  } else {
    switch (move) {
      case "up": {
        const next = nearestUp(rows, current - 1);
        selected = next < 0 ? current : next;
        break;
      }
      case "down": {
        const next = nearestDown(rows, current + 1);
        selected = next < 0 ? current : next;
        break;
      }
      case "pageup":
        selected = nearestSelectable(rows, current - page, -1);
        break;
      case "pagedown":
        selected = nearestSelectable(rows, current + page, 1);
        break;
      case "home":
        selected = nearestSelectable(rows, 0, 1);
        break;
      case "end":
        selected = nearestSelectable(rows, rows.length - 1, -1);
        break;
    }
  }
  return revealSelection(rows, { selected, offset: position.offset }, height);
}

function nearestUp(rows: readonly ListRow[], from: number): number {
  for (let i = Math.min(from, rows.length - 1); i >= 0; i -= 1)
    if (isSelectable(rows[i])) return i;
  return -1;
}

function nearestDown(rows: readonly ListRow[], from: number): number {
  for (let i = Math.max(from, 0); i < rows.length; i += 1)
    if (isSelectable(rows[i])) return i;
  return -1;
}

// ── Recycled list ───────────────────────────────────────────────────────

export interface RowListOptions {
  /** Prefix for node IDs: the root is `<id>`, row slots `<id>-row-<n>`. */
  readonly id?: string;
  /**
   * Row slots created up front, the most rows the list can ever show.
   * Slots are created once, inside the render callback, and reused; a
   * later `setViewport` can show fewer but never more.
   */
  readonly capacity: number;
  readonly width: number;
  readonly height: number;
  /** Read on every paint, so a theme switch shows on the next repaint. */
  readonly palette: () => RolePalette;
  /** Draw `▌` over the selected row's first column. Defaults to true. */
  readonly selectionBar?: boolean;
  /** Starts focused unless false. */
  readonly focused?: boolean;
  /** Called after the selected row changes, including to none. */
  readonly onSelect?: (row: ListRow | undefined, index: number) => void;
}

export interface RowList {
  readonly root: TuiNode<"box">;
  /** Replace the rows, keeping the selection by key, else near its index. */
  setRows(rows: readonly ListRow[]): void;
  /** Resize in place. `height` is capped at the capacity. */
  setViewport(width: number, height: number): void;
  setFocused(focused: boolean): void;
  /** Select the row with `key`; false when it is absent or not selectable. */
  select(key: string): boolean;
  move(move: ListMove): void;
  /**
   * Apply the move for a key name (`up`, `down`, `pageup`, `pagedown`,
   * `home`, `end`). Returns whether the key is a list key, so the caller
   * can consume it.
   */
  handleKey(name: string): boolean;
  selected(): { readonly row: ListRow; readonly index: number } | undefined;
  position(): ListPosition;
  /** Repaint every visible slot with the current palette. */
  repaint(): void;
}

/**
 * A fixed pool of one-line `<text>` slots showing a window of rows. Each
 * slot's content is one StyledText built from the row's role-tagged
 * segments, so the node count never depends on the row count.
 *
 * Must be created inside a dialog render callback, and needs a renderer
 * loaded with a StyleBridge (`loadTuiRenderer`). Every other method only
 * mutates existing nodes and works anywhere.
 */
export function createRowList(
  renderer: TuiRenderer,
  options: RowListOptions,
): RowList {
  if (!renderer.styled) throw new Error("the row list needs styled text");
  const capacity = Math.max(1, Math.floor(options.capacity));
  const bar = options.selectionBar ?? true;
  const id = options.id ?? "row-list";
  let width = Math.max(0, Math.floor(options.width));
  let height = clampHeight(options.height);
  let focused = options.focused ?? true;
  let rows: readonly ListRow[] = [];
  let position: ListPosition = { selected: -1, offset: 0 };

  function clampHeight(value: number): number {
    return Math.min(capacity, Math.max(1, Math.floor(value)));
  }

  const slots: TuiNode<"text">[] = [];
  for (let index = 0; index < capacity; index += 1)
    slots.push(
      renderer.create("text", {
        id: `${id}-row-${index}`,
        height: 1,
        flexShrink: 0,
        wrapMode: "none",
        content: "",
        visible: index < height,
      }),
    );
  const root = renderer.create(
    "box",
    {
      id,
      flexDirection: "column",
      flexShrink: 0,
      width,
      height,
      overflow: "hidden",
    },
    ...slots,
  );

  const paint = (): void => {
    const palette = options.palette();
    for (let slot = 0; slot < capacity; slot += 1) {
      const node = slots[slot];
      if (!node || slot >= height) continue;
      const index = position.offset + slot;
      const row = rows[index];
      renderer.setStyledText(
        node,
        row
          ? rowSpans(row, palette, width, {
              selected: index === position.selected,
              focused,
              bar,
            })
          : [],
      );
    }
  };

  const update = (next: ListPosition): void => {
    const previous = position.selected;
    position = next;
    paint();
    if (previous !== position.selected)
      options.onSelect?.(rows[position.selected], position.selected);
  };

  const list: RowList = {
    root,
    setRows(next) {
      const previousKey = rows[position.selected]?.key;
      const previousIndex = position.selected;
      const keptIndex =
        previousKey === undefined
          ? -1
          : next.findIndex((row) => row.key === previousKey);
      rows = next;
      const selected =
        keptIndex >= 0 && isSelectable(next[keptIndex])
          ? keptIndex
          : nearestSelectable(next, Math.max(previousIndex, 0), 1);
      position = revealSelection(
        next,
        { selected, offset: position.offset },
        height,
      );
      paint();
      const row = next[position.selected];
      if (row?.key !== previousKey || position.selected !== previousIndex)
        options.onSelect?.(row, position.selected);
    },
    setViewport(nextWidth, nextHeight) {
      const previousHeight = height;
      width = Math.max(0, Math.floor(nextWidth));
      height = clampHeight(nextHeight);
      renderer.set(root, "width", width);
      renderer.set(root, "height", height);
      if (height !== previousHeight)
        for (const [slot, node] of slots.entries())
          renderer.set(node, "visible", slot < height);
      position = revealSelection(rows, position, height);
      paint();
    },
    setFocused(next) {
      if (focused === next) return;
      focused = next;
      paint();
    },
    select(key) {
      const index = rows.findIndex((row) => row.key === key);
      if (index < 0 || !isSelectable(rows[index])) return false;
      update(revealSelection(rows, { ...position, selected: index }, height));
      return true;
    },
    move(move) {
      update(moveSelection(rows, position, move, height));
    },
    handleKey(name) {
      const move = keyMove(name);
      if (!move) return false;
      list.move(move);
      return true;
    },
    selected() {
      const row = rows[position.selected];
      return row ? { row, index: position.selected } : undefined;
    },
    position: () => position,
    repaint: paint,
  };
  return list;
}
