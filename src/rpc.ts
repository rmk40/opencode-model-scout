/**
 * Plugin RPC contract between the server half (`ctx.rpc.register`) and the
 * TUI half (`context.client.rpc(ModelScoutRpc)`).
 *
 * This is a plain object, not `Rpc.define(...)`: `define` is a runtime
 * function, and the bundle must not import `@opencode/*` at runtime (since
 * 2.0.26 the host throws if a plugin loads `@opencode/plugin` or `effect`
 * from its own `node_modules`). Only the type import below is allowed.
 *
 * Schemas are JSON Schema. The host validates input and output against
 * them, so the catalog output schema stays shallow; the TUI runs the strict
 * `validateCatalogPayload` from ./catalog-evidence over every response.
 */
import type { Rpc } from "@opencode/plugin";
import {
  CATALOG_SCHEMA_VERSION,
  type CatalogPayload,
} from "./catalog-evidence";
import { PLUGIN_ID } from "./constants";

/** Input of the `catalog` method. */
export type CatalogInput = Record<string, never>;

/** Output of the `catalog` method; see ./catalog-evidence. */
export type CatalogOutput = CatalogPayload;

/** Input of the `refresh` method. Omit `providerID` to refresh every target. */
export interface RefreshInput {
  providerID?: string;
}

/** Why a `refresh` request started or joined no discovery. */
export type RefreshRejection = "throttled" | "no-targets";

/** Output of the `refresh` method. */
export interface RefreshOutput {
  /** True when at least one selected target started or joined discovery. */
  accepted: boolean;
  /**
   * Set when `accepted` is false: `throttled` when every selected target
   * started discovery less than a minute ago, `no-targets` when no
   * discovery target matched the request.
   */
  reason?: RefreshRejection;
}

/**
 * Data of the `updated` event, published when the catalog changes: after a
 * discovery cycle completes and after a sync resolves the targets or changes
 * the bindings they serve.
 */
export interface UpdatedEventData {
  /** The catalog's `completedAt` when the event was published. */
  completedAt: string;
}

const EMPTY_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const ModelScoutRpc = {
  id: PLUGIN_ID,
  methods: {
    catalog: {
      input: EMPTY_INPUT,
      output: {
        type: "object",
        properties: {
          schemaVersion: { type: "number", const: CATALOG_SCHEMA_VERSION },
          packageVersion: { type: "string" },
          status: { type: "string", enum: ["pending", "running", "complete"] },
          startedAt: { type: "string" },
          completedAt: { type: "string" },
          providers: { type: "array", items: { type: "object" } },
        },
        required: ["schemaVersion", "packageVersion", "status", "providers"],
        additionalProperties: false,
      },
    },
    refresh: {
      input: {
        type: "object",
        properties: { providerID: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          accepted: { type: "boolean" },
          reason: { type: "string", enum: ["throttled", "no-targets"] },
        },
        required: ["accepted"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { completedAt: { type: "string" } },
        required: ["completedAt"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition;

export type ModelScoutRpcDefinition = typeof ModelScoutRpc;

export default ModelScoutRpc;
