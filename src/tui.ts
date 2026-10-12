import type { Plugin } from "@opencode/plugin/tui";
import type { BaseRenderable, RGBA } from "@opentui/core";
import {
  validateCatalogPayload,
  type CatalogPayload,
} from "./catalog-evidence";
import { COMMAND_NAME, PLUGIN_ID } from "./constants";
import { compactCount, formatBytes } from "./format";
import { ModelScoutRpc } from "./rpc";
import {
  buildBrowserView,
  type BrowserTheme,
  type BrowserView,
} from "./tui-browser";
import {
  collectModelGroups,
  isDiscoveryStarting,
  type HostCatalog,
  type ModelRow,
  type ProviderGroup,
} from "./tui-models";
import { TuiRenderer, type ReconcilerBridge } from "./tui-renderer";

type Context = Plugin.Context;

/** The location query every request of one dialog shares. */
interface LocationQuery {
  readonly directory: string;
}

const SHOW_COMMAND_ID = `${COMMAND_NAME}.show`;
const HOST_TIMEOUT_MS = 10_000;
const CATALOG_TIMEOUT_MS = 3_000;
const REFRESH_TIMEOUT_MS = 5_000;
/** Width of OpenCode's `xlarge` dialog panel. */
const XLARGE_DIALOG_COLUMNS = 116;

/** Flags worth showing, in display order. "Temp" is omitted as near-universal. */
const DISPLAY_FLAGS = ["Image", "Tools", "Reasoning"] as const;

interface ScoutTheme extends BrowserTheme {
  error: RGBA;
}

/**
 * Map the host's dialog surface onto the browser's color roles, matching the
 * host's own select dialog. Read on every render: `context.theme` follows the
 * active theme.
 */
function scoutTheme(context: Context): ScoutTheme {
  const tokens = context.theme.surface("dialog");
  return {
    text: tokens.text.base,
    textMuted: tokens.text.muted,
    error: tokens.text.feedback.error.base,
    primary: tokens.background.action.primary.focused,
    accent: tokens.hue.accent[200],
    backgroundPanel: tokens.background.base,
    backgroundElement: tokens.background.raised.high,
    selectedListItemText: tokens.text.action.primary.focused,
  };
}

/**
 * Loaded lazily so command registration never depends on OpenTUI; the host
 * injects its own `@opentui/solid` for this specifier at runtime.
 */
async function loadRenderer(): Promise<TuiRenderer> {
  const mod = (await import("@opentui/solid")) as unknown as ReconcilerBridge;
  return new TuiRenderer(mod);
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** Total content rows available inside the host's dialog chrome. */
function contentHeight(context: Context): number {
  const rows = finitePositive(context.renderer.terminalHeight) ?? 24;
  // The host places dialogs a quarter of the screen down; this keeps the
  // content above the status line on short terminals and caps it on tall ones.
  return Math.min(25, Math.max(1, rows - 12));
}

/** Outer content columns: the xlarge panel, narrowed on small terminals. */
function contentWidth(context: Context): number {
  const columns = finitePositive(context.renderer.terminalWidth);
  if (columns === undefined) return 80;
  return Math.max(1, Math.min(XLARGE_DIALOG_COLUMNS, columns - 2));
}

// ── Data ────────────────────────────────────────────────────────────────

interface Snapshot {
  groups: ProviderGroup[];
  notice?: string;
}

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
      ? "server plugin unavailable"
      : `server error (${error.type})`;
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
    return "server timed out";
  return "server unreachable";
}

/** Pending payloads re-render through the `updated` event once targets resolve. */
function catalogNotice(payload: CatalogPayload): string | undefined {
  if (payload.status === "running") return "discovery running";
  if (isDiscoveryStarting(payload)) return "discovery starting";
  if (payload.status === "pending") return "discovery pending";
  return undefined;
}

function refreshSkippedNotice(reason: unknown): string {
  if (reason === "throttled")
    return "refresh skipped: the last one was under a minute ago";
  if (reason === "no-targets")
    return "refresh skipped: no providers to discover";
  return "refresh skipped";
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
    if (!payload) return { notice: "host state only: invalid server evidence" };
    return { payload, notice: catalogNotice(payload) };
  } catch (error) {
    return { notice: `host state only: ${describeRpcFailure(error)}` };
  }
}

async function loadSnapshot(
  context: Context,
  location: LocationQuery,
): Promise<Snapshot> {
  const [host, evidence] = await Promise.all([
    readHost(context, location),
    readEvidence(context, location),
  ]);
  return {
    groups: collectModelGroups(host, evidence.payload),
    notice: evidence.notice,
  };
}

