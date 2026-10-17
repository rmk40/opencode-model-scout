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
  fitStatusParts,
  hasInventory,
  inActionOrder,
  integrationFacts,
  isCurrent,
  keyLabel,
  LINK_LABEL_COLUMNS,
  LINK_ORDER,
  LINK_URL_INDENT,
  linkLabel,
  linkLayout,
  reducePending,
  RESULT_ROWS,
  retrySentence,
  retryTitle,
  submitEvent,
  type ActiveConnection,
  type ActualyzeEndpoint,
  type ActualyzeLinkID,
  type ActualyzeState,
  type IntegrationFacts,
  type PendingMarker,
  type SessionTracker,
  type StatusPart,
} from "./tui-actualyze";
import {
  findRecord,
  footerShown,
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
import {
  NBSP,
  relativeAge,
  wrapText,
  type HelpEntry,
  type Line,
} from "./tui-detail";
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
/** After this long in "checking", the status says it is still checking. */
const STILL_CHECKING_MS = 20_000;

const KEY_VISIBLE =
  "The key is visible while you type; OpenCode stores it and Model Scout never shows it.";

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
  /** The card on screen is the server-unavailable card, whose `r` reads the catalog again. */
  cardReloads: boolean;
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
  const prompting = session.prompting;
  endSession(session);
  if (!prompting) {
    handle?.close();
    return;
  }
  // The prompt replaced the dialog, so the handle no longer closes anything.
  // A replaced prompt settles at once, but its continuation, which clears
  // `prompting`, runs as a microtask queued before this one; clearing only
  // if the flag is still set leaves a dialog that replaced the prompt alone.
  queueMicrotask(() => {
    if (!session.prompting) return;
    try {
      context.ui.dialog.clear();
    } catch {
      // A failing clear must not escape the plugin cleanup.
    }
  });
}

