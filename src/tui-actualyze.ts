import type {
  CatalogPayload,
  CatalogProviderRecord,
  CredentialSource,
  ProviderFailureKind,
} from "./catalog-evidence";
import {
  ACTUALYZE_BASE_URL,
  ACTUALYZE_INTEGRATION_ID,
  ACTUALYZE_LINK_PATHS,
  ACTUALYZE_PROVIDER_ID,
} from "./constants";

// ── Endpoint ────────────────────────────────────────────────────────────

/**
 * Where the Actualyze provider points, reduced to what the dialog shows:
 * the origin (no credentials, path, or query) and whether the base URL
 * differs from the built-in one. The full URL is never kept.
 */
export interface ActualyzeEndpoint {
  /** Undefined when the configured base URL is not an http(s) URL. */
  readonly origin: string | undefined;
  readonly customEndpoint: boolean;
}

/**
 * A base URL without trailing slashes, fragment, or credentials, with the
 * origin as `URL` serializes it (lowercase scheme and host, no default
 * port); undefined when it is not an http(s) URL.
 */
export function normalizeEndpointURL(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}${url.search}`;
}

const BUILT_IN_URL = normalizeEndpointURL(ACTUALYZE_BASE_URL);

/** The built-in endpoint, also used while the provider is hidden for lack of a key. */
export const BUILT_IN_ENDPOINT: ActualyzeEndpoint = {
  origin: new URL(ACTUALYZE_BASE_URL).origin,
  customEndpoint: false,
};

/**
 * The endpoint of a listed Actualyze provider from its `settings.baseURL`.
 * A missing base URL means the built-in one; anything else that is not an
 * http(s) URL is a custom endpoint without an origin, so no link points at
 * production by mistake.
 */
export function actualyzeEndpoint(baseURL: unknown): ActualyzeEndpoint {
  if (baseURL === undefined || baseURL === null || baseURL === "")
    return BUILT_IN_ENDPOINT;
  if (typeof baseURL !== "string")
    return { origin: undefined, customEndpoint: true };
  const normalized = normalizeEndpointURL(baseURL);
  if (normalized === undefined)
    return { origin: undefined, customEndpoint: true };
  return {
    origin: new URL(normalized).origin,
    customEndpoint: normalized !== BUILT_IN_URL,
  };
}

export { displayOrigin } from "./format";

export type ActualyzeLinkID = keyof typeof ACTUALYZE_LINK_PATHS;

export interface ActualyzeLink {
  readonly id: ActualyzeLinkID;
  readonly label: string;
  readonly url: string;
}

/** Page names as the Actualyze app labels them. */
const LINK_LABELS: Readonly<Record<ActualyzeLinkID, string>> = {
  apiKeys: "API Keys",
  catalog: "Catalog",
  budgets: "Budgets",
  usage: "Usage",
  troubleshooting: "Troubleshooting",
};

export const LINK_ORDER: readonly ActualyzeLinkID[] = [
  "apiKeys",
  "catalog",
  "budgets",
  "usage",
  "troubleshooting",
];

export function linkLabel(id: ActualyzeLinkID): string {
  return LINK_LABELS[id];
}

/** One app page on `origin`. */
export function actualyzeLink(
  origin: string,
  id: ActualyzeLinkID,
): ActualyzeLink {
  return {
    id,
    label: LINK_LABELS[id],
    url: `${origin}${ACTUALYZE_LINK_PATHS[id]}`,
  };
}

/** Every app page on `origin`, in links-screen order. */
export function actualyzeLinks(origin: string): ActualyzeLink[] {
  return LINK_ORDER.map((id) => actualyzeLink(origin, id));
}

/** Columns of a link's label column when the URL shares its line. */
export const LINK_LABEL_COLUMNS = 21;
/** Columns before a URL on its own line under the label. */
export const LINK_URL_INDENT = 6;

/**
 * How the links screen lays out `links` in `width` columns: the URL in a
 * column beside each label, or, when any URL would not fit there, every URL
 * on its own line under its label, so the list never mixes the two.
 */
export function linkLayout(
  links: readonly ActualyzeLink[],
  width: number,
  measure: (text: string) => number = (text) => text.length,
): "beside" | "below" {
  return links.every((link) => LINK_LABEL_COLUMNS + measure(link.url) <= width)
    ? "beside"
    : "below";
}

/** The app page that helps with a failure: API keys for 401 and 403, Budgets for 402, Troubleshooting otherwise. */
export function failureLink(kind: ProviderFailureKind): ActualyzeLinkID {
  switch (kind) {
    case "unauthorized":
    case "forbidden":
      return "apiKeys";
    case "payment-required":
      return "budgets";
    default:
      return "troubleshooting";
  }
}

// ── Connection ──────────────────────────────────────────────────────────

/** The integration's active connection: a stored credential or an environment variable. */
export type ActiveConnection =
  | { readonly kind: "credential"; readonly label: string }
  | { readonly kind: "env"; readonly name: string };

/** What the dialog reads from the integration; connection info never carries a secret. */
export interface IntegrationFacts {
  /** `connections[0]`, which OpenCode keeps as the active connection. */
  readonly connection: ActiveConnection | undefined;
  /** The integration offers a plain key method with no form fields. */
  readonly keyMethod: boolean;
}

/** The fields of OpenCode's `IntegrationInfo` the dialog reads. */
export interface IntegrationShape {
  readonly methods?: readonly {
    readonly type?: unknown;
    readonly form?: unknown;
  }[];
  readonly connections?: readonly {
    readonly type?: unknown;
    readonly label?: unknown;
    readonly name?: unknown;
  }[];
}

function activeConnection(
  integration: IntegrationShape,
): ActiveConnection | undefined {
  const first = integration.connections?.[0];
  if (!first) return undefined;
  if (first.type === "env")
    return {
      kind: "env",
      name: typeof first.name === "string" ? first.name : "",
    };
  return {
    kind: "credential",
    label: typeof first.label === "string" ? first.label : "",
  };
}

export function integrationFacts(
  integration: IntegrationShape | undefined,
): IntegrationFacts {
  if (!integration) return { connection: undefined, keyMethod: false };
  return {
    connection: activeConnection(integration),
    keyMethod: (integration.methods ?? []).some(
      (method) => method.type === "key" && method.form === undefined,
    ),
  };
}

/**
 * Whether `k` may run the key flow: the provider's integration is the
 * `actualyze` integration, and it offers a plain key method.
 */
export function canEnterKey(
  providerIntegrationID: string,
  facts: IntegrationFacts | undefined,
): boolean {
  return (
    providerIntegrationID === ACTUALYZE_INTEGRATION_ID &&
    facts?.keyMethod === true
  );
}

/**
 * How the status line names the key in use: `settings.apiKey` when
 * discovery reads it, else the active connection's label in quotes, or the
 * environment variable's name.
 */
export function keyLabel(
  connection: ActiveConnection | undefined,
  credentialSource: CredentialSource | undefined,
): string | undefined {
  if (credentialSource === "settings") return "settings.apiKey";
  if (!connection) return undefined;
  if (connection.kind === "env") return connection.name;
  return `"${connection.label}"`;
}

// ── Pending key ─────────────────────────────────────────────────────────

export type PendingPhase = "saving" | "saved" | "unconfirmed";

/** A key this TUI submitted in an `/actualyze` session. */
export interface PendingMarker {
  readonly session: number;
  readonly phase: PendingPhase;
  /** The record's `credentialEpoch` at submit, or -1 without a record. */
  readonly epochAtSubmit: number;
  /** The catalog payload's `instanceID` at submit, if one was read. */
  readonly instanceIDAtSubmit: string | undefined;
  /** `Date.now()` when the save was confirmed, for the "still checking" hint. */
  readonly savedAt?: number;
}

export type PendingEvent =
  | {
      readonly type: "submit";
      readonly session: number;
      readonly epochAtSubmit: number;
      readonly instanceIDAtSubmit: string | undefined;
    }
  | { readonly type: "resolved"; readonly session: number; readonly at: number }
  | { readonly type: "rejected"; readonly session: number }
  | { readonly type: "checked" }
  | { readonly type: "ended"; readonly session: number };

/**
 * The pending marker after `event`. A submit replaces any marker; a save
 * completion applies only to the saving marker of its own session; a
 * rejection or timeout is "unconfirmed" because OpenCode may have stored
 * the key before the error; `checked` clears a saved marker once the
 * catalog answers for the new credential; the end of its session clears it.
 */
export function reducePending(
  marker: PendingMarker | undefined,
  event: PendingEvent,
): PendingMarker | undefined {
  switch (event.type) {
    case "submit":
      return {
        session: event.session,
        phase: "saving",
        epochAtSubmit: event.epochAtSubmit,
        instanceIDAtSubmit: event.instanceIDAtSubmit,
      };
    case "resolved":
      return marker?.session === event.session && marker.phase === "saving"
        ? { ...marker, phase: "saved", savedAt: event.at }
        : marker;
    case "rejected":
      return marker?.session === event.session && marker.phase === "saving"
        ? { ...marker, phase: "unconfirmed" }
        : marker;
    case "checked":
      return marker?.phase === "saved" ? undefined : marker;
    case "ended":
      return marker?.session === event.session ? undefined : marker;
  }
}

/** The submit event for the catalog the dialog last read. */
export function submitEvent(
  session: number,
  payload: CatalogPayload | undefined,
): Extract<PendingEvent, { type: "submit" }> {
  const record = payload?.providers.find(
    (item) => item.id === ACTUALYZE_PROVIDER_ID,
  );
  return {
    type: "submit",
    session,
    epochAtSubmit: record?.credentialEpoch ?? -1,
    instanceIDAtSubmit: payload?.instanceID,
  };
}

// ── State ───────────────────────────────────────────────────────────────

/** A record is current when its result belongs to its credential. */
export function isCurrent(record: CatalogProviderRecord): boolean {
  return record.resultEpoch === record.credentialEpoch;
}

/**
 * Whether a saved key still waits for the catalog: no current record yet,
 * or one whose credential epoch is not past the submit. After a server
 * reload or restart (another `instanceID`) epochs restart, so any current
 * record counts as new.
 */
export function awaitingCheck(
  marker: PendingMarker,
  payload: CatalogPayload | undefined,
): boolean {
  const record = payload?.providers.find(
    (item) => item.id === ACTUALYZE_PROVIDER_ID,
  );
  if (!record || !isCurrent(record)) return true;
  const baseline =
    payload?.instanceID === marker.instanceIDAtSubmit
      ? marker.epochAtSubmit
      : -1;
  return record.credentialEpoch <= baseline;
}

export type ActualyzeRow =
  | "saving"
  | "unconfirmed"
  | "server-unavailable"
  | "not-managed"
  | "checking"
  | "no-key"
  | "resolving"
  | "discovering"
  | "failure"
  | "empty"
  | "ready";

/** Every input the state table reads. */
export interface ActualyzeInputs {
  readonly pending: PendingMarker | undefined;
  /** The catalog RPC: not read yet, failed or invalid, or answered. */
  readonly server: "loading" | "unavailable" | "ready";
  /** The payload when `server` is `ready`. */
  readonly payload: CatalogPayload | undefined;
  /** Whether the integration has a connection; undefined until it is read. */
  readonly connected: boolean | undefined;
}

export interface ActualyzeState {
  readonly row: ActualyzeRow;
  /** The `actualyze` record, when the payload has one. */
  readonly record: CatalogProviderRecord | undefined;
}

/**
 * The `/actualyze` state, highest priority first. Rows that show a
 * discovery result need a current record; every combination no other row
 * claims is `resolving`.
 */
export function deriveActualyzeState(inputs: ActualyzeInputs): ActualyzeState {
  const payload = inputs.server === "ready" ? inputs.payload : undefined;
  const record = payload?.providers.find(
    (item) => item.id === ACTUALYZE_PROVIDER_ID,
  );
  const at = (row: ActualyzeRow): ActualyzeState => ({ row, record });
  const pending = inputs.pending;
  if (pending?.phase === "saving") return at("saving");
  if (pending?.phase === "unconfirmed") return at("unconfirmed");
  if (inputs.server === "unavailable") return at("server-unavailable");
  if (payload?.builtIn.actualyze === "foreign") return at("not-managed");
  if (pending?.phase === "saved" && awaitingCheck(pending, payload))
    return at("checking");
  // While the catalog loads, a missing record says nothing yet: a
  // `settings.apiKey` user has no connection either.
  if (
    inputs.server !== "loading" &&
    inputs.connected === false &&
    (!record || record.credentialSource === "none")
  )
    return at("no-key");
  if (
    inputs.connected === true &&
    (!record ||
      payload?.status === "pending" ||
      record.credentialSource === "unresolved" ||
      !isCurrent(record))
  )
    return at("resolving");
  if (!record || !isCurrent(record)) return at("resolving");
  if (record.discovering && record.lastGoodAt === null)
    return at("discovering");
  if (record.failure !== null) return at("failure");
  if (record.lastGoodAt !== null)
    return at(record.models.length === 0 ? "empty" : "ready");
  return at("resolving");
}

/** The record's inventory from the last good discovery, if it has one. */
export function hasInventory(
  record: CatalogProviderRecord | undefined,
): boolean {
  return (
    record !== undefined &&
    record.lastGoodAt !== null &&
    record.models.length > 0
  );
}

/** Rows that also show the header-auth notice when headers replace the key. */
export const RESULT_ROWS: ReadonlySet<ActualyzeRow> = new Set<ActualyzeRow>([
  "discovering",
  "failure",
  "empty",
  "ready",
]);

// ── Status line and hints ───────────────────────────────────────────────

/** A part of the status line after its headline; whole parts with the highest `drop` go first. */
export interface StatusPart {
  readonly text: string;
  readonly drop: number;
}

/** Columns before each status part: " · ". */
const STATUS_SEPARATOR = 3;

/**
 * The status parts that fit in `width` columns after a headline of
 * `headWidth` columns, in their order. Parts are dropped whole, the highest
 * `drop` first and the later one on a tie, so the line never ends in a
 * separator or a cut word.
 */
export function fitStatusParts<Part extends StatusPart>(
  headWidth: number,
  parts: readonly Part[],
  width: number,
  measure: (text: string) => number = (text) => text.length,
): Part[] {
  const kept = parts.filter((part) => part.text.length > 0);
  const used = (): number =>
    kept.reduce(
      (sum, part) => sum + STATUS_SEPARATOR + measure(part.text),
      headWidth,
    );
  while (kept.length > 0 && used() > width) {
    let drop = 0;
    for (const [index, part] of kept.entries())
      if (part.drop >= (kept[drop]?.drop ?? 0)) drop = index;
    kept.splice(drop, 1);
  }
  return kept;
}

/**
 * Keys in the order every `/actualyze` card and footer lists them: the key
 * action, retry, copy link, links, connections, all providers.
 */
export const ACTION_ORDER: readonly string[] = ["k", "r", "y", "l", "c", "b"];

/** `items` sorted by `ACTION_ORDER`; keys outside it keep their place after those in it. */
export function inActionOrder<Item extends { readonly key: string }>(
  items: readonly Item[],
): Item[] {
  const rank = (item: Item): number => {
    const index = ACTION_ORDER.indexOf(item.key);
    return index < 0 ? ACTION_ORDER.length : index;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/** The retry hint: "retry (59 s)" while a refresh waits, "retry" once it may run. */
export function retryTitle(wait: number | undefined): string {
  return wait === undefined ? "retry" : `retry (${wait} s)`;
}

/** The sentence that tells when `r` works. */
export function retrySentence(wait: number | undefined): string {
  return wait === undefined
    ? "Retry with r."
    : "Retry with r once the wait ends.";
}

// ── Sessions ────────────────────────────────────────────────────────────

/**
 * `/actualyze` sessions of one plugin instance. A session starts when the
 * command opens and ends when its dialog closes for any reason but the key
 * prompt round trip; only the latest session is active, so a completion
 * that arrives for an earlier one changes nothing.
 */
export interface SessionTracker {
  /** Start a session at `directory`; any earlier session ends. */
  start(directory: string): number;
  end(session: number): void;
  /** Whether `session` is the active one and still at `directory`. */
  accepts(session: number, directory: string | undefined): boolean;
  active(): number | undefined;
}

export function createSessionTracker(): SessionTracker {
  let next = 1;
  let current: { id: number; directory: string } | undefined;
  return {
    start(directory) {
      const id = next;
      next += 1;
      current = { id, directory };
      return id;
    },
    end(session) {
      if (current?.id === session) current = undefined;
    },
    accepts(session, directory) {
      return current?.id === session && current.directory === directory;
    },
    active() {
      return current?.id;
    },
  };
}
