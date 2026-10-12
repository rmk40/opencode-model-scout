import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiCommand,
  TuiDialogStack,
} from "@opencode-ai/plugin/tui";
import type { BaseRenderable, RGBA } from "@opentui/core";
import { COMMAND_NAME, PLUGIN_NAME } from "./constants";
import { formatBytes, compactCount } from "./format";
import { buildBrowserView, type BrowserView } from "./tui-browser";
import {
  collectModelGroups,
  hostProviderFingerprint,
  type ModelRow,
  type ProviderGroup,
  type SdkProviderView,
} from "./tui-models";
import { TuiRenderer, type ReconcilerBridge } from "./tui-renderer";
import {
  createRuntimeKey,
  createWorktreeKey,
  resolveExactCatalogSnapshot,
  type CatalogCorrelation,
  type ExactCatalogSnapshot,
} from "./catalog-snapshot";
import { serverKeyFromPinnedClient } from "./tui-client-adapter";

/** Slash command that opens the dialog. */
const SHOW_SLASH = COMMAND_NAME;

/** Flags worth showing, in display order. "Temp" is omitted as near-universal. */
const DISPLAY_FLAGS = ["Vision", "Tools", "Reasoning"] as const;
const TUI_PROCESS_STARTED_AT_MS = Date.now() - process.uptime() * 1000;
// The server config hook completes before opencode starts the TUI plugin worker.
// Allow that short handoff while server/worktree/fingerprint keys provide the
// exact correlation; this is not a standalone TTL-based identity check.
const SNAPSHOT_HANDOFF_TOLERANCE_MS = 5_000;
const SNAPSHOT_STARTUP_WINDOW_MS = 60_000;

/** Keep the SDK structural cast at one boundary. */
function providerViews(api: TuiPluginApi): readonly SdkProviderView[] {
  return (api.state.provider ?? []) as unknown as readonly SdkProviderView[];
}

function catalogCorrelation(
  api: TuiPluginApi,
  providers: readonly SdkProviderView[],
): CatalogCorrelation | undefined {
  const serverKey = serverKeyFromPinnedClient(api.client);
  const worktree = api.state.path?.worktree;
  if (!serverKey || typeof worktree !== "string" || worktree.length === 0)
    return undefined;
  return {
    serverKey,
    worktreeKey: createWorktreeKey(worktree),
    runtimeKey: createRuntimeKey(),
    providerFingerprint: hostProviderFingerprint(providers),
    diskNotBeforeMs: TUI_PROCESS_STARTED_AT_MS - SNAPSHOT_HANDOFF_TOLERANCE_MS,
    diskNotAfterMs: TUI_PROCESS_STARTED_AT_MS + SNAPSHOT_STARTUP_WINDOW_MS,
  };
}

/**
 * The subset of the @opentui/solid reconciler used by the typed renderer.
 * Loaded lazily (see `loadRenderer`) so that importing this module never
 * forces a top-level dependency on @opentui — command registration must
 * succeed even if the rendering layer is unavailable.
 */
async function loadRenderer(): Promise<TuiRenderer> {
  const mod = (await import("@opentui/solid")) as unknown as ReconcilerBridge;
  return new TuiRenderer(mod);
}

/** Read the discoverable provider/model groups from the TUI's merged state. */
function readGroups(
  api: TuiPluginApi,
  exact?: ExactCatalogSnapshot,
): ProviderGroup[] {
  // `api.state.provider` is the server's merged provider list (includes the
  // models the server plugin injected at startup). Treated as a structural
  // view so this module never hard-depends on the SDK types.
  return collectModelGroups(providerViews(api), exact);
}

/** Total content rows available inside the host's dialog chrome. */
function contentHeight(api: TuiPluginApi): number {
  const term = api.renderer?.terminalHeight;
  const rows =
    typeof term === "number" && Number.isFinite(term) && term > 0
      ? Math.floor(term)
      : 24;
  // Short terminals need most of their dialog area covered; tall terminals need
  // a cap so plugin content stays above the host status line.
  return Math.min(25, Math.max(1, rows - 12));
}

/** Bounded columns for row clipping inside the host's xlarge dialog. */
function contentWidth(api: TuiPluginApi): number {
  const columns = api.renderer?.terminalWidth;
  if (typeof columns !== "number" || !Number.isFinite(columns) || columns <= 0)
    return 80;
  return Math.max(1, Math.min(120, Math.floor(columns) - 8));
}

