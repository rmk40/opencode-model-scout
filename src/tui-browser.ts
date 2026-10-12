import type {
  ColorInput,
  KeyEvent,
  KeyHandler,
  SelectOption,
} from "@opentui/core";
import stringWidth from "string-width";
import type {
  CapabilityEvidence,
  CostEvidence,
  MetadataSource,
  ScalarEvidence,
} from "./catalog-evidence";
import { compactCount, formatBytes } from "./format";
import {
  coreMetadataCoverage,
  type CoreMetadataCoverage,
  type CoreMetadataName,
  type ModelRow,
  type ProviderGroup,
} from "./tui-models";
import { TuiRenderer, type TuiNode } from "./tui-renderer";

export type BrowserScreen = "list" | "detail";
export type FocusTarget = "search" | "list" | "detail";
export type ModelTypeFacet = "all" | "llm" | "vlm" | "embedding" | "unknown";
export type CapabilityNameFacet =
  | "any"
  | "image"
  | "tools"
  | "reasoning"
  | "temperature";
export type CapabilityStateFacet =
  | "any"
  | "supported"
  | "unsupported"
  | "unknown";
export type MetadataFacet = "any" | "complete-core" | "missing-core";
export type OriginFacet = "all" | "discovered" | "pre-existing" | "unknown";
export type BrowserFacetKey =
  | "provider"
  | "type"
  | "capability"
  | "capabilityState"
  | "metadata"
  | "origin";

export interface BrowserFacets {
  provider: string;
  type: ModelTypeFacet;
  capability: CapabilityNameFacet;
  capabilityState: CapabilityStateFacet;
  metadata: MetadataFacet;
  origin: OriginFacet;
}

type FocusNode = TuiNode<"input"> | TuiNode<"select"> | TuiNode<"scrollbox">;

export interface BrowserState {
  query: string;
  selected?: string;
  screen: BrowserScreen;
  focus: FocusTarget;
  facets: BrowserFacets;
}

export type BrowserItemKind = "provider" | "model";

export interface BrowserItem {
  key: string;
  kind: BrowserItemKind;
  /** Logical name retained for search, state, and tests. */
  name: string;
  /** The complete, width-bounded terminal row shown by the select. */
  displayRow: string;
  detail: string;
}

export interface BrowserProjection {
  query: string;
  items: readonly BrowserItem[];
  emptyMessage: string;
  filterSummary: string;
  originFilterAvailable: boolean;
  summary: BrowserSummary;
}

export interface BrowserSummary {
  visibleModels: number;
  totalModels: number;
  providerCount: number;
  missingCoreCount: number;
}

export type BrowserEvent =
  | { type: "search"; query: string }
  | { type: "highlight"; key: string }
  | { type: "show"; screen: BrowserScreen }
  | { type: "focus"; target: FocusTarget }
  | { type: "facets"; facets: BrowserFacets };

export const INITIAL_BROWSER_FACETS: BrowserFacets = {
  provider: "all",
  type: "all",
  capability: "any",
  capabilityState: "any",
  metadata: "any",
  origin: "all",
};

export const INITIAL_BROWSER_STATE: BrowserState = {
  query: "",
  selected: undefined,
  screen: "list",
  focus: "search",
  facets: INITIAL_BROWSER_FACETS,
};

function modelSearchFields(group: ProviderGroup, model: ModelRow): string[] {
  return [
    model.id,
    model.name,
    group.provider,
    group.id,
    model.type,
    model.family,
    model.parameterSize,
    model.quantization,
    model.enabled ? undefined : "disabled",
    ...model.flags,
  ].filter((field): field is string => Boolean(field));
}

function normalizedSearchText(fields: readonly string[]): string {
  return fields.join("\n").toLocaleLowerCase();
}

