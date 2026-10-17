import type { Plugin } from "@opencode/plugin/tui";
import type { BaseRenderable } from "@opentui/core";
import {
  validateCatalogPayload,
  type CatalogPayload,
} from "./catalog-evidence";
import { COMMAND_NAME } from "./constants";
import { compactCount, formatBytes } from "./format";
import { ModelScoutRpc } from "./rpc";
import {
  ALL_PROVIDERS,
  browserLayout,
  buildBrowserView,
  DEFAULT_FILTERS,
  DEFAULT_NAV,
  findRecord,
  LOADING_DATA,
  qualifiedID,
  refreshWaitSeconds,
  type BrowserData,
  type BrowserExtraAction,
  type BrowserNotice,
  type BrowserScope,
  type BrowserSort,
  type BrowserView,
  type NavState,
  type NoticeRole,
  type TypeFilter,
} from "./tui-browser";
import {
  collectModelGroups,
  type HostCatalog,
  type ModelRow,
  type ProviderGroup,
} from "./tui-models";
import {
  loadTuiRenderer,
  type TuiNode,
  type TuiRenderer,
} from "./tui-renderer";
import { rolePalette } from "./tui-theme";

type Context = Plugin.Context;

/** The location query every request of one dialog shares. */
interface LocationQuery {
  readonly directory: string;
}

const HOST_TIMEOUT_MS = 10_000;
const CATALOG_TIMEOUT_MS = 3_000;
const REFRESH_TIMEOUT_MS = 5_000;
/** How long a transient notice stays. */
const NOTICE_MS = 5_000;
/** Relative ages in details repaint this often. */
const AGE_REPAINT_MS = 15_000;

// ── Data ────────────────────────────────────────────────────────────────

interface Evidence {
  payload?: CatalogPayload;
  notice?: string;
}

/** RPC calls reject with plain `{ type, message }` objects, not errors. */
interface RpcFailure {
  type: string;
  message: string;
}

function isRpcFailure(value: unknown): value is RpcFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function describeRpcFailure(error: unknown): string {
  if (isRpcFailure(error))
    return error.type === "rpc.unavailable"
      ? "scout's server half did not answer"
      : `scout's server half failed (${error.type})`;
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
    return "scout's server half timed out";
  return "scout's server half is unreachable";
}

async function readHost(
  context: Context,
  location: LocationQuery,
): Promise<HostCatalog> {
  const signal = AbortSignal.timeout(HOST_TIMEOUT_MS);
  const [providers, models] = await Promise.all([
    context.client.provider.list({ location }, { signal }),
    context.client.model.list({ location }, { signal }),
  ]);
  return { providers: providers.data, models: models.data };
}