/**
 * The fallback text block is newline-structured, so provider/model controlled
 * strings must not smuggle their own line or paragraph breaks (or bidi
 * embedding/isolate controls) into it. Same threat model as the interactive
 * browser: C0/C1 controls, line/paragraph separators, and bidi controls are
 * replaced with spaces while ZWJ, variation selectors, and other joiners that
 * legitimate names rely on pass through.
 */
function sanitizeFallbackValue(value: string): string {
  return value.replace(
    /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+/gu,
    " ",
  );
}

/** Single-space-joined detail segment for a model's metadata line. */
function modelDetail(model: ModelRow): string {
  const parts: string[] = [];
  if (model.type) parts.push(sanitizeFallbackValue(model.type));
  if (model.context !== undefined)
    parts.push(`ctx ${compactCount(model.context)}`);
  if (model.output !== undefined)
    parts.push(`out ${compactCount(model.output)}`);
  if (model.sizeBytes !== undefined) parts.push(formatBytes(model.sizeBytes));

  const flags = DISPLAY_FLAGS.filter((f) => model.flags.includes(f));
  if (flags.length > 0) parts.push(sanitizeFallbackValue(flags.join(" ")));

  const provenance = [model.family, model.parameterSize, model.quantization]
    .filter((v): v is string => Boolean(v))
    .map(sanitizeFallbackValue)
    .join(" ");
  if (provenance) parts.push(provenance);

  return parts.join("  ·  ");
}

/**
 * Build the whole table as a single plain-text block. Each model is two lines:
 *
 *   gemma-4-26b-a4b-it-4bit
 *     vlm  ·  ctx 262K  ·  out 32K  ·  19.2 GB  ·  Vision Tools  ·  gemma
 *
 * Rendering as one `<text content=…>` (rather than per-line elements or spans)
 * is the only structure that renders reliably in the host: text nodes take
 * their text from `content`, and spans/boxes have repeatedly collapsed or
 * thrown opentui "orphan text" errors.
 */
function buildTableText(groups: readonly ProviderGroup[]): string {
  if (groups.length === 0) {
    return "No models discovered.\n\nLocal providers may be offline, or no OpenAI-compatible provider is configured.";
  }

  const lines: string[] = [];
  for (const [index, group] of groups.entries()) {
    if (index > 0) lines.push("");
    const count = group.models.length;
    const provider = sanitizeFallbackValue(group.provider);
    lines.push(`${provider} — ${count} model${count !== 1 ? "s" : ""}`);

    for (const model of group.models) {
      lines.push(`  ${sanitizeFallbackValue(model.id)}`);
      const detail = modelDetail(model);
      if (detail) lines.push(`    ${detail}`);
    }
  }
  return lines.join("\n");
}

/**
 * Build the legacy flat-text content. This remains a runtime fallback for an
 * interactive construction failure; normal dialog opens use buildBrowserView.
 */