function queryTerms(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function matchesQuery(searchText: string, terms: readonly string[]): boolean {
  return terms.every((term) => searchText.includes(term));
}

function providerKey(group: ProviderGroup): string {
  return `provider:${encodeURIComponent(group.id)}`;
}

function modelKey(group: ProviderGroup, model: ModelRow): string {
  return `${providerKey(group)}:model:${encodeURIComponent(model.id)}`;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function sanitizeInlineValue(value: string): string {
  return value.replace(
    /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+/gu,
    " ",
  );
}

function sliceByTerminalColumns(value: string, maxColumns: number): string {
  let columns = 0;
  let result = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const nextColumns = stringWidth(segment);
    if (columns + nextColumns > maxColumns) break;
    result += segment;
    columns += nextColumns;
  }
  return result;
}

function bounded(value: string, max: number): string {
  const width = Math.max(0, Math.floor(max));
  if (width === 0) return "";
  const safeValue = sanitizeInlineValue(value);
  if (stringWidth(safeValue) <= width) return safeValue;
  if (width === 1) return "…";
  const prefix = sliceByTerminalColumns(safeValue, width - 1)
    .trimEnd()
    .replace(/[·,:;|/-]+$/u, "")
    .trimEnd();
  return `${sliceByTerminalColumns(prefix, width - 1)}…`;
}

/** Bound a value to a column and pad it to that exact terminal width. */
function paddedColumn(value: string, width: number): string {
  const cell = bounded(value, width);
  return cell + " ".repeat(Math.max(0, width - stringWidth(cell)));
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

const EVIDENCE_LABELS: Record<MetadataSource, string> = {
  "provider-probe": "probe",
  "pre-existing": "config",
  "server-list": "server",
  "models.dev": "models.dev",
  heuristic: "heuristic",
  "policy-default": "default",
  "host-default": "host default",
  "unmatched-host": "host",
};

function sourceLabel(
  evidence: ScalarEvidence<string | number> | CapabilityEvidence | undefined,
): string | undefined {
  if (!evidence || evidence.state === "unknown") return undefined;
  return EVIDENCE_LABELS[evidence.source];
}

function evidencedValue(
  value: string,
  evidence: ScalarEvidence<string | number> | undefined,
): string {
  const source = sourceLabel(evidence);
  const safeValue = sanitizeInlineValue(value);
  return source ? `${safeValue} [${source}]` : safeValue;
}

function capabilityValue(evidence: CapabilityEvidence): string {
  const source = sourceLabel(evidence);
  const state = sanitizeInlineValue(evidence.state);
  return source ? `${state} [${source}]` : state;
}

const MODEL_ROW_INDENT = "  ";
const MODEL_TYPE_COLUMNS = 9; // "embedding"
const MODEL_CONTEXT_COLUMNS = 8; // "ctx 131K"
const MODEL_COLUMN_GAP = "  ";
const MODEL_NAME_MIN_COLUMNS = 8;
/**
 * Deliberate readable ceiling for the name column. On wide terminals the
 * spare width is left unused after the last column instead of stretching the
 * name column, which would push type/context/core far from the names.
 */
const MODEL_NAME_MAX_COLUMNS = 40;

/**
 * Indented columnar model row under its provider header. The provider name is
 * intentionally omitted: the header row above already carries it.
 */
function modelDisplayRow(
  model: ModelRow,
  coverage: CoreMetadataCoverage,
  width: number,
): string {
  const tail = [
    `core ${coverage.known}/${coverage.total}`,
    ...(model.enabled ? [] : ["disabled"]),
  ];
  const fixedColumns =
    MODEL_ROW_INDENT.length +
    MODEL_COLUMN_GAP.length * (2 + tail.length) +
    MODEL_TYPE_COLUMNS +
    MODEL_CONTEXT_COLUMNS +
    stringWidth(tail.join(""));
  const nameColumns = Math.min(
    MODEL_NAME_MAX_COLUMNS,
    Math.max(MODEL_NAME_MIN_COLUMNS, width - fixedColumns),
  );
  const row = [
    MODEL_ROW_INDENT + paddedColumn(model.name, nameColumns),
    paddedColumn(model.type ?? "unknown", MODEL_TYPE_COLUMNS),
    paddedColumn(
      model.context === undefined
        ? "ctx —"
        : `ctx ${compactCount(model.context)}`,
      MODEL_CONTEXT_COLUMNS,
    ),
    ...tail,
  ].join(MODEL_COLUMN_GAP);
  return bounded(row, width).trimEnd();
}

function modelDetail(group: ProviderGroup, model: ModelRow): string {
  const coverage = coreMetadataCoverage(model);
  const summary = [
    model.type ? sanitizeInlineValue(model.type) : "unknown type",
    model.context === undefined
      ? undefined
      : `ctx ${compactCount(model.context)}`,
    model.output === undefined
      ? undefined
      : `out ${compactCount(model.output)}`,
    `core ${coverage.known}/${coverage.total}`,
    model.origin ? sanitizeInlineValue(model.origin) : undefined,
    model.enabled ? undefined : "disabled",
  ].filter((part): part is string => Boolean(part));
  const lines = [
    sanitizeInlineValue(model.name),
    `Provider: ${sanitizeInlineValue(group.provider)} · Model ID: ${evidencedValue(model.id, model.provenance?.identity)}`,
    summary.join(" · "),
    "",
    "Capabilities",
  ];

  const unknownState: CapabilityEvidence = { state: "unknown" };
  if (model.type === "embedding") {
    lines.push("Chat capabilities: not applicable");
  } else if (model.capabilities) {
    lines.push(
      `Tools: ${capabilityValue(model.capabilities.toolCall)} · Reasoning: ${capabilityValue(model.capabilities.reasoning)}`,
      `Temperature: ${capabilityValue(model.capabilities.temperature)}`,
    );
  } else if (model.flags.length > 0) {
    lines.push(model.flags.map(sanitizeInlineValue).join(" · "));
  } else {
    lines.push("Tools: unknown · Reasoning: unknown · Temperature: unknown");
  }
  const input = model.inputModalities;
  lines.push(
    `Image input: ${capabilityValue(input?.image ?? unknownState)} · PDF input: ${capabilityValue(input?.pdf ?? unknownState)}`,
    `Audio input: ${capabilityValue(input?.audio ?? unknownState)} · Video input: ${capabilityValue(input?.video ?? unknownState)}`,
  );

  lines.push("", "Cost (USD per 1M tokens)", ...costLines(model.cost));

  lines.push("", "Metadata");
  if (!model.enabled) lines.push("Enabled: no (hidden from the model picker)");
  if (model.type)
    lines.push(`Type: ${evidencedValue(model.type, model.provenance?.type)}`);
  if (model.context !== undefined)
    lines.push(
      `Context: ${evidencedValue(compactCount(model.context), model.provenance?.context)}`,
    );
  if (model.output !== undefined)
    lines.push(
      `Max output: ${evidencedValue(compactCount(model.output), model.provenance?.output)}`,
    );
  if (model.sizeBytes !== undefined)
    lines.push(
      `Size: ${evidencedValue(formatBytes(model.sizeBytes), model.provenance?.sizeBytes)}`,
    );
  const descriptors = [
    model.family
      ? `Family ${evidencedValue(model.family, model.provenance?.family)}`
      : undefined,
    model.parameterSize
      ? `Parameters ${evidencedValue(model.parameterSize, model.provenance?.parameterSize)}`
      : undefined,
    model.quantization
      ? `Quantization ${evidencedValue(model.quantization, model.provenance?.quantization)}`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  if (descriptors.length > 0) lines.push(descriptors.join(" · "));
  if (model.probeIdentity)
    lines.push(
      `Probe identity: ${evidencedValue(model.probeIdentity, model.provenance?.probeIdentity)}`,
    );
  lines.push(
    `Missing core: ${coverage.missing.length > 0 ? coverage.missing.join(", ") : "none"}`,
  );
  if (group.endpoint)
    lines.push(`Endpoint: ${sanitizeInlineValue(group.endpoint)}`);

  const warnings = new Set([
    ...(group.warnings ?? []),
    ...(model.warnings ?? []),
  ]);
  if (warnings.size > 0) {
    lines.push("", "Warnings");
    for (const warning of warnings)
      lines.push(`• ${sanitizeInlineValue(warning)}`);
  }
  lines.push(
    "",
    "Sources: probe · config · server · models.dev · heuristic · default · host default · host",
  );
  return lines.join("\n");
}

function priceValue(evidence: ScalarEvidence<number>): string {
  if (evidence.state === "unknown") return "unknown";
  return evidencedValue(
    `$${Number(evidence.value.toFixed(6)).toString()}`,
    evidence,
  );
}

function costLines(cost: CostEvidence | undefined): string[] {
  if (
    !cost ||
    Object.values(cost).every(
      (price: ScalarEvidence<number>) => price.state === "unknown",
    )
  )
    return ["Prices: unknown"];
  return [
    `Input: ${priceValue(cost.input)} · Output: ${priceValue(cost.output)}`,
    `Cache read: ${priceValue(cost.cacheRead)} · Cache write: ${priceValue(cost.cacheWrite)}`,
  ];
}

function capabilityEvidence(
  model: ModelRow,
  facet: CapabilityNameFacet,
): CapabilityEvidence[] {
  if (model.type === "embedding") return [];
  const unknownState: CapabilityEvidence = { state: "unknown" };
  const image = model.inputModalities?.image ?? unknownState;
  const toolCall = model.capabilities?.toolCall ?? unknownState;
  const reasoning = model.capabilities?.reasoning ?? unknownState;
  const temperature = model.capabilities?.temperature ?? unknownState;
  switch (facet) {
    case "image":
      return [image];
    case "tools":
      return [toolCall];
    case "reasoning":
      return [reasoning];
    case "temperature":
      return [temperature];
    case "any":
      return [image, toolCall, reasoning, temperature];
  }
}

function modelMatchesFacets(
  group: ProviderGroup,
  model: ModelRow,
  facets: BrowserFacets,
  coverage: CoreMetadataCoverage = coreMetadataCoverage(model),
): boolean {
  if (facets.provider !== "all" && facets.provider !== group.id) return false;
  const type = model.type ?? "unknown";
  if (facets.type !== "all" && facets.type !== type) return false;
  if (facets.capabilityState !== "any") {
    const evidence = capabilityEvidence(model, facets.capability);
    if (!evidence.some((item) => item.state === facets.capabilityState))
      return false;
  }
  if (facets.metadata === "complete-core" && !coverage.complete) return false;
  if (facets.metadata === "missing-core" && coverage.complete) return false;
  const origin = model.origin ?? "unknown";
  return facets.origin === "all" || facets.origin === origin;
}

type EvidenceState = CapabilityEvidence["state"];

export interface ProviderSummary {
  modelCount: number;
  origins: Record<"discovered" | "pre-existing" | "unknown", number>;
  completeCore: number;
  missingCore: number;
  commonMissing: Array<{ field: CoreMetadataName; count: number }>;
  capabilities: Record<
    CapabilityNameFacet,
    Record<EvidenceState, number> & { applicable: number }
  >;
}

const CAPABILITY_NAMES = [
  "image",
  "tools",
  "reasoning",
  "temperature",
] as const;

/** Pure provider aggregation used by header rows and diagnostics views. */
export function summarizeProvider(group: ProviderGroup): ProviderSummary {
  const origins = { discovered: 0, "pre-existing": 0, unknown: 0 };
  const missing = new Map<CoreMetadataName, number>();
  const capabilities = Object.fromEntries(
    ["any", ...CAPABILITY_NAMES].map((name) => [
      name,
      { applicable: 0, supported: 0, unsupported: 0, unknown: 0 },
    ]),
  ) as ProviderSummary["capabilities"];
  let completeCore = 0;
  for (const model of group.models) {
    origins[model.origin ?? "unknown"] += 1;
    const coverage = coreMetadataCoverage(model);
    if (coverage.complete) completeCore += 1;
    for (const field of coverage.missing)
      missing.set(field, (missing.get(field) ?? 0) + 1);
    if (model.type === "embedding") continue;
    for (const name of CAPABILITY_NAMES) {
      const evidence = capabilityEvidence(model, name)[0] ?? {
        state: "unknown" as const,
      };
      capabilities[name].applicable += 1;
      capabilities[name][evidence.state] += 1;
      capabilities.any.applicable += 1;
      capabilities.any[evidence.state] += 1;
    }
  }
  return {
    modelCount: group.models.length,
    origins,
    completeCore,
    missingCore: group.models.length - completeCore,
    commonMissing: [...missing]
      .map(([field, count]) => ({ field, count }))
      .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field)),
    capabilities,
  };
}

/**
 * Permanent textual header affordance: unselected provider rows must still
 * read as headers next to indented model rows, independent of the Select's
 * own selected-row gutter.
 */
const PROVIDER_HEADER_PREFIX = "▸ ";

interface ProviderHeaderCounts {
  visibleModels: number;
  totalModels: number;
  /** Complete-core count among the surviving (visible) child models. */
  completeVisible: number;
}

/**
 * Header row built from the surviving child models of the active projection.
 * When search or facets hide children, the count cell shows `visible/total`
 * and core coverage describes the visible children only; full-catalog
 * diagnostics stay on the provider detail screen.
 */
function providerDisplayRow(
  group: ProviderGroup,
  counts: ProviderHeaderCounts,
  width: number,
): string {
  const countCell =
    counts.visibleModels === counts.totalModels
      ? plural(counts.totalModels, "model")
      : `${counts.visibleModels}/${counts.totalModels} models`;
  return bounded(
    PROVIDER_HEADER_PREFIX +
      [
        group.provider,
        countCell,
        `core ${counts.completeVisible}/${counts.visibleModels}`,
        `discovery ${discoveryStatus(group)}`,
      ].join(" · "),
    width,
  );
}

/** Latest attempt outcome: its failure kind, else the model list result. */
function discoveryStatus(group: ProviderGroup): string {
  if (group.failure) return `failed (${group.failure.kind})`;
  return group.modelListAttempt ?? "unknown";
}

function providerDetail(
  group: ProviderGroup,
  summary: ProviderSummary = summarizeProvider(group),
): string {
  const typeCounts = new Map<string, number>();
  const families = new Set<string>();
  for (const model of group.models) {
    const type = model.type ? sanitizeInlineValue(model.type) : "unknown";
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    if (model.family) families.add(sanitizeInlineValue(model.family));
  }

  const lines = [
    sanitizeInlineValue(group.provider),
    `Provider ID: ${sanitizeInlineValue(group.id)}`,
    `${plural(summary.modelCount, "model")} · core ${summary.completeCore}/${summary.modelCount} · discovery ${sanitizeInlineValue(discoveryStatus(group))}`,
    "",
    "Discovery",
    `Model list: ${group.modelListAttempt ? sanitizeInlineValue(group.modelListAttempt) : "unknown"} · Probe: ${group.probeAttempt ? sanitizeInlineValue(group.probeAttempt) : "unknown"}`,
  ];
  if (group.hasEvidence)
    lines.push(
      `Last good inventory: ${group.lastGoodAt ? sanitizeInlineValue(group.lastGoodAt) : "none yet"}`,
    );
  if (group.failure)
    lines.push(
      `Latest attempt failed: ${sanitizeInlineValue(group.failure.kind)} at ${sanitizeInlineValue(group.failure.at)}`,
    );
  if (group.configuredProbe || group.resolvedProbe)
    lines.push(
      `Probe selection: ${group.configuredProbe ? sanitizeInlineValue(group.configuredProbe) : "auto"} → ${group.resolvedProbe ? sanitizeInlineValue(group.resolvedProbe) : "unresolved"}`,
    );
  if (group.endpoint)
    lines.push(`Endpoint: ${sanitizeInlineValue(group.endpoint)}`);
  lines.push(
    `Origin: discovered ${summary.origins.discovered} · configured ${summary.origins["pre-existing"]} · unknown ${summary.origins.unknown}`,
    "",
    "Coverage",
  );
  if (typeCounts.size > 0)
    lines.push(
      `Types: ${[...typeCounts].map(([type, count]) => `${type} ${count}`).join(" · ")}`,
    );
  if (summary.commonMissing.length > 0)
    lines.push(
      `Missing core: ${summary.commonMissing
        .slice(0, 4)
        .map(({ field, count }) => `${field} ${count}`)
        .join(" · ")}`,
    );
  else lines.push("Missing core: none");
  lines.push("", "Capabilities");
  for (const name of CAPABILITY_NAMES) {
    const counts = summary.capabilities[name];
    lines.push(
      `${name[0]?.toUpperCase()}${name.slice(1)}: ${counts.supported} supported · ${counts.unsupported} unsupported · ${counts.unknown} unknown`,
    );
  }
  if (families.size > 0)
    lines.push("", `Families: ${[...families].join(", ")}`);
  const warnings = new Set(group.warnings ?? []);
  if (warnings.size > 0) {
    lines.push("", "Warnings");
    for (const warning of warnings)
      lines.push(`• ${sanitizeInlineValue(warning)}`);
  }
  lines.push(
    "",
    `Evidence: ${group.hasEvidence ? "server discovery catalog plus host state" : "host state only"}`,
  );
  return lines.join("\n");
}

const TYPE_CYCLE: readonly ModelTypeFacet[] = [
  "all",
  "llm",
  "vlm",
  "embedding",
  "unknown",
];
const CAPABILITY_CYCLE: readonly CapabilityNameFacet[] = [
  "any",
  "image",
  "tools",
  "reasoning",
  "temperature",
];
const CAPABILITY_STATE_CYCLE: readonly CapabilityStateFacet[] = [
  "any",
  "supported",
  "unsupported",
  "unknown",
];
const METADATA_CYCLE: readonly MetadataFacet[] = [
  "any",
  "complete-core",
  "missing-core",
];
const ORIGIN_CYCLE: readonly OriginFacet[] = [
  "all",
  "discovered",
  "pre-existing",
  "unknown",
];

interface IndexedModel {
  group: ProviderGroup;
  model: ModelRow;
  coverage: CoreMetadataCoverage;
  searchText: string;
  item: BrowserItem;
}

interface IndexedProvider {
  group: ProviderGroup;
  summary: ProviderSummary;
  /** Provider-own fields only; child-model matches surface through children. */
  selfSearchText: string;
  /** Projection-time header row reflecting the surviving child models. */
  headerItem: (counts: ProviderHeaderCounts) => BrowserItem;
  models: readonly IndexedModel[];
}

interface BrowserIndex {
  providers: readonly IndexedProvider[];
  totalModels: number;
  originFilterAvailable: boolean;
  textWidth: number;
}

/**
 * Columns the OpenTUI Select consumes around each option row: the selection
 * gutter, internal padding, and the scroll indicator. Option rows budgeted to
 * the full textWidth lose their trailing column (the `core k/n` cell) behind
 * that chrome, so display rows must reserve these columns.
 */
const SELECT_CHROME_COLUMNS = 4;

function buildBrowserIndex(
  groups: readonly ProviderGroup[],
  textWidth = 76,
  rowWidth = Math.max(1, textWidth - SELECT_CHROME_COLUMNS),
): BrowserIndex {
  const providers: IndexedProvider[] = [];
  let totalModels = 0;
  for (const group of groups) {
    const models: IndexedModel[] = [];
    for (const model of group.models) {
      const coverage = coreMetadataCoverage(model);
      const item: BrowserItem = {
        key: modelKey(group, model),
        kind: "model",
        name: model.name,
        displayRow: modelDisplayRow(model, coverage, rowWidth),
        get detail() {
          return modelDetail(group, model);
        },
      };
      models.push({
        group,
        model,
        coverage,
        searchText: normalizedSearchText(modelSearchFields(group, model)),
        item,
      });
      totalModels += 1;
    }
    const summary = summarizeProvider(group);
    let detail: string | undefined;
    const headerItem = (counts: ProviderHeaderCounts): BrowserItem => ({
      key: providerKey(group),
      kind: "provider",
      name: group.provider,
      displayRow: providerDisplayRow(group, counts, rowWidth),
      get detail() {
        detail ??= providerDetail(group, summary);
        return detail;
      },
    });
    providers.push({
      group,
      summary,
      selfSearchText: normalizedSearchText(
        [group.provider, group.id, group.endpoint].filter(
          (field): field is string => Boolean(field),
        ),
      ),
      headerItem,
      models,
    });
  }
  return {
    providers,
    totalModels,
    originFilterAvailable: groups.some((group) => group.hasEvidence),
    textWidth,
  };
}

function nextValue<T extends string>(values: readonly T[], current: T): T {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length] ?? values[0];
}

