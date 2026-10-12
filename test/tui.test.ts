import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Mock the opentui reconciler so element construction does not require a live
// renderer context. The builder logic itself (createElement/setProp/insert) is
// exercised; we only stub the native renderable creation.
vi.mock("@opentui/solid", () => {
  return {
    createElement: (tag: string) => {
      const node = {
        tag,
        props: {} as Record<string, unknown>,
        children: [] as unknown[],
        selectedIndex: 0,
        setSelectedIndex(index: number) {
          this.selectedIndex = index;
        },
        getSelectedIndex() {
          return this.selectedIndex;
        },
      };
      return node;
    },
    setProp: (
      node: { props: Record<string, unknown> },
      name: string,
      value: unknown,
    ) => {
      node.props[name] = value;
      return value;
    },
    insert: (node: { children: unknown[] }, child: unknown) => {
      node.children.push(child);
      return child;
    },
  };
});

import type {
  TuiPluginApi,
  TuiPluginMeta,
  TuiCommand,
} from "@opencode-ai/plugin/tui";
import tuiPlugin from "../src/tui";
import { COMMAND_NAME, PLUGIN_NAME } from "../src/constants";
import {
  CATALOG_SCHEMA_VERSION,
  clearCatalogBridge,
  createAttemptId,
  createProviderFingerprint,
  createRuntimeKey,
  createServerKey,
  createWorktreeKey,
  knownScalar,
  persistCompleteSnapshot,
  persistRunningSnapshot,
  publishCompleteSnapshot,
  publishRunningSnapshot,
  unknownCapability,
  unknownScalar,
  type CompleteCatalogSnapshot,
  type RunningCatalogSnapshot,
} from "../src/catalog-snapshot";

const tempDirectories: string[] = [];

/** Invoke the plugin's tui entrypoint with a structurally-typed mock api. */
function runTui(api: unknown): Promise<void> {
  return tuiPlugin.tui(api as TuiPluginApi, undefined, {} as TuiPluginMeta);
}

/**
 * The command runners open the dialog asynchronously (they lazily import the
 * @opentui reconciler, which is mocked here). Poll until `predicate` holds so
 * the wait is timing-independent under parallel test load. Returns `true` once
 * satisfied, `false` if it never becomes true within the budget.
 */
async function waitUntil(predicate: () => boolean): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return predicate();
}

function rgba() {
  return { r: 0, g: 0, b: 0, a: 1 };
}

type MockNode = {
  tag?: string;
  props?: Record<string, unknown>;
  children?: unknown[];
};

/** opentui text-node tags that must be parented by a `<text>`, never a `<box>`. */
const TEXT_NODE_TAGS = new Set([
  "span",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "a",
  "br",
]);

/**
 * Find any opentui "orphan text" violation: a text-node element (span/b/i/…)
 * placed as a direct child of a non-text element. opentui throws at render time
 * for these ("Orphan text error: … must have a <text> as a parent"), so guard
 * against it structurally since the mock reconciler does not enforce it.
 */
function findOrphanSpan(node: unknown, parentTag?: string): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as MockNode;
  const tag = n.tag;
  if (
    tag &&
    TEXT_NODE_TAGS.has(tag) &&
    parentTag !== undefined &&
    parentTag !== "text" &&
    !TEXT_NODE_TAGS.has(parentTag)
  ) {
    return `<${tag}> under <${parentTag}>`;
  }
  for (const child of n.children ?? []) {
    const found = findOrphanSpan(child, tag);
    if (found) return found;
  }
  return undefined;
}

function findNodeById(node: unknown, id: string): MockNode | undefined {
  if (!node || typeof node !== "object") return undefined;
  const candidate = node as MockNode;
  if (candidate.props?.id === id) return candidate;
  for (const child of candidate.children ?? []) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return undefined;
}

function findTextContaining(node: unknown, text: string): MockNode | undefined {
  if (!node || typeof node !== "object") return undefined;
  const candidate = node as MockNode;
  if (
    candidate.tag === "text" &&
    typeof candidate.props?.content === "string" &&
    candidate.props.content.includes(text)
  )
    return candidate;
  for (const child of candidate.children ?? []) {
    const found = findTextContaining(child, text);
    if (found) return found;
  }
  return undefined;
}

/**
 * Open the first MODEL row's details. Row 0 in the unified grouped list is the
 * provider header, so the first model sits at index 1.
 */
