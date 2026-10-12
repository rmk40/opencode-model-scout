/**
 * models.dev fallback matcher built from the host's normalized provider
 * source records (`editor.provider.list()` inside a model transform).
 *
 * OpenCode 2 normalizes models.dev before plugins see it and drops the raw
 * `reasoning`, `temperature`, and `attachment` flags, so a match can supply
 * only tool support, input modalities, family, and a positive reasoning
 * signal. Limits are never taken from models.dev: they vary by provider and
 * quantization.
 */

/** What a models.dev match may contribute to a discovered model. */
export interface ModelsDevMatch {
  readonly tools: boolean;
  readonly input: readonly string[];
  readonly family?: string;
  /**
   * True when the matched record has effort variants. False means unknown,
   * not "no reasoning": the host derives variants per provider package.
   */
  readonly reasoning: boolean;
}

interface IndexEntry {
  readonly id: string;
  readonly normalized: string;
  readonly family?: string;
  readonly match: ModelsDevMatch;
}

export interface ModelsDevIndex {
  readonly entries: readonly IndexEntry[];
  readonly exact: ReadonlyMap<string, ModelsDevMatch>;
}

/** The subset of a host model record the index reads. */
export interface SourceModelLike {
  readonly family?: string;
  readonly capabilities: {
    readonly tools: boolean;
    readonly input: readonly string[];
  };
  readonly variants: readonly unknown[];
}

/** The subset of a host provider record the index reads. */
export interface SourceRecordLike {
  readonly provider: { readonly id: string };
  readonly models: ReadonlyMap<string, SourceModelLike>;
}

export const EMPTY_INDEX: ModelsDevIndex = Object.freeze({
  entries: Object.freeze([]) as readonly IndexEntry[],
  exact: new Map<string, ModelsDevMatch>(),
});

/**
 * Normalize a model ID for comparison: strip an owner prefix, replace `:`
 * with `-`, and lowercase. "qwen/qwen3-30b-a3b" → "qwen3-30b-a3b".
 */
function normalize(id: string): string {
  const slash = id.indexOf("/");
  const base = slash > 0 ? id.slice(slash + 1) : id;
  return base.toLowerCase().replace(/:/g, "-");
}

/** Leading letters of the normalized ID: "llama-3.2-3b" → "llama". */
function extractFamily(id: string): string {
  const normalized = normalize(id);
  const match = normalized.match(/^([a-z]+)/);
  return match?.[1] ?? normalized;
}

/** Parameter size: "qwen3:0.6b" → "0.6b", "smollm2:135m" → "135m". */
function extractSize(id: string): string | undefined {
  const normalized = normalize(id);
  const match = normalized.match(/(\d+\.?\d*[bm])\b/i);
  return match?.[1]?.toLowerCase();
}

function readMatch(model: SourceModelLike): ModelsDevMatch | undefined {
  const capabilities = model.capabilities as unknown;
  if (typeof capabilities !== "object" || capabilities === null)
    return undefined;
  const { tools, input } = capabilities as Record<string, unknown>;
  if (typeof tools !== "boolean" || !Array.isArray(input)) return undefined;
  const family =
    typeof model.family === "string" && model.family.length > 0
      ? model.family
      : undefined;
  return {
    tools,
    input: input.filter((value): value is string => typeof value === "string"),
    ...(family === undefined ? {} : { family }),
    reasoning: Array.isArray(model.variants) && model.variants.length > 0,
  };
}

const recordEntries = new WeakMap<SourceRecordLike, readonly IndexEntry[]>();

function entriesFor(record: SourceRecordLike): readonly IndexEntry[] {
  const cached = recordEntries.get(record);
  if (cached) return cached;
  const entries: IndexEntry[] = [];
  for (const [id, model] of record.models) {
    if (typeof id !== "string" || id.length === 0) continue;
    const match = readMatch(model);
    if (!match) continue;
    entries.push({
      id,
      normalized: normalize(id),
      ...(match.family === undefined ? {} : { family: match.family }),
      match,
    });
  }
  recordEntries.set(record, entries);
  return entries;
}

/** Build an index from provider records, in record order. */
export function buildModelsDevIndex(
  records: readonly SourceRecordLike[],
): ModelsDevIndex {
  const entries = records.flatMap((record) => entriesFor(record));
  const exact = new Map<string, ModelsDevMatch>();
  for (const entry of entries) {
    if (!exact.has(entry.normalized)) exact.set(entry.normalized, entry.match);
  }
  return { entries, exact };
}

/**
 * Memoized {@link buildModelsDevIndex}. The host returns a new array on
 * every call, so the cache compares the individual record identities: the
 * index is rebuilt only when a record was added, removed, or replaced.
 */
export function createModelsDevIndexCache(): (
  records: readonly SourceRecordLike[],
) => ModelsDevIndex {
  let lastRecords: readonly SourceRecordLike[] = [];
  let lastIndex: ModelsDevIndex | undefined;
  return (records) => {
    if (
      lastIndex !== undefined &&
      records.length === lastRecords.length &&
      records.every((record, index) => record === lastRecords[index])
    )
      return lastIndex;
    lastRecords = [...records];
    lastIndex = buildModelsDevIndex(records);
    return lastIndex;
  };
}

/**
 * Find the best models.dev match for a served model ID:
 * 1. exact normalized ID,
 * 2. family plus parameter size,
 * 3. family only.
 */
export function findModelsDevMatch(
  localId: string,
  index: ModelsDevIndex,
): ModelsDevMatch | undefined {
  if (index.entries.length === 0) return undefined;

  const localNorm = normalize(localId);
  const exact = index.exact.get(localNorm);
  if (exact) return exact;

  const localFamily = extractFamily(localId);
  const localSize = extractSize(localId);
  if (localSize) {
    // Word-boundary match so "4b" does not match inside "14b".
    const sizePattern = new RegExp(
      `(?:^|[^\\d])${localSize.replace(".", "\\.")}(?:$|[^\\d])`,
    );
    const familySize = index.entries.find(
      (entry) =>
        (entry.family?.toLowerCase() === localFamily ||
          entry.normalized.startsWith(localFamily)) &&
        sizePattern.test(entry.normalized),
    );
    if (familySize) return familySize.match;
  }

  const familyOnly = index.entries.find(
    (entry) =>
      entry.family?.toLowerCase() === localFamily ||
      entry.normalized.startsWith(localFamily + "-"),
  );
  return familyOnly?.match;
}