/** Cycle one facet without mutating state. */
export function cycleBrowserFacet(
  facets: BrowserFacets,
  key: BrowserFacetKey,
  groups: readonly ProviderGroup[],
  originAvailable: boolean,
): BrowserFacets {
  switch (key) {
    case "provider": {
      const providers = ["all", ...groups.map((group) => group.id)];
      return { ...facets, provider: nextValue(providers, facets.provider) };
    }
    case "type":
      return { ...facets, type: nextValue(TYPE_CYCLE, facets.type) };
    case "capability":
      return {
        ...facets,
        capability: nextValue(CAPABILITY_CYCLE, facets.capability),
      };
    case "capabilityState":
      return {
        ...facets,
        capabilityState: nextValue(
          CAPABILITY_STATE_CYCLE,
          facets.capabilityState,
        ),
      };
    case "metadata":
      return {
        ...facets,
        metadata: nextValue(METADATA_CYCLE, facets.metadata),
      };
    case "origin":
      return originAvailable
        ? { ...facets, origin: nextValue(ORIGIN_CYCLE, facets.origin) }
        : { ...facets, origin: "all" };
  }
}

function humanFacetParts(
  facets: BrowserFacets,
  originAvailable: boolean,
): string[] {
  const parts: string[] = [];
  if (facets.provider !== "all") parts.push(`provider ${facets.provider}`);
  if (facets.type !== "all") parts.push(`type ${facets.type}`);
  if (facets.capability !== "any")
    parts.push(`capability ${facets.capability}`);
  if (facets.capabilityState !== "any")
    parts.push(`capability is ${facets.capabilityState}`);
  if (facets.metadata === "complete-core") parts.push("core metadata complete");
  if (facets.metadata === "missing-core") parts.push("core metadata missing");
  if (originAvailable && facets.origin !== "all")
    parts.push(`origin ${facets.origin}`);
  return parts;
}

