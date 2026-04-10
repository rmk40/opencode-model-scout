import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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

/** Shape of a single model in the models.dev api.json cache. */
interface ModelsDevModel {
  id: string;
  family?: string;
  tool_call: boolean;
  reasoning: boolean;
  attachment: boolean;
  temperature: boolean;
  modalities?: {
    input: string[];
    output: string[];
  };
}

/** Shape of a provider in the models.dev api.json cache. */
interface ModelsDevProvider {
  models: Record<string, ModelsDevModel>;
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
 * Resolve the path to opencode's cached models.dev api.json file.
 * Honors OPENCODE_MODELS_PATH if set (same as opencode internally),
 * otherwise follows the XDG convention:
 * $XDG_CACHE_HOME/opencode/models.json (defaults to ~/.cache/opencode/models.json)
 */
function modelsJsonPath(): string {
  if (process.env.OPENCODE_MODELS_PATH) return process.env.OPENCODE_MODELS_PATH;
  const cacheDir =
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheDir, "opencode", "models.json");
}

/**
 * Read opencode's cached models.dev data and build a flattened lookup index.
 * Reads directly from the XDG cache file to avoid deadlocking the SDK client
 * during the config hook (client.provider.list() routes through InstanceState
 * which hasn't finished initializing when the config hook runs).
 * On failure, caches the empty result to avoid re-reading a broken file.
 */
export async function fetchModelsDevIndex(): Promise<FlatModel[]> {
  if (cache) return cache;

  try {
    const raw = await readFile(modelsJsonPath(), "utf-8");
    const data: unknown = JSON.parse(raw);

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      cache = [];
      return [];
    }

    const flat: FlatModel[] = [];
    const providers = data as Record<string, ModelsDevProvider>;

    for (const provider of Object.values(providers)) {
      if (!provider.models) continue;
      for (const model of Object.values(provider.models)) {
        flat.push({
          id: model.id,
          normalized: normalize(model.id),
          family: model.family,
          meta: {
            toolCall: model.tool_call,
            reasoning: model.reasoning,
            attachment: model.attachment,
            temperature: model.temperature,
            family: model.family,
            modalities: model.modalities,
          },
        });
      }
    }

    cache = flat;
    return flat;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to read models.dev cache:`, error);
    cache = [];
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
