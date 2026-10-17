import type { Plugin } from "@opencode/plugin/tui";
import type { KeyEvent } from "@opentui/core";
import type {
  CatalogProviderRecord,
  ProviderFailure,
} from "./catalog-evidence";
import {
  ACTUALYZE_INTEGRATION_ID,
  ACTUALYZE_NAME,
  ACTUALYZE_PROVIDER_ID,
} from "./constants";
import {
  actualyzeEndpoint,
  actualyzeLink,
  actualyzeLinks,
  awaitingCheck,
  BUILT_IN_ENDPOINT,
  canEnterKey,
  createSessionTracker,
  deriveActualyzeState,
  displayOrigin,
  failureLink,
  hasInventory,
  integrationFacts,
  isCurrent,
  keyLabel,
  LINK_ORDER,
  linkLabel,
  reducePending,
  RESULT_ROWS,
  submitEvent,
  type ActiveConnection,
  type ActualyzeEndpoint,
  type ActualyzeLinkID,
  type ActualyzeState,
  type IntegrationFacts,
  type PendingMarker,
  type SessionTracker,
} from "./tui-actualyze";
import {
  findRecord,
  justify,
  refreshWaitSeconds,
  type BrowserData,
  type BrowserExtraAction,
  type BrowserFrame,
  type BrowserFrameCard,
  type BrowserScope,
  type FooterHint,
  type FrameKeyView,
} from "./tui-browser";
import { relativeAge, wrapText, type HelpEntry, type Line } from "./tui-detail";
import { keyMove, padText, textWidth, type Segment } from "./tui-list";
import {
  openBrowser,
  type BrowserFrameTools,
  type BrowserHandle,
} from "./tui-session";
import type { ForegroundRole } from "./tui-theme";

type Context = Plugin.Context;
type LocationRef = ReturnType<Context["data"]["location"]["default"]>;

const ACTUALYZE_SCOPE: BrowserScope = {
  kind: "provider",
  providerID: ACTUALYZE_PROVIDER_ID,
};

/** How long OpenCode gets to confirm a submitted key. */
const SAVE_TIMEOUT_MS = 15_000;
/** How long reading the integration and provider stores may take. */
const FACTS_TIMEOUT_MS = 10_000;
/** After this long in "checking", the card says the key is saved anyway. */
const STILL_CHECKING_MS = 20_000;
/** Content width from which card actions share one line. */
const INLINE_ACTIONS_COLUMNS = 100;

const KEY_VISIBLE =
  "The key is visible while you type. OpenCode stores it; Model Scout never shows it again.";

// ── Session state ───────────────────────────────────────────────────────

interface ProviderFacts {
  /** The provider's integration: its `integrationID`, else its ID. */
  readonly integrationID: string;
  readonly endpoint: ActualyzeEndpoint;
}

/** What the dialog reads from OpenCode's integration and provider stores. */
interface Facts {
  /** Undefined while OpenCode hides the provider for lack of a key. */
  readonly provider: ProviderFacts | undefined;
  readonly integration: IntegrationFacts;
}

interface Session {
  readonly id: number;
  readonly context: Context;
  readonly location: LocationRef;
  readonly openModelScout: () => void;
  /** Undefined until the stores are read once. */
  facts: Facts | undefined;
  factsReading: boolean;
  factsAgain: boolean;
  pending: PendingMarker | undefined;
  /** The links screen is open. */
  links: boolean;
  linkIndex: number;
  /** The link `y` copies from the card on screen, if it offers one. */
  cardLink: ActualyzeLinkID | undefined;
  /** The key prompt is open; the dialog it closed keeps the session. */
  prompting: boolean;
  ended: boolean;
  handle: BrowserHandle | undefined;
  tools: BrowserFrameTools | undefined;
  /** The browser data the frame last read, for the epoch at submit. */
  data: BrowserData | undefined;
  readonly stops: (() => void)[];
}

const trackers = new WeakMap<object, SessionTracker>();
const live = new WeakMap<object, Session>();
const retired = new WeakSet<object>();

function trackerFor(context: Context): SessionTracker {
  let tracker = trackers.get(context);
  if (!tracker) {
    tracker = createSessionTracker();
    trackers.set(context, tracker);
  }
  return tracker;
}

function currentDirectory(context: Context): string | undefined {
  try {
    return (context.location ?? context.data.location.default()).directory;
  } catch {
    return undefined;
  }
}

function accepts(session: Session): boolean {
  return (
    !session.ended &&
    trackerFor(session.context).accepts(
      session.id,
      currentDirectory(session.context),
    )
  );
}

function endSession(session: Session): void {
  if (session.ended) return;
  session.ended = true;
  session.pending = reducePending(session.pending, {
    type: "ended",
    session: session.id,
  });
  for (const stop of session.stops.splice(0)) stop();
  trackerFor(session.context).end(session.id);
  if (live.get(session.context) === session) live.delete(session.context);
}

function toast(
  context: Context,
  variant: "warning" | "error",
  message: string,
): void {
  try {
    context.ui.toast.show({ variant, title: ACTUALYZE_NAME, message });
  } catch {
    // A failing toast must not escape a key handler or a completion.
  }
}