/** One bounded, non-focusable row describing the active model facets. */
export function browserFilterSummary(
  facets: BrowserFacets,
  originAvailable: boolean,
  maxWidth = 76,
): string {
  const parts = humanFacetParts(facets, originAvailable);
  return bounded(
    parts.length === 0 ? "Filters: none" : `Filters: ${parts.join(" · ")}`,
    maxWidth,
  );
}

function facetsAtDefault(facets: BrowserFacets): boolean {
  return JSON.stringify(facets) === JSON.stringify(INITIAL_BROWSER_FACETS);
}

/** Model-level facets only; the provider facet is checked separately. */
function modelFacetsAtDefault(facets: BrowserFacets): boolean {
  return facetsAtDefault({ ...facets, provider: "all" });
}

/**
 * Project reconciled groups into one unified, searchable grouped list: a
 * selectable header row per visible provider followed by its matching models.
 */
export function projectBrowser(
  groups: readonly ProviderGroup[],
  query: string,
  facets: BrowserFacets = INITIAL_BROWSER_FACETS,
  index: BrowserIndex = buildBrowserIndex(groups),
): BrowserProjection {
  const items: BrowserItem[] = [];
  const originFilterAvailable = index.originFilterAvailable;
  const effectiveFacets = originFilterAvailable
    ? facets
    : { ...facets, origin: "all" as const };
  const defaultFacets = facetsAtDefault(effectiveFacets);
  const terms = queryTerms(query);
  let visibleModels = 0;
  let missingCoreCount = 0;
  let providerCount = 0;

  const defaultModelFacets = modelFacetsAtDefault(effectiveFacets);
  for (const provider of index.providers) {
    if (
      effectiveFacets.provider !== "all" &&
      effectiveFacets.provider !== provider.group.id
    )
      continue;
    // A provider-own search hit cascades to its children: the query selects
    // the provider, and active model facets keep narrowing its models even
    // when each model's own text does not contain the provider query.
    const selfMatch =
      terms.length > 0 && matchesQuery(provider.selfSearchText, terms);
    const children = provider.models.filter(
      (entry) =>
        (selfMatch || matchesQuery(entry.searchText, terms)) &&
        modelMatchesFacets(
          entry.group,
          entry.model,
          effectiveFacets,
          entry.coverage,
        ),
    );
    // A childless header stays visible only when it is itself the relevant
    // result — a direct search hit, or reachable without any search — and no
    // active model facet excludes every child. The provider facet alone never
    // hides a directly selected zero-model/error provider.
    const selfVisible = terms.length > 0 ? selfMatch : true;
    if (children.length === 0 && !(selfVisible && defaultModelFacets)) continue;
    providerCount += 1;
    let completeVisible = 0;
    for (const child of children)
      if (child.coverage.complete) completeVisible += 1;
    items.push(
      provider.headerItem({
        visibleModels: children.length,
        totalModels: provider.models.length,
        completeVisible,
      }),
    );
    for (const child of children) {
      visibleModels += 1;
      if (!child.coverage.complete) missingCoreCount += 1;
      items.push(child.item);
    }
  }

  const filterSummary = browserFilterSummary(
    effectiveFacets,
    originFilterAvailable,
    index.textWidth,
  );
  const filtered = terms.length > 0 || !defaultFacets;
  return {
    query,
    items,
    emptyMessage:
      groups.length === 0
        ? "No models available."
        : filtered
          ? `No matches. ${filterSummary}`
          : "No models available.",
    filterSummary,
    originFilterAvailable,
    summary: {
      visibleModels,
      totalModels: index.totalModels,
      providerCount,
      missingCoreCount,
    },
  };
}

