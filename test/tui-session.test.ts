import { afterEach, describe, expect, it, vi } from "vitest";

// The reconciler needs a live renderer; the mock records the
// createElement/setProp/insert calls the browser makes, and the core mock
// stands in for StyledText, which the browser assigns to `content` directly.
const { reconcilerMock, coreMock } = vi.hoisted(() => ({
  reconcilerMock: () => ({
    createElement: (tag: string) => ({
      tag,
      props: {} as Record<string, unknown>,
      children: [] as unknown[],
      content: undefined as unknown,
    }),
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
  }),
  coreMock: () => ({
    StyledText: class {
      constructor(readonly chunks: Array<{ text: string; fg?: unknown }>) {}
    },
    parseColor: (color: unknown) => color,
    TextAttributes: { BOLD: 1 },
  }),
}));
vi.mock("@opentui/solid", reconcilerMock);
vi.mock("@opentui/core", coreMock);

import type { Plugin } from "@opencode/plugin/tui";
import {
  CATALOG_SCHEMA_VERSION,
  knownScalar,
  unknownCapability,
  unknownScalar,
  type CatalogModelRecord,
  type CatalogPayload,
  type CatalogProviderRecord,
} from "../src/catalog-evidence";
import type { BrowserScope } from "../src/tui-browser";
import type { HostModel, HostProvider } from "../src/tui-models";
import {
  closeBrowsers,
  openBrowser,
  type OpenBrowserOptions,
} from "../src/tui-session";

// ── Rendered tree helpers ───────────────────────────────────────────────

interface MockNode {
  tag?: string;
  props?: Record<string, unknown>;
  children?: MockNode[];
  content?: unknown;
}

interface Chunk {
  text: string;
  fg?: { name: string };
  bg?: { name: string };
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

function chunksOf(node: MockNode | undefined): Chunk[] {
  const content = node?.content;
  return content && typeof content === "object" && "chunks" in content
    ? (content as { chunks: Chunk[] }).chunks
    : [];
}

/**
 * Text of a node. A focused selection is a background band without a
 * glyph; its first column reads as "▌" here, like the bar of an unfocused
 * selection, so tests can find the selected row either way.
 */
function textOf(node: MockNode | undefined): string {
  const chunks = chunksOf(node);
  if (chunks.length > 0) {
    const text = chunks.map((chunk) => chunk.text).join("");
    return chunks[0]?.bg !== undefined ? `▌${text.slice(1)}` : text;
  }
  return typeof node?.props?.content === "string" ? node.props.content : "";
}

function line(root: unknown, id: string): string {
  return textOf(findNodeById(root, id)).trimEnd();
}

function visible(node: MockNode | undefined): boolean {
  return node?.props?.visible !== false;
}

function lines(root: unknown, id: string): string[] {
  const box = findNodeById(root, id);
  if (!visible(box)) return [];
  return (box?.children ?? [])
    .filter(visible)
    .map((child) => textOf(child).trimEnd());
}

/** Non-empty rows of a row list; unused slots paint as empty lines. */
const listRows = (root: unknown, id = "modelscout-list"): string[] =>
  lines(root, id).filter((row) => row.length > 0);
const pane = (root: unknown): string =>
  lines(root, "modelscout-pane").join("\n");
const selectedRow = (root: unknown): string | undefined =>
  listRows(root).find((row) => row.startsWith("▌"));

/** Every string the tree would show: text content and input props. */
function allText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const candidate = node as MockNode;
  const own = [
    textOf(candidate),
    ...["value", "placeholder"].map((name) => {
      const value = candidate.props?.[name];
      return typeof value === "string" ? value : "";
    }),
  ];
  return [...own, ...(candidate.children ?? []).map(allText)].join("\n");
}

/** The color name of the footer chunk that reads `title`. */
function footerRole(root: unknown, title: string): string | undefined {
  return chunksOf(findNodeById(root, "modelscout-footer")).find(
    (chunk) => chunk.text === title,
  )?.fg?.name;
}

// ── Fixtures ────────────────────────────────────────────────────────────

const PROJECT = { directory: "/work/project" };
const GENERATED_AT = "2026-10-11T08:00:00.000Z";

function color(name: string) {
  return { name };
}

function stateful(prefix: string) {
  return {
    focused: color(`${prefix}.focused`),
    disabled: color(`${prefix}.disabled`),
    selected: color(`${prefix}.selected`),
  };
}

function surface() {
  return {
    text: {
      base: color("text.base"),
      muted: color("text.muted"),
      action: { primary: stateful("text.action.primary") },
      formfield: stateful("text.formfield"),
      feedback: {
        success: { base: color("text.feedback.success.base") },
        warning: { base: color("text.feedback.warning.base") },
        error: { base: color("text.feedback.error.base") },
        info: { base: color("text.feedback.info.base") },
      },
    },
    background: {
      action: { primary: stateful("background.action.primary") },
      formfield: stateful("background.formfield"),
    },
    border: { base: color("border.base") },
  };
}

function hostProvider(
  id = "atlas",
  name = "Atlas",
  settings: Record<string, unknown> = {
    baseURL: `https://${id}.test/openai/v1`,
  },
): HostProvider {
  return {
    id,
    name,
    package: "@opencode/ai/providers/openai-compatible",
    settings,
  };
}

function hostModel(
  id: string,
  name: string,
  overrides: Partial<HostModel> = {},
): HostModel {
  return {
    id,
    providerID: "atlas",
    name,
    enabled: true,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    cost: [],
    limit: { context: 8192, output: 4096 },
    ...overrides,
  };
}

function evidenceModel(
  id: string,
  overrides: Partial<CatalogModelRecord> = {},
): CatalogModelRecord {
  return {
    id,
    origin: "discovered",
    enabled: true,
    identity: knownScalar(id, "server-list", "reported"),
    name: unknownScalar(),
    modelType: unknownScalar(),
    context: knownScalar(8192, "provider-probe", "authoritative"),
    output: unknownScalar(),
    family: unknownScalar(),
    organizationOwner: unknownScalar(),
    parameterSize: unknownScalar(),
    quantization: unknownScalar(),
    sizeBytes: unknownScalar(),
    probeIdentity: unknownScalar(),
    capabilities: {
      toolCall: unknownCapability(),
      reasoning: unknownCapability(),
      temperature: unknownCapability(),
    },
    inputModalities: {
      text: unknownCapability(),
      image: unknownCapability(),
      pdf: unknownCapability(),
      audio: unknownCapability(),
      video: unknownCapability(),
    },
    cost: {
      input: unknownScalar(),
      output: unknownScalar(),
      cacheRead: unknownScalar(),
      cacheWrite: unknownScalar(),
    },
    ...overrides,
  };
}

function providerRecord(
  overrides: Partial<CatalogProviderRecord> = {},
): CatalogProviderRecord {
  return {
    id: "atlas",
    endpointOrigin: knownScalar(
      "https://atlas.test",
      "pre-existing",
      "configured",
    ),
    configuredProbe: unknownScalar(),
    resolvedProbe: knownScalar("vllm", "provider-probe", "reported"),
    lastGoodAt: GENERATED_AT,
    failure: null,
    modelListAttempt: "ready",
    probeAttempt: "complete",
    skippedModelIds: [],
    models: [],
    discovering: false,
    lastAttemptAt: GENERATED_AT,
    nextRefreshAt: null,
    credentialSource: "connection",
    credentialEpoch: 0,
    resultEpoch: 0,
    ...overrides,
  };
}

function payload(
  providers: CatalogProviderRecord[] = [providerRecord()],
  overrides: Partial<CatalogPayload> = {},
): CatalogPayload {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    packageVersion: "2.0.0",
    instanceID: "instance",
    generatedAt: GENERATED_AT,
    status: "complete",
    completedAt: GENERATED_AT,
    builtIn: { actualyze: "managed" },
    providers,
    ...overrides,
  };
}

// ── Harness ─────────────────────────────────────────────────────────────

interface HarnessOptions {
  location?: { directory: string } | undefined;
  terminalWidth?: number;
  terminalHeight?: number;
}

