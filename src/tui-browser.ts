import type { KeyEvent, KeyHandler } from "@opentui/core";
import type {
  CatalogPayload,
  CatalogProviderRecord,
  ScalarEvidence,
} from "./catalog-evidence";
import { displayOrigin, formatContextCell, PRICE_CELL_WIDTH } from "./format";
import {
  capabilityCell,
  helpLayout,
  helpLines,
  modelDetailLines,
  modelEvidenceLines,
  modelSummaryLine,
  needsAttention,
  paragraph,
  wrapText,
  priceCell,
  providerDetailLines,
  providerEvidenceLines,
  providerStatus,
  type HelpEntry,
  type Line,
} from "./tui-detail";
import {
  routeKey,
  type BrowserAction,
  type BrowserFocus,
  type BrowserScreen,
} from "./tui-keys";
import {
  createRowList,
  padText,
  rowSpans,
  sanitizeInline,
  sliceColumns,
  textWidth,
  type ListMove,
  type ListRow,
  type RowList,
  type Segment,
} from "./tui-list";
import {
  modelCertainty,
  type ModelRow,
  type ProviderGroup,
} from "./tui-models";
import type { TuiNode, TuiRenderer } from "./tui-renderer";
import type { ForegroundRole, RolePalette } from "./tui-theme";

// ── Navigation state ────────────────────────────────────────────────────

/** Every provider, or one provider listed without a group header. */
export type BrowserScope =
  | { readonly kind: "all" }
  | { readonly kind: "provider"; readonly providerID: string };

export const ALL_PROVIDERS: BrowserScope = { kind: "all" };

export type TypeFilter = "chat" | "embedding" | "all";

export interface BrowserFilters {
  /** `all`, or one provider ID. */
  provider: string;
  type: TypeFilter;
  tools: boolean;
  images: boolean;
  reasoning: boolean;
  priced: boolean;
  /** Let assumed and inferred capabilities satisfy the needs filters. */
  uncertain: boolean;
}

export type BrowserSort = "name" | "context" | "input" | "output";

export interface SelectedItem {
  providerID: string;
  /** Absent when a provider header is selected. */
  modelID?: string;
}

/** What the browser keeps across opens, per location and command. */
export interface NavState {
  query: string;
  filters: BrowserFilters;
  sort: BrowserSort;
  /** Provider IDs whose groups are collapsed. */
  collapsed: string[];
  selected?: SelectedItem;
}

export const DEFAULT_FILTERS: BrowserFilters = {
  provider: "all",
  type: "chat",
  tools: false,
  images: false,
  reasoning: false,
  priced: false,
  uncertain: false,
};

export const DEFAULT_NAV: NavState = {
  query: "",
  filters: DEFAULT_FILTERS,
  sort: "name",
  collapsed: [],
};

const SORTS: readonly BrowserSort[] = ["name", "context", "input", "output"];
const SORT_NAMES: Readonly<Record<BrowserSort, string>> = {
  name: "name",
  context: "context",
  input: "input price",
  output: "output price",
};

export function nextSort(sort: BrowserSort): BrowserSort {
  return SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length] ?? "name";
}

function filtersAtDefault(filters: BrowserFilters): boolean {
  return (Object.keys(DEFAULT_FILTERS) as (keyof BrowserFilters)[]).every(
    (key) => filters[key] === DEFAULT_FILTERS[key],
  );
}

/** Whether `x` would change anything. */
export function hasNarrowing(nav: NavState): boolean {
  return nav.query.trim().length > 0 || !filtersAtDefault(nav.filters);
}

// ── Data ────────────────────────────────────────────────────────────────

export type BrowserDataStatus = "loading" | "ready" | "failed";

/** Everything the browser shows, as one immutable snapshot. */
export interface BrowserData {
  readonly status: BrowserDataStatus;
  readonly groups: readonly ProviderGroup[];
  /** The validated RPC catalog, or undefined when scout's server half did not answer. */
  readonly catalog?: CatalogPayload;
  /** `Date.now()` when `catalog` arrived, for countdowns against `generatedAt`. */
  readonly catalogReceivedAt?: number;
  /** Why the catalog is missing, when it is. */
  readonly serverNotice?: string;
  /** `providerID/modelID` of every model OpenCode lists. */
  readonly hostListed: ReadonlySet<string>;
  /** The host list error, with status `failed`. */
  readonly error?: string;
}

export const LOADING_DATA: BrowserData = {
  status: "loading",
  groups: [],
  hostListed: new Set(),
};