export function reduceBrowserState(
  state: BrowserState,
  event: BrowserEvent,
): BrowserState {
  switch (event.type) {
    case "search":
      return { ...state, query: event.query, screen: "list" };
    case "highlight":
      return { ...state, selected: event.key };
    case "show":
      return { ...state, screen: event.screen };
    case "focus":
      return { ...state, focus: event.target };
    case "facets":
      return { ...state, facets: event.facets, screen: "list" };
  }
}

/** Resolve a remembered stable key to a valid list selection. */
export function resolveSelection(
  projection: BrowserProjection,
  selectedKey: string | undefined,
): { index: number; item: BrowserItem | undefined } {
  if (projection.items.length === 0) return { index: 0, item: undefined };
  const found = selectedKey
    ? projection.items.findIndex((item) => item.key === selectedKey)
    : -1;
  const index = found >= 0 ? found : 0;
  return { index, item: projection.items[index] };
}

export interface BrowserTheme {
  text: ColorInput;
  textMuted: ColorInput;
  primary: ColorInput;
  accent: ColorInput;
  /** Host dialog surface; keeps the select visually one panel with the host. */
  backgroundPanel: ColorInput;
  backgroundElement: ColorInput;
  selectedListItemText: ColorInput;
}

export interface BrowserViewOptions {
  groups: readonly ProviderGroup[];
  theme: BrowserTheme;
  /** Total content rows available inside the host dialog. */
  maxHeight?: number;
  /** Bounded content columns available inside the host dialog. */
  width?: number;
  keyInput: Pick<KeyHandler, "on" | "off">;
  /** Status shown right after the title, before the summary counts. */
  notice?: string;
  /** Called on Shift+R outside the search input; enables the hint. */
  onRefresh?: () => void;
}

export interface BrowserView {
  root: TuiNode<"box">;
  state: () => BrowserState;
  /**
   * Replace the rows in place, keeping query, facets, selection, and screen.
   * Only mutates existing nodes, so it is safe outside the render scope.
   */
  update: (groups: readonly ProviderGroup[], notice?: string) => void;
  setNotice: (notice: string | undefined) => void;
  dispose: () => void;
}

const DEFAULT_CONTENT_HEIGHT = 18;
const DEFAULT_CONTENT_WIDTH = 80;
const MAX_CONTENT_WIDTH = 120;