function buildFallbackContent(
  renderer: TuiRenderer,
  api: TuiPluginApi,
  constructionError: unknown,
  exact?: ExactCatalogSnapshot,
): BaseRenderable {
  const theme = api.theme.current;
  const maxHeight = contentHeight(api);
  const bodyHeight = Math.max(1, maxHeight - 4);

  let groups: ProviderGroup[] = [];
  let errorMessage: string | undefined;
  try {
    groups = readGroups(api, exact);
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  if (!errorMessage) {
    errorMessage =
      constructionError instanceof Error
        ? constructionError.message
        : String(constructionError);
  }

  // Content-sized column: the host wraps this in its centered, fixed-width
  // dialog panel, so we must NOT use flexGrow/minHeight (that would fill the
  // whole screen and break centering). The scroll area is bounded by maxHeight.
  const header = renderer.create(
    "box",
    { flexShrink: 0, paddingBottom: 1 },
    renderer.create("text", { fg: theme.text, content: "Model Scout" }),
  );

  // Error messages can carry externally derived text (endpoint responses,
  // filesystem paths); keep them to their single header line.
  const content = `(interactive browser unavailable) ${sanitizeFallbackValue(errorMessage)}\n\n${buildTableText(groups)}`;
  const color: RGBA = theme.error;

  const body = renderer.create(
    "scrollbox",
    {
      focused: true,
      height: bodyHeight,
      maxHeight: bodyHeight,
      scrollbarOptions: { visible: false },
    },
    renderer.create("text", { fg: color, content }),
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

/** Build the interactive browser from the TUI's effective provider state. */
function buildContent(
  renderer: TuiRenderer,
  api: TuiPluginApi,
  exact?: ExactCatalogSnapshot,
): BrowserView {
  return buildBrowserView(renderer, {
    groups: readGroups(api, exact),
    theme: api.theme.current,
    maxHeight: contentHeight(api),
    width: contentWidth(api),
    keyInput: api.renderer.keyInput,
  });
}

/** Surface an error as a toast, never throwing further. */
function showError(api: TuiPluginApi, err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err);
    api.ui.toast({ variant: "error", title: "Model Scout", message });
  } catch {
    // Even the toast failed — swallow rather than escape.
  }
}

/**
 * Open the Model Scout dialog. The host dialog stack supplies the surrounding
 * `Dialog` chrome (backdrop, sizing, esc handling) for whatever `replace`
 * returns, so we return the content box directly. Lazily loads the @opentui
 * reconciler; any failure surfaces as a toast and never escapes the runner.
 */
async function openDialog(
  api: TuiPluginApi,
  exact?: ExactCatalogSnapshot,
): Promise<void> {
  try {
    const renderer = await loadRenderer();
    let disposeBrowser = (): void => {};
    const disposeDialogBrowser = (): void => {
      const dispose = disposeBrowser;
      disposeBrowser = (): void => {};
      dispose();
    };
    try {
      // The browser root is the reconciler's concrete `Renderable`, which the
      // host's `JSX.Element`-typed render slot accepts at runtime.
      // `@opentui/solid`'s `JSX.Element` is effectively `any`, so `as never`
      // is the narrowest cast that bridges the two without tripping eslint's
      // no-unsafe-return on that `any`.
      api.ui.dialog.replace(() => {
        disposeDialogBrowser();
        try {
          const view = buildContent(renderer, api, exact);
          disposeBrowser = view.dispose;
          return renderer.raw(view.root) as never;
        } catch (err) {
          showError(api, err);
          return buildFallbackContent(renderer, api, err, exact) as never;
        }
      }, disposeDialogBrowser);
      // Must come AFTER replace: the host's replace() resets the dialog size
      // to "medium", so setting xlarge first would be overwritten.
      api.ui.dialog.setSize("xlarge");
    } catch (err) {
      disposeDialogBrowser();
      showError(api, err);
    }
  } catch (err) {
    showError(api, err);
  }
}

/**
 * Build the legacy `TuiCommand` list. The verified opencode 1.18.6 runtime surfaces
 * third-party plugin slash commands through `api.command.register` (the
 * `slash.name` field); the newer `api.keymap.registerLayer` path is not yet
 * wired for external plugins. `onSelect` receives the dialog stack but we use
 * the closed-over `api.ui.dialog` for clarity.
 */
function buildCommands(api: TuiPluginApi): TuiCommand[] {
  return [
    {
      title: "Model Scout",
      value: `${COMMAND_NAME}.show`,
      category: "Model Scout",
      description: "Show discovered models with metadata",
      slash: { name: SHOW_SLASH },
      onSelect: async (_dialog?: TuiDialogStack) => {
        try {
          const providers = providerViews(api);
          const correlation = catalogCorrelation(api, providers);
          const exact = correlation
            ? await resolveExactCatalogSnapshot(correlation)
            : undefined;
          await openDialog(api, exact);
        } catch (err) {
          showError(api, err);
        }
      },
    },
  ];
}

const tui: TuiPlugin = (api) => {
  // `api.command` remains the wired 1.18.6 registration surface
  // for third-party plugin slash commands. Guard it so the plugin degrades
  // gracefully on hosts that drop the shim.
  if (!api.command) return Promise.resolve();
  const dispose = api.command.register(() => buildCommands(api));
  api.lifecycle.onDispose(dispose);
  return Promise.resolve();
};

const plugin: TuiPluginModule & { id: string } = {
  id: `${PLUGIN_NAME}:tui`,
  tui,
};

export default plugin;