/** Discovery evidence, or a notice saying why only host rows are shown. */
async function readEvidence(
  context: Context,
  location: LocationQuery,
): Promise<Evidence> {
  try {
    const output: unknown = await context.client
      .rpc(ModelScoutRpc)
      .catalog(
        {},
        { location, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) },
      );
    const payload = validateCatalogPayload(output);
    if (!payload)
      return {
        notice:
          "Discovery details unavailable: scout's answer failed validation",
      };
    return { payload };
  } catch (error) {
    return {
      notice: `Discovery details unavailable: ${describeRpcFailure(error)}`,
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Host lists and evidence, read in parallel; a host failure rejects. */
async function loadData(
  context: Context,
  location: LocationQuery,
): Promise<BrowserData> {
  const [host, evidence] = await Promise.all([
    readHost(context, location),
    readEvidence(context, location),
  ]);
  return {
    status: "ready",
    groups: collectModelGroups(host, evidence.payload),
    ...(evidence.payload
      ? { catalog: evidence.payload, catalogReceivedAt: Date.now() }
      : {}),
    ...(evidence.notice ? { serverNotice: evidence.notice } : {}),
    hostListed: new Set(
      host.models.map((model) => qualifiedID(model.providerID, model.id)),
    ),
  };
}

/**
 * Update events for one location: the RPC `updated` and `status` events
 * and the host's `model.updated`. Subscribed before the first reads, so an
 * update that lands while they run is remembered and replayed once a
 * listener attaches.
 */
interface UpdateFeed {
  /** Route updates to `listener`, first replaying one if any arrived before. */
  attach(listener: () => void): void;
  stop(): void;
}

function subscribeUpdates(
  context: Context,
  location: LocationQuery,
): UpdateFeed {
  let listener: (() => void) | undefined;
  let missed = false;
  let stopped = false;
  const stops: Array<() => void> = [];
  const notify = (eventLocation: { directory: string } | undefined): void => {
    if (stopped || eventLocation?.directory !== location.directory) return;
    if (listener) listener();
    else missed = true;
  };
  try {
    const events = context.client.rpc(ModelScoutRpc).events;
    stops.push(events.on("updated", (event) => notify(event.location)));
    stops.push(events.on("status", (event) => notify(event.location)));
    stops.push(
      context.data.on("model.updated", (event) => notify(event.location)),
    );
  } catch {
    // Live updates are optional; the dialog stays usable without them.
  }
  return {
    attach(next) {
      listener = next;
      if (missed) {
        missed = false;
        next();
      }
    },
    stop() {
      stopped = true;
      listener = undefined;
      for (const stop of stops.splice(0)) stop();
    },
  };
}

// ── Navigation memory ───────────────────────────────────────────────────

interface NavMemory {
  views: Record<string, NavState>;
}

const SORTS = new Set<BrowserSort>(["name", "context", "input", "output"]);
const TYPES = new Set<TypeFilter>(["chat", "embedding", "all"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Navigation state read back from memory. Memory survives plugin hot
 * reloads, so a value an earlier plugin version wrote is checked field by
 * field and copied out of the store.
 */
export function readNav(value: unknown): NavState {
  const stored = record(value);
  if (!stored) return { ...DEFAULT_NAV, filters: { ...DEFAULT_FILTERS } };
  const filters = record(stored.filters) ?? {};
  const flag = (name: keyof typeof DEFAULT_FILTERS): boolean =>
    typeof filters[name] === "boolean"
      ? filters[name]
      : (DEFAULT_FILTERS[name] as boolean);
  const selected = record(stored.selected);
  return {
    query: typeof stored.query === "string" ? stored.query : "",
    filters: {
      provider: typeof filters.provider === "string" ? filters.provider : "all",
      type: TYPES.has(filters.type as TypeFilter)
        ? (filters.type as TypeFilter)
        : DEFAULT_FILTERS.type,
      tools: flag("tools"),
      images: flag("images"),
      reasoning: flag("reasoning"),
      priced: flag("priced"),
      uncertain: flag("uncertain"),
    },
    sort: SORTS.has(stored.sort as BrowserSort)
      ? (stored.sort as BrowserSort)
      : "name",
    collapsed: Array.isArray(stored.collapsed)
      ? stored.collapsed.filter((id): id is string => typeof id === "string")
      : [],
    ...(selected && typeof selected.providerID === "string"
      ? {
          selected: {
            providerID: selected.providerID,
            ...(typeof selected.modelID === "string"
              ? { modelID: selected.modelID }
              : {}),
          },
        }
      : {}),
  };
}

function scopeKey(scope: BrowserScope): string {
  return scope.kind === "all" ? COMMAND_NAME : `provider:${scope.providerID}`;
}

// ── Fallback content ────────────────────────────────────────────────────

/** Short model facts for the fallback table. */
function fallbackModelDetail(model: ModelRow): string {
  const parts: string[] = [];
  if (model.type) parts.push(sanitizeFallbackValue(model.type));
  if (model.context !== undefined)
    parts.push(`ctx ${compactCount(model.context)}`);
  if (model.output !== undefined)
    parts.push(`out ${compactCount(model.output)}`);
  if (model.sizeBytes !== undefined) parts.push(formatBytes(model.sizeBytes));
  const flags = ["Image", "Tools", "Reasoning"].filter((flag) =>
    model.flags.includes(flag),
  );
  if (flags.length > 0) parts.push(flags.join(" "));
  const provenance = [model.family, model.parameterSize, model.quantization]
    .filter((value): value is string => Boolean(value))
    .map(sanitizeFallbackValue)
    .join(" ");
  if (provenance) parts.push(provenance);
  if (!model.enabled) parts.push("disabled");
  return parts.join("  ·  ");
}

/**
 * The fallback text block is newline-structured, so provider and model
 * strings must not smuggle their own line or paragraph breaks (or bidi
 * embedding and isolate controls) into it.
 */
function sanitizeFallbackValue(value: string): string {
  return value.replace(
    /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+/gu,
    " ",
  );
}

/** The whole catalog as one text block, two lines per model. */
function buildTableText(data: BrowserData): string {
  if (data.status === "loading") return "Reading models from OpenCode…";
  if (data.status === "failed")
    return `Could not load models from OpenCode: ${sanitizeFallbackValue(data.error ?? "unknown error")}`;
  const groups: readonly ProviderGroup[] = data.groups;
  if (groups.length === 0)
    return "No OpenAI-compatible providers found. Add a provider with settings.baseURL to opencode.json.";
  const lines: string[] = [];
  for (const [index, group] of groups.entries()) {
    if (index > 0) lines.push("");
    const count = group.models.length;
    lines.push(
      `${sanitizeFallbackValue(group.provider)} — ${count} model${count === 1 ? "" : "s"}`,
    );
    for (const model of group.models) {
      lines.push(`  ${sanitizeFallbackValue(model.id)}`);
      const detail = fallbackModelDetail(model);
      if (detail) lines.push(`    ${detail}`);
    }
  }
  return lines.join("\n");
}

interface Fallback {
  readonly root: BaseRenderable;
  update(data: BrowserData): void;
}

/**
 * Flat, scrollable text shown when the interactive browser cannot be built.
 * One plain `<text content>` node renders where styled rows may not.
 */
function buildFallback(
  renderer: TuiRenderer,
  context: Context,
  data: BrowserData,
  error: unknown,
): Fallback {
  const palette = rolePalette(context);
  const layout = browserLayout(
    context.renderer.terminalWidth,
    context.renderer.terminalHeight,
  );
  const bodyHeight = Math.max(1, layout.height - 5);
  const message = `(interactive browser unavailable) ${sanitizeFallbackValue(errorText(error))}`;
  const body: TuiNode<"text"> = renderer.create("text", {
    fg: palette.error,
    content: `${message}\n\n${buildTableText(data)}`,
  });
  const root = renderer.create(
    "box",
    {
      flexDirection: "column",
      width: layout.outerWidth,
      height: layout.height,
      maxHeight: layout.height,
      overflow: "hidden",
      paddingLeft: 3,
      paddingRight: 3,
      paddingBottom: 1,
    },
    renderer.create(
      "box",
      { flexShrink: 0, paddingBottom: 1 },
      renderer.create("text", { fg: palette.base, content: "Model Scout" }),
    ),
    renderer.create(
      "scrollbox",
      {
        focused: true,
        height: bodyHeight,
        maxHeight: bodyHeight,
        scrollbarOptions: { visible: false },
      },
      body,
    ),
    renderer.create(
      "box",
      { flexShrink: 0, paddingTop: 1 },
      renderer.create("text", { fg: palette.muted, content: "close esc" }),
    ),
  );
  return {
    root: renderer.raw(root),
    update(next) {
      renderer.set(body, "content", `${message}\n\n${buildTableText(next)}`);
    },
  };
}

// ── Sessions ────────────────────────────────────────────────────────────

export interface OpenBrowserOptions {
  /** Opens `/actualyze`; without it the `a` key does nothing. */
  readonly actualyze?: () => void;
  readonly title?: string;
  readonly searchPlaceholder?: string;
  /** Keys a caller adds to the list and detail views. */
  readonly extraActions?: readonly BrowserExtraAction[];
}

export interface BrowserHandle {
  /** Close this dialog, if it is still the open one. */
  close(): void;
  readonly closed: boolean;
}

const sessions = new WeakMap<object, Set<BrowserHandle>>();
const retired = new WeakSet<object>();

/**
 * Close every browser opened for `context` and refuse later opens; the
 * plugin cleanup calls this so a reload leaves no dialog on screen.
 */
export function closeBrowsers(context: Context): void {
  retired.add(context);
  for (const handle of sessions.get(context) ?? []) handle.close();
  sessions.delete(context);
}

interface ActiveNotice {
  readonly role: NoticeRole;
  /** The text at `now`; undefined ends the notice. */
  readonly text: (now: number) => string | undefined;
  readonly expiresAt?: number;
}

function toastError(context: Context, error: unknown): void {
  try {
    context.ui.toast.show({
      variant: "error",
      title: "Model Scout",
      message: errorText(error),
    });
  } catch {
    // A failing toast must not escape the command runner.
  }
}

/**
 * Open the model browser for `scope` in a dialog. It shows at once in a
 * loading state and fills in when the host lists and the catalog return.
 * Resolves to undefined when the dialog could not open; that failure is
 * reported as a toast.
 */
export async function openBrowser(
  context: Context,
  scope: BrowserScope = ALL_PROVIDERS,
  options: OpenBrowserOptions = {},
): Promise<BrowserHandle | undefined> {
  let feed: UpdateFeed | undefined;
  try {
    const ref = context.location ?? context.data.location.default();
    const location: LocationQuery = { directory: ref.directory };
    feed = subscribeUpdates(context, location);
    const [renderer, untrack] = await Promise.all([
      loadTuiRenderer(),
      loadUntrack(),
    ]);
    if (retired.has(context)) {
      feed.stop();
      return undefined;
    }
    const handle = startSession(
      context,
      { renderer, untrack },
      location,
      scope,
      options,
      feed,
    );
    feed = undefined;
    if (!handle.closed) {
      const set = sessions.get(context) ?? new Set();
      set.add(handle);
      sessions.set(context, set);
    }
    return handle;
  } catch (error) {
    feed?.stop();
    toastError(context, error);
    return undefined;
  }
}

type Untrack = <T>(fn: () => T) => T;

/**
 * Solid's `untrack`, from the copy of `solid-js` the host supplies to
 * plugins. Without it the render runs tracked, which only means a reactive
 * read can run it again.
 */
async function loadUntrack(): Promise<Untrack> {
  try {
    const solid = (await import("solid-js")) as { untrack?: Untrack };
    if (typeof solid.untrack === "function") return solid.untrack;
  } catch {
    // Fall through to a tracked render.
  }
  return (fn) => fn();
}

function startSession(
  context: Context,
  runtime: { readonly renderer: TuiRenderer; readonly untrack: Untrack },
  location: LocationQuery,
  scope: BrowserScope,
  options: OpenBrowserOptions,
  updates: UpdateFeed,
): BrowserHandle {
  const { renderer, untrack } = runtime;
  let data: BrowserData = LOADING_DATA;
  let view: BrowserView | undefined;
  let fallback: Fallback | undefined;
  let closed = false;
  let notice: ActiveNotice | undefined;
  let ticks: ReturnType<typeof setInterval> | undefined;
  let lastAgePaint = Date.now();

  const memoryKey = `${location.directory}\u0000${scopeKey(scope)}`;
  const [memory, updateMemory] = context.storage.memory<NavMemory>(
    "navigation",
    { initial: { views: {} } },
  );
  let nav = readNav(memory.views[memoryKey]);

  const paintNotice = (now = Date.now()): void => {
    if (!notice) {
      view?.setNotice(undefined);
      return;
    }
    const text = notice.text(now);
    if (
      text === undefined ||
      (notice.expiresAt !== undefined && now >= notice.expiresAt)
    ) {
      notice = undefined;
      view?.setNotice(undefined);
      return;
    }
    const shown: BrowserNotice = { text, role: notice.role };
    view?.setNotice(shown);
  };

  const showNotice = (next: ActiveNotice): void => {
    if (closed) return;
    notice = next;
    paintNotice();
  };

  const transient = (text: string, role: NoticeRole): void =>
    showNotice({ role, text: () => text, expiresAt: Date.now() + NOTICE_MS });

  const setData = (next: BrowserData): void => {
    data = next;
    view?.update(data);
    fallback?.update(data);
  };

  let reloading = false;
  let reloadAgain = false;
  const reloadOnce = async (): Promise<void> => {
    try {
      const next = await loadData(context, location);
      if (!closed) setData(next);
    } catch (error) {
      if (closed) return;
      if (data.status === "ready")
        transient("▲ Update failed; showing the last result", "warn");
      else
        setData({ ...LOADING_DATA, status: "failed", error: errorText(error) });
    }
  };
  /** Coalesce bursts of events into at most one queued reload. */
  const reload = async (): Promise<void> => {
    if (closed) return;
    if (reloading) {
      reloadAgain = true;
      return;
    }
    reloading = true;
    try {
      do {
        reloadAgain = false;
        await reloadOnce();
      } while (reloadAgain && !closed);
    } finally {
      reloading = false;
    }
  };
  const scheduleReload = (): void => void reload();

  const providerName = (providerID: string | undefined): string =>
    providerID === undefined
      ? "every provider"
      : (data.groups.find((group) => group.id === providerID)?.provider ??
        providerID);

  /** Seconds until the selected providers may refresh again, if known. */
  const throttleWait = (providerID: string | undefined): number | undefined => {
    const now = Date.now();
    const ids =
      providerID === undefined
        ? (data.catalog?.providers.map((item) => item.id) ?? [])
        : [providerID];
    const waits = ids
      .map((id) => refreshWaitSeconds(findRecord(data, id), data, now))
      .filter((wait): wait is number => wait !== undefined);
    return waits.length > 0 ? Math.min(...waits) : undefined;
  };

  const refresh = async (providerID: string | undefined): Promise<void> => {
    if (closed) return;
    const who = providerName(providerID);
    transient(`○ Refresh requested for ${who}…`, "info");
    try {
      const result: unknown = await context.client
        .rpc(ModelScoutRpc)
        .refresh(providerID === undefined ? {} : { providerID }, {
          location,
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        });
      if (closed) return;
      const output =
        typeof result === "object" && result !== null
          ? (result as { accepted?: unknown; reason?: unknown })
          : {};
      if (output.accepted === true) {
        transient(`○ Refreshing ${who}…`, "info");
        scheduleReload();
        return;
      }
      if (output.reason === "throttled") {
        // The record's nextRefreshAt is only as fresh as the last read.
        await reload();
        if (closed) return;
        const wait = throttleWait(providerID);
        if (wait === undefined) {
          transient(
            `Refresh skipped: ${who} was checked under a minute ago`,
            "muted",
          );
          return;
        }
        const deadline = Date.now() + wait * 1000;
        showNotice({
          role: "muted",
          text: (now) => {
            const left = Math.ceil((deadline - now) / 1000);
            return left > 0
              ? `Refresh skipped: ${who} was checked recently. Try again in ${left} s.`
              : undefined;
          },
        });
        return;
      }
      if (output.reason === "no-targets") {
        transient(
          providerID === undefined
            ? "Refresh skipped: no providers to discover"
            : `Refresh skipped: ${who} is not a discovery target`,
          "muted",
        );
        return;
      }
      transient("Refresh skipped", "muted");
    } catch (error) {
      if (!closed)
        transient(`▲ Refresh failed: ${describeRpcFailure(error)}`, "warn");
    }
  };

  const copy = (text: string): void => {
    const terminal = context.renderer as unknown as {
      copyToClipboardOSC52?: (value: string) => boolean;
      isOsc52Supported?: () => boolean;
    };
    const supported = terminal.isOsc52Supported?.() ?? true;
    const sent =
      supported && typeof terminal.copyToClipboardOSC52 === "function"
        ? terminal.copyToClipboardOSC52(text)
        : false;
    if (sent) transient(`Copy sent to terminal: ${text}`, "ok");
    else
      showNotice({
        role: "warn",
        text: () =>
          `This terminal does not accept copy requests (OSC 52). Select the text: ${text}`,
        expiresAt: Date.now() + 30_000,
      });
  };

  /**
   * Builds the view from the current data and navigation. The host's
   * plugin context provider evaluates the render inside a memo, so a
   * reactive read (the theme, the prompt's model) would run it again and
   * remount the dialog; it runs untracked, and still replaces any view it
   * built before in case it runs twice.
   */
  const render = (): never => untrack(build);
  const build = (): never => {
    view?.dispose();
    view = undefined;
    fallback = undefined;
    try {
      view = buildBrowserView(renderer, {
        scope,
        data,
        nav,
        onNav: (next) => {
          nav = next;
          updateMemory((draft) => {
            draft.views[memoryKey] = next;
          });
        },
        palette: () => rolePalette(context),
        keyInput: context.renderer.keyInput,
        terminal: context.renderer,
        current: () => context.ui.model.current(),
        actions: {
          picker: () => context.keymap.dispatch("model.list"),
          refresh: (providerID) => void refresh(providerID),
          retry: () => {
            transient("○ Reading models from OpenCode again…", "info");
            scheduleReload();
          },
          copy,
          notify: (next) => transient(next.text, next.role),
          ...(options.actualyze ? { actualyze: options.actualyze } : {}),
        },
        ...(options.title ? { title: options.title } : {}),
        ...(options.searchPlaceholder
          ? { searchPlaceholder: options.searchPlaceholder }
          : {}),
        ...(options.extraActions ? { extraActions: options.extraActions } : {}),
      });
      paintNotice();
      // The host's render slot is typed as Solid's JSX.Element, which is
      // effectively `any`; the reconciler's renderable is what it renders.
      return renderer.raw(view.root) as never;
    } catch (error) {
      view?.dispose();
      view = undefined;
      toastError(context, error);
      fallback = buildFallback(renderer, context, data, error);
      return fallback.root as never;
    }
  };

  /** Runs from the host's onClose, including when another dialog replaces ours. */
  const end = (): void => {
    if (closed) return;
    closed = true;
    if (ticks !== undefined) clearInterval(ticks);
    ticks = undefined;
    updates.stop();
    view?.dispose();
    view = undefined;
    sessions.get(context)?.delete(handle);
  };

  const handle: BrowserHandle = {
    close() {
      if (closed) return;
      context.ui.dialog.clear();
      end();
    },
    get closed() {
      return closed;
    },
  };

  try {
    context.ui.dialog.show(render, end);
    // `show` resets the size and placement, so they are set afterwards.
    context.ui.dialog.set({ size: "xlarge", centered: true });
  } catch (error) {
    end();
    throw error;
  }

  ticks = setInterval(() => {
    if (closed) return;
    const now = Date.now();
    if (notice) paintNotice(now);
    if (now - lastAgePaint >= AGE_REPAINT_MS) {
      lastAgePaint = now;
      view?.tick();
    }
  }, 1000);
  // A timer must not keep a test or a closing process alive on its own.
  (ticks as { unref?: () => void }).unref?.();

  void reload();
  updates.attach(scheduleReload);
  return handle;
}
