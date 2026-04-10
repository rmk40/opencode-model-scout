import type { PluginInput } from "@opencode-ai/plugin";
import { LOG_PREFIX } from "./constants";

/**
 * Metadata extracted from a models.dev model entry.
 * Only capabilities that are safe to apply without a probe.
 * Context/output limits are NOT included — they vary by provider
 * and quantization, so the probe is the authoritative source.
 */
export interface ModelsDevMeta {
  toolCall: boolean;
  reasoning: boolean;
  attachment: boolean;
  temperature: boolean;
  family?: string;
  modalities?: {
    input: string[];
    output: string[];
  };
}

/** Flattened model entry from the provider list response. */
interface FlatModel {
  id: string;
  normalized: string;
  family?: string;
  meta: ModelsDevMeta;
}

/** Module-level cache — fetched once per plugin session. */
let cache: FlatModel[] | undefined;

/**
 * Normalize a model ID for comparison.
 * Strips owner prefix, replaces ':' with '-', lowercases.
 * "qwen/qwen3-30b-a3b" → "qwen3-30b-a3b"
 * "qwen3:0.6b" → "qwen3-0.6b"
 */
function normalize(id: string): string {
  const slash = id.indexOf("/");
  const base = slash > 0 ? id.slice(slash + 1) : id;
  return base.toLowerCase().replace(/:/g, "-");
}

/**
 * Extract family base from a model ID.
 * "qwen3:0.6b" → "qwen3"
 * "llama-3.2-3b-instruct" → "llama"
 * "deepseek-r1:7b" → "deepseek"
 */
function extractFamily(id: string): string {
  const normalized = normalize(id);
  // Take everything before the first number-with-suffix or size indicator
  const match = normalized.match(/^([a-z]+)/);
  return match?.[1] ?? normalized;
}

/**
 * Extract parameter size from a model ID.
 * "qwen3:0.6b" → "0.6b"
 * "qwen3-30b-a3b" → "30b"
 * "smollm2:135m" → "135m"
 */
function extractSize(id: string): string | undefined {
  const normalized = normalize(id);
  const match = normalized.match(/(\d+\.?\d*[bm])\b/i);
  return match?.[1]?.toLowerCase();
}

/**
 * Fetch models.dev data via the opencode SDK client and build
 * a flattened lookup index.
 */
export async function fetchModelsDevIndex(
  client: PluginInput["client"],
): Promise<FlatModel[]> {
  if (cache) return cache;

  try {
    const response = await client.provider.list();
    if (!response.data) return [];

    const flat: FlatModel[] = [];

    for (const provider of response.data.all) {
      for (const [, model] of Object.entries(provider.models)) {
        // Access the runtime object which includes family even though
        // the SDK type doesn't declare it
        const m = model as typeof model & { family?: string };

        flat.push({
          id: model.id,
          normalized: normalize(model.id),
          family: m.family,
          meta: {
            toolCall: model.tool_call,
            reasoning: model.reasoning,
            attachment: model.attachment,
            temperature: model.temperature,
            family: m.family,
            modalities: model.modalities,
          },
        });
      }
    }

    cache = flat;
    return flat;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to fetch models.dev index:`, error);
    return [];
  }
}

/**
 * Find the best models.dev match for a local model ID.
 *
 * Matching strategy:
 * 1. Exact normalized ID match (highest confidence)
 * 2. Family + size match (model family base matches AND size matches)
 * 3. Family-only match (same family, use capabilities only)
 *
 * Returns undefined if no match found.
 */
export function findMatch(
  localId: string,
  index: readonly FlatModel[],
): ModelsDevMeta | undefined {
  if (index.length === 0) return undefined;

  const localNorm = normalize(localId);
  const localFamily = extractFamily(localId);
  const localSize = extractSize(localId);

  // 1. Exact normalized match
  const exact = index.find((m) => m.normalized === localNorm);
  if (exact) return exact.meta;

  // 2. Family + size match (use word boundary to avoid 4b matching inside 14b)
  if (localSize) {
    const sizePattern = new RegExp(
      `(?:^|[^\\d])${localSize.replace(".", "\\.")}(?:$|[^\\d])`,
    );
    const familySizeMatch = index.find(
      (m) =>
        (m.family?.toLowerCase() === localFamily ||
          m.normalized.startsWith(localFamily)) &&
        sizePattern.test(m.normalized),
    );
    if (familySizeMatch) return familySizeMatch.meta;
  }

  // 3. Family-only match — find any model with the same family
  // Only return capability flags, NOT limits (they vary by size)
  const familyMatch = index.find(
    (m) =>
      m.family?.toLowerCase() === localFamily ||
      m.normalized.startsWith(localFamily + "-"),
  );
  if (familyMatch) return familyMatch.meta;

  return undefined;
}

/** Reset the cache (for testing). */
export function resetCache(): void {
  cache = undefined;
}
