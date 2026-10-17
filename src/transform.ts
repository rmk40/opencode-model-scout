/**
 * Synchronous catalog transforms.
 *
 * - The provider transform records which provider IDs exist when it runs,
 *   then adds the built-in Actualyze provider. External plugins run before
 *   the config provider plugin, so the recorded set holds models.dev
 *   templates, built-ins, and earlier plugins' providers, but not
 *   config-only providers.
 * - The model transform adds scout's discovered models. It runs in two
 *   passes: a pure pass computes every patch inside `try`/`catch`, and only
 *   then are the patches applied with `editor.update`. Editor updates
 *   mutate the candidate immediately, so failing halfway through the first
 *   pass would otherwise leave partial edits, and a throwing transform
 *   disables every registration of the plugin.
 *
 * Both callbacks replace (never accumulate) what they record, because the
 * host can abandon a candidate and restart the fold.
 */
import type { Plugin } from "@opencode/plugin";
import { addActualyzeProvider, type ActualyzeAddition } from "./actualyze";
import {
  NEVER_PROBED_PROVIDER_IDS,
  OPENAI_COMPATIBLE_PACKAGES,
} from "./constants";
import { canonicalProbeKey } from "./probes/index";
import {
  normalizeBaseURL,
  toModelInfo,
  type MappedModel,
  type ModelPatch,
} from "./discover";
import {
  createModelsDevIndexCache,
  EMPTY_INDEX,
  type ModelsDevIndex,
  type SourceRecordLike,
} from "./models-dev-index";
import { targetKeys, type Binding, type TargetKeys } from "./store";
import type { ProviderInventory } from "./discover";

type ModelTransform = Plugin.Context["model"]["transform"];
export type ModelEditor = Parameters<Parameters<ModelTransform>[0]>[0];
type ProviderTransform = Plugin.Context["provider"]["transform"];
export type ProviderEditor = Parameters<Parameters<ProviderTransform>[0]>[0];
type MutableModel = Parameters<Parameters<ModelEditor["update"]>[2]>[0];

export function isOpenAICompatiblePackage(pkg: unknown): boolean {
  return typeof pkg === "string" && OPENAI_COMPATIBLE_PACKAGES.has(pkg);
}

