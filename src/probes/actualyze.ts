import type {
  ProbeInputModality,
  ProbeModelCost,
  ProbeModelMeta,
  ProbeResult,
  ProviderProbe,
} from "./types";
import { buildHeaders, EMPTY_RESULT, probeFetch, readJson } from "./util";

/**
 * Actualyze model object, as served by both `GET /v1/models` entries and
 * `GET /v1/models/{id}`. Capability flags are tri-state: `true` and `false`
 * are verdicts, `null` means the platform does not know.
 */
interface ActualyzeModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_window?: unknown;
  max_output_tokens?: unknown;
  capabilities: Record<string, unknown>;
  modalities?: unknown;
  cost?: unknown;
}

/** `actualyze` is the current owner string; `atlas` is served by older deployments. */
const ACTUALYZE_OWNERS: ReadonlySet<string> = new Set(["actualyze", "atlas"]);

const ACTUALYZE_DETAIL_CONCURRENCY = 8;

const INPUT_MODALITIES: readonly ProbeInputModality[] = [
  "text",
  "image",
  "pdf",
  "audio",
  "video",
];

/** Exact, case-sensitive match of an `owned_by` value served by Actualyze. */
export function isActualyzeOwner(value: unknown): boolean {
  return typeof value === "string" && ACTUALYZE_OWNERS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".."
  );
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Best-effort cleanup for an unused response body.
  }
}

function isActualyzeModelObject(
  value: unknown,
  expectedId: string,
): value is ActualyzeModelObject {
  if (!isRecord(value) || !isRecord(value.capabilities)) return false;

  return (
    value.id === expectedId &&
    value.object === "model" &&
    typeof value.created === "number" &&
    Number.isFinite(value.created) &&
    isActualyzeOwner(value.owned_by)
  );
}

/**
 * A list entry carries the full advertisement when it has the
 * `context_window` key and a `capabilities` object, even with `null` values.
 * Thin entries from older deployments need the per-model detail request.
 * `cost` is not part of the check: Actualyze omits prices it cannot resolve.
 */
function isAdvertisedInFull(
  value: unknown,
  expectedId: string,
): value is ActualyzeModelObject {
  return (
    isActualyzeModelObject(value, expectedId) &&
    Object.hasOwn(value, "context_window")
  );
}

/**
 * `modalities.input` is authoritative. Without it, input modalities are
 * derived from the capability flags only when every input flag is a boolean,
 * because an unknown flag cannot be expressed in a modality list.
 */
function readInputModalities(
  detail: ActualyzeModelObject,
): ProbeInputModality[] | undefined {
  if (isRecord(detail.modalities) && Array.isArray(detail.modalities.input)) {
    const reported = new Set<unknown>(detail.modalities.input);
    const modalities = INPUT_MODALITIES.filter((modality) =>
      reported.has(modality),
    );
    return modalities.length > 0 ? modalities : undefined;
  }

  const { vision, document, audio, video } = detail.capabilities;
  if (
    typeof vision !== "boolean" ||
    typeof document !== "boolean" ||
    typeof audio !== "boolean" ||
    typeof video !== "boolean"
  ) {
    return undefined;
  }
  const modalities: ProbeInputModality[] = ["text"];
  if (vision) modalities.push("image");
  if (document) modalities.push("pdf");
  if (audio) modalities.push("audio");
  if (video) modalities.push("video");
  return modalities;
}

/** Cache prices that are absent stay undefined (unknown), never zero. */
function readCost(cost: unknown): ProbeModelCost | undefined {
  if (!isRecord(cost) || !isPrice(cost.input) || !isPrice(cost.output)) {
    return undefined;
  }
  const result: ProbeModelCost = { input: cost.input, output: cost.output };
  if (isPrice(cost.cache_read)) result.cacheRead = cost.cache_read;
  if (isPrice(cost.cache_write)) result.cacheWrite = cost.cache_write;
  return result;
}

/**
 * A model whose `modalities.output` lists `embedding` is an embedding
 * model; otherwise `vision: true` makes it a `vlm`. `vision: false` says
 * nothing about the type, because embedding models take no images either,
 * so the type is left to discovery's name heuristic.
 */