/**
 * End the active `/actualyze` session and close its dialog, and refuse
 * later opens; the plugin cleanup calls this.
 */
export function closeActualyze(context: Context): void {
  retired.add(context);
  const session = live.get(context);
  if (!session) return;
  const handle = session.handle;
  endSession(session);
  handle?.close();
}

export interface OpenActualyzeOptions {
  /** Opens `/modelscout`, for `b`. */
  readonly openModelScout: () => void;
}

/** Open `/actualyze`: a new session, which ends any earlier one. */
export async function openActualyze(
  context: Context,
  options: OpenActualyzeOptions,
): Promise<void> {
  if (retired.has(context)) return;
  const previous = live.get(context);
  if (previous) endSession(previous);
  let location: LocationRef;
  try {
    location = context.location ?? context.data.location.default();
  } catch (error) {
    toast(
      context,
      "error",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  const session: Session = {
    id: trackerFor(context).start(location.directory),
    context,
    location,
    openModelScout: options.openModelScout,
    facts: undefined,
    factsReading: false,
    factsAgain: false,
    pending: undefined,
    links: false,
    linkIndex: 0,
    cardLink: undefined,
    prompting: false,
    ended: false,
    handle: undefined,
    tools: undefined,
    data: undefined,
    stops: [],
  };
  live.set(context, session);
  watchFacts(session);
  void readFactsInto(session, false);
  await show(session);
}

/** Show the dialog for `session`, at the start and after the key prompt. */
async function show(session: Session): Promise<void> {
  if (session.ended) return;
  let tools: BrowserFrameTools | undefined;
  const handle = await openBrowser(session.context, ACTUALYZE_SCOPE, {
    title: ACTUALYZE_NAME,
    searchPlaceholder: "Search Actualyze models",
    extraActions: extraActions(session),
    frame: (given) => {
      tools = given;
      session.tools = given;
      return createFrame(session);
    },
    onClose: () => {
      if (session.tools === tools) {
        session.tools = undefined;
        session.handle = undefined;
      }
      if (!session.prompting) endSession(session);
    },
  });
  if (!handle) {
    endSession(session);
    return;
  }
  if (session.ended) {
    handle.close();
    return;
  }
  if (!handle.closed) session.handle = handle;
}

// ── Integration and provider ────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the provider and its integration from OpenCode's stores. Only the
 * provider's `integrationID` and `settings.baseURL` are read; its other
 * settings can hold a plaintext key.
 */
async function readFacts(context: Context, ref: LocationRef): Promise<Facts> {
  const stores = context.data.location;
  await withTimeout(
    Promise.all([stores.integration.sync(ref), stores.provider.sync(ref)]),
    FACTS_TIMEOUT_MS,
  );
  const provider = stores.provider
    .list(ref)
    ?.find((item) => item.id === ACTUALYZE_PROVIDER_ID);
  const integrationID = provider?.integrationID ?? ACTUALYZE_INTEGRATION_ID;
  const integration = stores.integration
    .list(ref)
    ?.find((item) => item.id === integrationID);
  return {
    provider: provider
      ? {
          integrationID,
          endpoint: actualyzeEndpoint(
            (provider.settings as Record<string, unknown> | undefined)?.baseURL,
          ),
        }
      : undefined,
    integration: integrationFacts(integration),
  };
}

/** Read the stores again, at most one read at a time; a failed read keeps the last facts. */
async function readFactsInto(
  session: Session,
  invalidate: boolean,
): Promise<void> {
  if (session.ended) return;
  if (session.factsReading) {
    session.factsAgain = true;
    return;
  }
  session.factsReading = true;
  const stores = session.context.data.location;
  try {
    let fresh = invalidate;
    do {
      session.factsAgain = false;
      if (fresh) {
        stores.integration.invalidate(session.location);
        stores.provider.invalidate(session.location);
      }
      fresh = true;
      try {
        const facts = await readFacts(session.context, session.location);
        if (session.ended) return;
        session.facts = facts;
        session.tools?.repaint();
      } catch {
        // The next event reads again.
      }
    } while (session.factsAgain && !session.ended);
  } finally {
    session.factsReading = false;
  }
}

/** Connection and provider changes; `credential.switched` has no location. */
function watchFacts(session: Session): void {
  const reread = (event: { location?: { directory?: string } }): void => {
    if (
      event.location !== undefined &&
      event.location.directory !== session.location.directory
    )
      return;
    void readFactsInto(session, true);
  };
  const data = session.context.data;
  try {
    session.stops.push(
      data.on("integration.updated", reread),
      data.on("credential.updated", reread),
      data.on("credential.switched", reread),
      data.on("provider.updated", reread),
    );
  } catch {
    // Without events the dialog shows what it read when it opened.
  }
}

// ── Derived view ────────────────────────────────────────────────────────

interface ViewState {
  readonly state: ActualyzeState;
  readonly data: BrowserData;
  readonly pending: PendingMarker | undefined;
  readonly connection: ActiveConnection | undefined;
  readonly connected: boolean | undefined;
  /** Undefined until the stores are read. */
  readonly endpoint: ActualyzeEndpoint | undefined;
  readonly keyAllowed: boolean;
}

function keyAllowed(session: Session): boolean {
  const facts = session.facts;
  return (
    facts !== undefined &&
    session.pending?.phase !== "saving" &&
    canEnterKey(
      facts.provider?.integrationID ?? ACTUALYZE_INTEGRATION_ID,
      facts.integration,
    )
  );
}

function viewState(session: Session, data: BrowserData): ViewState {
  session.data = data;
  const server =
    data.status !== "ready"
      ? "loading"
      : data.catalog
        ? "ready"
        : "unavailable";
  const pending = session.pending;
  if (
    server === "ready" &&
    pending?.phase === "saved" &&
    !awaitingCheck(pending, data.catalog)
  )
    session.pending = reducePending(pending, { type: "checked" });
  const facts = session.facts;
  const connection = facts?.integration.connection;
  const connected = facts ? connection !== undefined : undefined;
  return {
    state: deriveActualyzeState({
      pending: session.pending,
      server,
      payload: data.catalog,
      connected,
    }),
    data,
    pending: session.pending,
    connection,
    connected,
    endpoint: facts
      ? (facts.provider?.endpoint ?? BUILT_IN_ENDPOINT)
      : undefined,
    keyAllowed: keyAllowed(session),
  };
}

function seg(text: string, role: ForegroundRole = "base"): Segment {
  return { text, role };
}

function hostOf(view: ViewState): string {
  const origin = view.endpoint?.origin;
  return origin ? displayOrigin(origin) : "the endpoint";
}

/** Headline, explanation, and color for a failed model list. */
function failureCopy(
  failure: ProviderFailure,
  view: ViewState,
  retryIn: number | undefined,
): { headline: string; body: string; role: ForegroundRole } {
  const status = failure.httpStatus;
  switch (failure.kind) {
    case "unauthorized":
      return {
        headline: "Key rejected (401)",
        body: "Actualyze did not accept this key. It answers the same way for a revoked or expired key, a key without the inference scope, and a key from another Actualyze environment.",
        role: "error",
      };
    case "forbidden":
      return {
        headline: "Access denied (403)",
        body: "Actualyze accepted the key but did not allow the model list. A read-only key or a team without model access gets this answer; ask a workspace admin.",
        role: "error",
      };
    case "payment-required":
      return {
        headline: "Budget or entitlement blocked (402)",
        body: "Actualyze did not allow this catalog request. No balance or reset date is available through this key; Budgets in the app shows them, and may need an admin role.",
        role: "warn",
      };
    case "rate-limited":
      return {
        headline:
          retryIn === undefined
            ? "Catalog rate limited (429)"
            : `Catalog rate limited · retry in ${retryIn} s`,
        body: "This limits the model list only, not inference. Model Scout checks again once the wait ends.",
        role: "warn",
      };
    case "unreachable":
      return {
        headline: `Can't reach ${hostOf(view)}`,
        body: "Check your network, VPN, or proxy, and settings.baseURL of providers.actualyze, then press r.",
        role: "warn",
      };
    case "timeout":
      return {
        headline: `${hostOf(view)} did not answer in time`,
        body: "The model list timed out. Check your network or the endpoint, then press r.",
        role: "warn",
      };
    case "server-error":
      return {
        headline: `Actualyze server error (${status ?? "5xx"})`,
        body: "Actualyze failed to list models. Try again later.",
        role: "warn",
      };
    case "not-found":
      return {
        headline: "No model list at this endpoint (404)",
        body: "settings.baseURL should end in /openai/v1.",
        role: "warn",
      };
    case "http-error":
      return {
        headline: `Unexpected answer (${status ?? "HTTP"})`,
        body: "The model list request did not succeed.",
        role: "warn",
      };
    case "invalid-response":
      return {
        headline: "Unexpected answer (not a model list)",
        body: "The endpoint answered, but not with a model list. Check settings.baseURL.",
        role: "warn",
      };
    case "aborted":
      return {
        headline: "Discovery was interrupted",
        body: "It runs again on the next refresh; r retries now.",
        role: "warn",
      };
    case "error":
      return {
        headline: "Discovery failed",
        body: "It runs again on the next refresh; r retries now.",
        role: "warn",
      };
  }
}

/** Where the key in use comes from, when the card should say so. */
function keySourceNote(
  view: ViewState,
  record: CatalogProviderRecord | undefined,
): string | undefined {
  if (record?.credentialSource === "settings")
    return "The key comes from settings.apiKey in opencode.json; a key connected with k takes precedence.";
  if (view.connection?.kind === "env")
    return `The key comes from ${view.connection.name} on the background service; a key connected with k takes precedence.`;
  return undefined;
}

// ── Header and status ───────────────────────────────────────────────────

function headerSegments(view: ViewState, width: number): Segment[] {
  const right: Segment[] = [];
  const endpoint = view.endpoint;
  if (endpoint?.customEndpoint)
    right.push(seg("custom endpoint", "info"), seg("  "));
  if (endpoint?.origin)
    right.push(seg(displayOrigin(endpoint.origin), "muted"));
  else if (endpoint) right.push(seg("settings.baseURL is not a URL", "warn"));
  return justify([seg("● ACTUALYZE", "brand")], right, width);
}

function checkedAge(
  record: CatalogProviderRecord | undefined,
  now: number,
): string | undefined {
  const age = relativeAge(
    record?.lastAttemptAt ?? record?.failure?.at ?? record?.lastGoodAt,
    now,
  );
  return age ? `checked ${age}` : undefined;
}

function statusSegments(view: ViewState, now: number): Segment[] {
  const { state, data } = view;
  const record = state.record;
  const key = keyLabel(view.connection, record?.credentialSource);
  const keyPart = key ? `key ${key}` : undefined;
  const join = (head: Segment, ...parts: (string | undefined)[]): Segment[] => {
    const rest = parts.filter((part): part is string => Boolean(part));
    return rest.length > 0
      ? [head, seg(` · ${rest.join(" · ")}`, "muted")]
      : [head];
  };
  if (data.status === "failed")
    return [seg("▲ OpenCode's model lists did not load", "error")];
  switch (state.row) {
    case "saving":
      return [seg("○ Saving key in OpenCode…", "info")];
    case "unconfirmed":
      return [seg("▲ OpenCode did not confirm the key was saved", "error")];
    case "server-unavailable":
      return join(
        seg("▲ Discovery status unavailable", "warn"),
        keyPart ?? (view.connected === false ? "not connected" : undefined),
      );
    case "not-managed":
      return join(seg("Not managed by Model Scout", "muted"), keyPart);
    case "checking":
      return [seg(`○ ${checkingText(view.pending, now)}`, "info")];
    case "no-key":
      return [seg("Not connected", "muted")];
    case "resolving":
      return join(seg("○ Checking the connection…", "info"), keyPart);
    case "discovering":
      return join(seg("○ Loading models…", "info"), keyPart);
    case "failure": {
      if (!record?.failure) return [];
      const copy = failureCopy(
        record.failure,
        view,
        refreshWaitSeconds(record, data, now),
      );
      return join(
        seg(`▲ ${copy.headline}`, copy.role),
        keyPart,
        checkedAge(record, now),
      );
    }
    case "empty":
      return join(
        seg("● Catalog accessible", "ok"),
        keyPart,
        "no models for this key",
        checkedAge(record, now),
      );
    case "ready": {
      const count = record?.models.length ?? 0;
      const segments = join(
        seg("● Catalog accessible", "ok"),
        keyPart,
        `${count} ${count === 1 ? "model" : "models"}`,
        checkedAge(record, now),
      );
      return record?.discovering
        ? [...segments, seg(" · ", "muted"), seg("○ checking", "info")]
        : segments;
    }
  }
}

function checkingText(pending: PendingMarker | undefined, now: number): string {
  const savedAt = pending?.savedAt ?? now;
  return now - savedAt >= STILL_CHECKING_MS
    ? "Still checking. The key is saved."
    : "Key saved. Checking the current connection…";
}

// ── Cards ───────────────────────────────────────────────────────────────

interface CardAction {
  readonly key: string;
  /** Footer title. */
  readonly title: string;
  /** Text in the card, before the key; defaults to the title. */
  readonly label?: string;
  /** Text in the card after the key. */
  readonly suffix?: string;
  readonly enabled?: boolean;
  /** Shown inside the card as well as in the footer. */
  readonly primary?: boolean;
  readonly help: string;
}

function keyAction(
  view: ViewState,
  primary: boolean,
  label?: string,
): CardAction {
  return {
    key: "k",
    title: view.connected ? "another key" : "connect key",
    ...(label ? { label } : {}),
    enabled: view.keyAllowed,
    primary,
    help: KEY_HELP,
  };
}

const KEY_HELP =
  "connect a key through OpenCode's key prompt; the key is visible while you type";
const CONNECTIONS_HELP =
  "OpenCode's connections (pick Actualyze): switch, rename, or remove keys";

function copyAction(link: ActualyzeLinkID, primary: boolean): CardAction {
  const name = linkLabel(link);
  return {
    key: "y",
    title: "copy link",
    label: `copy ${name} link`,
    primary,
    help: `copy the ${name} link`,
  };
}

const LINKS_ACTION: CardAction = {
  key: "l",
  title: "links",
  help: "app links: API keys, catalog, budgets, usage, troubleshooting",
};

function connectionsAction(primary: boolean): CardAction {
  return {
    key: "c",
    title: "connections",
    suffix: " (pick Actualyze)",
    primary,
    help: CONNECTIONS_HELP,
  };
}

const BROWSE_ACTION: CardAction = {
  key: "b",
  title: "all providers",
  help: "every provider (/modelscout)",
};

function retryAction(wait: number | undefined, primary: boolean): CardAction {
  return {
    key: "r",
    title: wait === undefined ? "retry" : `retry in ${wait} s`,
    enabled: wait === undefined,
    primary,
    help: "check the catalog again",
  };
}

/** Lines of a card with a bar in `role` down its left edge. */
class CardWriter {
  readonly lines: Line[] = [];
  private readonly inner: number;

  constructor(
    private readonly role: ForegroundRole,
    private readonly width: number,
  ) {
    this.inner = Math.max(8, width - 2);
  }

  private push(content: readonly Segment[]): void {
    this.lines.push([seg("▌ ", this.role), ...content]);
  }

  blank(): void {
    this.lines.push([seg("▌", this.role)]);
  }

  text(body: string, role: ForegroundRole = "base"): void {
    for (const part of wrapText(body, this.inner)) this.push([seg(part, role)]);
  }

  /** A numbered step with its continuation lines indented under the text. */
  step(number: string, body: string, extra?: string): void {
    const indent = 3;
    const parts = wrapText(body, this.inner - indent);
    for (const [index, part] of parts.entries())
      this.push([seg(padText(index === 0 ? number : "", indent)), seg(part)]);
    if (extra) this.push([seg(" ".repeat(indent)), seg(extra, "muted")]);
  }

  actions(actions: readonly CardAction[]): void {
    const shown = actions.filter((action) => action.primary);
    if (shown.length === 0) return;
    const parts = shown.map((action): Segment[] => {
      const enabled = action.enabled !== false;
      return [
        seg(action.label ?? action.title, enabled ? "base" : "disabled"),
        seg(" "),
        seg(action.key, enabled ? "key" : "disabled"),
        ...(action.suffix
          ? [seg(action.suffix, enabled ? "muted" : "disabled")]
          : []),
      ];
    });
    const inline = parts.flatMap((part, index) =>
      index === 0 ? part : [seg("   "), ...part],
    );
    const inlineWidth = inline.reduce(
      (sum, part) => sum + textWidth(part.text),
      0,
    );
    if (this.width >= INLINE_ACTIONS_COLUMNS && inlineWidth <= this.inner)
      this.push(inline);
    else for (const part of parts) this.push(part);
  }
}

function hints(actions: readonly CardAction[]): FooterHint[] {
  return actions.map((action) => ({
    title: action.title,
    key: action.key,
    enabled: action.enabled !== false,
  }));
}

function helpFor(actions: readonly CardAction[]): HelpEntry[] {
  return actions.map((action) => ({ keys: action.key, action: action.help }));
}

function replaceCard(
  writer: CardWriter,
  actions: readonly CardAction[],
  refresh = false,
): BrowserFrameCard {
  return {
    placement: "replace",
    lines: writer.lines,
    hints: hints(actions),
    help: helpFor(actions),
    refresh,
  };
}

const HEADERS_NOTICE =
  "Discovery uses the provider's configured headers, not the connected key.";

function noKeyCard(view: ViewState, width: number): BrowserFrameCard {
  const writer = new CardWriter("muted", width);
  const origin = view.endpoint?.origin;
  writer.text(
    "Connect an Actualyze API key to use your team's models in OpenCode.",
  );
  writer.blank();
  writer.step(
    "1",
    "Create a key in Account Settings → Security → API Keys (Read & Write).",
    origin ? actualyzeLink(origin, "apiKeys").url : undefined,
  );
  if (view.keyAllowed) writer.step("2", `Press k and paste it. ${KEY_VISIBLE}`);
  else
    writer.step(
      "2",
      "Press c and pick Actualyze to connect it in OpenCode's connections.",
    );
  writer.blank();
  writer.text(
    "From a shell: opencode auth login actualyze, or ACTUALYZE_API_KEY on the background service.",
    "muted",
  );
  const actions = [
    keyAction(view, false),
    ...(origin ? [copyAction("apiKeys", false)] : []),
    LINKS_ACTION,
    connectionsAction(false),
    BROWSE_ACTION,
  ];
  return replaceCard(writer, actions);
}

function failureCard(
  view: ViewState,
  record: CatalogProviderRecord,
  failure: ProviderFailure,
  width: number,
  now: number,
  linkable: boolean,
): BrowserFrameCard {
  const wait = refreshWaitSeconds(record, view.data, now);
  const copy = failureCopy(failure, view, wait);
  const above = hasInventory(record);
  const writer = new CardWriter(copy.role, width);
  writer.text(copy.body);
  const note = keySourceNote(view, record);
  if (note) writer.text(note, "muted");
  if (above) {
    const count = record.models.length;
    const age = relativeAge(record.lastGoodAt, now);
    writer.text(
      `Showing ${count} ${count === 1 ? "model" : "models"} from the last good check${age ? `, ${age}` : ""}. Links are under l.`,
      "muted",
    );
    return { placement: "above", lines: writer.lines };
  }
  const link = failureLink(failure.kind);
  const copyLink = linkable ? [copyAction(link, true)] : [];
  let actions: CardAction[];
  switch (failure.kind) {
    case "unauthorized":
    case "forbidden":
      actions = [
        keyAction(view, true),
        ...copyLink,
        connectionsAction(true),
        retryAction(wait, false),
        LINKS_ACTION,
        BROWSE_ACTION,
      ];
      break;
    case "payment-required":
      actions = [
        ...copyLink,
        keyAction(view, true),
        retryAction(wait, true),
        LINKS_ACTION,
        connectionsAction(false),
        BROWSE_ACTION,
      ];
      break;
    case "rate-limited":
      actions = [
        retryAction(wait, true),
        LINKS_ACTION,
        keyAction(view, false),
        BROWSE_ACTION,
      ];
      break;
    default:
      actions = [
        retryAction(wait, true),
        ...copyLink,
        keyAction(view, false),
        LINKS_ACTION,
        connectionsAction(false),
        BROWSE_ACTION,
      ];
  }
  writer.blank();
  writer.actions(actions);
  return replaceCard(writer, actions, true);
}

interface Described {
  readonly status: Segment[];
  readonly card: BrowserFrameCard | undefined;
  /** The link `y` copies from this card. */
  readonly link: ActualyzeLinkID | undefined;
}

function describe(
  session: Session,
  view: ViewState,
  width: number,
  now: number,
): Described {
  const status = statusSegments(view, now);
  if (session.links) return { status, ...linksCard(session, view, width) };
  // Host lists that failed to load keep the browser's own card and retry.
  if (view.data.status === "failed")
    return { status, card: undefined, link: undefined };
  const { card, link } = describeRow(session, view, width, now);
  const record = view.state.record;
  const origin = view.endpoint?.origin;
  const described = { status, card, link: origin ? link : undefined };
  if (
    !RESULT_ROWS.has(view.state.row) ||
    record?.credentialSource !== "headers"
  )
    return described;
  const notice = new CardWriter("info", width);
  notice.text(HEADERS_NOTICE, "info");
  return {
    ...described,
    card: card
      ? { ...card, lines: [...card.lines, ...notice.lines] }
      : { placement: "above", lines: notice.lines },
  };
}

function describeRow(
  session: Session,
  view: ViewState,
  width: number,
  now: number,
): {
  readonly card: BrowserFrameCard | undefined;
  readonly link?: ActualyzeLinkID;
} {
  const { state, data } = view;
  const record = state.record;
  const origin = view.endpoint?.origin;
  const done = (
    card: BrowserFrameCard | undefined,
    link?: ActualyzeLinkID,
  ): { card: BrowserFrameCard | undefined; link?: ActualyzeLinkID } =>
    link ? { card, link } : { card };
  switch (state.row) {
    case "saving": {
      const writer = new CardWriter("info", width);
      writer.text("Saving key in OpenCode…");
      writer.text(
        "Closing this dialog does not undo a completed save.",
        "muted",
      );
      return done(replaceCard(writer, [LINKS_ACTION, BROWSE_ACTION]));
    }
    case "unconfirmed": {
      const writer = new CardWriter("error", width);
      writer.text(
        "OpenCode did not confirm the key was saved. Check connections before trying again.",
      );
      const actions = [
        connectionsAction(true),
        keyAction(view, true, "try again"),
        LINKS_ACTION,
        BROWSE_ACTION,
      ];
      writer.blank();
      writer.actions(actions);
      return done(replaceCard(writer, actions));
    }
    case "server-unavailable": {
      const writer = new CardWriter("warn", width);
      writer.text(
        "Model Scout's server half did not answer, so the catalog status is unknown. Connecting a key still works.",
      );
      const key = keyLabel(view.connection, undefined);
      writer.text(
        key
          ? `Connection: key ${key}.`
          : view.connected === false
            ? "No key is connected."
            : "The connection is not known yet.",
        "muted",
      );
      if (session.pending?.phase === "saved") writer.text("Key saved.", "ok");
      const actions = [
        keyAction(view, true),
        connectionsAction(true),
        LINKS_ACTION,
        BROWSE_ACTION,
      ];
      writer.blank();
      writer.actions(actions);
      return done(replaceCard(writer, actions, true));
    }
    case "not-managed": {
      const writer = new CardWriter("muted", width);
      writer.text(
        "Another plugin or a models.dev catalog defines the actualyze provider, so Model Scout does not discover its models.",
      );
      writer.text(
        'To opt in, add "probe": "actualyze" to providers.actualyze.settings in opencode.json.',
        "muted",
      );
      return done(
        replaceCard(writer, [
          connectionsAction(false),
          LINKS_ACTION,
          BROWSE_ACTION,
        ]),
      );
    }
    case "checking": {
      const writer = new CardWriter("info", width);
      writer.text(checkingText(view.pending, now));
      writer.text(
        "Model Scout lists the models this key can reach; no inference request is sent.",
        "muted",
      );
      return done(replaceCard(writer, [LINKS_ACTION, BROWSE_ACTION]));
    }
    case "no-key":
      return done(noKeyCard(view, width), "apiKeys");
    case "resolving": {
      const writer = new CardWriter("info", width);
      writer.text(
        data.status === "loading"
          ? "Reading models from OpenCode and Model Scout…"
          : "Checking the connection…",
      );
      return done(
        replaceCard(writer, [
          LINKS_ACTION,
          connectionsAction(false),
          BROWSE_ACTION,
        ]),
      );
    }
    case "discovering": {
      const writer = new CardWriter("info", width);
      writer.text("Loading models…");
      writer.text(
        "Model Scout is reading the catalog this key can reach.",
        "muted",
      );
      return done(replaceCard(writer, [LINKS_ACTION, BROWSE_ACTION]));
    }
    case "failure": {
      if (!record?.failure) return done(undefined);
      const link = failureLink(record.failure.kind);
      const card = failureCard(
        view,
        record,
        record.failure,
        width,
        now,
        origin !== undefined,
      );
      return done(card, card.placement === "replace" ? link : undefined);
    }
    case "empty": {
      const writer = new CardWriter("muted", width);
      writer.text("Catalog accessible · no models for this key");
      writer.text(
        "The key works, but its team cannot use any models yet. Ask a workspace admin for model access.",
        "muted",
      );
      const actions = [
        retryAction(refreshWaitSeconds(record, data, now), true),
        ...(origin ? [copyAction("catalog", true)] : []),
        keyAction(view, true),
        LINKS_ACTION,
        connectionsAction(false),
        BROWSE_ACTION,
      ];
      writer.blank();
      writer.actions(actions);
      return done(replaceCard(writer, actions, true), "catalog");
    }
    case "ready":
      return done(undefined);
  }
}

// ── Links ───────────────────────────────────────────────────────────────

const LINK_LABEL_COLUMNS = 21;

function linksCard(
  session: Session,
  view: ViewState,
  width: number,
): { card: BrowserFrameCard; link: ActualyzeLinkID | undefined } {
  const origin = view.endpoint?.origin;
  const lines: Line[] = [
    [seg("Links · enter or y copies the selected link", "muted")],
    [],
  ];
  const highlight: number[] = [];
  const actions: CardAction[] = [
    { key: "enter", title: "copy", help: "copy the selected link" },
    { key: "backspace", title: "back", help: "back; l does the same" },
    BROWSE_ACTION,
  ];
  const help: HelpEntry[] = [
    { keys: "↑ ↓ home end", action: "choose a link" },
    ...helpFor(actions),
    { keys: "y", action: "copy the selected link" },
  ];
  if (!origin) {
    lines.push([
      seg(
        "No app links: settings.baseURL of providers.actualyze is not an http(s) URL.",
        "warn",
      ),
    ]);
    return {
      card: {
        placement: "replace",
        lines,
        hints: hints(actions.slice(1)),
        help,
      },
      link: undefined,
    };
  }
  const links = actualyzeLinks(origin);
  const index = Math.min(Math.max(0, session.linkIndex), links.length - 1);
  for (const [position, link] of links.entries()) {
    const label = `   ${link.label}`;
    const start = lines.length;
    if (LINK_LABEL_COLUMNS + textWidth(link.url) <= width)
      lines.push([
        seg(padText(label, LINK_LABEL_COLUMNS)),
        seg(link.url, "muted"),
      ]);
    else lines.push([seg(label)], [seg(`      ${link.url}`, "muted")]);
    if (position === index)
      for (let line = start; line < lines.length; line += 1)
        highlight.push(line);
  }
  lines.push([]);
  lines.push([seg("Budgets may need an admin role in Actualyze.", "muted")]);
  lines.push([
    seg(
      "Copying sends the link to your terminal's clipboard; Model Scout cannot open a browser.",
      "muted",
    ),
  ]);
  return {
    card: {
      placement: "replace",
      lines,
      highlight,
      hints: hints(actions),
      help,
    },
    link: links[index]?.id,
  };
}

function openLinks(session: Session): void {
  if (session.links) {
    session.links = false;
    session.tools?.repaint();
    return;
  }
  const record = session.data
    ? findRecord(session.data, ACTUALYZE_PROVIDER_ID)
    : undefined;
  const preferred =
    record?.failure && isCurrent(record)
      ? failureLink(record.failure.kind)
      : "apiKeys";
  session.linkIndex = Math.max(0, LINK_ORDER.indexOf(preferred));
  session.links = true;
  session.tools?.repaint();
}

function copyLink(session: Session, id: ActualyzeLinkID | undefined): void {
  const origin = session.facts
    ? (session.facts.provider?.endpoint ?? BUILT_IN_ENDPOINT).origin
    : undefined;
  if (!origin || !id) return;
  session.tools?.copy(actualyzeLink(origin, id).url);
}

function hasModifier(key: KeyEvent): boolean {
  return Boolean(key.ctrl || key.meta || key.option || key.super || key.hyper);
}

/** Keys of the links screen, and `y` on a card that offers a link. */
function routeFrameKey(
  session: Session,
  key: KeyEvent,
  view: FrameKeyView,
): (() => void) | undefined {
  if (hasModifier(key) || view.screen !== "list") return undefined;
  const plainY = key.name === "y" && !key.shift;
  if (session.links) {
    const move = keyMove(key.name);
    if (move && move !== "pageup" && move !== "pagedown") {
      return () => {
        const last = LINK_ORDER.length - 1;
        session.linkIndex =
          move === "up"
            ? Math.max(0, session.linkIndex - 1)
            : move === "down"
              ? Math.min(last, session.linkIndex + 1)
              : move === "home"
                ? 0
                : last;
        session.tools?.repaint();
      };
    }
    if (key.name === "return" || key.name === "enter" || plainY)
      return () => copyLink(session, session.cardLink);
    if (key.name === "backspace" || key.name === "l")
      return () => {
        session.links = false;
        session.tools?.repaint();
      };
    return undefined;
  }
  if (plainY && view.card?.placement === "replace" && session.cardLink)
    return () => copyLink(session, session.cardLink);
  return undefined;
}

function createFrame(session: Session): BrowserFrame {
  const read = (data: BrowserData, width: number, now: number): Described => {
    const view = viewState(session, data);
    const described = describe(session, view, width, now);
    session.cardLink = described.link;
    return described;
  };
  return {
    header: (data, width) => headerSegments(viewState(session, data), width),
    status: (data, width, now) => {
      const { status, card } = read(data, width, now);
      if (card?.placement === "replace") return status;
      return justify(status, frameKeyHints(session, status, width), width);
    },
    card: (data, width, now) => read(data, width, now).card,
    route: (key, view) => routeFrameKey(session, key, view),
  };
}

// ── Actions ─────────────────────────────────────────────────────────────

function extraActions(session: Session): BrowserExtraAction[] {
  return [
    {
      key: "k",
      get title() {
        return session.facts?.integration.connection
          ? "another key"
          : "connect key";
      },
      prominent: true,
      help: KEY_HELP,
      enabled: () => keyAllowed(session),
      run: () => void enterKey(session),
    },
    {
      key: "l",
      title: LINKS_ACTION.title,
      prominent: true,
      help: LINKS_ACTION.help,
      run: () => openLinks(session),
    },
    {
      key: "c",
      title: "connections",
      help: CONNECTIONS_HELP,
      run: () => session.context.keymap.dispatch("provider.connect"),
    },
    {
      key: "b",
      title: BROWSE_ACTION.title,
      help: BROWSE_ACTION.help,
      run: () => session.openModelScout(),
    },
  ];
}

/**
 * `c`, `b`, `l`, and `k` at the right of the status line in the list views,
 * as many as fit: the footer drops caller hints first when it runs out of
 * room, and `?` lists all four.
 */
function frameKeyHints(
  session: Session,
  left: readonly Segment[],
  width: number,
): Segment[] {
  const used = left.reduce((sum, part) => sum + textWidth(part.text), 0);
  // `c` and `b` first: the footer lists `k` and `l` before them.
  const items: [string, string, boolean][] = [
    ["connections", "c", true],
    ["all providers", "b", true],
    ["links", "l", true],
    [
      session.facts?.integration.connection ? "another key" : "connect key",
      "k",
      keyAllowed(session),
    ],
  ];
  const right: Segment[] = [];
  let columns = 0;
  for (const [title, key, enabled] of items) {
    const gap = right.length > 0 ? 2 : 0;
    const next = gap + textWidth(title) + 1 + key.length;
    if (used + 2 + columns + next > width) break;
    if (gap) right.push(seg("  "));
    right.push(
      seg(title, enabled ? "muted" : "disabled"),
      seg(" "),
      seg(key, enabled ? "key" : "disabled"),
    );
    columns += next;
  }
  return right;
}

type SaveOutcome = "saved" | "unconfirmed";

/** Submit `key` once; a rejection or no answer within 15 s is unconfirmed. */
async function saveKey(
  context: Context,
  key: string,
  directory: string,
): Promise<SaveOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SaveOutcome>((resolve) => {
    timer = setTimeout(() => resolve("unconfirmed"), SAVE_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([
      context.client.integration.connect
        .key(
          {
            integrationID: ACTUALYZE_INTEGRATION_ID,
            key,
            location: { directory },
          },
          { signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) },
        )
        .then((): SaveOutcome => "saved"),
      timeout,
    ]);
  } catch {
    return "unconfirmed";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The `k` flow: OpenCode's prompt replaces the dialog, the key is submitted
 * once, and the dialog shows again while OpenCode saves it. A cancelled or
 * replaced prompt ends the session; an empty answer shows the dialog again.
 */
async function enterKey(session: Session): Promise<void> {
  if (session.ended || !keyAllowed(session)) return;
  const { context } = session;
  session.prompting = true;
  let entered: string | undefined;
  try {
    entered = await context.ui.dialog.prompt({
      title: "Actualyze API key",
      description: KEY_VISIBLE,
    });
  } catch {
    entered = undefined;
  } finally {
    session.prompting = false;
  }
  if (session.ended) return;
  if (entered === undefined || !accepts(session)) {
    endSession(session);
    return;
  }
  let saving: Promise<SaveOutcome>;
  {
    const key = entered.trim();
    entered = undefined;
    if (key === "") {
      await show(session);
      return;
    }
    session.pending = reducePending(
      session.pending,
      submitEvent(session.id, session.data?.catalog),
    );
    session.links = false;
    saving = saveKey(context, key, session.location.directory);
  }
  void show(session);
  const outcome = await saving;
  if (!accepts(session)) {
    if (outcome === "unconfirmed")
      toast(
        context,
        "warning",
        "OpenCode did not confirm the Actualyze key was saved",
      );
    return;
  }
  session.pending = reducePending(
    session.pending,
    outcome === "saved"
      ? { type: "resolved", session: session.id, at: Date.now() }
      : { type: "rejected", session: session.id },
  );
  session.tools?.repaint();
  if (outcome === "saved") void readFactsInto(session, true);
}