function harness(options: HarnessOptions = {}) {
  let open: { render: () => unknown; onClose?: () => void } | undefined;
  const dialog = {
    show: vi.fn((render: () => unknown, onClose?: () => void) => {
      // The host closes whatever it replaces before showing the new dialog.
      open?.onClose?.();
      open = { render, onClose };
    }),
    set: vi.fn(),
    clear: vi.fn(() => {
      const current = open;
      open = undefined;
      current?.onClose?.();
    }),
  };
  const toast = { show: vi.fn() };
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
  const resizeListeners = new Set<() => void>();
  const renderer: Record<string, unknown> & {
    terminalWidth: number;
    terminalHeight: number;
    copyToClipboardOSC52: ReturnType<typeof vi.fn>;
    isOsc52Supported: ReturnType<typeof vi.fn>;
  } = {
    terminalWidth: options.terminalWidth ?? 120,
    terminalHeight: options.terminalHeight ?? 36,
    keyInput,
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "resize") resizeListeners.add(listener);
    }),
    off: vi.fn((event: string, listener: () => void) => {
      if (event === "resize") resizeListeners.delete(listener);
    }),
    copyToClipboardOSC52: vi.fn((_text: string) => true),
    isOsc52Supported: vi.fn(() => true),
  };

  let hostProviders: HostProvider[] = [hostProvider()];
  let hostModels: HostModel[] = [hostModel("atlas-model", "Atlas Model")];
  const modelList = vi.fn(
    async (input: { location: { directory: string } }) => ({
      location: input.location,
      data: hostModels,
    }),
  );
  const providerList = vi.fn(
    async (input: { location: { directory: string } }) => ({
      location: input.location,
      data: hostProviders,
    }),
  );
  const catalog = vi.fn(
    async (_input: unknown, _options: unknown): Promise<unknown> => payload(),
  );
  const refresh = vi.fn(
    async (_input: unknown, _options: unknown): Promise<unknown> => ({
      accepted: true,
    }),
  );
  const rpcHandlers = new Map<string, Set<(event: unknown) => void>>();
  const on = vi.fn((name: string, handler: (event: unknown) => void) => {
    const set = rpcHandlers.get(name) ?? new Set();
    set.add(handler);
    rpcHandlers.set(name, set);
    return () => set.delete(handler);
  });
  const rpc = vi.fn(() => ({ catalog, refresh, events: { on } }));
  const modelHandlers = new Set<(event: unknown) => void>();
  const dataOn = vi.fn((_type: string, handler: (event: unknown) => void) => {
    modelHandlers.add(handler);
    return () => modelHandlers.delete(handler);
  });
  const memories = new Map<
    string,
    readonly [object, (fn: (draft: object) => void) => void]
  >();
  const memory = vi.fn((key: string, input: { initial: object }) => {
    const existing = memories.get(key);
    if (existing) return existing;
    const value = structuredClone(input.initial);
    const entry = [value, (fn: (draft: object) => void) => fn(value)] as const;
    memories.set(key, entry);
    return entry;
  });
  const store = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
  let currentModel: { providerID: string; modelID: string } | undefined;
  let integrations: Array<{ id: string; connections: unknown[] }> = [];
  const integrationList = vi.fn(() => integrations);

  const context = {
    location: "location" in options ? options.location : PROJECT,
    data: {
      on: dataOn,
      location: {
        default: () => ({ directory: "/default/project" }),
        integration: { list: integrationList },
      },
    },
    client: {
      rpc,
      model: { list: modelList },
      provider: { list: providerList },
    },
    ui: {
      dialog,
      toast,
      model: { current: () => currentModel },
    },
    keymap: { dispatch: vi.fn() },
    storage: { memory, store },
    renderer,
    theme: { surface: () => surface() },
    themeMode: "dark",
  };
  const pluginContext = context as unknown as Plugin.Context;

  /** Open the browser and render it, as the host would. */
  const show = async (
    scope: BrowserScope = { kind: "all" },
    browserOptions: OpenBrowserOptions = {},
  ) => {
    const handle = await openBrowser(pluginContext, scope, browserOptions);
    return { handle, root: open?.render() };
  };
  /** Open the browser and wait until model rows arrived. */
  const ready = async (
    scope: BrowserScope = { kind: "all" },
    browserOptions: OpenBrowserOptions = {},
  ) => {
    const shown = await show(scope, browserOptions);
    await vi.waitFor(() =>
      expect(listRows(shown.root).length).toBeGreaterThan(0),
    );
    return shown;
  };
  const press = (key: Record<string, unknown>) => {
    const event = {
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      super: false,
      hyper: false,
      sequence:
        typeof key.name === "string" && key.name.length === 1 ? key.name : "",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...key,
    };
    for (const listener of [...keyListeners]) listener(event);
    return event;
  };

  return {
    context,
    pluginContext,
    dialog,
    toast,
    renderer,
    keyListeners,
    modelList,
    catalog,
    refresh,
    store,
    integrationList,
    show,
    ready,
    press,
    current: () => open,
    setIntegrations: (next: Array<{ id: string; connections: unknown[] }>) => {
      integrations = next;
    },
    setHostModels: (models: HostModel[]) => {
      hostModels = models;
    },
    setHostProviders: (providers: HostProvider[]) => {
      hostProviders = providers;
    },
    setCurrentModel: (
      model: { providerID: string; modelID: string } | undefined,
    ) => {
      currentModel = model;
    },
    resize: (columns: number, rows: number) => {
      renderer.terminalWidth = columns;
      renderer.terminalHeight = rows;
      for (const listener of resizeListeners) listener();
    },
    emitRpc: (name: string, event: unknown) => {
      for (const handler of rpcHandlers.get(name) ?? []) handler(event);
    },
    emitModelUpdated: (event: unknown) => {
      for (const handler of modelHandlers) handler(event);
    },
  };
}