function openFirstDetail(root: unknown): MockNode | undefined {
  const results = findNodeById(root, "modelscout-results");
  const onSelect = results?.props?.onSelect;
  if (typeof onSelect === "function") (onSelect as (index: number) => void)(1);
  return findNodeById(root, "modelscout-detail-text");
}

function collectTags(node: unknown, tags: string[] = []): string[] {
  if (!node || typeof node !== "object") return tags;
  const candidate = node as MockNode;
  if (candidate.tag) tags.push(candidate.tag);
  for (const child of candidate.children ?? []) collectTags(child, tags);
  return tags;
}

function createMockApi(
  providers: unknown[] = [],
  withCommand = true,
  terminalWidth: number | undefined = 120,
  terminalHeight: number | undefined = 40,
) {
  const dialog = {
    replace: vi.fn(),
    clear: vi.fn(),
    setSize: vi.fn(),
    size: "medium" as const,
    depth: 0,
    open: false,
  };
  const registered: Array<() => TuiCommand[]> = [];
  const dispose = vi.fn();
  const onDispose = vi.fn();
  const toast = vi.fn();
  const keyListeners = new Set<(key: unknown) => void>();
  const keyInput = {
    on: vi.fn((event: string, listener: (key: unknown) => void) => {
      if (event === "keypress") keyListeners.add(listener);
      return keyInput;
    }),
    off: vi.fn((event: string, listener: (key: unknown) => void) => {
      if (event === "keypress") keyListeners.delete(listener);
      return keyInput;
    }),
  };

  const api = {
    command: withCommand
      ? {
          register: vi.fn((cb: () => TuiCommand[]) => {
            registered.push(cb);
            return dispose;
          }),
          trigger: vi.fn(),
          show: vi.fn(),
        }
      : undefined,
    ui: {
      Dialog: vi.fn((props: unknown) => ({ dialog: props })),
      dialog,
      toast,
    },
    theme: {
      current: {
        text: rgba(),
        textMuted: rgba(),
        error: rgba(),
        primary: rgba(),
        secondary: rgba(),
        accent: rgba(),
        info: rgba(),
        warning: rgba(),
        success: rgba(),
        backgroundPanel: rgba(),
        backgroundElement: rgba(),
        selectedListItemText: rgba(),
      },
    },
    client: {
      client: {
        getConfig: () => ({ baseUrl: "http://127.0.0.1:4096/" }),
      },
    },
    state: {
      provider: providers,
      path: { worktree: "atlas-worktree" },
    },
    renderer: { terminalWidth, terminalHeight, keyInput },
    lifecycle: { onDispose },
  };

  const commands = (): TuiCommand[] => registered[0]?.() ?? [];
  const commandBySlash = (slash: string) =>
    commands().find((c) => c.slash?.name === slash);

  return {
    api,
    dialog,
    registered,
    dispose,
    onDispose,
    toast,
    keyInput,
    keyListeners,
    commandBySlash,
  };
}

function atlasExactSnapshot(startedAt = new Date().toISOString()): {
  marker: RunningCatalogSnapshot;
  snapshot: CompleteCatalogSnapshot;
} {
  const marker: RunningCatalogSnapshot = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    packageVersion: "1.6.0",
    status: "running",
    attemptId: createAttemptId(),
    startedAt,
    worktreeKey: createWorktreeKey("atlas-worktree"),
    serverKey: createServerKey("http://127.0.0.1:4096")!,
    runtimeKey: createRuntimeKey(),
    providerFingerprint: createProviderFingerprint([
      { id: "atlas", baseURL: "https://atlas.test/v1" },
    ]),
  };
  return {
    marker,
    snapshot: {
      ...marker,
      status: "complete",
      completedAt: startedAt,
      providers: [
        {
          id: "atlas",
          endpointOrigin: knownScalar(
            "https://atlas.test",
            "pre-existing",
            "configured",
          ),
          configuredProbe: unknownScalar(),
          resolvedProbe: unknownScalar(),
          status: "ready",
          modelListAttempt: "ready",
          probeAttempt: "not-requested",
          skippedModelIds: [],
          models: [
            {
              id: "atlas-model",
              origin: "discovered",
              identity: knownScalar("atlas-model", "server-list", "reported"),
              name: unknownScalar(),
              modelType: unknownScalar(),
              context: unknownScalar(),
              output: unknownScalar(),
              family: unknownScalar(),
              organizationOwner: unknownScalar(),
              parameterSize: unknownScalar(),
              quantization: unknownScalar(),
              sizeBytes: unknownScalar(),
              probeIdentity: unknownScalar(),
              capabilities: {
                vision: unknownCapability(),
                toolCall: unknownCapability(),
                reasoning: unknownCapability(),
                temperature: unknownCapability(),
              },
            },
          ],
        },
      ],
    },
  };
}