export interface FooterContext {
  screen: BrowserScreen;
  focus: FocusTarget;
  width: number;
  multiProvider: boolean;
  hasItems: boolean;
  /** The zero-item list remains a valid recovery focus target (facet-empty). */
  listRecoverable: boolean;
  /** Discovery evidence exists, so the `o` facet key does something. */
  originFilterAvailable: boolean;
  /** Shift+R requests a server refresh. */
  refreshAvailable?: boolean;
}

/**
 * Focus-aware footer. Every advertised key must work in the advertised
 * focus/screen combination:
 * - Search focus advertises only the actions the search input honors,
 *   including the enter/arrow exit to a zero-item but recoverable list.
 * - Facet keys advertise `p` only for multi-provider catalogs and `o` only
 *   when discovery evidence supplies model origins.
 * - List and detail footers degrade full → medium → compact; the medium
 *   variant fits the 70-column text budget of an 80-column terminal while
 *   still exposing the facet shortcuts and reset. The refresh hint appears
 *   only in the full variant.
 */
export function footerContent(context: FooterContext): string {
  const {
    screen,
    focus,
    width,
    multiProvider,
    hasItems,
    listRecoverable,
    originFilterAvailable,
    refreshAvailable = false,
  } = context;
  if (focus === "search") {
    const hint = hasItems
      ? "enter results · ↑/↓ results · esc close"
      : listRecoverable
        ? "enter filters · ↑/↓ filters · esc close"
        : "esc close";
    return bounded(hint, width);
  }
  const facetKeys = [
    ...(multiProvider ? ["p"] : []),
    "t",
    "c",
    "s",
    "m",
    ...(originFilterAvailable ? ["o"] : []),
  ].join("/");
  if (screen === "list" && !hasItems) {
    // Facet-empty recovery: only facet cycling, reset, search, and close work.
    const variants = [
      ...(refreshAvailable
        ? [`/ search · ${facetKeys} filters · r reset · R refresh · esc close`]
        : []),
      `/ search · ${facetKeys} filters · r reset · esc close`,
      `/ search · ${facetKeys} · r reset · esc close`,
      "r reset · esc close",
    ];
    const fit = variants.find((variant) => stringWidth(variant) <= width);
    return bounded(fit ?? variants[variants.length - 1] ?? "", width);
  }
  const variants =
    screen === "list"
      ? [
          ...(refreshAvailable
            ? [
                `↑/↓ navigate · enter open · / search · ${facetKeys} filters · r reset · R refresh · esc close`,
              ]
            : []),
          `↑/↓ navigate · enter open · / search · ${facetKeys} filters · r reset · esc close`,
          `↑/↓ · enter open · / search · ${facetKeys} · r reset · esc close`,
          "↑/↓ move · enter open · / search · esc close",
        ]
      : [
          ...(refreshAvailable
            ? [
                `↑/↓ scroll · backspace list · / search · ${facetKeys} filters · r reset · R refresh · esc close`,
              ]
            : []),
          `↑/↓ scroll · backspace list · / search · ${facetKeys} filters · r reset · esc close`,
          `↑/↓ scroll · backspace · / search · ${facetKeys} · r reset · esc`,
          "↑/↓ scroll · backspace list · / search · esc close",
        ];
  const fit = variants.find((variant) => stringWidth(variant) <= width);
  return bounded(fit ?? variants[variants.length - 1] ?? "", width);
}

export interface BrowserLayoutBudget {
  summaryRows: number;
  searchRows: number;
  filterRows: number;
  footerRows: number;
  viewportHeight: number;
  listHeight: number;
  rootHeight: number;
}