/** End a session whose location changed, closing its dialog if still open. */
function abandon(session: Session): void {
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
    cardReloads: false,
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

/**
 * What a failed model list means: the status headline, the card's title
 * and body, and the color of the glyph and the card bar. The endpoint is
 * in the header, so no headline repeats it.
 */
interface FailureCopy {
  readonly headline: string;
  readonly title: string;
  readonly body: string;
  readonly role: ForegroundRole;
}

const BASE_URL_SETTING = "providers.actualyze.settings.baseURL";

function failureCopy(
  failure: ProviderFailure,
  wait: number | undefined,
): FailureCopy {
  const status = failure.httpStatus;
  const retry = retrySentence(wait);
  switch (failure.kind) {
    case "unauthorized":
      return {
        headline: "Key rejected (401)",
        title: "Actualyze did not accept this key",
        body: "It answers the same way for a revoked or expired key, a key without the inference scope, or a key from another Actualyze environment.",
        role: "error",
      };
    case "forbidden":
      return {
        headline: "Access denied (403)",
        title: "Actualyze refused the model list request",
        body: "Check the key's permissions and model access with your administrator.",
        role: "error",
      };
    case "payment-required":
      return {
        headline: "Budget or entitlement blocked (402)",
        title: "Actualyze did not allow the model list request",
        body: "No balance or reset date is available through this key. The Budgets page in the app shows them; it may need an admin role.",
        role: "warn",
      };
    case "rate-limited":
      return {
        headline: "Catalog rate limited (429)",
        title: "The model list is rate limited, not inference",
        body: `${wait === undefined ? "Retry with r" : "Retry with r once the wait ends"}; otherwise Model Scout checks again on its next scheduled refresh, or when settings or the key change.`,
        role: "warn",
      };
    case "unreachable":
      return {
        headline: "Could not reach the endpoint",
        title: "The connection failed",
        body: `Check your network, VPN, or proxy, and ${BASE_URL_SETTING}. ${retry}`,
        role: "warn",
      };
    case "timeout":
      return {
        headline: "Endpoint did not answer in time",
        title: "The model list request timed out",
        body: `Check your network or the endpoint. ${retry}`,
        role: "warn",
      };
    case "server-error":
      return {
        headline: `Actualyze server error (${status ?? "5xx"})`,
        title: "Actualyze failed to list models",
        body: `This is on Actualyze's side. ${retry}`,
        role: "warn",
      };
    case "not-found":
      return {
        headline: "No model list at this endpoint (404)",
        title: "The base URL may be wrong",
        body: `The setting ${BASE_URL_SETTING} should end in /openai/v1.`,
        role: "warn",
      };
    case "http-error":
      return {
        headline: `Unexpected answer (${status ?? "HTTP"})`,
        title: "The model list request did not succeed",
        body: retry,
        role: "warn",
      };
    case "invalid-response":
      return {
        headline: "Unexpected answer (not a model list)",
        title: "The endpoint did not send a model list",
        body: `Check ${BASE_URL_SETTING}. ${retry}`,
        role: "warn",
      };
    case "aborted":
      return {
        headline: "Discovery was interrupted",
        title: "Discovery stopped before it finished",
        body: `It runs again on the next refresh. ${retry}`,
        role: "warn",
      };
    case "error":
      return {
        headline: "Discovery failed",
        title: "Discovery stopped with an error",
        body: `It runs again on the next refresh. ${retry}`,
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

/** A status part with its color; see `fitStatusParts`. */
interface ColoredPart extends StatusPart {
  readonly role: ForegroundRole;
}

/** Drop order of status parts: the age goes first, then the key label. */
const DROP_AGE = 3;
const DROP_KEY = 2;
const DROP_DETAIL = 1;

/**
 * The status line: a glyph in the state's color, the headline in base,
 * then parts that fit, each after " · ". Whole parts are dropped when the
 * line is too narrow, the age first and the key label next.
 */
function statusLine(
  glyph: string,
  glyphRole: ForegroundRole,
  headline: string,
  parts: readonly (ColoredPart | undefined)[],
  width: number,
): Segment[] {
  const head = [seg(glyph, glyphRole), seg(` ${headline}`)];
  const fitted = fitStatusParts(
    textWidth(`${glyph} ${headline}`),
    parts.filter((part): part is ColoredPart => part !== undefined),
    width,
    textWidth,
  );
  return [
    ...head,
    ...fitted.flatMap((part) => [
      seg(" · ", "muted"),
      seg(part.text, part.role),
    ]),
  ];
}

/** Chat models of the Actualyze group, as `/modelscout` counts them. */
function chatModelCount(data: BrowserData): number {
  const group = data.groups.find((item) => item.id === ACTUALYZE_PROVIDER_ID);
  return (
    group?.models.filter((model) => model.type !== "embedding").length ?? 0
  );
}

function statusSegments(
  view: ViewState,
  now: number,
  width: number,
): Segment[] {
  const { state, data } = view;
  const record = state.record;
  const key = keyLabel(view.connection, record?.credentialSource);
  const keyPart: ColoredPart | undefined = key
    ? { text: `key ${key}`, role: "muted", drop: DROP_KEY }
    : undefined;
  const age = checkedAge(record, now);
  const agePart: ColoredPart | undefined = age
    ? { text: age, role: "muted", drop: DROP_AGE }
    : undefined;
  const line = (
    glyph: string,
    role: ForegroundRole,
    headline: string,
    ...parts: (ColoredPart | undefined)[]
  ): Segment[] => statusLine(glyph, role, headline, parts, width);
  if (data.status === "failed")
    return line("▲", "error", "OpenCode's model lists did not load");
  switch (state.row) {
    case "saving":
      return line("○", "info", "Saving key…");
    case "unconfirmed":
      return line("▲", "error", "Save not confirmed");
    case "server-unavailable":
      return line(
        "▲",
        "warn",
        "Discovery status unavailable",
        keyPart ??
          (view.connected === false
            ? { text: "not connected", role: "muted", drop: DROP_KEY }
            : undefined),
      );
    case "not-managed":
      return line("○", "muted", "Not managed by Model Scout", keyPart);
    case "checking":
      return line("○", "info", checkingHeadline(view.pending, now));
    case "no-key":
      return line("○", "muted", "Not connected");
    case "resolving":
      return data.status === "loading"
        ? line("○", "info", "Loading…")
        : line("○", "info", "Checking the connection…", keyPart);
    case "discovering":
      return line("○", "info", "Loading models…", keyPart);
    case "failure": {
      if (!record?.failure) return [];
      const copy = failureCopy(
        record.failure,
        refreshWaitSeconds(record, data, now),
      );
      return line("▲", copy.role, copy.headline, keyPart, agePart);
    }
    case "empty":
      return line("▲", "warn", "No models for this key", keyPart, agePart);
    case "ready": {
      const count = chatModelCount(data);
      return line(
        "●",
        "ok",
        "Catalog accessible",
        keyPart,
        {
          text: `${count} ${count === 1 ? "model" : "models"}`,
          role: "muted",
          drop: DROP_DETAIL,
        },
        agePart,
        record?.discovering
          ? { text: "○ checking", role: "info", drop: DROP_DETAIL }
          : undefined,
      );
    }
  }
}

function checkingHeadline(
  pending: PendingMarker | undefined,
  now: number,
): string {
  const savedAt = pending?.savedAt ?? now;
  return now - savedAt >= STILL_CHECKING_MS
    ? "Still checking the current connection…"
    : "Checking the current connection…";
}

// ── Cards ───────────────────────────────────────────────────────────────

/** A key a card offers; the card's action row and the footer show the same title. */
interface CardAction {
  readonly key: string;
  readonly title: string;
  readonly enabled?: boolean;
  readonly help: string;
}

function keyAction(view: ViewState): CardAction {
  return {
    key: "k",
    title: view.connected ? "another key" : "connect key",
    enabled: view.keyAllowed,
    help: KEY_HELP,
  };
}

const KEY_HELP =
  "connect a key through OpenCode's key prompt; the key is visible while you type";
const CONNECTIONS_HELP =
  "OpenCode's connections (pick Actualyze): switch, rename, or remove keys";

function copyAction(link: ActualyzeLinkID): CardAction {
  return {
    key: "y",
    title: "copy link",
    help: `copy the ${linkLabel(link)} link`,
  };
}

const LINKS_ACTION: CardAction = {
  key: "l",
  title: "links",
  help: "app links: API Keys, Catalog, Budgets, Usage, Troubleshooting",
};

function connectionsAction(): CardAction {
  return { key: "c", title: "connections", help: CONNECTIONS_HELP };
}

const BROWSE_ACTION: CardAction = {
  key: "b",
  title: "all providers",
  help: "every provider (/modelscout)",
};

function retryAction(wait: number | undefined): CardAction {
  return {
    key: "r",
    title: retryTitle(wait),
    enabled: wait === undefined,
    help: "check the catalog again",
  };
}

/** One footer-style hint: the title, then the key; dimmed when disabled. */
function actionSegments(action: CardAction): Segment[] {
  const enabled = action.enabled !== false;
  return [
    seg(action.title, enabled ? "base" : "disabled"),
    seg(" "),
    seg(action.key, enabled ? "key" : "disabled"),
  ];
}

/** Lines of a card with a bar in `role` down its left edge. */
class CardWriter {
  readonly lines: Line[] = [];
  private readonly inner: number;

  constructor(
    private readonly role: ForegroundRole,
    /** The content width, which the footer shares. */
    readonly width: number,
  ) {
    this.inner = Math.max(8, width - 2);
  }

  private push(content: readonly Segment[]): void {
    this.lines.push([seg("▌ ", this.role), ...content]);
  }

  blank(): void {
    this.lines.push([seg("▌", this.role)]);
  }

  /** The card's title, bold. */
  title(text: string): void {
    for (const part of wrapText(text, this.inner))
      this.push([seg(part, "strong")]);
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
    if (extra)
      for (const part of wrapText(extra, this.inner - indent))
        this.push([seg(" ".repeat(indent)), seg(part, "muted")]);
  }

  /**
   * `actions`, already in `ACTION_ORDER`, with the footer's titles and its
   * two-column gaps: on one line when they fit, else one per line.
   */
  actions(actions: readonly CardAction[]): void {
    if (actions.length === 0) return;
    const parts = actions.map(actionSegments);
    const inline = parts.flatMap((part, index) =>
      index === 0 ? part : [seg("  "), ...part],
    );
    const inlineWidth = inline.reduce(
      (sum, part) => sum + textWidth(part.text),
      0,
    );
    if (inlineWidth <= this.inner) this.push(inline);
    else for (const part of parts) this.push(part);
  }
}

function hints(actions: readonly CardAction[]): FooterHint[] {
  return inActionOrder(actions).map((action) => ({
    title: action.title,
    key: action.key,
    enabled: action.enabled !== false,
  }));
}

function helpFor(actions: readonly CardAction[]): HelpEntry[] {
  return inActionOrder(actions).map((action) => ({
    keys: action.key,
    action: action.help,
  }));
}

/**
 * The keys of a card the footer cannot fit at `width` columns, in footer
 * order; the card lists them in its own action row, so nothing appears
 * twice and nothing is out of sight.
 */
function overflowActions(
  actions: readonly CardAction[],
  width: number,
): CardAction[] {
  const ordered = inActionOrder(actions);
  const shown = footerShown(hints(ordered), width);
  return ordered.filter((_, index) => !shown.has(index));
}

/**
 * A card that replaces the list. Its action row, after a spacer, holds only
 * the keys the footer cannot fit; with none it has no row.
 */
function replaceCard(
  writer: CardWriter,
  actions: readonly CardAction[],
  refresh = false,
): BrowserFrameCard {
  const overflow = overflowActions(actions, writer.width);
  if (overflow.length > 0) {
    writer.blank();
    writer.actions(overflow);
  }
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
  writer.title("Connect an Actualyze API key");
  writer.text("Your team's Actualyze models then show up in OpenCode.");
  writer.blank();
  writer.step(
    "1",
    `Create a key in Account Settings → Security → API${NBSP}Keys (Read${NBSP}&${NBSP}Write).`,
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
    "From a shell: opencode auth login actualyze, or set ACTUALYZE_API_KEY for the background service.",
    "muted",
  );
  const actions = [
    keyAction(view),
    ...(origin ? [copyAction("apiKeys")] : []),
    LINKS_ACTION,
    connectionsAction(),
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
  const copy = failureCopy(failure, wait);
  const above = hasInventory(record);
  const writer = new CardWriter(copy.role, width);
  writer.title(copy.title);
  writer.text(copy.body);
  const note = keySourceNote(view, record);
  if (note) writer.text(note, "muted");
  if (above) {
    const count = chatModelCount(view.data);
    const age = relativeAge(record.lastGoodAt, now);
    writer.text(
      `Showing ${count} ${count === 1 ? "model" : "models"} from the last good check${age ? `, ${age}` : ""}. Links are under l.`,
      "muted",
    );
    return { placement: "above", lines: writer.lines };
  }
  const link = failureLink(failure.kind);
  const copyLink = linkable ? [copyAction(link)] : [];
  let actions: CardAction[];
  switch (failure.kind) {
    case "unauthorized":
    case "forbidden":
      actions = [
        keyAction(view),
        ...copyLink,
        connectionsAction(),
        retryAction(wait),
        LINKS_ACTION,
        BROWSE_ACTION,
      ];
      break;
    case "payment-required":
      actions = [
        ...copyLink,
        keyAction(view),
        retryAction(wait),
        LINKS_ACTION,
        connectionsAction(),
        BROWSE_ACTION,
      ];
      break;
    case "rate-limited":
      actions = [
        retryAction(wait),
        LINKS_ACTION,
        keyAction(view),
        connectionsAction(),
        BROWSE_ACTION,
      ];
      break;
    default:
      actions = [
        retryAction(wait),
        ...copyLink,
        keyAction(view),
        LINKS_ACTION,
        connectionsAction(),
        BROWSE_ACTION,
      ];
  }
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
  const status = statusSegments(view, now, width);
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
      writer.title("OpenCode is storing the key");
      writer.text(
        "Closing this dialog does not undo a completed save.",
        "muted",
      );
      return done(replaceCard(writer, [LINKS_ACTION, BROWSE_ACTION]));
    }
    case "unconfirmed": {
      const writer = new CardWriter("error", width);
      writer.title("OpenCode did not confirm the key was saved");
      writer.text(
        "It may have stored the key before the error. Check connections before trying again.",
      );
      const actions = [
        keyAction(view),
        connectionsAction(),
        LINKS_ACTION,
        BROWSE_ACTION,
      ];
      return done(replaceCard(writer, actions));
    }
    case "server-unavailable": {
      const writer = new CardWriter("warn", width);
      writer.title("Model Scout's server half did not answer");
      writer.text(
        "The catalog status is unknown. Connecting a key still works.",
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
      if (session.pending?.phase === "saved") writer.text("Key saved.");
      const actions = [
        keyAction(view),
        connectionsAction(),
        // Discovery refresh needs the server half; `r` reads the catalog again.
        retryAction(refreshWaitSeconds(record, data, now)),
        LINKS_ACTION,
        BROWSE_ACTION,
      ];
      return done(replaceCard(writer, actions));
    }
    case "not-managed": {
      const writer = new CardWriter("muted", width);
      writer.title("Another definition of actualyze is in use");
      writer.text(
        "Another plugin or a models.dev catalog defines the actualyze provider, so Model Scout does not discover its models.",
      );
      writer.text(
        'To opt in, add "probe": "actualyze" to providers.actualyze.settings in opencode.json.',
      );
      return done(
        replaceCard(writer, [connectionsAction(), LINKS_ACTION, BROWSE_ACTION]),
      );
    }
    case "checking": {
      const writer = new CardWriter("info", width);
      writer.title("Key saved");
      writer.text(
        "Model Scout is listing the models this key can reach; no inference request is sent.",
      );
      return done(
        replaceCard(writer, [
          LINKS_ACTION,
          keyAction(view),
          connectionsAction(),
          BROWSE_ACTION,
        ]),
      );
    }
    case "no-key":
      return done(noKeyCard(view, width), "apiKeys");
    case "resolving": {
      const writer = new CardWriter("info", width);
      if (data.status === "loading") {
        writer.title("Reading models");
        writer.text(
          "Model Scout is reading OpenCode's model lists and its own catalog.",
        );
      } else {
        writer.title("Waiting for discovery");
        writer.text(
          "Model Scout is waiting for discovery with the current key.",
        );
      }
      return done(
        replaceCard(writer, [
          LINKS_ACTION,
          keyAction(view),
          connectionsAction(),
          BROWSE_ACTION,
        ]),
      );
    }
    case "discovering": {
      const writer = new CardWriter("info", width);
      writer.title("Reading the catalog");
      writer.text("Model Scout is reading the models this key can reach.");
      return done(
        replaceCard(writer, [
          LINKS_ACTION,
          keyAction(view),
          connectionsAction(),
          BROWSE_ACTION,
        ]),
      );
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
      const wait = refreshWaitSeconds(record, data, now);
      const writer = new CardWriter("warn", width);
      writer.title("Empty catalog");
      writer.text(
        `The catalog answered with an empty list: this key's team cannot use any models yet. Ask a workspace admin for model access. ${retrySentence(wait)}`,
      );
      const actions = [
        retryAction(wait),
        ...(origin ? [copyAction("catalog")] : []),
        keyAction(view),
        LINKS_ACTION,
        connectionsAction(),
        BROWSE_ACTION,
      ];
      return done(replaceCard(writer, actions, true), "catalog");
    }
    case "ready":
      return done(undefined);
  }
}

// ── Links ───────────────────────────────────────────────────────────────

function linksCard(
  session: Session,
  view: ViewState,
  width: number,
): { card: BrowserFrameCard; link: ActualyzeLinkID | undefined } {
  const origin = view.endpoint?.origin;
  const paragraph = (text: string, role: ForegroundRole = "base"): Line[] =>
    wrapText(text, width).map((part) => [seg(part, role)]);
  const lines: Line[] = [...paragraph("Actualyze app links", "strong")];
  const highlight: number[] = [];
  // The links screen's own keys, in its own order rather than the cards'.
  const actions: CardAction[] = [
    { key: "enter", title: "copy", help: "copy the selected link" },
    { key: "backspace", title: "back", help: "back; l does the same" },
    BROWSE_ACTION,
  ];
  const footer = (shown: readonly CardAction[]): FooterHint[] =>
    shown.map((action) => ({ title: action.title, key: action.key }));
  const help: HelpEntry[] = [
    { keys: "↑ ↓ home end", action: "choose a link" },
    ...actions.map((action) => ({ keys: action.key, action: action.help })),
    { keys: "y", action: "copy the selected link" },
  ];
  if (!origin) {
    lines.push(
      [],
      ...paragraph(
        "No app links: providers.actualyze.settings.baseURL is not an http(s) URL.",
        "warn",
      ),
    );
    return {
      card: {
        placement: "replace",
        lines,
        hints: footer(actions.slice(1)),
        help,
      },
      link: undefined,
    };
  }
  const links = actualyzeLinks(origin);
  const index = Math.min(Math.max(0, session.linkIndex), links.length - 1);
  // Two-line rows take twice the rows, so that layout leaves out the blank
  // row under the title and the second note to fit 80x24.
  const beside = linkLayout(links, width, textWidth) === "beside";
  if (beside) lines.push([]);
  for (const [position, link] of links.entries()) {
    const label = `   ${link.label}`;
    const start = lines.length;
    if (beside)
      lines.push([
        seg(padText(label, LINK_LABEL_COLUMNS)),
        seg(link.url, "muted"),
      ]);
    else
      lines.push(
        [seg(label)],
        ...wrapText(link.url, width - LINK_URL_INDENT).map((part) => [
          seg(" ".repeat(LINK_URL_INDENT)),
          seg(part, "muted"),
        ]),
      );
    if (position === index)
      for (let line = start; line < lines.length; line += 1)
        highlight.push(line);
  }
  lines.push([]);
  lines.push(
    ...paragraph("Budgets may need an admin role in Actualyze.", "muted"),
  );
  if (beside)
    lines.push(
      ...paragraph(
        "Enter or y copies the selected link to your terminal's clipboard; Model Scout cannot open a browser.",
        "muted",
      ),
    );
  return {
    card: {
      placement: "replace",
      lines,
      highlight,
      hints: footer(actions),
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
  if (
    key.name === "r" &&
    !key.shift &&
    view.card?.placement === "replace" &&
    session.cardReloads
  )
    return () => session.tools?.reload();
  return undefined;
}

function createFrame(session: Session): BrowserFrame {
  const read = (data: BrowserData, width: number, now: number): Described => {
    const view = viewState(session, data);
    const described = describe(session, view, width, now);
    session.cardLink = described.link;
    session.cardReloads =
      !session.links &&
      view.data.status !== "failed" &&
      view.state.row === "server-unavailable";
    return described;
  };
  return {
    header: (data, width) => headerSegments(viewState(session, data), width),
    status: (data, width, now) => read(data, width, now).status,
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
  if (session.ended) {
    // A plugin reload while the prompt was open: say the key went nowhere.
    if (entered?.trim())
      toast(
        context,
        "warning",
        "The Actualyze key was not saved: Model Scout was reloaded. Enter it again with /actualyze.",
      );
    return;
  }
  if (entered === undefined) {
    endSession(session);
    return;
  }
  if (!accepts(session)) {
    endSession(session);
    if (entered.trim())
      toast(
        context,
        "warning",
        "The Actualyze key was not saved: the location changed. Enter it again with /actualyze.",
      );
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
    // Another location now: this session's card would wait forever.
    if (!session.ended) abandon(session);
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