describe("tui plugin module", () => {
  it("exposes a namespaced id and a tui entrypoint", () => {
    expect(tuiPlugin.id).toBe(`${PLUGIN_NAME}:tui`);
    expect(typeof tuiPlugin.tui).toBe("function");
  });
});

describe("tui command registration", () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(async () => {
    clearCatalogBridge();
    mock = createMockApi([
      {
        id: "atlas",
        name: "Atlas",
        options: { baseURL: "https://atlas.test/v1" },
        models: {
          "atlas-model": { id: "atlas-model", name: "Atlas Model" },
        },
      },
    ]);
    await runTui(mock.api);
  });

  afterEach(async () => {
    clearCatalogBridge();
    delete process.env.XDG_CACHE_HOME;
    await Promise.all(
      tempDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("registers via api.command.register", () => {
    expect(mock.api.command?.register).toHaveBeenCalledTimes(1);
  });

  it("registers synchronously without waiting for provenance resolution", async () => {
    const immediate = createMockApi([]);
    const registration = runTui(immediate.api);
    expect(immediate.api.command?.register).toHaveBeenCalledOnce();
    await registration;
  });

  it("registers a single /modelscout slash command", () => {
    const cmds = mock.registered[0]?.() ?? [];
    expect(cmds).toHaveLength(1);
    const show = mock.commandBySlash(COMMAND_NAME);
    expect(show).toBeDefined();
    expect(show?.title).toBe("Model Scout");
    expect(show?.value).toBe(`${COMMAND_NAME}.show`);
  });

  it("wires the dispose into lifecycle.onDispose", () => {
    expect(mock.onDispose).toHaveBeenCalledTimes(1);
    expect(mock.onDispose).toHaveBeenCalledWith(mock.dispose);
  });

  it("opens the dialog (replace + xlarge) when /modelscout is selected", async () => {
    void mock.commandBySlash(COMMAND_NAME)?.onSelect?.();
    expect(
      await waitUntil(() => mock.dialog.replace.mock.calls.length > 0),
    ).toBe(true);
    expect(mock.dialog.replace).toHaveBeenCalledTimes(1);
    expect(mock.dialog.setSize).toHaveBeenCalledWith("xlarge");
  });

  it("resolves the exact catalog snapshot when the command is selected", async () => {
    const providers = [
      {
        id: "atlas",
        name: "Atlas",
        options: { baseURL: "https://atlas.test/v1" },
        models: {
          "atlas-model": { id: "atlas-model", name: "Atlas Model" },
        },
      },
    ];
    const late = createMockApi(providers);
    await runTui(late.api);

    const startedAt = new Date().toISOString();
    const marker: RunningCatalogSnapshot = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      packageVersion: "1.6.0",
      status: "running",
      attemptId: createAttemptId(),
      startedAt,
      worktreeKey: createWorktreeKey("atlas-worktree"),
      serverKey: createServerKey("http://127.0.0.1:4096")!,
      runtimeKey: createRuntimeKey(),
      providerFingerprint: createProviderFingerprint([
        { id: "atlas", baseURL: "https://atlas.test/v1" },
      ]),
    };
    const snapshot: CompleteCatalogSnapshot = {
      ...marker,
      status: "complete",
      completedAt: startedAt,
      providers: [
        {
          id: "atlas",
          endpointOrigin: knownScalar(
            "https://atlas.test",
            "pre-existing",
            "configured",
          ),
          configuredProbe: unknownScalar(),
          resolvedProbe: unknownScalar(),
          status: "ready",
          modelListAttempt: "ready",
          probeAttempt: "not-requested",
          skippedModelIds: [],
          models: [
            {
              id: "atlas-model",
              origin: "discovered",
              identity: knownScalar("atlas-model", "server-list", "reported"),
              name: unknownScalar(),
              modelType: unknownScalar(),
              context: unknownScalar(),
              output: unknownScalar(),
              family: unknownScalar(),
              organizationOwner: unknownScalar(),
              parameterSize: unknownScalar(),
              quantization: unknownScalar(),
              sizeBytes: unknownScalar(),
              probeIdentity: unknownScalar(),
              capabilities: {
                vision: unknownCapability(),
                toolCall: unknownCapability(),
                reasoning: unknownCapability(),
                temperature: unknownCapability(),
              },
            },
          ],
        },
      ],
    };
    publishRunningSnapshot(marker);
    expect(publishCompleteSnapshot(snapshot)).toBe(true);

    const select = late.commandBySlash(COMMAND_NAME)?.onSelect as
      | (() => Promise<void>)
      | undefined;
    await select?.();
    const render = late.dialog.replace.mock.calls[0]?.[0] as () => unknown;
    const detail = openFirstDetail(render());
    expect(detail?.props?.content).toContain("discovered");
    expect(detail?.props?.content).toContain("Model ID: atlas-model [server]");
  });

  it("resolves the exact server/worktree snapshot on separate-realm command open", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "model-scout-tui-"));
    tempDirectories.push(cache);
    process.env.XDG_CACHE_HOME = cache;
    const providers = [
      {
        id: "atlas",
        name: "Atlas",
        options: { baseURL: "https://atlas.test/v1" },
        models: {
          "atlas-model": { id: "atlas-model", name: "Atlas Model" },
        },
      },
    ];
    const separateRealm = createMockApi(providers);
    await runTui(separateRealm.api);
    const { marker, snapshot } = atlasExactSnapshot();
    expect(await persistRunningSnapshot(marker, cache)).toBe(true);
    expect(await persistCompleteSnapshot(snapshot, cache)).toBe(true);
    clearCatalogBridge();

    const select = separateRealm.commandBySlash(COMMAND_NAME)?.onSelect as
      | (() => Promise<void>)
      | undefined;
    await select?.();
    const render = separateRealm.dialog.replace.mock
      .calls[0]?.[0] as () => unknown;
    const detail = openFirstDetail(render());
    expect(detail?.props?.content).toContain("discovered");
    expect(detail?.props?.content).toContain("Model ID: atlas-model [server]");
  });

  it("degrades a separate-process runtime mismatch to host-only data", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "model-scout-tui-"));
    tempDirectories.push(cache);
    process.env.XDG_CACHE_HOME = cache;
    const providers = [
      {
        id: "atlas",
        name: "Atlas",
        options: { baseURL: "https://atlas.test/v1" },
        models: {
          "atlas-model": { id: "atlas-model", name: "Atlas Model" },
        },
      },
    ];
    const separateProcess = createMockApi(providers);
    await runTui(separateProcess.api);
    const { marker, snapshot } = atlasExactSnapshot();
    marker.runtimeKey = createRuntimeKey(process.pid + 1);
    snapshot.runtimeKey = marker.runtimeKey;
    expect(await persistRunningSnapshot(marker, cache)).toBe(true);
    expect(await persistCompleteSnapshot(snapshot, cache)).toBe(true);
    clearCatalogBridge();

    await separateProcess.commandBySlash(COMMAND_NAME)?.onSelect?.();
    const render = separateProcess.dialog.replace.mock
      .calls[0]?.[0] as () => unknown;
    const detail = openFirstDetail(render());
    expect(detail?.props?.content).not.toContain("· discovered");
    expect(detail?.props?.content).toContain(
      "provenance unavailable; showing host state only",
    );
    expect(detail?.props?.content).toContain("[host]");
  });

  it("falls back to host-only data when pinned client config is inaccessible", async () => {
    const inaccessible = createMockApi([
      {
        id: "atlas",
        name: "Atlas",
        options: { baseURL: "https://atlas.test/v1" },
        models: {
          "atlas-model": { id: "atlas-model", name: "Atlas Model" },
        },
      },
    ]);
    inaccessible.api.client.client.getConfig = () => {
      throw new Error("protected client unavailable");
    };
    await runTui(inaccessible.api);
    const select = inaccessible.commandBySlash(COMMAND_NAME)?.onSelect as
      | (() => Promise<void>)
      | undefined;
    await expect(select?.()).resolves.toBeUndefined();
    const render = inaccessible.dialog.replace.mock
      .calls[0]?.[0] as () => unknown;
    const detail = openFirstDetail(render());
    expect(detail?.props?.content).toContain(
      "provenance unavailable; showing host state only",
    );
    expect(detail?.props?.content).toContain("[host]");
    expect(inaccessible.toast).not.toHaveBeenCalled();
  });

  it("calls setSize AFTER replace (replace resets size to medium)", async () => {
    void mock.commandBySlash(COMMAND_NAME)?.onSelect?.();
    await waitUntil(
      () =>
        mock.dialog.replace.mock.calls.length > 0 &&
        mock.dialog.setSize.mock.calls.length > 0,
    );
    const replaceOrder = mock.dialog.replace.mock.invocationCallOrder[0];
    const setSizeOrder = mock.dialog.setSize.mock.invocationCallOrder[0];
    expect(replaceOrder).toBeDefined();
    expect(setSizeOrder).toBeDefined();
    expect(replaceOrder).toBeLessThan(setSizeOrder);
  });

  it("returns the content element directly (no api.ui.Dialog double-wrap)", async () => {
    void mock.commandBySlash(COMMAND_NAME)?.onSelect?.();
    await waitUntil(() => mock.dialog.replace.mock.calls.length > 0);
    const render = mock.dialog.replace.mock.calls[0]?.[0] as () => unknown;
    expect(typeof render).toBe("function");
    expect(() => render()).not.toThrow();
    expect(mock.api.ui.Dialog).not.toHaveBeenCalled();
  });

  it("never constructs a tab_select or a mode row in the unified browser", async () => {
    void mock.commandBySlash(COMMAND_NAME)?.onSelect?.();
    await waitUntil(() => mock.dialog.replace.mock.calls.length > 0);
    const render = mock.dialog.replace.mock.calls[0]?.[0] as () => unknown;
    const root = render();
    expect(collectTags(root)).not.toContain("tab_select");
    expect(findNodeById(root, "modelscout-mode")).toBeUndefined();
    expect(findNodeById(root, "modelscout-mode-row")).toBeUndefined();
  });

  it("pairs the selected row with the host's primary/selected-text colors", async () => {
    void mock.commandBySlash(COMMAND_NAME)?.onSelect?.();
    await waitUntil(() => mock.dialog.replace.mock.calls.length > 0);
    const render = mock.dialog.replace.mock.calls[0]?.[0] as () => unknown;
    const results = findNodeById(render(), "modelscout-results");
    const theme = mock.api.theme.current;
    expect(results?.props?.selectedBackgroundColor).toBe(theme.primary);
    expect(results?.props?.selectedTextColor).toBe(theme.selectedListItemText);
    expect(results?.props?.backgroundColor).toBe(theme.backgroundPanel);
    expect(results?.props?.focusedBackgroundColor).toBe(theme.backgroundPanel);
  });

  it("uses one bounded full-width list screen at 100 columns", async () => {
    const singlePane = createMockApi(mock.api.state.provider, true, 100);
    await runTui(singlePane.api);
    await singlePane.commandBySlash(COMMAND_NAME)?.onSelect?.();
    const render = singlePane.dialog.replace.mock
      .calls[0]?.[0] as () => unknown;
    const root = render();
    expect(findNodeById(root, "modelscout-pane")).toBeUndefined();
    expect(findNodeById(root, "modelscout-list-screen")?.props?.width).toBe(
      "100%",
    );
    expect(findNodeById(root, "modelscout-detail-screen")?.props?.width).toBe(
      "100%",
    );
    const footer = findNodeById(root, "modelscout-footer-text");
    expect((footer?.props?.content as string).length).toBeLessThanOrEqual(84);
    expect(findNodeById(root, "modelscout-browser")?.props).toMatchObject({
      overflow: "hidden",
      width: 88,
      height: 25,
      maxHeight: 25,
    });
  });

  it.each([80, 109, 110, 160])(
    "keeps the same single-pane structure at %i columns",
    async (columns) => {
      const boundary = createMockApi(mock.api.state.provider, true, columns);
      await runTui(boundary.api);
      await boundary.commandBySlash(COMMAND_NAME)?.onSelect?.();
      const render = boundary.dialog.replace.mock
        .calls[0]?.[0] as () => unknown;
      const root = render();
      expect(findNodeById(root, "modelscout-pane")).toBeUndefined();
      // Outer width (content + 2+2 padding) stays at the dialog budget of
      // min(120, columns - 8); the numeric width is content-box only.
      expect(findNodeById(root, "modelscout-browser")?.props?.width).toBe(
        Math.max(1, Math.min(120, columns - 8) - 4),
      );
    },
  );

  it.each([40, 30, 24, 18, 14])(
    "passes a composed total-height budget at %i terminal rows",
    async (rows) => {
      const sized = createMockApi(mock.api.state.provider, true, 120, rows);
      await runTui(sized.api);
      await sized.commandBySlash(COMMAND_NAME)?.onSelect?.();
      const render = sized.dialog.replace.mock.calls[0]?.[0] as () => unknown;
      const root = render();
      const available = Math.min(25, Math.max(1, rows - 12));
      expect(findNodeById(root, "modelscout-browser")?.props).toMatchObject({
        height: available,
        maxHeight: available,
      });
    },
  );

  it("uses safe browser dimensions when terminal dimensions are unavailable", async () => {
    const unknownSize = createMockApi(mock.api.state.provider);
    const renderer = unknownSize.api.renderer as {
      terminalWidth?: number;
      terminalHeight?: number;
    };
    renderer.terminalWidth = undefined;
    renderer.terminalHeight = undefined;
    await runTui(unknownSize.api);
    await unknownSize.commandBySlash(COMMAND_NAME)?.onSelect?.();
    const render = unknownSize.dialog.replace.mock
      .calls[0]?.[0] as () => unknown;
    expect(findNodeById(render(), "modelscout-browser")?.props).toMatchObject({
      width: 76,
      height: 12,
      maxHeight: 12,
    });
  });

  it("passes a non-recursive onClose that disposes browser key listeners", async () => {
    void mock.commandBySlash(COMMAND_NAME)?.onSelect?.();
    await waitUntil(() => mock.dialog.replace.mock.calls.length > 0);
    const render = mock.dialog.replace.mock.calls[0]?.[0] as () => unknown;
    const onClose = mock.dialog.replace.mock.calls[0]?.[1] as () => void;

    render();
    expect(mock.keyListeners.size).toBe(1);
    onClose();
    onClose();

    expect(mock.keyListeners.size).toBe(0);
    expect(mock.keyInput.off).toHaveBeenCalledTimes(1);
    expect(mock.dialog.clear).not.toHaveBeenCalled();
  });

  it("replaces a prior render listener before constructing another browser", async () => {
    void mock.commandBySlash(COMMAND_NAME)?.onSelect?.();
    await waitUntil(() => mock.dialog.replace.mock.calls.length > 0);
    const render = mock.dialog.replace.mock.calls[0]?.[0] as () => unknown;
    const onClose = mock.dialog.replace.mock.calls[0]?.[1] as () => void;

    render();
    render();
    expect(mock.keyListeners.size).toBe(1);
    expect(mock.keyInput.off).toHaveBeenCalledTimes(1);

    onClose();
    expect(mock.keyListeners.size).toBe(0);
    expect(mock.keyInput.off).toHaveBeenCalledTimes(2);
  });

  it("falls back to bounded flat content when browser construction fails", async () => {
    await mock.commandBySlash(COMMAND_NAME)?.onSelect?.();
    const render = mock.dialog.replace.mock.calls[0]?.[0] as () => unknown;
    mock.keyInput.on.mockImplementationOnce(() => {
      throw new Error("key input unavailable");
    });

    let root: unknown;
    expect(() => {
      root = render();
    }).not.toThrow();
    expect(mock.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "error",
        message: "key input unavailable",
      }),
    );
    expect(
      findTextContaining(root, "(interactive browser unavailable)"),
    ).toBeDefined();
    expect((root as MockNode).props).toMatchObject({
      overflow: "hidden",
      height: 25,
      maxHeight: 25,
    });
  });

  it("keeps forged provider/model strings on their fallback lines", async () => {
    const forged = createMockApi([
      {
        id: "atlas",
        name: "Atlas\nForged Provider — 9 models",
        options: { baseURL: "https://atlas.test/v1" },
        models: {
          "atlas-model\r\n  forged-standalone-row": {
            id: "atlas-model\r\n  forged-standalone-row",
            name: "Atlas Model",
            family: "atlas-family\u2028Forged Provider — 9 models",
            parameterSize: "8B\u2029forged",
            quantization: "Q4\u202eforged",
          },
        },
      },
    ]);
    await runTui(forged.api);
    await forged.commandBySlash(COMMAND_NAME)?.onSelect?.();
    const render = forged.dialog.replace.mock.calls[0]?.[0] as () => unknown;
    forged.keyInput.on.mockImplementationOnce(() => {
      throw new Error("forced fallback\nForged Error — standalone line");
    });

    const root = render();
    const body = findTextContaining(root, "(interactive browser unavailable)");
    expect(body).toBeDefined();
    const content = body?.props?.content as string;
    // Only intentional structural newlines remain; every external control,
    // line/paragraph separator, and bidi control has been spaced out.
    expect(content.replaceAll("\n", "")).not.toMatch(
      /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u,
    );
    const lines = content.split("\n");
    expect(lines).not.toContain("Forged Provider — 9 models");
    expect(lines).not.toContain("  forged-standalone-row");
    expect(lines).not.toContain("Forged Error — standalone line");
    // The sanitized values stay inline on their structured rows.
    expect(lines).toContain("Atlas Forged Provider — 9 models — 1 model");
    expect(lines).toContain("  atlas-model   forged-standalone-row");
    expect(
      lines.some((line) =>
        line.includes("forced fallback Forged Error — standalone line"),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes("atlas-family Forged Provider — 9 models"),
      ),
    ).toBe(true);
  });

  it("never renders a span/text-node directly under a box (opentui orphan rule)", async () => {
    void mock.commandBySlash(COMMAND_NAME)?.onSelect?.();
    await waitUntil(() => mock.dialog.replace.mock.calls.length > 0);
    const render = mock.dialog.replace.mock.calls[0]?.[0] as () => unknown;
    expect(findOrphanSpan(render())).toBeUndefined();
  });

  it("never renders a span directly under a box for the empty state", async () => {
    const empty = createMockApi([]);
    await runTui(empty.api);
    void empty.commandBySlash(COMMAND_NAME)?.onSelect?.();
    await waitUntil(() => empty.dialog.replace.mock.calls.length > 0);
    const render = empty.dialog.replace.mock.calls[0]?.[0] as () => unknown;
    expect(findOrphanSpan(render())).toBeUndefined();
  });

  it("does not throw when provider state is empty", async () => {
    const empty = createMockApi([]);
    await runTui(empty.api);
    void empty.commandBySlash(COMMAND_NAME)?.onSelect?.();
    await waitUntil(() => empty.dialog.replace.mock.calls.length > 0);
    const render = empty.dialog.replace.mock.calls[0]?.[0] as () => unknown;
    expect(() => render()).not.toThrow();
  });

  it("never throws out of onSelect: a failing replace is caught and toasted", async () => {
    mock.dialog.replace.mockImplementationOnce(() => {
      throw new Error("dialog unavailable");
    });
    expect(() => mock.commandBySlash(COMMAND_NAME)?.onSelect?.()).not.toThrow();
    expect(await waitUntil(() => mock.toast.mock.calls.length > 0)).toBe(true);
    expect(mock.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "error", title: "Model Scout" }),
    );
  });
});

describe("tui graceful degradation", () => {
  it("does nothing when api.command is unavailable", async () => {
    const mock = createMockApi([], false);
    await expect(runTui(mock.api)).resolves.toBeUndefined();
    expect(mock.onDispose).not.toHaveBeenCalled();
  });

  it("toasts (never throws) when the @opentui reconciler fails to load", async () => {
    // Re-import the plugin with @opentui/solid mocked to throw at import time,
    // exercising the loadRenderer() rejection arm of openDialog.
    vi.resetModules();
    vi.doMock("@opentui/solid", () => {
      throw new Error("opentui unavailable");
    });
    const fresh = (await import("../src/tui")).default;
    const mock = createMockApi([]);
    await fresh.tui(
      mock.api as unknown as TuiPluginApi,
      undefined,
      {} as TuiPluginMeta,
    );
    void mock.commandBySlash(COMMAND_NAME)?.onSelect?.();
    expect(await waitUntil(() => mock.toast.mock.calls.length > 0)).toBe(true);
    expect(mock.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "error", title: "Model Scout" }),
    );
    vi.doUnmock("@opentui/solid");
    vi.resetModules();
  });
});