function readModelType(
  detail: ActualyzeModelObject,
  vision: boolean | undefined,
): ProbeModelMeta["modelType"] {
  const output =
    isRecord(detail.modalities) && Array.isArray(detail.modalities.output)
      ? (detail.modalities.output as unknown[])
      : undefined;
  if (output?.includes("embedding")) return "embedding";
  if (vision === true) return "vlm";
  return undefined;
}

function toProbeMeta(detail: ActualyzeModelObject): ProbeModelMeta {
  const meta: ProbeModelMeta = {};
  const { capabilities } = detail;

  if (isPositiveSafeInteger(detail.context_window)) {
    meta.context = detail.context_window;
  }
  if (isPositiveSafeInteger(detail.max_output_tokens)) {
    meta.maxTokens = detail.max_output_tokens;
  }

  if (typeof capabilities.vision === "boolean") {
    meta.vision = capabilities.vision;
  }
  const modelType = readModelType(detail, meta.vision);
  if (modelType) meta.modelType = modelType;
  if (typeof capabilities.tool_use === "boolean") {
    meta.toolCall = capabilities.tool_use;
  }
  if (
    capabilities.thinking === true ||
    capabilities.thinking_adaptive === true
  ) {
    meta.reasoning = true;
  } else if (
    capabilities.thinking === false &&
    capabilities.thinking_adaptive === false
  ) {
    meta.reasoning = false;
  }
  if (typeof capabilities.temperature === "boolean") {
    meta.temperature = capabilities.temperature;
  }

  const inputModalities = readInputModalities(detail);
  if (inputModalities) meta.inputModalities = inputModalities;

  const cost = readCost(detail.cost);
  if (cost) meta.cost = cost;

  return meta;
}

/**
 * Probe Actualyze (Atlas platform). List entries that carry the full
 * advertisement are read directly; the remaining safe IDs are fetched from
 * the per-model detail endpoint in parallel.
 */
export const probeActualyze: ProviderProbe = async (
  baseURL,
  apiKey,
  context,
): Promise<ProbeResult> => {
  try {
    const listedModels = context?.modelsResponse;
    if (!listedModels || listedModels.length === 0) return EMPTY_RESULT;

    const signal = context?.signal;
    if (signal?.aborted) return EMPTY_RESULT;

    const eligibleModels =
      context?.probeSelection === "auto"
        ? listedModels.filter((model) => isActualyzeOwner(model?.owned_by))
        : listedModels;

    const models = Object.create(null) as Record<string, ProbeModelMeta>;
    const modelIds = new Set<string>();
    for (const model of eligibleModels) {
      const id: unknown = model?.id;
      if (!isSafeModelId(id)) continue;
      modelIds.add(id);
      if (!Object.hasOwn(models, id) && isAdvertisedInFull(model, id)) {
        models[id] = toProbeMeta(model);
      }
    }
    if (modelIds.size === 0) return EMPTY_RESULT;

    const detailIds = [...modelIds].filter((id) => !Object.hasOwn(models, id));
    const headers = buildHeaders(apiKey, context?.headers);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (!signal?.aborted) {
        const id = detailIds[nextIndex];
        nextIndex += 1;
        if (id === undefined) return;

        let encodedId: string;
        try {
          encodedId = encodeURIComponent(id);
        } catch {
          continue;
        }

        const response = await probeFetch(`${baseURL}/v1/models/${encodedId}`, {
          headers,
          signal,
        });
        if (!response) continue;
        if (!response.ok) {
          cancelBody(response);
          continue;
        }

        const detail = await readJson<unknown>(response, 2000);
        if (!signal?.aborted && isActualyzeModelObject(detail, id)) {
          models[id] = toProbeMeta(detail);
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(ACTUALYZE_DETAIL_CONCURRENCY, detailIds.length) },
        worker,
      ),
    );

    if (signal?.aborted) return EMPTY_RESULT;

    return Object.keys(models).length === 0 ? EMPTY_RESULT : { models };
  } catch {
    return EMPTY_RESULT;
  }
};