type Harness = ReturnType<typeof harness>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Yield to the event loop; `setImmediate` stays real under the fake timers used here. */
async function settle(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function useFakeClock(at: string): void {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
  vi.setSystemTime(Date.parse(at));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── States ──────────────────────────────────────────────────────────────

describe("states", () => {
  it("shows only keys and close in the footer while loading", async () => {
    const h = harness();
    const models = deferred<{ location: unknown; data: HostModel[] }>();
    h.modelList.mockReturnValueOnce(models.promise as never);
    const { root } = await h.show();
    expect(line(root, "modelscout-footer")).toMatch(/^keys \? +close esc$/);
    models.resolve({ location: PROJECT, data: [] });
  });

  describe("with no providers", () => {
    const empty = (h: Harness) => {
      h.setHostProviders([]);
      h.setHostModels([]);
      h.catalog.mockResolvedValue(payload([]));
    };

    it("explains how to add a server, without an Actualyze hint when there is no hook", async () => {
      const h = harness();
      empty(h);
      const { root } = await h.show();
      await vi.waitFor(() =>
        expect(pane(root)).toContain("No OpenAI-compatible providers found."),
      );
      expect(pane(root)).toMatch(
        /Other servers +add a provider with settings\.baseURL/,
      );
      expect(pane(root)).not.toContain("press a");
      expect(line(root, "modelscout-footer")).toMatch(/^keys \? +close esc$/);
      expect(line(root, "modelscout-header")).toMatch(
        /0 providers · 0 models$/,
      );
    });

    it("offers a to connect Actualyze when the hook is given, and a runs it", async () => {
      const h = harness();
      empty(h);
      const actualyze = vi.fn();
      const { root } = await h.show({ kind: "all" }, { actualyze });
      await vi.waitFor(() =>
        expect(pane(root)).toContain(
          "press a to connect an API key (opens /actualyze)",
        ),
      );
      expect(line(root, "modelscout-footer")).toMatch(
        /^connect Actualyze a {2}keys \? +close esc$/,
      );
      const event = h.press({ name: "a" });
      expect(event.preventDefault).toHaveBeenCalled();
      expect(actualyze).toHaveBeenCalledOnce();
    });
  });

  it("says discovery is starting while the catalog is pending with no providers", async () => {
    const h = harness();
    const { completedAt: _completed, ...pending } = payload([]);
    h.catalog.mockResolvedValue({ ...pending, status: "pending" });
    const { root } = await h.ready();
    expect(line(root, "modelscout-notice")).toBe("○ Discovery is starting");
  });

  it("explains no matches from filters alone and offers x and f", async () => {
    const h = harness();
    const { root } = await h.ready();
    h.press({ name: "f" });
    // Needs images: the only model accepts text only.
    for (let step = 0; step < 3; step += 1) h.press({ name: "down" });
    h.press({ name: "right" });
    h.press({ name: "backspace" });
    expect(pane(root)).toContain("No models match these filters.");
    expect(pane(root)).toContain(
      "x clears search and filters · f changes filters",
    );
    expect(line(root, "modelscout-footer")).toMatch(
      /^clear x {2}filters f {2}keys \?/,
    );
    h.press({ name: "x" });
    expect(listRows(root).some((row) => row.includes("Atlas Model"))).toBe(
      true,
    );
  });

  it("lists an empty provider with a note", async () => {
    const h = harness();
    h.setHostModels([]);
    const { root } = await h.ready();
    expect(listRows(root)).toEqual([
      expect.stringMatching(/^▌▾ Atlas +0 models {2}● ready$/),
      "   No models returned; r refreshes",
    ]);
  });

  it("explains an empty or absent provider in a single-provider scope", async () => {
    const h = harness();
    h.setHostModels([]);
    const shown = await h.show({ kind: "provider", providerID: "atlas" });
    await vi.waitFor(() =>
      expect(pane(shown.root)).toContain("No models returned; r refreshes"),
    );
    shown.handle?.close();

    const absent = await h.show({ kind: "provider", providerID: "missing" });
    await vi.waitFor(() =>
      expect(pane(absent.root)).toContain("No models from this provider yet."),
    );
  });

  it("disables refresh and says so in provider details when scout's server half is unavailable", async () => {
    const h = harness();
    h.catalog.mockRejectedValue(new Error("connection refused"));
    const { root } = await h.ready();
    expect(line(root, "modelscout-notice")).toBe(
      "▲ Discovery details unavailable: scout's server half is unreachable. Showing OpenCode's model list.",
    );
    expect(footerRole(root, "refresh")).toBe("text.action.primary.disabled");
    h.press({ name: "home" });
    expect(pane(root).replace(/\s+/g, " ")).toContain(
      "Discovery details unavailable; showing OpenCode's model list.",
    );
    h.press({ name: "r", sequence: "R", shift: true });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("names a timed-out catalog read", async () => {
    const h = harness();
    h.catalog.mockRejectedValue(
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
    );
    const { root } = await h.ready();
    expect(line(root, "modelscout-notice")).toContain(
      "scout's server half timed out",
    );
  });

  it("marks the header and offers retry when the host lists fail, and R retries too", async () => {
    const h = harness();
    h.modelList.mockRejectedValueOnce(new Error("service down"));
    const { root } = await h.show();
    await vi.waitFor(() =>
      expect(line(root, "modelscout-header")).toMatch(
        /▲ OpenCode lists unavailable$/,
      ),
    );
    expect(line(root, "modelscout-footer")).toMatch(/^retry r {2}keys \?/);
    h.press({ name: "r", sequence: "R", shift: true });
    await vi.waitFor(() => expect(listRows(root).length).toBeGreaterThan(0));
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

// ── The model picker ────────────────────────────────────────────────────

describe("the m key", () => {
  it.each([
    [
      "a model OpenCode does not list",
      (h: Harness) => {
        h.catalog.mockResolvedValue(
          payload([providerRecord({ models: [evidenceModel("ghost")] })]),
        );
        h.setHostModels([hostModel("atlas-model", "Atlas Model")]);
      },
      "ghost",
      "Not in OpenCode's model list yet",
    ],
    [
      "a model hidden from the picker",
      (h: Harness) => {
        h.setHostModels([
          hostModel("atlas-model", "Atlas Model", { enabled: false }),
        ]);
      },
      "Atlas Model",
      "Hidden from OpenCode's model picker",
    ],
    [
      "a deprecated model",
      (h: Harness) => {
        h.setHostModels([
          hostModel("atlas-model", "Atlas Model", { status: "deprecated" }),
        ]);
      },
      "Atlas Model",
      "Deprecated; not in OpenCode's model picker",
    ],
  ])(
    "explains instead of opening the picker for %s",
    async (_label, arrange, rowName, reason) => {
      const h = harness();
      arrange(h);
      const { root } = await h.ready();
      while (!selectedRow(root)?.includes(rowName)) h.press({ name: "down" });
      expect(footerRole(root, "select")).toBe("text.action.primary.disabled");
      expect(pane(root)).toContain(reason);
      const event = h.press({ name: "m" });
      expect(event.preventDefault).toHaveBeenCalled();
      expect(h.context.keymap.dispatch).not.toHaveBeenCalled();
      expect(line(root, "modelscout-notice")).toBe(reason);
    },
  );

  it("asks for a model on a provider header, and opens the picker for a listed model", async () => {
    const h = harness();
    const { root } = await h.ready();
    expect(footerRole(root, "select")).toBe("text.base");
    h.press({ name: "home" });
    h.press({ name: "m" });
    expect(line(root, "modelscout-notice")).toBe(
      "Select a model to open the picker",
    );
    h.press({ name: "down" });
    h.press({ name: "m" });
    expect(h.context.keymap.dispatch).toHaveBeenCalledWith("model.list");
  });
});

/** Move the list selection down until the row named `name` is selected. */
function selectRowNamed(h: Harness, root: unknown, name: string): void {
  for (let step = 0; step < 10 && !selectedRow(root)?.includes(name); step += 1)
    h.press({ name: "down" });
  expect(selectedRow(root)).toContain(name);
}

describe("enter", () => {
  it.each([
    [
      "an embedding model",
      (h: Harness) => {
        h.catalog.mockResolvedValue(
          payload([
            providerRecord({
              models: [
                evidenceModel("atlas-model", {
                  modelType: knownScalar(
                    "embedding",
                    "provider-probe",
                    "authoritative",
                  ),
                }),
              ],
            }),
          ]),
        );
      },
      // Embeddings are hidden until the type filter shows them.
      (h: Harness) => {
        h.press({ name: "f" });
        h.press({ name: "down" });
        h.press({ name: "left" });
        h.press({ name: "backspace" });
      },
      "Atlas Model",
      "Embedding model; not in the chat picker",
    ],
    [
      "a model OpenCode does not list",
      (h: Harness) => {
        h.catalog.mockResolvedValue(
          payload([providerRecord({ models: [evidenceModel("ghost")] })]),
        );
      },
      undefined,
      "ghost",
      "Not in OpenCode's model list yet",
    ],
    [
      "a model hidden from the picker",
      (h: Harness) => {
        h.setHostModels([
          hostModel("atlas-model", "Atlas Model", { enabled: false }),
        ]);
      },
      undefined,
      "Atlas Model",
      "Hidden from OpenCode's model picker",
    ],
    [
      "a deprecated model",
      (h: Harness) => {
        h.setHostModels([
          hostModel("atlas-model", "Atlas Model", { status: "deprecated" }),
        ]);
      },
      undefined,
      "Atlas Model",
      "Deprecated; not in OpenCode's model picker",
    ],
  ])(
    "explains instead of opening the picker for %s, on the list and in details",
    async (_label, arrange, reveal, rowName, reason) => {
      const h = harness();
      arrange(h);
      const { root } = await h.ready();
      reveal?.(h);
      selectRowNamed(h, root, rowName);

      const onList = h.press({ name: "return" });
      expect(onList.preventDefault).toHaveBeenCalled();
      expect(line(root, "modelscout-notice")).toBe(reason);

      h.press({ name: "i" });
      expect(line(root, "modelscout-footer")).toMatch(
        /^select enter {2}back backspace/,
      );
      expect(footerRole(root, "select")).toBe("text.action.primary.disabled");
      // A copy replaces the notice, so the next one comes from enter in details.
      h.press({ name: "y" });
      expect(line(root, "modelscout-notice")).toMatch(/^Copy sent/);
      const inDetails = h.press({ name: "return" });
      expect(inDetails.preventDefault).toHaveBeenCalled();
      expect(line(root, "modelscout-notice")).toBe(reason);
      expect(h.context.keymap.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["alpha", "beta", "active"])(
    "opens the picker with enter and m for a model whose status is %s",
    async (status) => {
      const h = harness();
      h.setHostModels([hostModel("atlas-model", "Atlas Model", { status })]);
      const { root } = await h.ready();
      expect(selectedRow(root)).toContain("Atlas Model");
      expect(footerRole(root, "select")).toBe("text.base");
      h.press({ name: "return" });
      h.press({ name: "m" });
      expect(h.context.keymap.dispatch.mock.calls).toEqual([
        ["model.list"],
        ["model.list"],
      ]);
    },
  );

  it.each([
    ["the list", 120, 36, []],
    ["the wide details screen", 120, 36, ["i"]],
    ["the narrow details screen", 80, 24, ["i"]],
  ] as const)(
    "opens the picker for a listed model from %s, consuming the key",
    async (_label, columns, rows, before) => {
      const h = harness({ terminalWidth: columns, terminalHeight: rows });
      await h.ready();
      for (const name of before) h.press({ name });
      const event = h.press({ name: "return" });
      expect(event.preventDefault).toHaveBeenCalled();
      expect(h.context.keymap.dispatch).toHaveBeenCalledExactlyOnceWith(
        "model.list",
      );
    },
  );

  it("opens a provider header's full-width details screen, where enter does nothing", async () => {
    const h = harness();
    const { root } = await h.ready();
    h.press({ name: "home" });
    h.press({ name: "return" });
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(false);
    expect(findNodeById(root, "modelscout-pane")?.props?.width).toBe(110);
    expect(pane(root)).toMatch(/Server type +vLLM, detected automatically/);
    expect(line(root, "modelscout-footer")).toMatch(
      /^back backspace {2}copy y/,
    );
    const shown = pane(root);
    h.press({ name: "return" });
    expect(h.context.keymap.dispatch).not.toHaveBeenCalled();
    expect(pane(root)).toBe(shown);
    // One backspace still returns, so enter opened no second screen.
    h.press({ name: "backspace" });
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(true);
    expect(selectedRow(root)).toMatch(/Atlas +1 model/);
  });
});

describe("leaving details", () => {
  it.each([
    ["wide", 120, 36],
    ["narrow", 80, 24],
  ] as const)(
    "returns to the list with backspace, left, or i, on the same row and without collapsing (%s)",
    async (_label, columns, rows) => {
      const h = harness({ terminalWidth: columns, terminalHeight: rows });
      h.setHostModels([
        hostModel("m-a", "Model A"),
        hostModel("m-b", "Model B"),
      ]);
      const { root } = await h.ready();
      h.press({ name: "down" });
      expect(selectedRow(root)).toContain("Model B");
      for (const name of ["backspace", "left", "i"]) {
        h.press({ name: "i" });
        expect(visible(findNodeById(root, "modelscout-list"))).toBe(false);
        h.press({ name });
        expect(visible(findNodeById(root, "modelscout-list"))).toBe(true);
        expect(selectedRow(root)).toContain("Model B");
        expect(listRows(root)).toHaveLength(3);
      }
      // The list has the keys again.
      h.press({ name: "up" });
      expect(selectedRow(root)).toContain("Model A");
    },
  );
});

describe("footer hints by row and screen", () => {
  it("offers select and details i on a model row, and details enter on a provider header", async () => {
    const h = harness();
    const { root } = await h.ready();
    expect(line(root, "modelscout-footer")).toMatch(
      /^select enter {2}details i {2}copy y/,
    );
    expect(footerRole(root, "select")).toBe("text.base");
    h.press({ name: "home" });
    expect(line(root, "modelscout-footer")).toMatch(
      /^details enter {2}collapse ←/,
    );
  });

  it.each([
    ["wide detail screen", 120, 36],
    ["narrow detail screen", 80, 24],
  ] as const)(
    "offers select, back, and copy in the %s on a model, and no select on a provider",
    async (_label, columns, rows) => {
      const h = harness({ terminalWidth: columns, terminalHeight: rows });
      const { root } = await h.ready();
      h.press({ name: "i" });
      expect(line(root, "modelscout-footer")).toMatch(
        /^select enter {2}back backspace {2}copy y/,
      );
      expect(footerRole(root, "select")).toBe("text.base");
      h.press({ name: "backspace" });
      h.press({ name: "home" });
      h.press({ name: "i" });
      expect(line(root, "modelscout-footer")).toMatch(
        /^back backspace {2}copy y/,
      );
    },
  );
});

// ── The model picker's search ───────────────────────────────────────────

/** A focused input as OpenCode's model picker mounts its search. */
function pickerSearch(value = "") {
  return { id: "picker-search", traits: { status: "FILTER" }, value };
}

/** Report `field` as the renderer's focused renderable, as OpenTUI does. */
function focusField(h: Harness, field: unknown): void {
  h.renderer.currentFocusedRenderable = field;
}

/**
 * Open the browser on the fake clock; `model.list` replaces the dialog, as
 * OpenCode's picker does.
 */
async function openForPicker(h: Harness): Promise<unknown> {
  const { root } = await h.show();
  await settle();
  expect(listRows(root).length).toBeGreaterThan(0);
  h.context.keymap.dispatch.mockImplementation((command: string) => {
    if (command === "model.list") h.dialog.show(() => "picker");
  });
  return root;
}

describe("the picker's search", () => {
  const connected = [
    { id: "other", connections: [] },
    { id: "atlas", connections: [{ id: "c1" }] },
  ];

  it.each([
    [
      "an integration has a connection",
      (h: Harness) => h.setIntegrations(connected),
      "Atlas Cloud Atlas Model",
    ],
    [
      "integrations have no connection",
      (h: Harness) => h.setIntegrations([{ id: "atlas", connections: [] }]),
      "Atlas Model",
    ],
    ["there are no integrations", (_h: Harness) => undefined, "Atlas Model"],
    [
      "the integration list cannot be read",
      (h: Harness) =>
        h.integrationList.mockImplementation(() => {
          throw new Error("not synced");
        }),
      "Atlas Model",
    ],
  ])(
    "types OpenCode's provider and model names when %s",
    async (_label, arrange, query) => {
      useFakeClock(GENERATED_AT);
      const h = harness();
      h.setHostProviders([hostProvider("atlas", "Atlas Cloud")]);
      arrange(h);
      await openForPicker(h);
      h.press({ name: "return" });
      const field = pickerSearch();
      focusField(h, field);
      await vi.advanceTimersByTimeAsync(50);
      expect(field.value).toBe(query);
    },
  );

  it("names a provider OpenCode does not list by its ID", async () => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    h.setHostProviders([]);
    h.setIntegrations(connected);
    await openForPicker(h);
    h.press({ name: "return" });
    const field = pickerSearch();
    focusField(h, field);
    await vi.advanceTimersByTimeAsync(50);
    expect(field.value).toBe("atlas Atlas Model");
  });

  // Both rows, so neither the first nor the last model with the ID passes by chance.
  it.each([
    ["Shared on Atlas", "Atlas Shared on Atlas"],
    ["Shared on Bravo", "Bravo Shared on Bravo"],
  ])(
    "types the names of the selected model %j when two providers share its ID",
    async (rowName, query) => {
      useFakeClock(GENERATED_AT);
      const h = harness();
      h.setHostProviders([
        hostProvider("atlas", "Atlas"),
        hostProvider("bravo", "Bravo"),
      ]);
      h.setHostModels([
        hostModel("shared", "Shared on Atlas"),
        hostModel("shared", "Shared on Bravo", { providerID: "bravo" }),
      ]);
      h.setIntegrations(connected);
      const root = await openForPicker(h);
      selectRowNamed(h, root, rowName);
      h.press({ name: "return" });
      const field = pickerSearch();
      focusField(h, field);
      await vi.advanceTimersByTimeAsync(50);
      expect(field.value).toBe(query);
    },
  );

  it("waits for the picker's search, passing over scout's own search and other inputs", async () => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    await openForPicker(h);
    h.press({ name: "m" });
    // Scout's search is skipped by its ID even if it carried the trait.
    const own = {
      id: "modelscout-search",
      traits: { status: "FILTER" },
      value: "",
    };
    const prompt = { id: "prompt", traits: {}, value: "" };
    const select = { id: "list", traits: { status: "FILTER" }, value: 3 };
    for (const other of [undefined, own, prompt, select]) {
      focusField(h, other);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(own.value).toBe("");
    expect(prompt.value).toBe("");
    expect(select.value).toBe(3);
    const field = pickerSearch();
    focusField(h, field);
    await vi.advanceTimersByTimeAsync(50);
    expect(field.value).toBe("Atlas Model");
  });

  it("keeps a search the user already started and stops looking", async () => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    await openForPicker(h);
    h.press({ name: "return" });
    const started = pickerSearch("gp");
    focusField(h, started);
    await vi.advanceTimersByTimeAsync(50);
    expect(started.value).toBe("gp");
    const later = pickerSearch();
    focusField(h, later);
    await vi.advanceTimersByTimeAsync(200);
    expect(later.value).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fills the search once, leaving it alone after the user clears it", async () => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    await openForPicker(h);
    h.press({ name: "return" });
    const field = pickerSearch();
    focusField(h, field);
    await vi.advanceTimersByTimeAsync(50);
    expect(field.value).toBe("Atlas Model");
    // The picker replaced the browser, so no key listener of scout's is left.
    expect(h.keyListeners.size).toBe(0);
    field.value = "";
    await vi.advanceTimersByTimeAsync(200);
    expect(field.value).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [900, "Atlas Model"],
    [1_100, ""],
  ])(
    "looks for about a second: a search that appears after %i ms gets %j",
    async (after, expected) => {
      useFakeClock(GENERATED_AT);
      const h = harness();
      await openForPicker(h);
      h.press({ name: "return" });
      await vi.advanceTimersByTimeAsync(after);
      const field = pickerSearch();
      focusField(h, field);
      await vi.advanceTimersByTimeAsync(100);
      expect(field.value).toBe(expected);
      expect(vi.getTimerCount()).toBe(0);
      expect(h.keyListeners.size).toBe(0);
    },
  );

  it("stops looking when the plugin cleans up, removing its timer and key listener at once", async () => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    await openForPicker(h);
    h.press({ name: "return" });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.keyListeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    closeBrowsers(h.pluginContext);
    expect(h.keyListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const field = pickerSearch();
    focusField(h, field);
    await vi.advanceTimersByTimeAsync(100);
    expect(field.value).toBe("");
  });

  it.each([
    [
      "the focused renderable cannot be read",
      (h: Harness) =>
        Object.defineProperty(h.renderer, "currentFocusedRenderable", {
          configurable: true,
          get() {
            throw new Error("renderer destroyed");
          },
        }),
    ],
    [
      "it fails only on a later look",
      (h: Harness) => {
        let looks = 0;
        Object.defineProperty(h.renderer, "currentFocusedRenderable", {
          configurable: true,
          get() {
            looks += 1;
            if (looks > 1) throw new Error("renderer destroyed");
            return undefined;
          },
        });
      },
    ],
    [
      "the search refuses the value",
      (h: Harness) =>
        focusField(h, {
          id: "picker-search",
          traits: { status: "FILTER" },
          get value() {
            return "";
          },
          set value(_next: string) {
            throw new Error("read-only");
          },
        }),
    ],
  ])("never throws when %s", async (_label, arrange) => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    await openForPicker(h);
    arrange(h);
    expect(() => h.press({ name: "return" })).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(h.context.keymap.dispatch).toHaveBeenCalledWith("model.list");
  });

  it("neither throws nor types anywhere when the picker cannot be opened", async () => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    await openForPicker(h);
    h.context.keymap.dispatch.mockImplementation(() => {
      throw new Error("unknown command");
    });
    const field = pickerSearch();
    focusField(h, field);
    expect(() => h.press({ name: "return" })).not.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    expect(field.value).toBe("");
  });
});

/** A keypress as OpenTUI delivers it, with the flag its key handler reads. */
interface EmittedKey {
  readonly name: string;
  readonly sequence: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly option: boolean;
  readonly super: boolean;
  readonly hyper: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

type KeyListener = (key: EmittedKey) => void;

/**
 * A key input that calls listeners as OpenTUI's key handler does: only the
 * listeners present when a keypress begins, in order, stopping after one
 * that stops propagation. It offers `prependListener` only when `prepend`
 * is set.
 */
function keyEmitter(prepend: boolean) {
  let listeners: KeyListener[] = [];
  const on = vi.fn((event: string, listener: KeyListener) => {
    if (event === "keypress") listeners = [...listeners, listener];
  });
  const off = vi.fn((event: string, listener: KeyListener) => {
    if (event === "keypress")
      listeners = listeners.filter((item) => item !== listener);
  });
  const prependListener = vi.fn((event: string, listener: KeyListener) => {
    if (event === "keypress") listeners = [listener, ...listeners];
  });
  return {
    keyInput: prepend ? { on, off, prependListener } : { on, off },
    on,
    prependListener,
    count: () => listeners.length,
    /** Listen ahead of every other listener, as OpenCode's keymap does. */
    first: (listener: KeyListener) => {
      listeners = [listener, ...listeners];
    },
    press(name: string, modifiers: { ctrl?: boolean } = {}): EmittedKey {
      const key: EmittedKey = {
        name,
        sequence: name.length === 1 ? name : "",
        ctrl: modifiers.ctrl ?? false,
        meta: false,
        shift: false,
        option: false,
        super: false,
        hyper: false,
        propagationStopped: false,
        preventDefault: () => undefined,
        stopPropagation: () => {
          key.propagationStopped = true;
        },
      };
      for (const listener of [...listeners]) {
        listener(key);
        if (key.propagationStopped) break;
      }
      return key;
    },
  };
}

type KeyEmitter = ReturnType<typeof keyEmitter>;

describe("keys during the picker handoff", () => {
  /** Open the browser with `keys` as its key input; `model.list` replaces it. */
  async function openWith(h: Harness, keys: KeyEmitter): Promise<unknown> {
    h.renderer.keyInput = keys.keyInput;
    return openForPicker(h);
  }

  const emitters = [
    ["with prependListener", true],
    ["with on alone", false],
  ] as const;

  it.each(emitters)(
    "fills after the handoff key, which never reaches the new listener, and then stops listening (%s)",
    async (_label, prepend) => {
      useFakeClock(GENERATED_AT);
      const h = harness();
      const keys = keyEmitter(prepend);
      await openWith(h, keys);
      keys.press("return");
      // The picker replaced the browser; only the pre-fill listens now.
      expect(keys.count()).toBe(1);
      const field = pickerSearch();
      focusField(h, field);
      await vi.advanceTimersByTimeAsync(50);
      expect(field.value).toBe("Atlas Model");
      expect(keys.count()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(emitters)(
    "ends the attempt on any key that arrives before the fill (%s)",
    async (_label, prepend) => {
      useFakeClock(GENERATED_AT);
      const h = harness();
      const keys = keyEmitter(prepend);
      await openWith(h, keys);
      keys.press("return");
      keys.press("x");
      expect(keys.count()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      const field = pickerSearch();
      focusField(h, field);
      await vi.advanceTimersByTimeAsync(100);
      expect(field.value).toBe("");
    },
  );

  it("hears a key OpenCode's keymap stops, because it listens ahead of the keymap", async () => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    const keys = keyEmitter(true);
    // The keymap listens ahead of plugins and stops the keys it handles,
    // such as ctrl+a, which opens another dialog with a filter input.
    keys.first((key) => {
      if (key.ctrl) key.stopPropagation();
    });
    await openWith(h, keys);
    keys.press("return");
    keys.press("a", { ctrl: true });
    expect(keys.count()).toBe(1);
    const field = pickerSearch();
    focusField(h, field);
    await vi.advanceTimersByTimeAsync(100);
    expect(field.value).toBe("");
  });

  it("ends an earlier attempt when another handoff starts, so its query never reaches the newer picker", async () => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    h.setHostModels([hostModel("m-a", "Model A"), hostModel("m-b", "Model B")]);
    // Without prependListener the browser, which stays open here, goes
    // first and stops the keys it handles, so the earlier attempt never
    // hears them and only the second handoff can end it.
    const keys = keyEmitter(false);
    h.renderer.keyInput = keys.keyInput;
    const { root } = await h.show();
    await settle();
    expect(selectedRow(root)).toContain("Model A");
    keys.press("return");
    await vi.advanceTimersByTimeAsync(5);
    keys.press("down");
    expect(selectedRow(root)).toContain("Model B");
    keys.press("return");
    // The browser and the newer attempt.
    expect(keys.count()).toBe(2);
    const field = pickerSearch();
    focusField(h, field);
    await vi.advanceTimersByTimeAsync(50);
    expect(field.value).toBe("Model B");
  });

  it.each([
    ["on", false],
    ["prependListener", true],
  ] as const)(
    "types nothing when %s cannot attach the key listener",
    async (_method, prepend) => {
      useFakeClock(GENERATED_AT);
      const h = harness();
      const keys = keyEmitter(prepend);
      await openWith(h, keys);
      (prepend ? keys.prependListener : keys.on).mockImplementation(() => {
        throw new Error("emitter closed");
      });
      const field = pickerSearch();
      focusField(h, field);
      expect(() => keys.press("return")).not.toThrow();
      await vi.advanceTimersByTimeAsync(100);
      expect(field.value).toBe("");
      expect(keys.count()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

// ── Copy ────────────────────────────────────────────────────────────────

describe("copy", () => {
  it("copies the provider ID from a provider header", async () => {
    const h = harness();
    await h.ready();
    h.press({ name: "home" });
    h.press({ name: "y" });
    expect(h.renderer.copyToClipboardOSC52).toHaveBeenLastCalledWith("atlas");
  });

  it("keeps the text visible when the terminal refuses the copy", async () => {
    const h = harness();
    const { root } = await h.ready();
    h.renderer.copyToClipboardOSC52.mockReturnValue(false);
    h.press({ name: "y" });
    expect(line(root, "modelscout-notice")).toBe(
      "Terminal copy (OSC 52) is unavailable; select the text below:",
    );
    expect(lines(root, "modelscout-banner")).toEqual(["atlas/atlas-model"]);
  });

  it("tries OSC 52 when the renderer cannot say whether it is supported", async () => {
    const h = harness();
    const { root } = await h.ready();
    Reflect.deleteProperty(h.renderer, "isOsc52Supported");
    h.press({ name: "y" });
    expect(h.renderer.copyToClipboardOSC52).toHaveBeenCalledWith(
      "atlas/atlas-model",
    );
    expect(line(root, "modelscout-notice")).toBe(
      "Copy sent to terminal: atlas/atlas-model",
    );
  });

  it("clears the copy notice after 5 s but keeps an unsupported notice for 30 s", async () => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    const { root } = await h.show();
    await settle();
    h.press({ name: "y" });
    expect(line(root, "modelscout-notice")).toMatch(/^Copy sent/);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(line(root, "modelscout-notice")).toBe("");

    h.renderer.isOsc52Supported.mockReturnValue(false);
    h.press({ name: "y" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(line(root, "modelscout-notice")).toMatch(/OSC 52\) is unavailable/);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(line(root, "modelscout-notice")).toBe("");
  });
});

// ── Refresh ─────────────────────────────────────────────────────────────

describe("refresh", () => {
  it.each([
    [
      { accepted: false, reason: "throttled" },
      "Refresh skipped: Atlas was checked under a minute ago",
    ],
    [{ accepted: false, reason: "something-new" }, "Refresh skipped"],
    [undefined, "Refresh skipped"],
  ])("explains the answer %j", async (answer, notice) => {
    const h = harness();
    const { root } = await h.ready();
    h.refresh.mockResolvedValueOnce(answer);
    h.press({ name: "r" });
    await vi.waitFor(() =>
      expect(line(root, "modelscout-notice")).toBe(notice),
    );
  });

  it("explains an R that finds no targets", async () => {
    const h = harness();
    const { root } = await h.ready();
    h.refresh.mockResolvedValueOnce({ accepted: false, reason: "no-targets" });
    h.press({ name: "r", sequence: "R", shift: true });
    await vi.waitFor(() =>
      expect(line(root, "modelscout-notice")).toBe(
        "Refresh skipped: no providers to discover",
      ),
    );
  });

  it.each([
    [
      Object.assign(new Error("slow"), { name: "TimeoutError" }),
      "▲ Refresh failed: scout's server half timed out",
    ],
    [
      new Error("socket hang up"),
      "▲ Refresh failed: scout's server half is unreachable",
    ],
    [
      { type: "rpc.unavailable", message: "" },
      "▲ Refresh failed: scout's server half did not answer",
    ],
  ])("explains a failed refresh (%s)", async (error, notice) => {
    const h = harness();
    const { root } = await h.ready();
    h.refresh.mockRejectedValueOnce(error);
    h.press({ name: "r" });
    await vi.waitFor(() =>
      expect(line(root, "modelscout-notice")).toBe(notice),
    );
  });

  it("says a refresh was requested while the answer is pending, then re-reads after acceptance", async () => {
    const h = harness();
    const { root } = await h.ready();
    const answer = deferred<unknown>();
    h.refresh.mockReturnValueOnce(answer.promise);
    h.press({ name: "r" });
    expect(line(root, "modelscout-notice")).toBe(
      "○ Refresh requested for Atlas…",
    );
    answer.resolve({ accepted: true });
    await vi.waitFor(() => expect(h.modelList).toHaveBeenCalledTimes(2));
  });

  it("refreshes the scoped provider with r and leaves R alone in a single-provider scope", async () => {
    const h = harness();
    await h.ready({ kind: "provider", providerID: "atlas" });
    h.press({ name: "r" });
    await vi.waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.refresh.mock.calls[0]?.[0]).toEqual({ providerID: "atlas" });
    const shifted = h.press({ name: "r", sequence: "R", shift: true });
    await settle();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(shifted.preventDefault).not.toHaveBeenCalled();
  });

  it("counts a throttled refresh down each second and then drops the notice", async () => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    h.catalog.mockResolvedValue(
      payload([providerRecord({ nextRefreshAt: "2026-10-11T08:00:40.000Z" })]),
    );
    const { root } = await h.show();
    await settle();
    h.refresh.mockResolvedValueOnce({ accepted: false, reason: "throttled" });
    h.press({ name: "r" });
    await settle();
    expect(line(root, "modelscout-notice")).toBe(
      "Refresh skipped: Atlas was checked recently. Try again in 40 s.",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(line(root, "modelscout-notice")).toBe(
      "Refresh skipped: Atlas was checked recently. Try again in 30 s.",
    );
    await vi.advanceTimersByTimeAsync(31_000);
    expect(line(root, "modelscout-notice")).toBe("");
  });

  it("uses the shortest wait across providers for a throttled R", async () => {
    const h = harness();
    h.setHostProviders([hostProvider(), hostProvider("bravo", "Bravo")]);
    h.catalog.mockResolvedValue(
      payload([
        providerRecord({ nextRefreshAt: "2026-10-11T08:00:50.000Z" }),
        providerRecord({
          id: "bravo",
          endpointOrigin: knownScalar(
            "https://bravo.test",
            "pre-existing",
            "configured",
          ),
          nextRefreshAt: "2026-10-11T08:00:30.000Z",
        }),
      ]),
    );
    const { root } = await h.ready();
    h.refresh.mockResolvedValueOnce({ accepted: false, reason: "throttled" });
    h.press({ name: "r", sequence: "R", shift: true });
    await vi.waitFor(() =>
      expect(line(root, "modelscout-notice")).toMatch(
        /^Refresh skipped: every provider was checked recently\. Try again in (29|30) s\.$/,
      ),
    );
  });
});

// ── Selection and navigation memory ─────────────────────────────────────

describe("selection", () => {
  it("keeps the selected model across a reload that adds rows before it", async () => {
    const h = harness();
    h.setHostModels([hostModel("m-b", "Model B"), hostModel("m-c", "Model C")]);
    const { root } = await h.ready();
    h.press({ name: "down" });
    expect(selectedRow(root)).toContain("Model C");
    h.setHostModels([
      hostModel("m-a", "Model A"),
      hostModel("m-b", "Model B"),
      hostModel("m-c", "Model C"),
    ]);
    h.emitRpc("updated", { location: PROJECT });
    await vi.waitFor(() => expect(listRows(root)).toHaveLength(4));
    expect(selectedRow(root)).toContain("Model C");
  });

  it("keeps the selected model when the sort moves it", async () => {
    const h = harness();
    h.setHostModels([
      hostModel("small", "A Small", { limit: { context: 1000, output: 0 } }),
      hostModel("big", "B Big", { limit: { context: 900_000, output: 0 } }),
    ]);
    const { root } = await h.ready();
    expect(selectedRow(root)).toContain("A Small");
    h.press({ name: "s" });
    expect(line(root, "modelscout-filters")).toMatch(/sort context · clear x$/);
    expect(listRows(root)[1]).toContain("B Big");
    expect(selectedRow(root)).toContain("A Small");
  });

  it("returns to the list when the model shown in details disappears", async () => {
    const h = harness({ terminalWidth: 80, terminalHeight: 24 });
    h.setHostModels([hostModel("m-a", "Model A"), hostModel("m-b", "Model B")]);
    const { root } = await h.ready();
    h.press({ name: "down" });
    h.press({ name: "i" });
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(false);
    h.setHostModels([]);
    h.setHostProviders([]);
    h.catalog.mockResolvedValue(payload([]));
    h.emitRpc("updated", { location: PROJECT });
    await vi.waitFor(() =>
      expect(pane(root)).toContain("No OpenAI-compatible providers found."),
    );
  });

  it("selects the current model once the host lists recover from a failure", async () => {
    const h = harness();
    h.setHostModels([hostModel("m-a", "Model A"), hostModel("m-b", "Model B")]);
    h.setCurrentModel({ providerID: "atlas", modelID: "m-b" });
    h.modelList.mockRejectedValueOnce(new Error("service down"));
    const { root } = await h.show();
    await vi.waitFor(() => expect(pane(root)).toContain("r retries."));
    h.press({ name: "r" });
    await vi.waitFor(() => expect(listRows(root).length).toBeGreaterThan(0));
    expect(selectedRow(root)).toMatch(/^▌● Model B/);
  });

  it("selects the current model on the first open when its rows arrive after an empty first read", async () => {
    // A fresh start: the provider is listed before its discovered models are.
    const h = harness();
    h.setHostModels([]);
    h.catalog.mockResolvedValue(
      payload([
        providerRecord({
          discovering: true,
          lastGoodAt: null,
          resultEpoch: null,
        }),
      ]),
    );
    h.setCurrentModel({ providerID: "atlas", modelID: "m-b" });
    const { root } = await h.ready();
    expect(listRows(root)).toEqual([
      expect.stringMatching(/^▌▾ Atlas/),
      "   Checking the model list…",
    ]);
    h.setHostModels([hostModel("m-a", "Model A"), hostModel("m-b", "Model B")]);
    h.catalog.mockResolvedValue(payload());
    h.emitRpc("status", { location: PROJECT });
    await vi.waitFor(() => expect(listRows(root)).toHaveLength(3));
    expect(selectedRow(root)).toMatch(/^▌● Model B/);
  });

  it("restores the stored selection on a later open instead of the current model", async () => {
    const h = harness();
    h.setHostModels([
      hostModel("m-a", "Model A"),
      hostModel("m-b", "Model B"),
      hostModel("m-c", "Model C"),
    ]);
    const first = await h.ready();
    h.press({ name: "end" });
    first.handle?.close();
    h.setCurrentModel({ providerID: "atlas", modelID: "m-a" });
    const again = await h.ready();
    expect(selectedRow(again.root)).toMatch(/Model C/);
    expect(listRows(again.root).find((row) => row.includes("Model A"))).toMatch(
      /^ ● Model A/,
    );
  });
});

describe("navigation memory", () => {
  it("keeps state per location and per scope, and never writes to persistent storage", async () => {
    const h = harness();
    const first = await h.ready();
    h.press({ name: "s" });
    first.handle?.close();

    const scoped = await h.ready({ kind: "provider", providerID: "atlas" });
    expect(line(scoped.root, "modelscout-filters")).toContain("sort name");
    scoped.handle?.close();

    const same = await h.ready();
    expect(line(same.root, "modelscout-filters")).toContain("sort context");
    same.handle?.close();

    h.context.location = { directory: "/work/other" };
    const other = await h.ready();
    expect(line(other.root, "modelscout-filters")).toContain("sort name");
    expect(h.store.get).not.toHaveBeenCalled();
    expect(h.store.set).not.toHaveBeenCalled();
  });

  it("remembers a collapsed provider", async () => {
    const h = harness();
    const first = await h.ready();
    h.press({ name: "left" });
    expect(listRows(first.root)).toEqual([expect.stringMatching(/^▌▸ Atlas/)]);
    first.handle?.close();
    const again = await h.ready();
    expect(listRows(again.root)).toEqual([expect.stringMatching(/^▌▸ Atlas/)]);
  });
});

// ── Updates and timers ──────────────────────────────────────────────────

describe("updates", () => {
  it("replays an update that arrived while the dialog was opening", async () => {
    const h = harness();
    const opening = h.show();
    h.emitRpc("updated", { location: PROJECT });
    const { root } = await opening;
    await vi.waitFor(() => expect(listRows(root).length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(h.modelList).toHaveBeenCalledTimes(2));
  });

  it("ignores RPC events for another location or without one", async () => {
    const h = harness();
    await h.ready();
    h.emitRpc("status", { location: { directory: "/elsewhere" } });
    h.emitRpc("updated", {});
    h.emitModelUpdated({ location: { directory: "/elsewhere" } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.modelList).toHaveBeenCalledOnce();
  });

  it("repaints relative ages in details while the dialog stays open", async () => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    const { root } = await h.show();
    await settle();
    h.press({ name: "home" });
    expect(pane(root)).toContain("● Ready · checked just now");
    await vi.advanceTimersByTimeAsync(75_000);
    expect(pane(root)).toContain("● Ready · checked 1 min ago");
  });

  it("stops repainting once closed", async () => {
    useFakeClock(GENERATED_AT);
    const h = harness();
    const { root, handle } = await h.show();
    await settle();
    h.press({ name: "home" });
    handle?.close();
    await vi.advanceTimersByTimeAsync(75_000);
    expect(pane(root)).toContain("checked just now");
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── Keys and screens ────────────────────────────────────────────────────

describe("wide layout keys", () => {
  it("opens the details over the list on i, scrolls them without moving the list, and backspace returns", async () => {
    const h = harness();
    const { root } = await h.ready();
    const before = selectedRow(root);
    h.press({ name: "i" });
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(false);
    expect(line(root, "modelscout-footer")).toMatch(
      /^select enter {2}back backspace/,
    );
    h.press({ name: "down" });
    h.press({ name: "backspace" });
    expect(selectedRow(root)).toBe(before);
    expect(line(root, "modelscout-footer")).toMatch(
      /^select enter {2}details i/,
    );
  });

  it("keeps the details screen when the terminal narrows", async () => {
    const h = harness();
    const { root } = await h.ready();
    h.press({ name: "i" });
    h.resize(80, 24);
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(false);
    expect(pane(root)).toContain("atlas/atlas-model");
    h.press({ name: "backspace" });
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(true);
    expect(line(root, "modelscout-summary")).toMatch(/^Atlas Model/);
  });
});

describe("the preview beside the list", () => {
  /** 16 rows leave a body shorter than a model's or a provider's details. */
  const short = { terminalWidth: 120, terminalHeight: 16 };
  const shownPane = (root: unknown): string[] => lines(root, "modelscout-pane");

  it("follows the selection under every move key, from its top, and never takes the keys", async () => {
    const h = harness(short);
    h.setHostModels([
      hostModel("m-a", "Model A"),
      hostModel("m-b", "Model B"),
      hostModel("m-c", "Model C"),
    ]);
    const { root } = await h.ready();
    for (const [name, row, subject] of [
      ["down", "Model B", "atlas/m-b"],
      ["end", "Model C", "atlas/m-c"],
      ["up", "Model B", "atlas/m-b"],
      ["home", "Atlas", "https://atlas.test"],
      ["pagedown", "Model C", "atlas/m-c"],
      ["pageup", "Atlas", "https://atlas.test"],
    ] as const) {
      h.press({ name });
      expect(selectedRow(root), name).toContain(row);
      expect(visible(findNodeById(root, "modelscout-list"))).toBe(true);
      const preview = shownPane(root);
      expect(preview.join("\n"), name).toContain(subject);
      expect(preview[0], name).not.toMatch(/^↑/);
      expect(preview.at(-1), name).toMatch(/^↓ \d+ more · i$/);
    }
  });

  it("names i in the more line of the side preview only", async () => {
    const h = harness(short);
    const { root } = await h.ready();
    const last = (): string | undefined => shownPane(root).at(-1);
    expect(last()).toMatch(/^↓ \d+ more · i$/);
    for (const [open, close] of [
      ["i", "backspace"],
      ["d", "backspace"],
      ["?", "?"],
    ]) {
      h.press({ name: open, sequence: open });
      expect(last(), open).toMatch(/^↓ (\d+ )?more$/);
      h.press({ name: close, sequence: close === "?" ? "?" : "" });
      expect(last(), open).toMatch(/^↓ \d+ more · i$/);
    }
  });

  it("keeps the more line plain on a card in place of the list", async () => {
    const h = harness(short);
    h.setHostProviders([]);
    h.setHostModels([]);
    h.catalog.mockResolvedValue(payload([]));
    const { root } = await h.show();
    await vi.waitFor(() =>
      expect(shownPane(root).join("\n")).toContain(
        "No OpenAI-compatible providers found.",
      ),
    );
    expect(shownPane(root).at(-1)).toMatch(/^↓ \d+ more$/);
  });

  it("shows the preview from its top after the details screen was scrolled", async () => {
    const h = harness(short);
    const { root } = await h.ready();
    h.press({ name: "i" });
    for (let step = 0; step < 3; step += 1) h.press({ name: "down" });
    expect(shownPane(root)[0]).toBe("↑ 3 more");
    h.press({ name: "backspace" });
    expect(shownPane(root)[0]).not.toMatch(/^↑/);
    expect(shownPane(root).at(-1)).toMatch(/^↓ \d+ more · i$/);
  });

  it("gives the details screen the whole content width at every size, and keeps it open across a resize", async () => {
    const h = harness();
    const { root } = await h.ready();
    const width = (): unknown =>
      findNodeById(root, "modelscout-pane")?.props?.width;
    const shows = (id: string): boolean => visible(findNodeById(root, id));
    // The preview shares the 110 content columns with the list (58) and a separator (3).
    expect(width()).toBe(49);
    expect(shows("modelscout-separator")).toBe(true);
    h.press({ name: "i" });
    expect(width()).toBe(110);
    expect(shows("modelscout-list")).toBe(false);
    expect(shows("modelscout-separator")).toBe(false);
    h.resize(80, 24);
    expect(width()).toBe(72);
    expect(shows("modelscout-list")).toBe(false);
    h.resize(120, 36);
    expect(width()).toBe(110);
    expect(shows("modelscout-list")).toBe(false);
    expect(pane(root)).toContain("atlas/atlas-model");
    h.press({ name: "backspace" });
    expect(width()).toBe(49);
    expect(shows("modelscout-list")).toBe(true);
  });

  it("scrolls the details screen with every move key without moving the list", async () => {
    const h = harness(short);
    h.setHostModels([hostModel("m-a", "Model A"), hostModel("m-b", "Model B")]);
    const { root } = await h.ready();
    h.press({ name: "i" });
    const first = (): string | undefined => shownPane(root)[0];
    const last = (): string | undefined => shownPane(root).at(-1);
    expect(first()).not.toMatch(/^↑/);
    /** Lines hidden above, from the top row's `↑ N more`. */
    const above = (): number =>
      Number(/^↑ (\d+) more$/.exec(first() ?? "")?.[1] ?? 0);
    h.press({ name: "down" });
    expect(first()).toBe("↑ 1 more");
    h.press({ name: "home" });
    expect(first()).not.toMatch(/^↑/);
    h.press({ name: "pagedown" });
    const paged = above();
    expect(paged).toBeGreaterThan(1);
    h.press({ name: "pageup" });
    expect(above()).toBeLessThan(paged);
    h.press({ name: "end" });
    expect(last()).not.toMatch(/^↓/);
    h.press({ name: "up" });
    expect(last()).toMatch(/^↓ \d+ more$/);
    h.press({ name: "backspace" });
    expect(selectedRow(root)).toContain("Model A");
  });
});

describe("narrow layout keys", () => {
  it("opens provider details from a header and summarizes the header under the list", async () => {
    const h = harness({ terminalWidth: 80, terminalHeight: 24 });
    const { root } = await h.ready();
    h.press({ name: "home" });
    // "https://" is left out; "http://" would stay to flag an endpoint without TLS.
    expect(line(root, "modelscout-summary")).toBe("Atlas · atlas.test");
    h.press({ name: "return" });
    expect(pane(root)).toMatch(/Server type +vLLM, detected automatically/);
    h.press({ name: "backspace" });
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(true);
  });
});

describe("key list", () => {
  it("lists the list keys for every provider, hides keys ?, and returns with backspace", async () => {
    const h = harness();
    const { root } = await h.ready();
    h.press({ name: "?", sequence: "?" });
    expect(pane(root)).toMatch(/^Keys · Model Scout list/);
    expect(pane(root)).toMatch(/R +refresh every provider/);
    expect(pane(root)).toMatch(/← → +collapse or expand a provider/);
    expect(pane(root)).not.toContain("open /actualyze");
    expect(line(root, "modelscout-footer")).toMatch(
      /^back backspace +close esc$/,
    );
    h.press({ name: "backspace" });
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(true);
  });

  it("leaves R and collapse out of a single-provider scope and adds caller keys", async () => {
    const h = harness();
    await h.ready(
      { kind: "provider", providerID: "atlas" },
      {
        actualyze: () => undefined,
        extraActions: [
          { key: "k", title: "another key", run: () => undefined },
        ],
      },
    );
    const root = h.current()?.render();
    h.press({ name: "?", sequence: "?" });
    const text = pane(root);
    expect(text).not.toMatch(/R +refresh every provider/);
    expect(text).not.toContain("collapse or expand");
    expect(text).toMatch(/a +open \/actualyze/);
    expect(text).toMatch(/k +another key/);
  });

  it.each([
    ["wide", 120, 36],
    ["narrow", 80, 24],
  ] as const)(
    "lists enter / m as one picker entry and i for details (%s)",
    async (_label, columns, rows) => {
      const h = harness({ terminalWidth: columns, terminalHeight: rows });
      const { root } = await h.ready();
      h.press({ name: "?", sequence: "?" });
      const shown = lines(root, "modelscout-pane");
      expect(shown.filter((text) => /^enter \/ m\s/.test(text))).toEqual([
        expect.stringMatching(/select the model in OpenCode's model picker$/),
      ]);
      expect(shown.some((text) => /^(enter|m)\s{2,}/.test(text))).toBe(false);
      expect(shown.some((text) => /^i\s{2,}details/.test(text))).toBe(true);
    },
  );

  it("titles the key list after the view below it", async () => {
    const h = harness({ terminalWidth: 80, terminalHeight: 24 });
    const { root } = await h.ready();
    h.press({ name: "i" });
    h.press({ name: "?", sequence: "?" });
    expect(pane(root)).toMatch(/^Keys · Model Scout details/);
    h.press({ name: "?", sequence: "?" });
    h.press({ name: "d" });
    h.press({ name: "?", sequence: "?" });
    expect(pane(root)).toMatch(/^Keys · Model Scout evidence/);
  });
});

describe("collapse and expand", () => {
  it("collapses the selected model's group onto its header and expands it again", async () => {
    const h = harness();
    const { root } = await h.ready();
    h.press({ name: "left" });
    expect(listRows(root)).toEqual([expect.stringMatching(/^▌▸ Atlas/)]);
    expect(line(root, "modelscout-footer")).toMatch(/expand →/);
    h.press({ name: "left" });
    expect(listRows(root)).toHaveLength(1);
    h.press({ name: "right" });
    expect(listRows(root)).toEqual([
      expect.stringMatching(/^▌▾ Atlas/),
      expect.stringContaining("Atlas Model"),
    ]);
  });

  it("shows a collapsed group's models during a search, where left only moves to the header", async () => {
    const h = harness();
    const { root } = await h.ready();
    h.press({ name: "left" });
    h.press({ name: "/" });
    const search = findNodeById(root, "modelscout-search");
    (search?.props?.onInput as (value: string) => void)("atlas");
    h.press({ name: "return" });
    expect(listRows(root)).toHaveLength(2);
    h.press({ name: "down" });
    expect(selectedRow(root)).toContain("Atlas Model");
    h.press({ name: "left" });
    expect(selectedRow(root)).toMatch(/Atlas +1 model/);
    expect(listRows(root)).toHaveLength(2);
    h.press({ name: "x" });
    expect(listRows(root)).toEqual([expect.stringMatching(/^▌▸ Atlas/)]);
  });
});

describe("filter screen", () => {
  it("applies changes live, lists every field, and returns with f", async () => {
    const h = harness();
    h.setHostModels([hostModel("atlas-model", "Atlas Model")]);
    h.catalog.mockResolvedValue(
      payload([
        providerRecord({
          models: [
            evidenceModel("vec", {
              enabled: false,
              modelType: knownScalar(
                "embedding",
                "provider-probe",
                "authoritative",
              ),
            }),
          ],
        }),
      ]),
    );
    const { root } = await h.ready();
    expect(line(root, "modelscout-filters")).toMatch(
      /^Filters: chat · all providers · 1 embedding hidden/,
    );
    h.press({ name: "f" });
    const fields = listRows(root, "modelscout-filter-list").slice(1);
    expect(
      fields.map(
        (row) =>
          row
            .replace(/^▌/, " ")
            .trim()
            .split(/\s{2,}/)[0],
      ),
    ).toEqual([
      "Provider",
      "Type",
      "Needs tools",
      "Needs images",
      "Needs reasoning",
      "Priced only",
      "Include assumed or inferred",
    ]);
    expect(fields.at(-1)).toMatch(/No$/);
    h.press({ name: "down" });
    h.press({ name: "right" });
    expect(lines(root, "modelscout-filter-list")[0]).toBe(
      "Filters · 1 matching model · applied as you change them",
    );
    expect(lines(root, "modelscout-filter-list")[3]).toMatch(
      /Type +Embedding$/,
    );
    h.press({ name: "f" });
    expect(listRows(root).some((row) => row.includes("vec"))).toBe(true);
    expect(listRows(root).some((row) => row.includes("Atlas Model"))).toBe(
      false,
    );
  });
});

describe("search focus", () => {
  it("shows only results enter in the footer and runs no letter or ? action", async () => {
    const h = harness();
    const { root } = await h.ready();
    h.press({ name: "/" });
    expect(line(root, "modelscout-footer")).toMatch(
      /^results enter +close esc$/,
    );
    for (const name of ["x", "r", "s", "f", "?", "y"]) {
      const event = h.press({ name });
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.renderer.copyToClipboardOSC52).not.toHaveBeenCalled();
    expect(line(root, "modelscout-filters")).toContain("sort name");
    expect(visible(findNodeById(root, "modelscout-filter-list"))).toBe(false);
  });

  it("returns to the list on down, keeping the query", async () => {
    const h = harness();
    const { root } = await h.ready();
    h.press({ name: "/" });
    const search = findNodeById(root, "modelscout-search");
    (search?.props?.onInput as (value: string) => void)("atlas");
    h.press({ name: "down" });
    expect(search?.props?.focused).toBe(false);
    expect(listRows(root).some((row) => row.includes("Atlas Model"))).toBe(
      true,
    );
    expect(line(root, "modelscout-filters")).toMatch(/clear x$/);
  });
});

describe("caller extra actions", () => {
  it("shows the hint, ignores the key while disabled, and runs it after consuming the key", async () => {
    const h = harness();
    let enabled = false;
    const order: string[] = [];
    const run = vi.fn(() => order.push("run"));
    const { root } = await h.ready(
      { kind: "all" },
      {
        extraActions: [
          { key: "k", title: "another key", enabled: () => enabled, run },
        ],
      },
    );
    // The list footer has no room left for it at 110 columns; details do.
    h.press({ name: "i" });
    expect(footerRole(root, "another key")).toBe(
      "text.action.primary.disabled",
    );
    h.press({ name: "k" });
    expect(run).not.toHaveBeenCalled();
    enabled = true;
    h.press({ name: "k", preventDefault: () => order.push("consumed") });
    expect(order).toEqual(["consumed", "run"]);
  });

  it("uses the caller's title and search placeholder", async () => {
    const h = harness();
    const { root } = await h.ready(
      { kind: "provider", providerID: "atlas" },
      {
        title: "Actualyze models",
        searchPlaceholder: "Search Actualyze models",
      },
    );
    expect(line(root, "modelscout-header")).toMatch(
      /^Actualyze models +1 model$/,
    );
    expect(findNodeById(root, "modelscout-search")?.props?.placeholder).toBe(
      "Search Actualyze models",
    );
  });
});

// ── Secrets ─────────────────────────────────────────────────────────────

describe("provider settings", () => {
  it("never renders a key, header, credential, path, or query from provider settings", async () => {
    const h = harness();
    h.setHostProviders([
      hostProvider("atlas", "Atlas", {
        baseURL: "https://user:hunter2@atlas.test:8443/openai/v1?token=tok123",
        apiKey: "sk-live-SECRET",
        headers: { Authorization: "Bearer HDR-SECRET" },
      }),
    ]);
    h.catalog.mockRejectedValue({ type: "rpc.unavailable", message: "" });
    const { root } = await h.ready();
    const screens: string[] = [];
    const capture = () => screens.push(allText(root));
    capture();
    h.press({ name: "d" });
    capture();
    h.press({ name: "backspace" });
    h.press({ name: "home" });
    capture();
    h.press({ name: "d" });
    capture();
    h.press({ name: "backspace" });
    h.press({ name: "?", sequence: "?" });
    capture();
    h.press({ name: "backspace" });
    h.press({ name: "f" });
    capture();
    h.press({ name: "f" });
    h.resize(80, 24);
    h.press({ name: "down" });
    capture();
    h.press({ name: "i" });
    capture();

    const everything = screens.join("\n");
    expect(everything).toContain("https://atlas.test:8443");
    for (const secret of [
      "SECRET",
      "hunter2",
      "user:",
      "tok123",
      "/openai/v1",
      'apiKey":',
    ])
      expect(everything).not.toContain(secret);
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────

describe("handles", () => {
  it("closes its own dialog once and reports closed", async () => {
    const h = harness();
    const { handle } = await h.ready();
    expect(handle?.closed).toBe(false);
    handle?.close();
    handle?.close();
    expect(handle?.closed).toBe(true);
    expect(h.dialog.clear).toHaveBeenCalledOnce();
    expect(h.keyListeners.size).toBe(0);
  });

  it("refuses to open after closeBrowsers ran for the context", async () => {
    const h = harness();
    await h.ready();
    closeBrowsers(h.pluginContext);
    expect(h.current()).toBeUndefined();
    const shown = await h.show();
    expect(shown.handle).toBeUndefined();
    expect(h.dialog.show).toHaveBeenCalledOnce();
  });
});