export function qualifiedID(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

export function findRecord(
  data: BrowserData,
  providerID: string,
): CatalogProviderRecord | undefined {
  return data.catalog?.providers.find((record) => record.id === providerID);
}

/**
 * Seconds until `record` may refresh, measured on the server clock: the
 * time from the payload's `generatedAt` to `nextRefreshAt`, less the time
 * since the payload arrived.
 */
export function refreshWaitSeconds(
  record: CatalogProviderRecord | undefined,
  data: BrowserData,
  now: number,
): number | undefined {
  if (!record?.nextRefreshAt || !data.catalog) return undefined;
  const remaining =
    Date.parse(record.nextRefreshAt) -
    Date.parse(data.catalog.generatedAt) -
    (now - (data.catalogReceivedAt ?? now));
  if (!Number.isFinite(remaining) || remaining <= 0) return undefined;
  return Math.ceil(remaining / 1000);
}

// ── Filtering and sorting ───────────────────────────────────────────────

function queryTerms(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function searchText(group: ProviderGroup, model: ModelRow): string {
  return [
    model.name,
    model.id,
    group.provider,
    group.id,
    model.family,
    model.quantization,
  ]
    .filter((field): field is string => Boolean(field))
    .join("\n")
    .toLocaleLowerCase();
}

/** Case-insensitive AND of whitespace-separated terms over the model's and provider's names and IDs, family, and quantization. */
export function matchesQuery(
  group: ProviderGroup,
  model: ModelRow,
  query: string,
): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const text = searchText(group, model);
  return terms.every((term) => text.includes(term));
}

function satisfies(
  model: ModelRow,
  name: "tools" | "image" | "reasoning",
  uncertain: boolean,
): boolean {
  const certainty = modelCertainty(model).capabilities[name];
  return (
    certainty === "confirmed" ||
    (uncertain && (certainty === "assumed" || certainty === "inferred"))
  );
}

function knownPrice(
  evidence: ScalarEvidence<number> | undefined,
): number | undefined {
  return evidence?.state === "known" ? evidence.value : undefined;
}

function priced(model: ModelRow): boolean {
  return (
    knownPrice(model.cost?.input) !== undefined ||
    knownPrice(model.cost?.output) !== undefined
  );
}

/** Every filter except the type filter. */
function matchesNeeds(model: ModelRow, filters: BrowserFilters): boolean {
  if (filters.tools && !satisfies(model, "tools", filters.uncertain))
    return false;
  if (filters.images && !satisfies(model, "image", filters.uncertain))
    return false;
  if (filters.reasoning && !satisfies(model, "reasoning", filters.uncertain))
    return false;
  return !filters.priced || priced(model);
}

function matchesType(model: ModelRow, type: TypeFilter): boolean {
  const embedding = model.type === "embedding";
  return type === "all" || (type === "embedding" ? embedding : !embedding);
}

function sortValue(model: ModelRow, sort: BrowserSort): number | undefined {
  switch (sort) {
    case "name":
      return undefined;
    case "context": {
      const certainty = modelCertainty(model).context;
      return certainty === "confirmed" || certainty === "inferred"
        ? model.context
        : undefined;
    }
    case "input":
      return knownPrice(model.cost?.input);
    case "output":
      return knownPrice(model.cost?.output);
  }
}

/** Order models by `sort`; unknown values sort last, ties by name then ID. */
export function sortModels(
  models: readonly ModelRow[],
  sort: BrowserSort,
): ModelRow[] {
  const byName = (a: ModelRow, b: ModelRow): number =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  return [...models].sort((a, b) => {
    if (sort === "name") return byName(a, b);
    const left = sortValue(a, sort);
    const right = sortValue(b, sort);
    if (left === undefined && right === undefined) return byName(a, b);
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    const order = sort === "context" ? right - left : left - right;
    return order || byName(a, b);
  });
}

// ── Projection ──────────────────────────────────────────────────────────

export type BrowserRowKind = "provider" | "model" | "note";

export interface BrowserRow extends ListRow {
  readonly kind: BrowserRowKind;
  readonly group: ProviderGroup;
  readonly model?: ModelRow;
}

export interface BrowserProjection {
  readonly rows: readonly BrowserRow[];
  readonly providerCount: number;
  readonly totalModels: number;
  readonly visibleModels: number;
  readonly attention: number;
  readonly discovering: number;
  readonly embeddingsHidden: number;
}

export interface ProjectionOptions {
  readonly scope: BrowserScope;
  /** Columns of each list row. */
  readonly width: number;
  readonly current?: { readonly providerID: string; readonly modelID: string };
}

export function providerKey(providerID: string): string {
  return `p\u0000${providerID}`;
}

export function modelKey(providerID: string, modelID: string): string {
  return `m\u0000${providerID}\u0000${modelID}`;
}

export function selectionKey(
  selected: SelectedItem | undefined,
): string | undefined {
  if (!selected) return undefined;
  return selected.modelID === undefined
    ? providerKey(selected.providerID)
    : modelKey(selected.providerID, selected.modelID);
}

const GUTTER = 3;
const CONTEXT_COLUMNS = 6;
const CAPABILITY_COLUMNS = 5;
const GAP = "  ";
const FIXED_MODEL_COLUMNS =
  GUTTER +
  CONTEXT_COLUMNS +
  GAP.length +
  CAPABILITY_COLUMNS +
  GAP.length +
  PRICE_CELL_WIDTH;

function segmentsWidth(segments: readonly Segment[]): number {
  return segments.reduce(
    (sum, segment) => sum + textWidth(sanitizeInline(segment.text)),
    0,
  );
}

/**
 * A model row: gutter (column 1 for the selection bar, column 2 for the
 * current-model `●`), name, context, `T I R`, and the price cell.
 */
export function modelRowSegments(
  model: ModelRow,
  width: number,
  current: boolean,
): Segment[] {
  const nameColumns = Math.max(4, width - FIXED_MODEL_COLUMNS);
  const certainty = modelCertainty(model);
  const assumedContext = certainty.context === "assumed";
  const context =
    model.context === undefined || certainty.context === "not-reported"
      ? ""
      : formatContextCell(model.context, assumedContext);
  const embedding = model.type === "embedding";
  const caps = certainty.capabilities;
  return [
    { text: " ", role: "base" },
    { text: current ? "●" : " ", role: "current" },
    { text: " ", role: "base" },
    {
      text: padText(model.name, nameColumns),
      role: embedding || !model.enabled ? "muted" : "base",
    },
    {
      text: padText(context, CONTEXT_COLUMNS, "right"),
      role: assumedContext ? "faint" : "muted",
    },
    { text: GAP, role: "base" },
    capabilityCell(embedding ? "not-reported" : caps.tools, "t"),
    { text: " ", role: "base" },
    capabilityCell(embedding ? "not-reported" : caps.image, "i"),
    { text: " ", role: "base" },
    capabilityCell(embedding ? "not-reported" : caps.reasoning, "r"),
    { text: GAP, role: "base" },
    {
      text: padText(priceCell(model), PRICE_CELL_WIDTH, "right"),
      role: "muted",
    },
  ];
}

/** Status glyphs whose color carries the state. */
const STATUS_GLYPHS = new Set(["●", "○", "▲"]);

/**
 * A status label as segments: a leading status glyph takes the state's
 * color and the words stay in base, which reads on every theme.
 */
export function glyphSegments(label: {
  readonly text: string;
  readonly role: ForegroundRole;
}): Segment[] {
  const glyph = label.text.slice(0, 1);
  if (!STATUS_GLYPHS.has(glyph) || label.text[1] !== " ")
    return [{ text: label.text, role: label.role }];
  return [
    { text: glyph, role: label.role },
    { text: label.text.slice(1), role: "base" },
  ];
}

/** A provider header: `▾`/`▸`, the name, and count and status at the right edge. */
export function providerRowSegments(
  group: ProviderGroup,
  record: CatalogProviderRecord | undefined,
  counts: { visible: number; total: number },
  collapsed: boolean,
  width: number,
): Segment[] {
  const count =
    counts.visible === counts.total
      ? `${counts.total} ${counts.total === 1 ? "model" : "models"}`
      : `${counts.visible}/${counts.total} models`;
  const status = providerStatus(record);
  const right: Segment[] = [
    { text: count, role: "muted" },
    ...(status
      ? [{ text: GAP, role: "base" as const }, ...glyphSegments(status)]
      : []),
  ];
  // The last column matches the price cell's tier column, so the status
  // ends where the price digits do.
  const nameColumns = Math.max(4, width - GUTTER - 2 - segmentsWidth(right));
  return [
    { text: " ", role: "base" },
    { text: collapsed ? "▸" : "▾", role: "muted" },
    { text: " ", role: "base" },
    { text: padText(group.provider, nameColumns), role: "group" },
    { text: " ", role: "base" },
    ...right,
    { text: " ", role: "base" },
  ];
}

function noteText(
  group: ProviderGroup,
  record: CatalogProviderRecord | undefined,
  hidden: number,
): string {
  if (hidden > 0)
    return `${hidden} embedding ${hidden === 1 ? "model" : "models"} hidden; f shows them`;
  if (record?.discovering) return "Checking the model list…";
  if (record?.failure && !record.lastGoodAt)
    return "No models yet; the model list failed";
  if (record?.lastGoodAt) return "No models returned; r refreshes";
  return group.hasEvidence ? "No models yet" : "No models listed";
}

/** Rows for the list screen: provider headers, their models, and notes for empty providers. */
export function projectBrowser(
  data: BrowserData,
  nav: NavState,
  options: ProjectionOptions,
): BrowserProjection {
  const { scope, width, current } = options;
  const single = scope.kind === "provider";
  const groups = data.groups.filter((group) =>
    single
      ? group.id === scope.providerID
      : nav.filters.provider === "all" || group.id === nav.filters.provider,
  );
  const narrowing =
    queryTerms(nav.query).length > 0 ||
    !filtersAtDefault({ ...nav.filters, provider: "all" });
  const rows: BrowserRow[] = [];
  let totalModels = 0;
  let visibleModels = 0;
  let attention = 0;
  let discovering = 0;
  let embeddingsHidden = 0;

  for (const group of groups) {
    const record = findRecord(data, group.id);
    if (needsAttention(record)) attention += 1;
    if (record?.discovering) discovering += 1;
    // Counts leave out models the type filter hides; the filter row counts hidden embeddings.
    const typed = group.models.filter((model) =>
      matchesType(model, nav.filters.type),
    ).length;
    totalModels += typed;
    const searched = group.models.filter(
      (model) =>
        matchesQuery(group, model, nav.query) &&
        matchesNeeds(model, nav.filters),
    );
    const matching = searched.filter((model) =>
      matchesType(model, nav.filters.type),
    );
    const hidden =
      nav.filters.type === "chat" ? searched.length - matching.length : 0;
    embeddingsHidden += hidden;
    visibleModels += matching.length;
    const explicit = !single && nav.filters.provider === group.id;
    if (matching.length === 0 && narrowing && !explicit) continue;

    const collapsed =
      !single &&
      queryTerms(nav.query).length === 0 &&
      nav.collapsed.includes(group.id);
    if (!single)
      rows.push({
        key: providerKey(group.id),
        kind: "provider",
        group,
        segments: providerRowSegments(
          group,
          record,
          { visible: matching.length, total: typed },
          collapsed,
          width,
        ),
      });
    if (collapsed) continue;
    for (const model of sortModels(matching, nav.sort)) {
      const isCurrent =
        current?.providerID === group.id && current.modelID === model.id;
      rows.push({
        key: modelKey(group.id, model.id),
        kind: "model",
        group,
        model,
        segments: modelRowSegments(model, width, isCurrent),
      });
    }
    if (matching.length === 0 && !single)
      rows.push({
        key: `n\u0000${group.id}`,
        kind: "note",
        group,
        selectable: false,
        segments: [
          { text: `   ${noteText(group, record, hidden)}`, role: "faint" },
        ],
      });
  }
  return {
    rows,
    providerCount: groups.length,
    totalModels,
    visibleModels,
    attention,
    discovering,
    embeddingsHidden,
  };
}

/**
 * The row the first open selects: the prompt's current model when listed,
 * else the first chat model, else the first selectable row.
 */
export function initialSelection(
  rows: readonly BrowserRow[],
  current:
    | { readonly providerID: string; readonly modelID: string }
    | undefined,
): BrowserRow | undefined {
  if (current) {
    const key = modelKey(current.providerID, current.modelID);
    const found = rows.find((row) => row.key === key);
    if (found) return found;
  }
  return (
    rows.find(
      (row) => row.kind === "model" && row.model?.type !== "embedding",
    ) ?? rows.find((row) => row.selectable !== false)
  );
}

// ── Filter screen ───────────────────────────────────────────────────────

export type FilterField =
  | "provider"
  | "type"
  | "tools"
  | "images"
  | "reasoning"
  | "priced"
  | "uncertain";

const FILTER_LABELS: Readonly<Record<FilterField, string>> = {
  provider: "Provider",
  type: "Type",
  tools: "Needs tools",
  images: "Needs images",
  reasoning: "Needs reasoning",
  priced: "Priced only",
  uncertain: "Include assumed or inferred",
};

const TYPE_CYCLE: readonly TypeFilter[] = ["chat", "embedding", "all"];
const TYPE_WORDS: Readonly<Record<TypeFilter, string>> = {
  chat: "chat",
  embedding: "embedding",
  all: "all types",
};

export function filterFields(scope: BrowserScope): FilterField[] {
  const fields: FilterField[] = [
    "type",
    "tools",
    "images",
    "reasoning",
    "priced",
    "uncertain",
  ];
  return scope.kind === "all" ? ["provider", ...fields] : fields;
}

/** Step one filter field forward or back; booleans toggle. */
export function cycleFilter(
  filters: BrowserFilters,
  field: FilterField,
  direction: 1 | -1,
  providerIDs: readonly string[],
): BrowserFilters {
  const step = <T>(values: readonly T[], current: T): T => {
    const index = values.indexOf(current);
    return (
      values[(index + direction + values.length) % values.length] ??
      values[0] ??
      current
    );
  };
  switch (field) {
    case "provider":
      return {
        ...filters,
        provider: step(["all", ...providerIDs], filters.provider),
      };
    case "type":
      return { ...filters, type: step(TYPE_CYCLE, filters.type) };
    default:
      return { ...filters, [field]: !filters[field] };
  }
}

function filterValue(
  filters: BrowserFilters,
  field: FilterField,
  groups: readonly ProviderGroup[],
): string {
  switch (field) {
    case "provider":
      return filters.provider === "all"
        ? "All providers"
        : (groups.find((group) => group.id === filters.provider)?.provider ??
            filters.provider);
    case "type":
      return filters.type === "all"
        ? "All types"
        : filters.type === "chat"
          ? "Chat"
          : "Embedding";
    default:
      return filters[field] ? "Yes" : "No";
  }
}

/** The one-line filter summary: `chat · all providers · 1 embedding hidden`. */
export function filterSummary(
  nav: NavState,
  scope: BrowserScope,
  groups: readonly ProviderGroup[],
  embeddingsHidden: number,
): string {
  const filters = nav.filters;
  const parts: string[] = [TYPE_WORDS[filters.type]];
  if (scope.kind === "all")
    parts.push(
      filters.provider === "all"
        ? "all providers"
        : (groups.find((group) => group.id === filters.provider)?.provider ??
            filters.provider),
    );
  if (filters.tools) parts.push("tools");
  if (filters.images) parts.push("images");
  if (filters.reasoning) parts.push("reasoning");
  if (filters.priced) parts.push("priced");
  if (filters.uncertain) parts.push("incl. assumed");
  if (embeddingsHidden > 0)
    parts.push(
      `${embeddingsHidden} ${embeddingsHidden === 1 ? "embedding" : "embeddings"} hidden`,
    );
  return parts.join(" · ");
}

// ── Footer ──────────────────────────────────────────────────────────────

export interface FooterHint {
  readonly title: string;
  readonly key: string;
  readonly enabled?: boolean;
}

function hintSegments(hint: FooterHint): Segment[] {
  const enabled = hint.enabled !== false;
  return [
    { text: hint.title, role: enabled ? "base" : "disabled" },
    { text: " ", role: "base" },
    { text: hint.key, role: enabled ? "key" : "disabled" },
  ];
}

/**
 * Hints in the host's footer style. Optional hints drop from the right as
 * the width shrinks; `keys ?` and `close esc` always remain.
 */
export function footerSegments(
  hints: readonly FooterHint[],
  width: number,
  keysHint = true,
): Segment[] {
  const close = hintSegments({ title: "close", key: "esc" });
  const all: FooterHint[] = keysHint
    ? [...hints, { title: "keys", key: "?" }]
    : [...hints];
  const shown = footerShown(hints, width, keysHint);
  const left: Segment[] = [];
  for (const [index, hint] of all.entries()) {
    if (index < hints.length && !shown.has(index)) continue;
    if (left.length > 0) left.push({ text: GAP, role: "base" });
    left.push(...hintSegments(hint));
  }
  return justify(left, close, width);
}

/**
 * Indexes of `hints` the footer shows at `width` columns, beside "keys ?"
 * (unless `keysHint` is false) and "close esc".
 */
export function footerShown(
  hints: readonly FooterHint[],
  width: number,
  keysHint = true,
): Set<number> {
  const close = hintSegments({ title: "close", key: "esc" });
  const widths = hints.map((hint) => segmentsWidth(hintSegments(hint)));
  if (keysHint)
    widths.push(segmentsWidth(hintSegments({ title: "keys", key: "?" })));
  const fitted = fitFooterHints(
    widths,
    width - segmentsWidth(close) - FOOTER_CLOSE_GAP,
    keysHint ? widths.length - 1 : undefined,
  );
  return new Set([...fitted].filter((index) => index < hints.length));
}

/** Fewest columns between the last hint and "close esc". */
const FOOTER_CLOSE_GAP = 4;

/**
 * Which hints fit in `budget` columns, by index. Hints count in list order,
 * earlier first; one that does not fit is skipped and later, shorter ones
 * still get a chance, so the order on screen never changes. `required` is
 * always kept. Hints are separated by two columns.
 */
export function fitFooterHints(
  widths: readonly number[],
  budget: number,
  required?: number,
): Set<number> {
  const shown = new Set<number>();
  const gap = GAP.length;
  let used = required !== undefined ? (widths[required] ?? 0) : 0;
  if (required !== undefined) shown.add(required);
  for (const [index, columns] of widths.entries()) {
    if (index === required) continue;
    const next = used + (shown.size > 0 ? gap : 0) + columns;
    if (next > budget) continue;
    shown.add(index);
    used = next;
  }
  return shown;
}

/** `left` at the start and `right` at the end of `width` columns; `left` is cut when both do not fit. */
export function justify(
  left: readonly Segment[],
  right: readonly Segment[],
  width: number,
): Segment[] {
  const rightWidth = segmentsWidth(right);
  const room = Math.max(0, width - rightWidth - (right.length > 0 ? 1 : 0));
  const fitted: Segment[] = [];
  let used = 0;
  for (const segment of left) {
    const columns = textWidth(sanitizeInline(segment.text));
    if (used + columns <= room) {
      fitted.push(segment);
      used += columns;
      continue;
    }
    if (room - used > 1)
      fitted.push({
        text: padText(segment.text, room - used),
        role: segment.role,
      });
    used = room;
    break;
  }
  const fill = Math.max(right.length > 0 ? 1 : 0, width - used - rightWidth);
  return [...fitted, { text: " ".repeat(fill), role: "base" }, ...right];
}

// ── Layout ──────────────────────────────────────────────────────────────

/** Wide layout: list 58, separator 3, detail 49. */
export const WIDE_MIN_COLUMNS = 120;
const WIDE_LIST_COLUMNS = 58;
const SEPARATOR_COLUMNS = 3;
const DIALOG_MAX_COLUMNS = 116;
const SIDE_PADDING = 3;
const MAX_CONTENT_ROWS = 30;
/** Header, search, filter, and notice rows, the footer, and the bottom padding. */
const CHROME_ROWS = 6;
/** Row slots of every list and pane; the most body rows the dialog can show. */
const BODY_CAPACITY = MAX_CONTENT_ROWS;
/** Most rows a frame's banner above the list takes. */
const BANNER_CAPACITY = 8;
/** Fewest list rows a banner leaves. */
const MIN_LIST_ROWS = 4;

export interface BrowserLayout {
  readonly wide: boolean;
  /** Content columns inside the side padding. */
  readonly width: number;
  /**
   * The root's width. OpenTUI sizes a box with its padding included, so
   * this is `width` plus both side paddings: the dialog's width.
   */
  readonly outerWidth: number;
  /** Content rows, including the bottom padding row; also the root's height. */
  readonly height: number;
  readonly bodyHeight: number;
  readonly listWidth: number;
  readonly paneWidth: number;
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** The row the host's dialog panel adds above the content. */
const HOST_TOP_ROWS = 1;

/**
 * Dialog width `min(116, cols - 2)` with side padding 3. Content height
 * `min(30, rows - 5)`: with the row the host adds above it, the dialog
 * takes at most `rows - 4` rows, so the centered panel leaves rows free
 * above and below. A preview of the selected row sits beside the list from
 * 120 columns.
 */
export function browserLayout(columns: number, rows: number): BrowserLayout {
  const cols = finitePositive(columns, 80);
  const lines = finitePositive(rows, 24);
  const width = Math.max(
    20,
    Math.min(DIALOG_MAX_COLUMNS, cols - 2) - SIDE_PADDING * 2,
  );
  const height = Math.max(
    CHROME_ROWS + 2,
    Math.min(MAX_CONTENT_ROWS, lines - 4 - HOST_TOP_ROWS),
  );
  const wide = cols >= WIDE_MIN_COLUMNS;
  const listWidth = wide ? WIDE_LIST_COLUMNS : width;
  return {
    wide,
    width,
    outerWidth: width + SIDE_PADDING * 2,
    height,
    bodyHeight: Math.min(BODY_CAPACITY, height - CHROME_ROWS),
    listWidth,
    paneWidth: wide
      ? Math.max(1, width - listWidth - SEPARATOR_COLUMNS)
      : width,
  };
}

/**
 * Columns of a list row's content. The selection band spans the whole list
 * width, so the last column is padding inside the band.
 */
export function rowColumns(layout: BrowserLayout): number {
  return Math.max(1, layout.listWidth - 1);
}

// ── Text pane ───────────────────────────────────────────────────────────

/**
 * How a pane's lines group: `pinned` heading lines that never scroll, then
 * blocks of `blocks[i]` lines each, which scroll and show only whole.
 * Without a layout every line is its own block.
 */
export interface PaneLayout {
  readonly pinned: number;
  readonly blocks: readonly number[];
}

interface TextPane {
  readonly root: TuiNode<"box">;
  /**
   * `highlight` lists lines painted as selected; the pane scrolls to show
   * the first. `layout` groups the lines into blocks.
   */
  setLines(
    lines: readonly Line[],
    keepOffset?: boolean,
    highlight?: readonly number[],
    layout?: PaneLayout,
  ): void;
  setViewport(width: number, height: number): void;
  /**
   * A key the bottom `↓ N more` line names after a `·`, for a pane that
   * cannot scroll itself; undefined for none. Shows from the next paint.
   */
  setMoreKey(key: string | undefined): void;
  scroll(move: ListMove): void;
  /** Whether lines are hidden above or below. */
  overflows(): boolean;
  repaint(): void;
}

/**
 * A scrolling stack of one-line text slots. The row list's window follows
 * its selection, and detail text has no selection, so the pane keeps its
 * own offset.
 */
function createTextPane(
  renderer: TuiRenderer,
  id: string,
  capacity: number,
  initial: { width: number; height: number },
  palette: () => RolePalette,
): TextPane {
  let width = initial.width;
  let height = Math.min(capacity, initial.height);
  let lines: readonly Line[] = [];
  let highlighted: ReadonlySet<number> = new Set();
  let offset = 0;
  const slots: TuiNode<"text">[] = [];
  for (let index = 0; index < capacity; index += 1)
    slots.push(
      renderer.create("text", {
        id: `${id}-line-${index}`,
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
  let pinned = 0;
  /** Lines per block after the pinned lines. */
  let blocks: readonly number[] = [];
  let moreKey: string | undefined;
  const shown = (): EntryWindow => entryWindow(blocks, height - pinned, offset);
  const indicator = (arrow: string, count: number, key?: string): Line => [
    {
      text: `${arrow} ${count > 0 ? `${count} ` : ""}more${key ? ` · ${key}` : ""}`,
      role: "muted",
    },
  ];
  /** What each slot shows: a line and its index, or an indicator (index -1). */
  const layoutSlots = (view: EntryWindow): { line?: Line; index: number }[] => {
    const shownSlots: { line?: Line; index: number }[] = [];
    for (let index = 0; index < Math.min(pinned, height); index += 1)
      shownSlots.push({ line: lines[index], index });
    if (view.top)
      shownSlots.push({ line: indicator("↑", view.above), index: -1 });
    const { units } = scrollUnits(blocks, height - pinned);
    let first = pinned;
    for (let unit = 0; unit < view.offset; unit += 1) first += units[unit] ?? 0;
    for (let index = first; index < first + view.rows; index += 1)
      shownSlots.push({ line: lines[index], index });
    if (view.bottom) {
      while (shownSlots.length < height - 1) shownSlots.push({ index: -1 });
      shownSlots.push({
        line: indicator("↓", view.below, moreKey),
        index: -1,
      });
    }
    return shownSlots;
  };
  const paint = (): void => {
    const colors = palette();
    const view = shown();
    offset = view.offset;
    const shownSlots = layoutSlots(view);
    for (const [slot, node] of slots.entries()) {
      if (slot >= height) continue;
      const { line, index } = shownSlots[slot] ?? { index: -1 };
      const selected = highlighted.has(index);
      renderer.setStyledText(
        node,
        line
          ? rowSpans({ key: "", segments: line }, colors, width, {
              selected,
              focused: selected,
              bar: selected,
            })
          : [],
      );
    }
  };
  return {
    root,
    setLines(next, keepOffset = false, highlight = [], layout) {
      lines = next;
      highlighted = new Set(highlight);
      const sum = (layout?.blocks ?? []).reduce(
        (total, size) => total + size,
        0,
      );
      // A layout that does not cover the lines falls back to one block per line.
      if (layout && layout.pinned + sum === next.length) {
        pinned = layout.pinned;
        blocks = layout.blocks;
      } else {
        pinned = 0;
        blocks = next.map(() => 1);
      }
      offset = keepOffset ? shown().offset : 0;
      const first = highlight[0];
      if (first !== undefined && pinned === 0)
        offset = revealLines(
          lines.length,
          height,
          offset,
          first,
          highlight[highlight.length - 1] ?? first,
        );
      paint();
    },
    setViewport(nextWidth, nextHeight) {
      width = Math.max(1, nextWidth);
      const previous = height;
      height = Math.min(capacity, Math.max(1, nextHeight));
      renderer.set(root, "width", width);
      renderer.set(root, "height", height);
      if (previous !== height)
        for (const [slot, node] of slots.entries())
          renderer.set(node, "visible", slot < height);
      paint();
    },
    setMoreKey(key) {
      moreKey = key;
    },
    scroll(move) {
      offset = scrollEntries(blocks, height - pinned, offset, move);
      paint();
    },
    overflows() {
      const view = shown();
      return view.top || view.bottom;
    },
    repaint: paint,
  };
}

/**
 * The units a pane scrolls by: one per entry, except that an entry taller
 * than the room between the two indicators (`height - 2` rows) is one unit
 * per line, so every line of it stays reachable. `entryOf` maps each unit
 * to its entry.
 */
export function scrollUnits(
  sizes: readonly number[],
  height: number,
): { units: number[]; entryOf: number[] } {
  const limit = Math.max(1, Math.floor(height) - 2);
  const units: number[] = [];
  const entryOf: number[] = [];
  for (const [entry, size] of sizes.entries()) {
    if (size > limit)
      for (let line = 0; line < size; line += 1) {
        units.push(1);
        entryOf.push(entry);
      }
    else {
      units.push(size);
      entryOf.push(entry);
    }
  }
  return { units, entryOf };
}

/**
 * `blockWindow` over `scrollUnits`, with the hidden counts in entries: an
 * entry partly in view is not counted. `top` and `bottom` say whether the
 * indicator rows show; they show without a count while only part of the
 * entry in view is hidden.
 */
export interface EntryWindow extends PaneWindow {
  readonly top: boolean;
  readonly bottom: boolean;
}

export function entryWindow(
  sizes: readonly number[],
  height: number,
  offset: number,
): EntryWindow {
  const { units, entryOf } = scrollUnits(sizes, height);
  const view = blockWindow(units, height, offset);
  const top = view.offset > 0;
  const bottom = view.below > 0;
  if (!top && !bottom) return { ...view, top, bottom };
  const count = units.length - view.offset - view.below;
  const firstEntry = entryOf[view.offset] ?? 0;
  const lastEntry = entryOf[view.offset + count - 1] ?? firstEntry;
  return {
    ...view,
    above: firstEntry,
    below: Math.max(0, sizes.length - 1 - lastEntry),
    top,
    bottom,
  };
}

/** The unit offset after one scroll move over `scrollUnits`. */
export function scrollEntries(
  sizes: readonly number[],
  height: number,
  offset: number,
  move: ListMove,
): number {
  return scrollBlocks(scrollUnits(sizes, height).units, height, offset, move);
}

/**
 * What a text pane of `height` rows shows from block `offset`: the first
 * block shown, how many lines of whole blocks fit (all rows when nothing
 * is hidden), and how many blocks are hidden above and below. While blocks
 * are hidden, a row at the top or the bottom gives way to an "↑ N more" or
 * "↓ N more" line. A block taller than the room left shows cut, alone.
 */
export interface PaneWindow {
  readonly offset: number;
  readonly rows: number;
  readonly above: number;
  readonly below: number;
}

export function blockWindow(
  sizes: readonly number[],
  height: number,
  offset: number,
): PaneWindow {
  const rows = Math.max(1, Math.floor(height));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= rows) return { offset: 0, rows, above: 0, below: 0 };
  const fit = (
    start: number,
    room: number,
  ): { count: number; lines: number } => {
    let lines = 0;
    let count = 0;
    for (let block = start; block < sizes.length; block += 1) {
      const size = sizes[block] ?? 0;
      if (lines + size > room) break;
      lines += size;
      count += 1;
    }
    return { count, lines };
  };
  // The last offset: the earliest block from which the rest fits under the ↑ row.
  let last = sizes.length - 1;
  let tail = 0;
  for (let block = sizes.length - 1; block >= 0; block -= 1) {
    tail += sizes[block] ?? 0;
    if (tail > rows - 1) break;
    last = block;
  }
  const start = Math.min(Math.max(0, Math.floor(offset)), Math.max(0, last));
  const top = start > 0 ? 1 : 0;
  let shown = fit(start, rows - top);
  if (start + shown.count < sizes.length) shown = fit(start, rows - top - 1);
  if (shown.count === 0) {
    const room = rows - top - (start + 1 < sizes.length ? 1 : 0);
    shown = { count: 1, lines: Math.max(1, room) };
  }
  return {
    offset: start,
    rows: shown.lines,
    above: start,
    below: sizes.length - start - shown.count,
  };
}

/** `blockWindow` for `total` lines of one block each. */
export function paneWindow(
  total: number,
  height: number,
  offset: number,
): PaneWindow {
  return blockWindow(lineBlocks(total), height, offset);
}

function lineBlocks(total: number): number[] {
  return Array.from({ length: Math.max(0, total) }, () => 1);
}

/** The block offset after one scroll move; a page keeps one block of overlap. */
export function scrollBlocks(
  sizes: readonly number[],
  height: number,
  offset: number,
  move: ListMove,
): number {
  const current = blockWindow(sizes, height, offset);
  const count = sizes.length - current.offset - current.below;
  const page = Math.max(1, count - 1);
  const next =
    move === "up"
      ? current.offset - 1
      : move === "down"
        ? current.offset + 1
        : move === "pageup"
          ? current.offset - page
          : move === "pagedown"
            ? current.offset + page
            : move === "home"
              ? 0
              : sizes.length;
  return blockWindow(sizes, height, next).offset;
}

/** `scrollBlocks` for `total` lines of one block each. */
export function scrollPane(
  total: number,
  height: number,
  offset: number,
  move: ListMove,
): number {
  return scrollBlocks(lineBlocks(total), height, offset, move);
}

/** An offset that shows lines `first` through `last`, moving as little as possible. */
function revealLines(
  total: number,
  height: number,
  offset: number,
  first: number,
  last: number,
): number {
  let start = paneWindow(total, height, offset).offset;
  for (let pass = 0; pass < 3; pass += 1) {
    const view = paneWindow(total, height, start);
    if (first < view.offset) start = first;
    else if (last >= view.offset + view.rows)
      start = view.offset + (last - (view.offset + view.rows) + 1);
    else return view.offset;
  }
  return paneWindow(total, height, start).offset;
}

// ── View ────────────────────────────────────────────────────────────────

export type NoticeRole = "info" | "ok" | "warn" | "error" | "muted";

export interface BrowserNotice {
  readonly text: string;
  readonly role: NoticeRole;
  /**
   * Text shown in full under the notice, cut into lines by column rather
   * than at spaces, so a long ID or URL stays readable and selectable.
   */
  readonly detail?: string;
}

/** `text` cut into lines of at most `width` columns, by grapheme. */
export function hardWrap(text: string, width: number): string[] {
  const columns = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  let rest = sanitizeInline(text);
  while (rest.length > 0) {
    const line = sliceColumns(rest, columns) || rest.slice(0, 1);
    lines.push(line);
    rest = rest.slice(line.length);
  }
  return lines;
}

/** A key a caller adds to the list and detail views, such as `/actualyze`'s `k`. */
export interface BrowserExtraAction {
  /** One lowercase letter that the browser does not use. */
  readonly key: string;
  /** Read on every paint, so a getter can change it. */
  readonly title: string;
  readonly enabled?: () => boolean;
  /** List the hint right after `copy y` instead of after the browser's own hints. */
  readonly prominent?: boolean;
  /** The key list's description; defaults to the title. */
  readonly help?: string;
  readonly run: () => void;
}

/**
 * Content a frame shows in place of the list (`replace`), which also hides
 * search and filters, or as a banner above it (`above`).
 */
export interface BrowserFrameCard {
  readonly placement: "replace" | "above";
  readonly lines: readonly Line[];
  /** Lines painted as selected, for a card that lists choices. */
  readonly highlight?: readonly number[];
  /** Footer hints while the card replaces the list. */
  readonly hints?: readonly FooterHint[];
  /** Key list entries while the card replaces the list. */
  readonly help?: readonly HelpEntry[];
  /** Whether `r` and `R` refresh while the card replaces the list. */
  readonly refresh?: boolean;
}

/** Where the browser is when a frame sees a key. */
export interface FrameKeyView {
  readonly screen: BrowserScreen;
  readonly focus: BrowserFocus;
  readonly card: BrowserFrameCard | undefined;
}

/**
 * A caller's frame around the browser, such as `/actualyze`'s branded
 * header and connection cards. Its methods run on every paint.
 */
export interface BrowserFrame {
  /** The header row, in place of the title line. */
  header(data: BrowserData, width: number): Segment[];
  /** A status row under the header. */
  status(data: BrowserData, width: number, now: number): Segment[];
  card(
    data: BrowserData,
    width: number,
    now: number,
  ): BrowserFrameCard | undefined;
  /**
   * Called before the browser routes a key, except while search has focus.
   * A returned function runs after the key is consumed.
   */
  route?(key: KeyEvent, view: FrameKeyView): (() => void) | undefined;
}

/** A model the browser hands to OpenCode's model picker. */
export interface PickerModel {
  readonly providerID: string;
  readonly modelID: string;
}

/** Side effects the view asks its session for. */
export interface BrowserActions {
  /** Open OpenCode's model picker with `model` highlighted; replaces the dialog. */
  picker(model: PickerModel): void;
  /** Refresh one provider's discovery, or every provider. */
  refresh(providerID: string | undefined): void;
  /** Re-read the host lists after they failed. */
  retry(): void;
  copy(text: string): void;
  notify(notice: BrowserNotice): void;
  /** Open `/actualyze`; the `a` key is inert without it. */
  actualyze?: () => void;
}

export interface TerminalSize {
  readonly terminalWidth: number;
  readonly terminalHeight: number;
  on(event: "resize", listener: (...args: unknown[]) => void): unknown;
  off(event: "resize", listener: (...args: unknown[]) => void): unknown;
}

export interface BrowserViewOptions {
  readonly scope: BrowserScope;
  readonly data: BrowserData;
  readonly nav: NavState;
  /** Called with a fresh copy whenever query, filters, sort, collapse, or selection change. */
  readonly onNav: (nav: NavState) => void;
  readonly palette: () => RolePalette;
  readonly keyInput: Pick<KeyHandler, "on" | "off">;
  readonly terminal: TerminalSize;
  readonly current: () =>
    | { readonly providerID: string; readonly modelID: string }
    | undefined;
  readonly actions: BrowserActions;
  readonly title?: string;
  readonly searchPlaceholder?: string;
  readonly extraActions?: readonly BrowserExtraAction[];
  readonly frame?: BrowserFrame;
}

export interface BrowserView {
  readonly root: TuiNode<"box">;
  update(data: BrowserData): void;
  setNotice(notice: BrowserNotice | undefined): void;
  /** Repaint time-dependent text: relative ages and countdowns. */
  tick(): void;
  /** Read the frame again after its own state changed. */
  refreshFrame(): void;
  screen(): BrowserScreen;
  focus(): BrowserFocus;
  dispose(): void;
}

function cloneNav(nav: NavState): NavState {
  return {
    query: nav.query,
    filters: { ...nav.filters },
    sort: nav.sort,
    collapsed: [...nav.collapsed],
    ...(nav.selected ? { selected: { ...nav.selected } } : {}),
  };
}

/** The renderable ID of the browser's search input. */
export const SEARCH_INPUT_ID = "modelscout-search";

function consume(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}

/**
 * Actions that close the dialog or show another one: the key is consumed
 * first, so it never reaches the next focused input, such as the search of
 * the picker that replaces the dialog.
 */
const HANDOFF_ACTIONS: ReadonlySet<BrowserAction["type"]> = new Set([
  "select",
  "picker",
  "actualyze",
  "extra",
]);

/**
 * Build the browser inside a dialog render callback. Every node is created
 * here, once; updates, resizes, and key handling only mutate them.
 */
export function buildBrowserView(
  renderer: TuiRenderer,
  options: BrowserViewOptions,
): BrowserView {
  const { scope, palette, actions, terminal } = options;
  const extraActions = options.extraActions ?? [];
  const extraKeys = new Set(extraActions.map((action) => action.key));
  const title = options.title ?? "Model Scout";
  let data = options.data;
  let nav = cloneNav(options.nav);
  let layout = browserLayout(terminal.terminalWidth, terminal.terminalHeight);
  let projection = projectBrowser(data, nav, {
    scope,
    width: rowColumns(layout),
    current: options.current(),
  });
  let screens: BrowserScreen[] = ["list"];
  let focus: BrowserFocus = "list";
  let notice: BrowserNotice | undefined;
  let selectionPending = nav.selected === undefined;
  let disposed = false;
  /** Selection whose details the pane shows, to keep its scroll offset on repaint. */
  let paneKey: string | undefined;
  const frame = options.frame;
  /** The frame's card, read again whenever data, layout, or the frame change. */
  let card: BrowserFrameCard | undefined;
  /** Rows the list, pane, and separator show; set by `applyScreen`. */
  let contentRows = 1;

  const screen = (): BrowserScreen => screens[screens.length - 1] ?? "list";
  const replacing = (): boolean => card?.placement === "replace";
  /** The list screen shows cards instead of rows. */
  const cardsShown = (): boolean => replacing() || projection.rows.length === 0;

  const text = (id: string): TuiNode<"text"> =>
    renderer.create("text", {
      id,
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      content: "",
    });

  const header = text("modelscout-header");
  const statusLine = text("modelscout-status");
  const slash = renderer.create("text", {
    id: "modelscout-slash",
    width: 3,
    height: 1,
    flexShrink: 0,
    content: "",
  });
  const search = renderer.create("input", {
    id: SEARCH_INPUT_ID,
    width: Math.max(1, layout.width - 3),
    value: nav.query,
    placeholder:
      options.searchPlaceholder ?? "Search name, ID, family, provider",
    focused: false,
    onInput: (value: string) => setQuery(value),
    onChange: (value: string) => setQuery(value),
    onSubmit: () => {
      if (focus === "search") setFocus("list");
    },
  });
  const searchRow = renderer.create(
    "box",
    {
      id: "modelscout-search-row",
      flexDirection: "row",
      height: 1,
      flexShrink: 0,
    },
    slash,
    search,
  );
  const filterLine = text("modelscout-filters");
  const noticeLine = text("modelscout-notice");
  const banner = createTextPane(
    renderer,
    "modelscout-banner",
    BANNER_CAPACITY,
    { width: layout.width, height: 1 },
    palette,
  );
  const list: RowList = createRowList(renderer, {
    id: "modelscout-list",
    capacity: BODY_CAPACITY,
    width: layout.listWidth,
    height: layout.bodyHeight,
    palette,
    focused: true,
    onSelect: (row) => onSelect(row as BrowserRow | undefined),
  });
  const separator = renderer.create("text", {
    id: "modelscout-separator",
    width: SEPARATOR_COLUMNS,
    height: layout.bodyHeight,
    flexShrink: 0,
    wrapMode: "none",
    content: "",
  });
  const pane = createTextPane(
    renderer,
    "modelscout-pane",
    BODY_CAPACITY,
    { width: layout.paneWidth, height: layout.bodyHeight },
    palette,
  );
  const filterList: RowList = createRowList(renderer, {
    id: "modelscout-filter-list",
    capacity: 12,
    width: layout.width,
    height: Math.min(12, layout.bodyHeight),
    palette,
    focused: true,
  });
  const body = renderer.create(
    "box",
    {
      id: "modelscout-body",
      flexDirection: "row",
      flexShrink: 0,
      height: layout.bodyHeight,
      overflow: "hidden",
    },
    list.root,
    separator,
    pane.root,
    filterList.root,
  );
  const summaryLine = text("modelscout-summary");
  const footer = text("modelscout-footer");
  const root = renderer.create(
    "box",
    {
      id: "modelscout-browser",
      flexDirection: "column",
      width: layout.outerWidth,
      height: layout.height,
      maxHeight: layout.height,
      overflow: "hidden",
      paddingLeft: SIDE_PADDING,
      paddingRight: SIDE_PADDING,
      paddingBottom: 1,
    },
    header,
    statusLine,
    searchRow,
    filterLine,
    noticeLine,
    banner.root,
    body,
    summaryLine,
    footer,
  );

  const paintLine = (
    node: TuiNode<"text">,
    segments: readonly Segment[],
    width = layout.width,
  ): void => {
    renderer.setStyledText(
      node,
      rowSpans({ key: "", segments }, palette(), width, {
        selected: false,
        focused: false,
        bar: false,
      }),
    );
  };

  // ── Selection ─────────────────────────────────────────────────────────

  /** The selected row, or none while a frame card replaces the list. */
  const selectedRow = (): BrowserRow | undefined =>
    replacing() ? undefined : (list.selected()?.row as BrowserRow | undefined);

  function onSelect(row: BrowserRow | undefined): void {
    if (!row || row.kind === "note") return;
    const next: SelectedItem = row.model
      ? { providerID: row.group.id, modelID: row.model.id }
      : { providerID: row.group.id };
    if (selectionKey(next) === selectionKey(nav.selected)) return;
    nav = { ...nav, selected: next };
    emitNav();
    paintPane();
    paintSummary();
    paintFooter();
  }

  function emitNav(): void {
    options.onNav(cloneNav(nav));
  }

  function setRows(): void {
    // Read before `setRows`, whose fallback selection reaches `onSelect`.
    const wanted = selectionKey(nav.selected);
    projection = projectBrowser(data, nav, {
      scope,
      width: rowColumns(layout),
      current: options.current(),
    });
    list.setRows(projection.rows);
    // The first open waits for a snapshot with model rows before choosing:
    // a fresh start can list a provider before its discovered models.
    if (
      selectionPending &&
      data.status === "ready" &&
      projection.rows.some((row) => row.kind === "model")
    ) {
      selectionPending = false;
      const first = initialSelection(projection.rows, options.current());
      if (first) list.select(first.key);
    } else if (wanted) list.select(wanted);
  }

  // ── Focus and screens ─────────────────────────────────────────────────

  function setFocus(next: BrowserFocus): void {
    focus = next;
    renderer.set(search, "focused", next === "search");
    list.setFocused(next === "list");
    paintChrome();
  }

  function pushScreen(next: BrowserScreen): void {
    if (screen() === next) return;
    screens = [...screens, next];
    if (next !== "list") renderer.set(search, "focused", false);
    applyScreen();
  }

  function popScreen(): void {
    if (screens.length > 1) screens = screens.slice(0, -1);
    applyScreen();
  }

  /**
   * Lines of the banner above the body: a notice's full detail on any
   * screen, then the frame's card when it sits above the list.
   */
  function bannerLines(): Line[] {
    const lines = noticeBannerLines();
    if (screen() === "list" && card?.placement === "above")
      lines.push(...card.lines);
    return lines;
  }

  /** The notice's lines in the banner: its wrapped rest, then its detail. */
  function noticeBannerLines(): Line[] {
    const wrapped = noticeText();
    // A wrapped notice continues in base, or muted when it is a muted note.
    const continued: ForegroundRole =
      wrapped?.role === "muted" ? "muted" : "base";
    const lines: Line[] = (wrapped?.lines.slice(1) ?? []).map((part) => [
      { text: part, role: continued },
    ]);
    if (notice?.detail)
      lines.push(
        ...hardWrap(notice.detail, layout.width).map((part) => [
          { text: part, role: "base" as const },
        ]),
      );
    return lines;
  }

  /**
   * Rows the banner takes above the body on the current screen. It leaves
   * the list `MIN_LIST_ROWS`, except that the notice's own lines, such as
   * text to select by hand, may take rows down to one list row.
   */
  function bannerRows(): number {
    const framed = frame ? 1 : 0;
    // The narrow list's summary row comes out of the same rows.
    const summary =
      screen() === "list" && !layout.wide && !cardsShown() ? 1 : 0;
    const room = layout.bodyHeight - framed - summary - MIN_LIST_ROWS;
    const noticeRoom = Math.min(
      noticeBannerLines().length,
      layout.bodyHeight - framed - summary - 1,
    );
    return Math.max(
      0,
      Math.min(
        bannerLines().length,
        BANNER_CAPACITY,
        Math.max(room, noticeRoom),
      ),
    );
  }

  /**
   * Rows the body takes on the current screen and layout. A frame's status
   * row and banner take rows from it; a replacing card gets the search and
   * filter rows.
   */
  function bodyRows(): number {
    const summary = screen() === "list" && !layout.wide && !cardsShown();
    const framed = frame ? 1 : 0;
    const hidden = searchHidden() ? 2 : 0;
    return (
      layout.bodyHeight - (summary ? 1 : 0) - framed + hidden - bannerRows()
    );
  }

  /** The key list and a replacing card have no use for search and filters. */
  function searchHidden(): boolean {
    return replacing() || screen() === "help";
  }

  /**
   * Read the frame's card again. A card that replaces the list leaves no
   * selected row, so screens about one and the search focus give way.
   */
  function syncCard(): void {
    card = frame?.card(data, layout.width, Date.now());
    if (!replacing()) return;
    if (screens.some((item) => item !== "list" && item !== "help"))
      screens = screens.filter((item) => item === "list" || item === "help");
    if (focus !== "list") {
      focus = "list";
      renderer.set(search, "focused", false);
      list.setFocused(true);
    }
  }

  /**
   * Show the nodes of the current screen at the current layout. The pane
   * scrolls back to the top unless `keepOffset` is set.
   */
  function applyScreen(keepOffset = false): void {
    syncCard();
    const current = screen();
    const listScreen = current === "list";
    const cards = listScreen && cardsShown();
    const split = listScreen && layout.wide && !cards;
    const summary = listScreen && !layout.wide && !cards;
    const fullBody = bodyRows();
    // A replacing card and the key list over it take the rows they need
    // plus the blank row before the footer; the list views keep the full
    // height.
    const bodyHeight =
      replacing() && (listScreen || current === "help")
        ? Math.min(fullBody, paneLines(layout.width).length + 1)
        : fullBody;
    // A blank row stays between the body and the footer, except under the
    // narrow list, where the summary line sits there.
    contentRows = Math.max(1, bodyHeight - (summary ? 0 : 1));
    const rootHeight = layout.height - (fullBody - bodyHeight);
    renderer.set(root, "height", rootHeight);
    renderer.set(root, "maxHeight", rootHeight);
    const bannerHeight = bannerRows();
    renderer.set(statusLine, "visible", frame !== undefined);
    renderer.set(searchRow, "visible", !searchHidden());
    renderer.set(filterLine, "visible", !searchHidden());
    renderer.set(banner.root, "visible", bannerHeight > 0);
    banner.setViewport(layout.width, Math.max(1, bannerHeight));
    banner.setLines(bannerHeight > 0 ? bannerLines() : []);
    renderer.set(body, "height", bodyHeight);
    renderer.set(list.root, "visible", listScreen && !cards);
    renderer.set(separator, "visible", split);
    renderer.set(
      pane.root,
      "visible",
      current !== "filters" && (!listScreen || split || cards),
    );
    renderer.set(filterList.root, "visible", current === "filters");
    renderer.set(summaryLine, "visible", summary);
    list.setViewport(layout.listWidth, contentRows);
    pane.setViewport(split ? layout.paneWidth : layout.width, contentRows);
    filterList.setViewport(layout.width, Math.min(12, contentRows));
    renderer.set(separator, "height", contentRows);
    if (current === "filters") paintFilters();
    if (!keepOffset) paneKey = undefined;
    paintPane();
    paintChrome();
  }

  function paintSeparator(): void {
    renderer.setStyledText(separator, [
      {
        text: Array.from({ length: contentRows }, () => " │ ").join("\n"),
        fg: palette().rule,
      },
    ]);
  }

  function relayout(): void {
    const next = browserLayout(terminal.terminalWidth, terminal.terminalHeight);
    const changed =
      next.wide !== layout.wide ||
      next.width !== layout.width ||
      next.height !== layout.height;
    layout = next;
    if (!changed) return;
    renderer.set(root, "width", layout.outerWidth);
    renderer.set(root, "height", layout.height);
    renderer.set(root, "maxHeight", layout.height);
    renderer.set(search, "width", Math.max(1, layout.width - 3));
    setRows();
    applyScreen(true);
  }

  // ── Painting ──────────────────────────────────────────────────────────

  function paneLines(width: number): Line[] {
    const now = Date.now();
    const current = screen();
    if (current === "help") return helpLines(helpTitle(), helpEntries(), width);
    if (current === "list" && replacing() && card) return [...card.lines];
    if (current === "list" && projection.rows.length === 0)
      return cardLines(width);
    const row = selectedRow();
    if (!row) return [];
    const record = findRecord(data, row.group.id);
    if (current === "evidence")
      return row.model
        ? modelEvidenceLines(row.group, row.model, width)
        : providerEvidenceLines(row.group, record, width);
    if (row.model) {
      const currentModel = options.current();
      return modelDetailLines(row.group, row.model, {
        width,
        current:
          currentModel?.providerID === row.group.id &&
          currentModel.modelID === row.model.id,
        pickerBlocked: pickerBlocked(row),
      });
    }
    return providerDetailLines(row.group, record, {
      width,
      now,
      retryInSeconds: refreshWaitSeconds(record, data, now),
      serverAvailable: data.catalog !== undefined,
    });
  }

  function paintPane(keepOffset = false): void {
    const current = screen();
    const split = current === "list" && layout.wide && !cardsShown();
    const visible =
      current !== "filters" && (current !== "list" || split || cardsShown());
    if (!visible) return;
    const width = split ? layout.paneWidth : layout.width;
    const key = `${current}\u0000${replacing() ? "card" : (list.selected()?.row.key ?? "")}`;
    const highlight =
      current === "list" && replacing() ? card?.highlight : undefined;
    const keep = keepOffset || key === paneKey;
    // The preview beside the list never scrolls; its last line says which
    // key opens the whole details.
    pane.setMoreKey(split ? "i" : undefined);
    if (current === "help") {
      // The key list scrolls by whole entries under its title.
      const help = helpLayout(helpTitle(), helpEntries(), width);
      pane.setLines(help.lines, keep, undefined, {
        pinned: help.pinned,
        blocks: help.entries,
      });
    } else pane.setLines(paneLines(width), keep, highlight);
    paneKey = key;
  }

  function cardLines(width: number): Line[] {
    const lines: Line[] = [[]];
    const indent = (line: Line): Line => [
      { text: "   ", role: "base" },
      ...line,
    ];
    const add = (body: string, role: ForegroundRole = "base"): void => {
      for (const line of paragraph(body, width - 3, role))
        lines.push(indent(line));
    };
    if (data.status === "loading") {
      add("○ Reading models from OpenCode and scout…", "info");
      return lines;
    }
    if (data.status === "failed") {
      add("▲ Could not load models from OpenCode.", "error");
      if (data.error) add(data.error, "muted");
      lines.push([]);
      add("r retries.", "base");
      return lines;
    }
    const inScope =
      scope.kind === "all"
        ? data.groups.length > 0
        : data.groups.some((group) => group.id === scope.providerID);
    if (!inScope) {
      if (scope.kind === "provider") {
        add("No models from this provider yet.", "muted");
        return lines;
      }
      add("No OpenAI-compatible providers found.", "base");
      lines.push([]);
      if (actions.actualyze)
        lines.push(
          ...labeledCard(
            "Actualyze",
            "press a to connect an API key (opens /actualyze)",
            width,
          ),
        );
      lines.push(
        ...labeledCard(
          "Other servers",
          "add a provider with settings.baseURL to opencode.json, for example vLLM, LiteLLM, or a local server, under your own provider ID. The README lists the supported servers.",
          width,
        ),
      );
      return lines;
    }
    if (!hasNarrowing(nav) && scope.kind === "provider") {
      const group = data.groups.find((item) => item.id === scope.providerID);
      if (group)
        add(
          noteText(
            group,
            findRecord(data, group.id),
            projection.embeddingsHidden,
          ),
          "muted",
        );
      return lines;
    }
    const query = nav.query.trim();
    add(
      query
        ? `No models match "${query}" with these filters.`
        : "No models match these filters.",
      "muted",
    );
    add("x clears search and filters · f changes filters", "muted");
    return lines;
  }

  function labeledCard(label: string, value: string, width: number): Line[] {
    const labelColumns = 17;
    return paragraph(value, Math.max(8, width - labelColumns), "base").map(
      (line, index) => [
        {
          text: padText(index === 0 ? `   ${label}` : "", labelColumns),
          role: "muted",
        },
        ...line,
      ],
    );
  }

  function paintFilters(): void {
    const fields = filterFields(scope);
    const previous = filterList.selected()?.row.key;
    const matching = projection.visibleModels;
    const rows: ListRow[] = [
      {
        key: "title",
        selectable: false,
        segments: [
          {
            text: `Filters · ${matching} matching ${matching === 1 ? "model" : "models"} · applied as you change them`,
            role: "muted",
          },
        ],
      },
      { key: "gap", selectable: false, segments: [] },
      ...fields.map((field) => ({
        key: field,
        segments: [
          { text: "   ", role: "base" as const },
          { text: padText(FILTER_LABELS[field], 30), role: "muted" as const },
          {
            text: filterValue(nav.filters, field, data.groups),
            role: "base" as const,
          },
        ],
      })),
    ];
    filterList.setRows(rows);
    if (previous) filterList.select(previous);
    else if (fields[0]) filterList.select(fields[0]);
  }

  function headerSegments(): Segment[] {
    const left: Segment[] = [{ text: title, role: "base" }];
    if (data.status === "loading")
      return justify(left, [{ text: "○ loading", role: "info" }], layout.width);
    if (data.status === "failed")
      return justify(
        left,
        [{ text: "▲ OpenCode lists unavailable", role: "error" }],
        layout.width,
      );
    const right: Segment[] = [];
    if (scope.kind === "all")
      right.push({
        text: `${projection.providerCount} ${projection.providerCount === 1 ? "provider" : "providers"} · `,
        role: "muted",
      });
    right.push({
      text: `${projection.totalModels} ${projection.totalModels === 1 ? "model" : "models"}`,
      role: "muted",
    });
    if (projection.attention > 0)
      right.push(
        { text: " · ", role: "muted" },
        ...glyphSegments({
          text: `▲ ${projection.attention} needs attention`,
          role: "warn",
        }),
      );
    if (projection.discovering > 0)
      right.push(
        { text: " · ", role: "muted" },
        ...glyphSegments({ text: "○ checking", role: "info" }),
      );
    return justify(left, right, layout.width);
  }

  function filterSegments(): Segment[] {
    const summary = filterSummary(
      nav,
      scope,
      data.groups,
      projection.embeddingsHidden,
    );
    const narrowing = hasNarrowing(nav);
    const right: Segment[] = [
      { text: `sort ${SORT_NAMES[nav.sort]} · `, role: "muted" },
      { text: "clear", role: narrowing ? "base" : "disabled" },
      { text: " ", role: "base" },
      { text: "x", role: narrowing ? "key" : "disabled" },
    ];
    // The "Filters:" label goes first when the summary needs the room.
    const labeled = `Filters: ${summary}`;
    const text =
      textWidth(labeled) + 1 + segmentsWidth(right) <= layout.width
        ? labeled
        : summary;
    return justify([{ text, role: "muted" }], right, layout.width);
  }

  /** The notice row's text, wrapped: the first line shows on the row, the rest in the banner. */
  function noticeText(): { lines: string[]; role: NoticeRole } | undefined {
    const wrap = (text: string, role: NoticeRole) => ({
      lines: wrapText(text, layout.width),
      role,
    });
    if (notice) return wrap(notice.text, notice.role);
    if (data.status === "ready" && data.serverNotice)
      return wrap(
        `▲ ${data.serverNotice}. Showing OpenCode's model list.`,
        "warn",
      );
    if (
      data.catalog?.status === "pending" &&
      data.catalog.providers.length === 0
    )
      return wrap("○ Discovery is starting", "info");
    return undefined;
  }

  function noticeSegments(): Segment[] {
    const shown = noticeText();
    return shown
      ? glyphSegments({ text: shown.lines[0] ?? "", role: shown.role })
      : [];
  }

  function paintSummary(): void {
    if (layout.wide || screen() !== "list") return;
    const row = selectedRow();
    paintLine(
      summaryLine,
      row?.model
        ? modelSummaryLine(row.model, layout.width)
        : row
          ? [
              { text: row.group.provider, role: "base" },
              {
                text: row.group.endpoint
                  ? ` · ${displayOrigin(row.group.endpoint)}`
                  : "",
                role: "muted",
              },
            ]
          : [],
    );
  }

  function paintChrome(): void {
    if (frame) {
      paintLine(header, frame.header(data, layout.width));
      paintLine(statusLine, frame.status(data, layout.width, Date.now()));
    } else paintLine(header, headerSegments());
    paintLine(
      slash,
      [{ text: "/", role: focus === "search" ? "field" : "faint" }],
      3,
    );
    const colors = palette();
    renderer.set(search, "textColor", colors.base);
    renderer.set(search, "focusedTextColor", colors.field);
    renderer.set(search, "focusedBackgroundColor", colors.fieldBg);
    renderer.set(search, "placeholderColor", colors.muted);
    paintLine(filterLine, filterSegments());
    paintLine(noticeLine, noticeSegments());
    paintSeparator();
    paintSummary();
    paintFooter();
  }

  function paintFooter(): void {
    paintLine(
      footer,
      footerSegments(
        footerHints(),
        layout.width,
        focus !== "search" && screen() !== "help",
      ),
    );
  }

  // ── Hints and help ────────────────────────────────────────────────────

  function pickerBlocked(row: BrowserRow): string | undefined {
    const model = row.model;
    if (!model) return "Select a model to open the picker";
    if (model.type === "embedding")
      return "Embedding model; not in the chat picker";
    if (!data.hostListed.has(qualifiedID(row.group.id, model.id)))
      return "Not in OpenCode's model list yet";
    if (model.hostStatus === "deprecated")
      return "Deprecated; not in OpenCode's model picker";
    if (!model.enabled) return "Hidden from OpenCode's model picker";
    return undefined;
  }

  function extraHints(prominent = false): FooterHint[] {
    return extraActions
      .filter((action) => (action.prominent ?? false) === prominent)
      .map((action) => ({
        title: action.title,
        key: action.key,
        enabled: action.enabled?.() ?? true,
      }));
  }

  function footerHints(): FooterHint[] {
    const discovery = data.catalog !== undefined;
    const row = selectedRow();
    const current = screen();
    if (focus === "search" && current === "list")
      return [{ title: "results", key: "enter" }];
    switch (current) {
      case "help":
        return [{ title: "back", key: "backspace" }];
      case "filters":
        return [
          { title: "change", key: "←/→" },
          { title: "clear", key: "x", enabled: hasNarrowing(nav) },
          { title: "back", key: "backspace" },
        ];
      case "evidence":
        return [
          { title: "back", key: "backspace" },
          { title: "copy", key: "y" },
        ];
      case "detail":
        return detailHints(row, discovery);
      case "list":
        break;
    }
    if (replacing()) {
      // The card's own keys come first: the card's action row lists the
      // ones the footer leaves out, computed without this hint. The scroll
      // hint shows only when every card key fits too; the "↓ N more" row
      // and `?` also say the card scrolls.
      const hints = [...(card?.hints ?? [])];
      if (
        cardScrolls() &&
        footerShown(hints, layout.width).size === hints.length
      )
        hints.push({ title: "scroll", key: "↑↓" });
      return hints;
    }
    if (data.status === "loading") return [];
    if (data.status === "failed") return [{ title: "retry", key: "r" }];
    if (projection.rows.length === 0) {
      const hints: FooterHint[] = [];
      if (hasNarrowing(nav))
        hints.push(
          { title: "clear", key: "x" },
          { title: "filters", key: "f" },
        );
      else if (actions.actualyze)
        hints.push({ title: "connect Actualyze", key: "a" });
      return [...hints, ...extraHints(true), ...extraHints()];
    }
    if (row?.kind === "provider") {
      const collapsed = nav.collapsed.includes(row.group.id);
      return [
        { title: "details", key: "enter" },
        collapsed
          ? { title: "expand", key: "→" }
          : { title: "collapse", key: "←" },
        { title: "refresh", key: "r", enabled: discovery },
        ...extraHints(true),
        { title: "filters", key: "f" },
        { title: "evidence", key: "d" },
        { title: "sort", key: "s" },
        { title: "search", key: "/" },
        ...extraHints(),
      ];
    }
    return [
      {
        title: "select",
        key: "enter",
        enabled: row !== undefined && pickerBlocked(row) === undefined,
      },
      { title: "details", key: "i" },
      { title: "copy", key: "y" },
      ...extraHints(true),
      { title: "refresh", key: "r", enabled: discovery },
      { title: "filters", key: "f" },
      { title: "evidence", key: "d" },
      { title: "sort", key: "s" },
      { title: "search", key: "/" },
      ...extraHints(),
    ];
  }

  function detailHints(
    row: BrowserRow | undefined,
    discovery: boolean,
  ): FooterHint[] {
    return [
      ...(row?.model
        ? [
            {
              title: "select",
              key: "enter",
              enabled: pickerBlocked(row) === undefined,
            },
          ]
        : []),
      { title: "back", key: "backspace" },
      { title: "copy", key: "y" },
      ...extraHints(true),
      { title: "evidence", key: "d" },
      { title: "refresh", key: "r", enabled: discovery },
      ...extraHints(),
    ];
  }

  function helpTitle(): string {
    const below = screens[screens.length - 2] ?? "list";
    const view =
      below === "filters"
        ? "filters"
        : below === "evidence"
          ? "evidence"
          : below === "detail"
            ? "details"
            : "list";
    return `Keys · ${title} ${view}`;
  }

  function helpEntries(): HelpEntry[] {
    const below = screens[screens.length - 2] ?? "list";
    const common: HelpEntry[] = [
      { keys: "?", action: "this list; backspace or ? returns" },
      { keys: "esc", action: "close" },
    ];
    if (below === "list" && replacing())
      return [
        ...(card?.highlight === undefined
          ? [
              {
                keys: "↑ ↓ pgup pgdn home end",
                action: "scroll the card when it runs past the dialog",
              },
            ]
          : []),
        ...(card?.help ?? []),
        ...common,
      ];
    if (below === "filters")
      return [
        { keys: "↑ ↓", action: "choose a filter" },
        {
          keys: "← → enter space",
          action: "change it; the list updates as you go",
        },
        { keys: "x", action: "clear search and filters" },
        { keys: "backspace f", action: "back to the list" },
        ...common,
      ];
    if (below === "evidence")
      return [
        { keys: "↑ ↓ pgup pgdn", action: "scroll" },
        { keys: "y / Y", action: "copy provider/model / the raw model ID" },
        { keys: "backspace", action: "back" },
        ...common,
      ];
    const entries: HelpEntry[] = [
      {
        keys: "↑ ↓ pgup pgdn home end",
        action: below === "detail" ? "scroll" : "move",
      },
      // One line each at 80 columns, so `/actualyze`'s keys stay in view.
      {
        keys: "enter / m",
        action: "select the model in OpenCode's model picker",
      },
      { keys: "i", action: "details; enter on a provider header too" },
      // A caller's keys come early: the footer drops their hints first.
      ...extraActions.map((action) => ({
        keys: action.key,
        action: action.help ?? action.title,
      })),
      ...(scope.kind === "all"
        ? [{ keys: "← →", action: "collapse or expand a provider" }]
        : []),
      {
        keys: "/",
        action:
          "search name, ID, family, provider; enter or ↓ returns to the list",
      },
      { keys: "f", action: "filters: provider, type, needs, priced" },
      { keys: "x", action: "clear search and filters" },
      { keys: "s", action: "sort: name, context, input price, output price" },
      { keys: "d", action: "evidence: where each value comes from" },
      { keys: "y / Y", action: "copy provider/model / the raw model ID" },
      { keys: "r", action: "refresh the selected provider's discovery" },
      ...(scope.kind === "all"
        ? [{ keys: "R", action: "refresh every provider" }]
        : []),
      ...(actions.actualyze ? [{ keys: "a", action: "open /actualyze" }] : []),
      {
        keys: "backspace",
        action:
          "back from details, evidence, or filters; i and ← also leave details",
      },
      ...common,
    ];
    return entries;
  }

  // ── Updates ───────────────────────────────────────────────────────────

  function setQuery(value: string): void {
    if (value === nav.query) return;
    nav = { ...nav, query: value };
    emitNav();
    refreshList();
  }

  function setNav(next: NavState): void {
    nav = next;
    emitNav();
    refreshList();
  }

  function refreshList(): void {
    setRows();
    applyScreen(true);
  }

  // ── Keys ──────────────────────────────────────────────────────────────

  function apply(action: BrowserAction): boolean {
    const row = selectedRow();
    const current = screen();
    switch (action.type) {
      case "move":
        if (current === "filters") filterList.move(action.move);
        else if (current === "list" && replacing()) pane.scroll(action.move);
        else if (projection.rows.length > 0) {
          selectionPending = false;
          list.move(action.move);
        }
        return true;
      case "scroll":
        pane.scroll(action.move);
        return true;
      case "select":
        if (!row) return false;
        return apply({ type: row.model ? "picker" : "open" });
      case "open":
        if (!row) return false;
        pushScreen("detail");
        return true;
      case "back":
        if (current === "list") return false;
        popScreen();
        if (screen() === "list") setFocus("list");
        return true;
      case "collapse":
      case "expand": {
        if (scope.kind !== "all" || !row) return false;
        selectionPending = false;
        const id = row.group.id;
        const collapse = action.type === "collapse";
        if (collapse === nav.collapsed.includes(id)) {
          if (collapse && row.model) list.select(providerKey(id));
          return true;
        }
        const collapsed = collapse
          ? [...nav.collapsed, id]
          : nav.collapsed.filter((item) => item !== id);
        setNav({ ...nav, collapsed, selected: { providerID: id } });
        list.select(providerKey(id));
        return true;
      }
      case "focus-search":
        screens = ["list"];
        applyScreen();
        setFocus("search");
        return true;
      case "leave-search":
        setFocus("list");
        return true;
      case "filters":
        pushScreen("filters");
        return true;
      case "filter-change": {
        const field = filterList.selected()?.row.key as FilterField | undefined;
        if (!field) return true;
        const ids = data.groups.map((group) => group.id);
        setNav({
          ...nav,
          filters: cycleFilter(nav.filters, field, action.direction, ids),
        });
        return true;
      }
      case "clear":
        renderer.set(search, "value", "");
        setNav({ ...nav, query: "", filters: { ...DEFAULT_FILTERS } });
        return true;
      case "sort":
        setNav({ ...nav, sort: nextSort(nav.sort) });
        return true;
      case "evidence":
        if (!row) return false;
        pushScreen("evidence");
        return true;
      case "picker": {
        if (!row) return false;
        const blocked = pickerBlocked(row);
        if (blocked) {
          actions.notify({ text: blocked, role: "muted" });
          return true;
        }
        // `pickerBlocked` reports a provider header; this narrows the type.
        if (!row.model) return false;
        actions.picker({ providerID: row.group.id, modelID: row.model.id });
        return true;
      }
      case "refresh":
        if (data.status === "failed") {
          actions.retry();
          return true;
        }
        if (!data.catalog) {
          actions.notify({
            text: "Refresh needs scout's server half, which did not answer",
            role: "warn",
          });
          return true;
        }
        actions.refresh(
          scope.kind === "provider" ? scope.providerID : row?.group.id,
        );
        return true;
      case "refresh-all":
        // One provider in scope: `r` is its refresh, and `R` is not a key.
        if (scope.kind === "provider") return false;
        if (data.status === "failed") {
          actions.retry();
          return true;
        }
        if (!data.catalog) {
          actions.notify({
            text: "Refresh needs scout's server half, which did not answer",
            role: "warn",
          });
          return true;
        }
        actions.refresh(undefined);
        return true;
      case "actualyze":
        if (!actions.actualyze) return false;
        actions.actualyze();
        return true;
      case "copy":
        if (!row) return false;
        actions.copy(
          row.model
            ? action.what === "qualified"
              ? qualifiedID(row.group.id, row.model.id)
              : row.model.id
            : row.group.id,
        );
        return true;
      case "help":
        pushScreen("help");
        return true;
      case "extra": {
        const extra = extraActions.find((item) => item.key === action.key);
        if (!extra || extra.enabled?.() === false) return false;
        extra.run();
        return true;
      }
    }
  }

  /**
   * What a replacing card leaves to the browser on the list screen: `?`,
   * the caller keys the card lists, and refresh when the card allows it.
   */
  function allowedUnderCard(action: BrowserAction): boolean {
    switch (action.type) {
      case "help":
        return true;
      case "extra":
        return card?.hints?.some((hint) => hint.key === action.key) === true;
      case "refresh":
      case "refresh-all":
        return card?.refresh === true;
      case "move":
        // The links screen moves its own selection; an informational card
        // that runs past the dialog scrolls.
        return cardScrolls();
      default:
        return false;
    }
  }

  /** A replacing card other than a selectable list that runs past the dialog. */
  function cardScrolls(): boolean {
    return replacing() && card?.highlight === undefined && pane.overflows();
  }

  const onKeyPress = (key: KeyEvent): void => {
    if (disposed) return;
    if (frame?.route && focus !== "search") {
      const run = frame.route(key, { screen: screen(), focus, card });
      if (run) {
        consume(key);
        run();
        return;
      }
    }
    const action = routeKey({ screen: screen(), focus, extraKeys }, key);
    if (!action) return;
    if (screen() === "list" && replacing() && !allowedUnderCard(action)) return;
    if (action.type === "actualyze" && !actions.actualyze) return;
    if (HANDOFF_ACTIONS.has(action.type)) {
      consume(key);
      apply(action);
      return;
    }
    if (apply(action)) consume(key);
  };

  const onResize = (): void => {
    if (!disposed) relayout();
  };

  // Listeners attach only after the first paint succeeds: a view that throws
  // while building never returns its `dispose`, so nothing could remove them.
  setRows();
  applyScreen();
  setFocus("list");
  options.keyInput.on("keypress", onKeyPress);
  try {
    terminal.on("resize", onResize);
  } catch (error) {
    options.keyInput.off("keypress", onKeyPress);
    throw error;
  }

  return {
    root,
    update(next) {
      data = next;
      const subject = selectedRow()?.key;
      setRows();
      // A detail or evidence screen whose subject disappeared returns to the
      // list rather than showing the row `setRows` fell back to.
      if (
        (screens.includes("detail") || screens.includes("evidence")) &&
        selectedRow()?.key !== subject
      )
        screens = ["list"];
      applyScreen(true);
    },
    setNotice(next) {
      const before = bannerRows();
      notice = next;
      // A banner that grows or shrinks changes the body's height; otherwise
      // only its text changes, such as a second copied ID of the same length.
      if (bannerRows() !== before) applyScreen(true);
      else {
        paintLine(noticeLine, noticeSegments());
        if (before > 0) banner.setLines(bannerLines());
      }
    },
    tick() {
      if (frame) applyScreen(true);
      else {
        paintPane(true);
        paintChrome();
      }
      list.repaint();
    },
    refreshFrame() {
      if (!disposed) applyScreen(true);
    },
    screen,
    focus: () => focus,
    dispose() {
      if (disposed) return;
      disposed = true;
      options.keyInput.off("keypress", onKeyPress);
      terminal.off("resize", onResize);
    },
  };
}