/** The subset of `Provider.Info` that eligibility reads. */
export interface ProviderLike {
  readonly id: string;
  readonly canonical?: string;
  readonly integrationID?: string;
  readonly package: string;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface EligibleTarget {
  readonly providerID: string;
  readonly integrationID: string;
  readonly package: string;
  /** `settings.baseURL` as configured. */
  readonly baseURL: string;
  /** `settings.probe` as configured. */
  readonly probe?: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly keys: TargetKeys;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringHeaders(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * A provider is a discovery target when it has `settings.baseURL` and
 * either opts in with `settings.probe`, or is auto-eligible: absent from the
 * recorded pre-config provider set, no `canonical`, and the
 * openai-compatible package. The absence check is a heuristic: a provider
 * plugin listed after scout also looks absent, which the package and
 * `canonical` requirements keep rare.
 */
export function eligibleTarget(
  provider: ProviderLike,
  recorded: ReadonlySet<string> | undefined,
): EligibleTarget | undefined {
  if (NEVER_PROBED_PROVIDER_IDS.has(provider.id)) return undefined;
  const settings = provider.settings;
  const baseURL = nonEmptyString(settings?.baseURL);
  if (!baseURL) return undefined;
  const probe = nonEmptyString(settings?.probe);
  if (
    !probe &&
    (recorded === undefined ||
      recorded.has(provider.id) ||
      provider.canonical !== undefined ||
      !isOpenAICompatiblePackage(provider.package))
  )
    return undefined;
  const apiKey = nonEmptyString(settings?.apiKey);
  const headers = stringHeaders(provider.headers);
  return {
    providerID: provider.id,
    integrationID: provider.integrationID ?? provider.id,
    package: provider.package,
    baseURL,
    ...(probe ? { probe } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
    keys: targetKeys({
      providerID: provider.id,
      baseURL: normalizeBaseURL(baseURL),
      probe:
        probe === undefined || probe === "auto"
          ? probe
          : (canonicalProbeKey(probe) ?? probe),
      apiKey,
      headers,
    }),
  };
}

/** What the last model fold saw for one target provider. */
export interface FoldView {
  /** Model IDs in the provider's source record (config or models.dev). */
  readonly declared: ReadonlySet<string>;
  readonly inventory?: ProviderInventory;
  readonly mapped: readonly MappedModel[];
  /** The pure pass threw; the provider got no patches. */
  readonly failed: boolean;
}

/** Per-instance state shared between the transforms and the refresher. */
export interface TransformState {
  /** Provider IDs present when the provider transform last ran. */
  recorded: ReadonlySet<string> | undefined;
  /**
   * The binding each target provider serves, set by the refresher once it
   * has resolved the target's credential. It stays across a probe-only
   * settings edit until rediscovery lands.
   */
  readonly active: Map<string, Binding>;
  /** Replaced on every model fold. */
  view: ReadonlyMap<string, FoldView>;
  /**
   * What the latest provider fold did with the built-in Actualyze provider;
   * undefined before the first fold.
   */
  actualyze: ActualyzeAddition | undefined;
}

export function createTransformState(): TransformState {
  return {
    recorded: undefined,
    active: new Map(),
    view: new Map(),
    actualyze: undefined,
  };
}

/**
 * The binding to serve for a target: the instance's active binding, while
 * its endpoint still matches. Which credential a target discovers with
 * depends on the integration's connection, which only the refresher can
 * look up, so even a target with `settings.apiKey` is served only after the
 * refresher has resolved its credential and set the active binding. The
 * active binding is also what keeps serving while only the probe selection
 * changed.
 */
export function servedBinding(
  target: EligibleTarget,
  state: TransformState,
): Binding | undefined {
  const active = state.active.get(target.providerID);
  return active && active.endpointKey === target.keys.endpointKey
    ? active
    : undefined;
}

/**
 * Record the provider IDs present before this transform, then add the
 * built-in Actualyze provider and record whether it was added. Recording
 * comes first so the added provider never counts as pre-existing; it is a
 * target through `settings.probe`.
 */
export function createProviderTransform(
  state: TransformState,
): (editor: ProviderEditor) => void {
  return (editor) => {
    try {
      state.recorded = new Set(
        editor.list().map((record) => record.provider.id),
      );
    } catch {
      state.recorded = undefined;
    }
    state.actualyze = addActualyzeProvider(editor);
  };
}

interface Plan {
  readonly providerID: string;
  readonly additions: readonly MappedModel[];
}

/**
 * Write a patch into a model the editor just created from
 * `Model.Info.default`. Every field scout controls is assigned, starting
 * from a fresh default, so replaying the patch on a fresh candidate always
 * yields the same model.
 */
export function applyPatch(model: MutableModel, patch: ModelPatch): void {
  // The editor's mutable view maps branded IDs and prices to object types;
  // at runtime they are plain strings and numbers, hence the casts.
  model.name = patch.name;
  if (patch.family !== undefined)
    model.family = patch.family as unknown as MutableModel["family"];
  model.capabilities = {
    tools: patch.tools,
    input: [...patch.input],
    output: ["text"],
  };
  model.limit = { context: patch.context, output: patch.output };
  model.variants = patch.variants.map((effort) => ({
    id: effort as unknown as MutableModel["variants"][number]["id"],
    settings: { reasoningEffort: effort },
  }));
  const cost = patch.cost
    ? [
        {
          input: patch.cost.input,
          output: patch.cost.output,
          cache: { read: patch.cost.cacheRead, write: patch.cost.cacheWrite },
        },
      ]
    : [];
  model.cost = cost as unknown as MutableModel["cost"];
  model.time = { released: patch.released };
  model.enabled = patch.enabled;
}

function indexRecords(
  records: readonly SourceRecordLike[],
  recorded: ReadonlySet<string> | undefined,
  targets: ReadonlySet<string>,
): SourceRecordLike[] {
  return records.filter(
    (record) =>
      !NEVER_PROBED_PROVIDER_IDS.has(record.provider.id) &&
      !targets.has(record.provider.id) &&
      (recorded === undefined || recorded.has(record.provider.id)),
  );
}

export function createModelTransform(
  state: TransformState,
): (editor: ModelEditor) => void {
  const indexCache = createModelsDevIndexCache();
  return (editor) => {
    const view = new Map<string, FoldView>();
    const plans: Plan[] = [];
    try {
      const records = editor.provider.list();
      const recorded = state.recorded;
      const targets: Array<{
        target: EligibleTarget;
        declared: ReadonlySet<string>;
      }> = [];
      for (const record of records) {
        try {
          const target = eligibleTarget(record.provider, recorded);
          if (target)
            targets.push({ target, declared: new Set(record.models.keys()) });
        } catch {
          // A malformed provider record is skipped.
        }
      }
      let index: ModelsDevIndex | undefined;
      const getIndex = (): ModelsDevIndex => {
        if (index) return index;
        try {
          index = indexCache(
            indexRecords(
              records,
              recorded,
              new Set(targets.map(({ target }) => target.providerID)),
            ),
          );
        } catch {
          index = EMPTY_INDEX;
        }
        return index;
      };
      for (const { target, declared } of targets) {
        const binding = servedBinding(target, state);
        if (!binding) {
          view.set(target.providerID, { declared, mapped: [], failed: false });
          continue;
        }
        try {
          const mapped = toModelInfo(binding.inventory, getIndex(), {
            reasoningVariants: isOpenAICompatiblePackage(target.package),
          });
          view.set(target.providerID, {
            declared,
            inventory: binding.inventory,
            mapped,
            failed: false,
          });
          plans.push({
            providerID: target.providerID,
            additions: mapped.filter((model) => !declared.has(model.id)),
          });
        } catch {
          view.set(target.providerID, {
            declared,
            inventory: binding.inventory,
            mapped: [],
            failed: true,
          });
        }
      }
    } catch {
      plans.length = 0;
    }
    state.view = view;
    for (const plan of plans) {
      for (const model of plan.additions) {
        try {
          editor.update(plan.providerID, model.id, (draft) =>
            applyPatch(draft, model.patch),
          );
        } catch {
          // The host rejected this one model; keep the others and the plugin.
        }
      }
    }
  };
}