// ── Fallback content ────────────────────────────────────────────────────

/**
 * The fallback text block is newline-structured, so provider/model controlled
 * strings must not smuggle their own line or paragraph breaks (or bidi
 * embedding/isolate controls) into it. C0/C1 controls, line/paragraph
 * separators, and bidi controls become spaces; joiners and variation
 * selectors that legitimate names rely on pass through.
 */
function sanitizeFallbackValue(value: string): string {
  return value.replace(
    /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+/gu,
    " ",
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelDetail(model: ModelRow): string {
  const parts: string[] = [];
  if (model.type) parts.push(sanitizeFallbackValue(model.type));
  if (model.context !== undefined)
    parts.push(`ctx ${compactCount(model.context)}`);
  if (model.output !== undefined)
    parts.push(`out ${compactCount(model.output)}`);
  if (model.sizeBytes !== undefined) parts.push(formatBytes(model.sizeBytes));
  const flags = DISPLAY_FLAGS.filter((flag) => model.flags.includes(flag));
  if (flags.length > 0) parts.push(flags.join(" "));
  const provenance = [model.family, model.parameterSize, model.quantization]
    .filter((value): value is string => Boolean(value))
    .map(sanitizeFallbackValue)
    .join(" ");
  if (provenance) parts.push(provenance);
  if (!model.enabled) parts.push("disabled");
  return parts.join("  ·  ");
}

/** The whole catalog as one text block, two lines per model. */
function buildTableText(groups: readonly ProviderGroup[]): string {
  if (groups.length === 0)
    return "No models discovered.\n\nNo OpenAI-compatible provider is configured, or discovery has not reported yet.";
  const lines: string[] = [];
  for (const [index, group] of groups.entries()) {
    if (index > 0) lines.push("");
    const count = group.models.length;
    lines.push(
      `${sanitizeFallbackValue(group.provider)} — ${count} model${count === 1 ? "" : "s"}`,
    );
    for (const model of group.models) {
      lines.push(`  ${sanitizeFallbackValue(model.id)}`);
      const detail = modelDetail(model);
      if (detail) lines.push(`    ${detail}`);
    }
  }
  return lines.join("\n");
}

/**
 * Flat, scrollable text shown when the interactive browser cannot be built.
 * One `<text content>` node renders reliably where nested spans do not.
 */
function buildFallbackContent(
  renderer: TuiRenderer,
  context: Context,
  groups: readonly ProviderGroup[],
  error: unknown,
): BaseRenderable {
  const theme = scoutTheme(context);
  const maxHeight = contentHeight(context);
  const bodyHeight = Math.max(1, maxHeight - 4);
  const header = renderer.create(
    "box",
    { flexShrink: 0, paddingBottom: 1 },
    renderer.create("text", { fg: theme.text, content: "Model Scout" }),
  );
  const body = renderer.create(
    "scrollbox",
    {
      focused: true,
      height: bodyHeight,
      maxHeight: bodyHeight,
      scrollbarOptions: { visible: false },
    },
    renderer.create("text", {
      fg: theme.error,
      content: `(interactive browser unavailable) ${sanitizeFallbackValue(errorText(error))}\n\n${buildTableText(groups)}`,
    }),
  );
  const footer = renderer.create(
    "box",
    { flexShrink: 0, paddingTop: 1 },
    renderer.create("text", { fg: theme.textMuted, content: "esc close" }),
  );
  return renderer.raw(
    renderer.create(
      "box",
      {
        flexDirection: "column",
        height: maxHeight,
        maxHeight,
        overflow: "hidden",
        paddingLeft: 2,
        paddingRight: 2,
        paddingBottom: 1,
      },
      header,
      body,
      footer,
    ),
  );
}

// ── Dialog session ──────────────────────────────────────────────────────

function showError(context: Context, error: unknown): void {
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
 * Update events for one location. Subscribed before the first reads, so an
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
    stops.push(
      context.client
        .rpc(ModelScoutRpc)
        .events.on("updated", (event) => notify(event.location)),
    );
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

interface Session {
  close(): void;
}

/**
 * One open dialog bound to one location. Host and evidence reloads, the
 * refresh request, and both event filters all use that location, because
 * RPC calls without one fall back to the server's own directory and event
 * subscriptions filter by type only.
 */
function startSession(
  context: Context,
  renderer: TuiRenderer,
  location: LocationQuery,
  initial: Snapshot,
  updates: UpdateFeed,
): Session {
  let groups = initial.groups;
  let notice = initial.notice;
  let view: BrowserView | undefined;
  let closed = false;
  const stops: Array<() => void> = [() => updates.stop()];

  const disposeView = (): void => {
    const current = view;
    view = undefined;
    current?.dispose();
  };

  const setNotice = (next: string | undefined): void => {
    notice = next;
    view?.setNotice(next);
  };

  let reloading = false;
  let reloadAgain = false;
  const reloadOnce = async (): Promise<void> => {
    try {
      const next = await loadSnapshot(context, location);
      if (closed) return;
      groups = next.groups;
      notice = next.notice;
      view?.update(groups, notice);
    } catch {
      if (!closed) setNotice("update failed; showing the last result");
    }
  };
  /** Coalesce bursts of events into at most one queued reload. */
  const scheduleReload = (): void => {
    if (closed) return;
    if (reloading) {
      reloadAgain = true;
      return;
    }
    reloading = true;
    void (async () => {
      try {
        do {
          reloadAgain = false;
          await reloadOnce();
        } while (reloadAgain && !closed);
      } finally {
        reloading = false;
      }
    })();
  };

  const requestRefresh = async (): Promise<void> => {
    if (closed) return;
    setNotice("refresh requested");
    try {
      const result: unknown = await context.client
        .rpc(ModelScoutRpc)
        .refresh(
          {},
          { location, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) },
        );
      if (closed) return;
      const output =
        typeof result === "object" && result !== null
          ? (result as { accepted?: unknown; reason?: unknown })
          : {};
      if (output.accepted === true) {
        setNotice("refreshing");
        scheduleReload();
      } else {
        setNotice(refreshSkippedNotice(output.reason));
      }
    } catch (error) {
      if (!closed) setNotice(`refresh failed: ${describeRpcFailure(error)}`);
    }
  };

  const render = (): never => {
    disposeView();
    try {
      view = buildBrowserView(renderer, {
        groups,
        notice,
        theme: scoutTheme(context),
        maxHeight: contentHeight(context),
        width: contentWidth(context),
        keyInput: context.renderer.keyInput,
        onRefresh: () => void requestRefresh(),
      });
      // The host's render slot is typed as Solid's JSX.Element, which is
      // effectively `any`; the reconciler's renderable is what it renders.
      return renderer.raw(view.root) as never;
    } catch (error) {
      showError(context, error);
      return buildFallbackContent(renderer, context, groups, error) as never;
    }
  };

  /** Runs from the host's onClose, including when another dialog replaces ours. */
  const end = (): void => {
    if (closed) return;
    closed = true;
    for (const stop of stops.splice(0)) stop();
    disposeView();
  };

  try {
    context.ui.dialog.show(render, end);
    // `show` resets the size to medium, so the size is set afterwards.
    context.ui.dialog.set({ size: "xlarge" });
  } catch (error) {
    end();
    throw error;
  }

  updates.attach(scheduleReload);

  return {
    close: () => {
      if (closed) return;
      context.ui.dialog.clear();
      end();
    },
  };
}

// ── Plugin ──────────────────────────────────────────────────────────────

function setup(context: Context): Plugin.Cleanup {
  let active = true;
  let session: Session | undefined;

  const open = async (): Promise<void> => {
    let updates: UpdateFeed | undefined;
    try {
      const ref = context.location ?? context.data.location.default();
      const location: LocationQuery = { directory: ref.directory };
      updates = subscribeUpdates(context, location);
      const [renderer, snapshot] = await Promise.all([
        loadRenderer(),
        loadSnapshot(context, location),
      ]);
      if (!active) {
        updates.stop();
        return;
      }
      const feed = updates;
      // The session owns the feed from here and stops it when it ends.
      updates = undefined;
      session = startSession(context, renderer, location, snapshot, feed);
    } catch (error) {
      updates?.stop();
      showError(context, error);
    }
  };

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: SHOW_COMMAND_ID,
        title: "Model Scout",
        description: "Show discovered models and the evidence behind them",
        slash: { name: COMMAND_NAME },
        palette: true,
        run: open,
      },
    ],
  }));

  // A plugin reload would otherwise leave the old dialog on screen.
  return () => {
    active = false;
    const current = session;
    session = undefined;
    current?.close();
  };
}

const plugin: Plugin.Definition = { id: PLUGIN_ID, setup };

export default plugin;
