/**
 * OpenCode 2 server plugin entry (`./server`).
 *
 * `setup` reads persisted bindings (local storage only), registers the
 * Actualyze integration, the provider and model transforms, and the RPC
 * contract, and starts the refresher without awaiting any network I/O:
 * plugins activate one at a time, so an awaited fetch here would delay
 * every later plugin.
 *
 * All `@opencode/*` imports must stay type-only, because the host throws if
 * a plugin loads `@opencode/plugin` or `effect` from its own `node_modules`.
 */
import type { Plugin } from "@opencode/plugin";
import { version as packageVersion } from "../package.json";
import { PLUGIN_ID } from "./constants";
import { isPlainRecord } from "./catalog-evidence";
import { ModelScoutRpc } from "./rpc";
import {
  createRefresher,
  loadPersisted,
  readOptions,
  type ActiveCredential,
  type HostEvent,
  type PersistedBinding,
  type RefresherHost,
} from "./refresher";
import { sharedStore } from "./store";
import { registerActualyzeIntegration } from "./actualyze";
import {
  createModelTransform,
  createProviderTransform,
  createTransformState,
} from "./transform";

type Context = Plugin.Context;
type StorageValue = Parameters<Context["storage"]["set"]>[1];

/** A JSON-only copy of a persisted binding, typed for `ctx.storage`. */
function storageValue(value: PersistedBinding): StorageValue {
  return JSON.parse(JSON.stringify(value)) as StorageValue;
}

async function activeCredential(
  context: Context,
  integrationID: string,
): Promise<ActiveCredential | undefined> {
  const connection = await context.integration.connection.active(integrationID);
  if (!connection) return undefined;
  const value = await context.integration.connection.resolve(connection);
  if (value?.type !== "key" || value.key.length === 0) return undefined;
  return {
    connection:
      connection.type === "credential"
        ? `credential:${connection.id}`
        : `env:${connection.name}`,
    key: value.key,
  };
}

async function* hostEvents(
  context: Context,
  signal: AbortSignal,
): AsyncIterable<HostEvent> {
  for await (const event of context.event.subscribe({ signal })) {
    yield {
      type: event.type,
      ...(event.location ? { location: event.location } : {}),
      ...("data" in event ? { data: event.data as unknown } : {}),
    };
  }
}

function refreshProviderID(input: unknown): string | undefined {
  return isPlainRecord(input) && typeof input.providerID === "string"
    ? input.providerID
    : undefined;
}

const plugin = {
  id: PLUGIN_ID,
  async setup(context: Context) {
    const options = readOptions(context.options);
    const store = sharedStore();
    const state = createTransformState();

    try {
      await loadPersisted(context.storage, store);
    } catch {
      // Storage is a startup cache; discovery repopulates it.
    }

    await context.integration.transform(registerActualyzeIntegration);
    await context.provider.transform(createProviderTransform(state));
    await context.model.transform(createModelTransform(state));

    // The RPC registration, which emits events, exists only after the
    // refresher its handlers call into.
    const rpc: {
      emitUpdated?: (completedAt: string) => Promise<void>;
      emitStatus?: (at: string) => Promise<void>;
    } = {};
    const host: RefresherHost = {
      location: context.location,
      listProviders: async () => (await context.provider.list()).data,
      activeCredential: (integrationID) =>
        activeCredential(context, integrationID),
      reload: () => context.model.reload(),
      events: (signal) => hostEvents(context, signal),
      emitUpdated: async (completedAt) => {
        await rpc.emitUpdated?.(completedAt);
      },
      emitStatus: async (at) => {
        await rpc.emitStatus?.(at);
      },
      persist: (key, value) => context.storage.set(key, storageValue(value)),
    };
    const refresher = createRefresher({
      host,
      options,
      state,
      store,
      packageVersion,
    });

    const registration = await context.rpc.register(ModelScoutRpc, {
      catalog: () => Promise.resolve(refresher.catalog()),
      refresh: (input) =>
        Promise.resolve(refresher.refresh(refreshProviderID(input))),
    });
    rpc.emitUpdated = (completedAt) =>
      registration.events.emit("updated", { completedAt });
    rpc.emitStatus = (at) => registration.events.emit("status", { at });

    refresher.start();
    return () => refresher.dispose();
  },
} satisfies Plugin.Plugin;

export default plugin;