function positiveFloor(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

/** Compose fixed chrome within, never above, the supplied total height. */
export function browserLayoutBudget(maxHeight?: number): BrowserLayoutBudget {
  const rootHeight = positiveFloor(maxHeight, DEFAULT_CONTENT_HEIGHT);
  const searchRows = rootHeight >= 2 ? 1 : 0;
  const summaryRows = rootHeight >= 3 ? 1 : 0;
  const filterRows = rootHeight >= 4 ? 1 : 0;
  const footerRows = rootHeight >= 5 ? 1 : 0;
  const fixedRows = searchRows + summaryRows + filterRows + footerRows;
  const viewportHeight = Math.max(1, rootHeight - fixedRows);
  return {
    summaryRows,
    searchRows,
    filterRows,
    footerRows,
    viewportHeight,
    listHeight: rootHeight - footerRows,
    rootHeight,
  };
}

function browserContentWidth(width?: number): number {
  return Math.min(
    MAX_CONTENT_WIDTH,
    positiveFloor(width, DEFAULT_CONTENT_WIDTH),
  );
}

function asSelectOptions(items: readonly BrowserItem[]): SelectOption[] {
  return items.map((item) => ({
    name: item.displayRow,
    description: "",
    value: item.key,
  }));
}

function consumeKey(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}

function hasCommandModifier(key: KeyEvent): boolean {
  return Boolean(key.ctrl || key.meta || key.option || key.super || key.hyper);
}

/** Build the unified grouped list/detail browser from reconciled rows. */
export function buildBrowserView(
  renderer: TuiRenderer,
  options: BrowserViewOptions,
): BrowserView {
  const { theme, keyInput, onRefresh } = options;
  const layout = browserLayoutBudget(options.maxHeight);
  const contentWidth = browserContentWidth(options.width);
  const textWidth = Math.max(1, contentWidth - 8);
  let groups = options.groups;
  let notice = options.notice;
  let browserIndex = buildBrowserIndex(groups, textWidth);
  let multiProvider = groups.length > 1;
  let state = INITIAL_BROWSER_STATE;
  let projection = projectBrowser(
    groups,
    state.query,
    state.facets,
    browserIndex,
  );
  state = reduceBrowserState(state, {
    type: "focus",
    target: projection.items.length > 0 ? "list" : "search",
  });

  const recordFocus = (target: FocusTarget): void => {
    state = reduceBrowserState(state, { type: "focus", target });
    refreshFooter();
  };

  const summaryText = renderer.create("text", {
    id: "modelscout-summary",
    fg: theme.text,
    content: "",
    height: 1,
    maxHeight: 1,
    overflow: "hidden",
  });
  const filterText = renderer.create("text", {
    id: "modelscout-filter-summary",
    fg: theme.textMuted,
    content: projection.filterSummary,
    height: 1,
    maxHeight: 1,
    overflow: "hidden",
  });
  const emptyText = renderer.create("text", {
    id: "modelscout-empty",
    fg: theme.textMuted,
    content: bounded(projection.emptyMessage, textWidth),
    height: 1,
    maxHeight: 1,
    overflow: "hidden",
    visible: false,
  });
  const detailText = renderer.create("text", {
    id: "modelscout-detail-text",
    fg: theme.text,
    content: "",
  });
  const footerText = renderer.create("text", {
    id: "modelscout-footer-text",
    fg: theme.textMuted,
    content: "",
    height: 1,
    maxHeight: 1,
    overflow: "hidden",
  });

  function refreshFooter(): void {
    renderer.set(
      footerText,
      "content",
      footerContent({
        screen: state.screen,
        focus: state.focus,
        width: textWidth,
        multiProvider,
        hasItems: projection.items.length > 0,
        listRecoverable: canRecoverFacetEmptyList(),
        originFilterAvailable: projection.originFilterAvailable,
        refreshAvailable: onRefresh !== undefined,
      }),
    );
  }

  const selectByIndex = (index: number): void => {
    const item = projection.items[index];
    if (!item) return;
    state = reduceBrowserState(state, { type: "highlight", key: item.key });
  };

  const list = renderer.create("select", {
    id: "modelscout-results",
    options: asSelectOptions(projection.items),
    selectedIndex: 0,
    height: layout.viewportHeight,
    maxHeight: layout.viewportHeight,
    showDescription: false,
    showScrollIndicator: true,
    wrapSelection: false,
    backgroundColor: theme.backgroundPanel,
    focusedBackgroundColor: theme.backgroundPanel,
    selectedBackgroundColor: theme.primary,
    textColor: theme.text,
    focusedTextColor: theme.text,
    selectedTextColor: theme.selectedListItemText,
    focused: state.focus === "list",
    "on:focused": () => recordFocus("list"),
    onChange: (index) => selectByIndex(index),
    onSelect: (index) => {
      selectByIndex(index);
      const item = projection.items[index];
      if (!item) return;
      renderer.set(detailText, "content", item.detail);
      state = reduceBrowserState(state, { type: "show", screen: "detail" });
      refresh();
      focus("detail");
    },
  });

  const search = renderer.create("input", {
    id: "modelscout-search",
    width: "100%",
    value: "",
    placeholder: "Search models and providers",
    textColor: theme.text,
    focusedTextColor: theme.text,
    placeholderColor: theme.textMuted,
    "on:focused": () => recordFocus("search"),
    focused: state.focus === "search",
    onInput: (query) => updateQuery(query),
    onChange: (query) => updateQuery(query),
    onSubmit: () => {
      // The zero-item list stays a valid focus target during facet-empty
      // recovery so Enter can leave search and reach the facet shortcuts.
      if (visibleFocusTargets().includes("list")) focus("list");
    },
  });

  const summaryRow = renderer.create(
    "box",
    {
      id: "modelscout-summary-row",
      height: 1,
      maxHeight: 1,
      overflow: "hidden",
      visible: layout.summaryRows > 0,
      flexShrink: 0,
    },
    summaryText,
  );
  const searchRow = renderer.create(
    "box",
    {
      id: "modelscout-search-row",
      height: 1,
      maxHeight: 1,
      overflow: "hidden",
      visible: layout.searchRows > 0,
      flexShrink: 0,
    },
    search,
  );
  const filterRow = renderer.create(
    "box",
    {
      id: "modelscout-filter-row",
      height: 1,
      maxHeight: 1,
      overflow: "hidden",
      visible: layout.filterRows > 0,
      flexShrink: 0,
    },
    filterText,
  );
  const resultsPane = renderer.create(
    "box",
    {
      id: "modelscout-list-pane",
      width: "100%",
      height: layout.viewportHeight,
      maxHeight: layout.viewportHeight,
      flexDirection: "column",
      overflow: "hidden",
    },
    list,
    emptyText,
  );
  const listScreen = renderer.create(
    "box",
    {
      id: "modelscout-list-screen",
      width: "100%",
      height: layout.listHeight,
      maxHeight: layout.listHeight,
      flexDirection: "column",
      overflow: "hidden",
      visible: true,
    },
    summaryRow,
    searchRow,
    filterRow,
    resultsPane,
  );
  const detailPane = renderer.create(
    "scrollbox",
    {
      id: "modelscout-detail-screen",
      width: "100%",
      height: layout.listHeight,
      maxHeight: layout.listHeight,
      focused: false,
      visible: false,
      "on:focused": () => recordFocus("detail"),
      scrollbarOptions: { visible: false },
    },
    detailText,
  );
  const footer = renderer.create(
    "box",
    {
      id: "modelscout-footer-row",
      height: 1,
      maxHeight: 1,
      overflow: "hidden",
      visible: layout.footerRows > 0,
      flexShrink: 0,
    },
    footerText,
  );
  const root = renderer.create(
    "box",
    {
      id: "modelscout-browser",
      flexDirection: "column",
      // The numeric width behaves as content-box while the root also carries
      // 2-column left/right padding; subtract both pads so the outer width
      // (content + padding) stays at the requested contentWidth and the
      // select viewport/scrollbar cannot overhang the dialog on the right.
      width: Math.max(1, contentWidth - 4),
      height: layout.rootHeight,
      maxHeight: layout.rootHeight,
      overflow: "hidden",
      paddingLeft: 2,
      paddingRight: 2,
    },
    listScreen,
    detailPane,
    footer,
  );

  function updateQuery(query: string): void {
    if (state.query === query) return;
    state = reduceBrowserState(state, { type: "search", query });
    refresh();
  }

  function focusNodes(): Readonly<Record<FocusTarget, FocusNode>> {
    return { search, list, detail: detailPane };
  }

  function visibleFocusTargets(): FocusTarget[] {
    if (state.screen === "detail") return ["detail"];
    const targets: FocusTarget[] = [];
    if (layout.searchRows > 0) targets.push("search");
    if (projection.items.length > 0 || canRecoverFacetEmptyList())
      targets.push("list");
    return targets.length > 0 ? targets : ["list"];
  }

  /**
   * A facet action can empty the whole intersection — with or without an
   * active query. The list keeps shortcut focus so the user can continue
   * cycling facets or press `r`; ordinary typing is untouched because the
   * shortcut handler never runs while search owns focus. Recovery only
   * exists when resetting facets would actually reveal a result for the
   * current query — an unrelated no-match query stays search-owned because
   * `r` cannot surface anything.
   */
  function canRecoverFacetEmptyList(): boolean {
    if (
      groups.length === 0 ||
      projection.items.length > 0 ||
      facetsAtDefault(state.facets)
    )
      return false;
    return (
      projectBrowser(groups, state.query, INITIAL_BROWSER_FACETS, browserIndex)
        .items.length > 0
    );
  }

  function focus(target: FocusTarget): void {
    const visible = visibleFocusTargets();
    const next = visible.includes(target) ? target : (visible[0] ?? "list");
    state = reduceBrowserState(state, { type: "focus", target: next });
    for (const [name, node] of Object.entries(focusNodes()) as Array<
      [FocusTarget, FocusNode]
    >) {
      renderer.set(node, "focused", name === next);
    }
    refreshFooter();
  }

  function refresh(): void {
    projection = projectBrowser(
      groups,
      state.query,
      state.facets,
      browserIndex,
    );
    const selection = resolveSelection(projection, state.selected);
    if (selection.item && state.selected !== selection.item.key) {
      state = reduceBrowserState(state, {
        type: "highlight",
        key: selection.item.key,
      });
    }
    renderer.set(list, "options", asSelectOptions(projection.items));
    renderer.set(list, "selectedIndex", selection.index);
    renderer.set(list, "visible", projection.items.length > 0);
    renderer.set(emptyText, "visible", projection.items.length === 0);
    renderer.set(
      emptyText,
      "content",
      bounded(projection.emptyMessage, textWidth),
    );
    renderer.set(filterText, "content", projection.filterSummary);
    refreshSummary();
    if (state.screen === "list") {
      renderer.set(listScreen, "visible", true);
      renderer.set(detailPane, "visible", false);
    } else {
      renderer.set(listScreen, "visible", false);
      renderer.set(detailPane, "visible", true);
      renderer.set(
        detailText,
        "content",
        selection.item?.detail ?? projection.emptyMessage,
      );
    }
    if (!visibleFocusTargets().includes(state.focus)) {
      focus(
        state.screen === "detail"
          ? "detail"
          : projection.items.length > 0 || canRecoverFacetEmptyList()
            ? "list"
            : "search",
      );
    }
    refreshFooter();
  }

  function refreshSummary(): void {
    const summary = projection.summary;
    const providerPart = multiProvider
      ? ` · ${plural(summary.providerCount, "provider")}`
      : "";
    const noticePart = notice ? ` · ${notice}` : "";
    renderer.set(
      summaryText,
      "content",
      bounded(
        `Model Scout${noticePart} · ${summary.visibleModels}/${summary.totalModels} models${providerPart} · ${summary.missingCoreCount} missing core`,
        textWidth,
      ),
    );
  }

  function update(next: readonly ProviderGroup[], nextNotice?: string): void {
    groups = next;
    notice = nextNotice;
    browserIndex = buildBrowserIndex(groups, textWidth);
    multiProvider = groups.length > 1;
    if (
      state.facets.provider !== "all" &&
      !groups.some((group) => group.id === state.facets.provider)
    )
      state = reduceBrowserState(state, {
        type: "facets",
        facets: { ...state.facets, provider: "all" },
      });
    if (
      state.screen === "detail" &&
      !projectBrowser(
        groups,
        state.query,
        state.facets,
        browserIndex,
      ).items.some((item) => item.key === state.selected)
    )
      state = reduceBrowserState(state, { type: "show", screen: "list" });
    refresh();
  }

  function returnToListFocus(): void {
    focus(
      projection.items.length > 0 || canRecoverFacetEmptyList()
        ? "list"
        : "search",
    );
  }

  const onKeyPress = (key: KeyEvent): void => {
    if (hasCommandModifier(key)) return;
    const name = key.name.toLowerCase();
    const slash = name === "/" || name === "slash" || key.sequence === "/";
    if (slash && state.focus !== "search") {
      if (state.screen === "detail") {
        state = reduceBrowserState(state, { type: "show", screen: "list" });
        refresh();
      }
      focus("search");
      consumeKey(key);
      return;
    }

    const backspace =
      name === "backspace" || key.sequence === "\b" || key.sequence === "\x7f";
    if (backspace && state.screen === "detail") {
      state = reduceBrowserState(state, { type: "show", screen: "list" });
      refresh();
      returnToListFocus();
      consumeKey(key);
      return;
    }

    if (
      state.screen === "list" &&
      state.focus === "search" &&
      (name === "up" || name === "down") &&
      visibleFocusTargets().includes("list")
    ) {
      if (projection.items.length > 0) {
        const selection = resolveSelection(projection, state.selected);
        const direction = name === "down" ? 1 : -1;
        const index = Math.max(
          0,
          Math.min(projection.items.length - 1, selection.index + direction),
        );
        const item = projection.items[index];
        if (item)
          state = reduceBrowserState(state, {
            type: "highlight",
            key: item.key,
          });
        // Real OpenTUI emits onChange here; state is already synchronized so
        // the callback is idempotent rather than a second explicit selection.
        renderer.setSelectedIndex(list, index);
      }
      // With zero items the list is still the facet-empty recovery target:
      // move focus there so the facet shortcuts and `r` become reachable.
      focus("list");
      consumeKey(key);
      return;
    }

    if (state.focus === "search") return;
    if (name === "r" && (key.shift || key.sequence === "R")) {
      if (!onRefresh) return;
      onRefresh();
      consumeKey(key);
      return;
    }
    const shortcut: Partial<Record<string, BrowserFacetKey>> = {
      ...(multiProvider ? { p: "provider" as const } : {}),
      t: "type",
      c: "capability",
      s: "capabilityState",
      m: "metadata",
      ...(projection.originFilterAvailable ? { o: "origin" as const } : {}),
    };
    if (name === "r") {
      state = reduceBrowserState(state, {
        type: "facets",
        facets: INITIAL_BROWSER_FACETS,
      });
      refresh();
      returnToListFocus();
      consumeKey(key);
      return;
    }
    const facet = shortcut[name];
    if (!facet) return;
    state = reduceBrowserState(state, {
      type: "facets",
      facets: cycleBrowserFacet(
        state.facets,
        facet,
        groups,
        projection.originFilterAvailable,
      ),
    });
    refresh();
    returnToListFocus();
    consumeKey(key);
  };

  refresh();
  focus(state.focus);
  keyInput.on("keypress", onKeyPress);
  let disposed = false;
  return {
    root,
    state: () => state,
    update: (next, nextNotice) => {
      if (!disposed) update(next, nextNotice);
    },
    setNotice: (next) => {
      if (disposed) return;
      notice = next;
      refreshSummary();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      keyInput.off("keypress", onKeyPress);
    },
  };
}
