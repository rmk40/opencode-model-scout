import { afterEach, describe, expect, it, vi } from "vitest";

// The reconciler needs a live renderer; the mock records the same
// createElement/setProp/insert calls the plugin makes against OpenTUI, and
// the core mock stands in for StyledText, which the plugin assigns to a
// text node's `content` directly.
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
  type CatalogPayload,
  type CatalogProviderRecord,
} from "../src/catalog-evidence";
import { COMMAND_NAME, PLUGIN_ID } from "../src/constants";
import plugin from "../src/tui";
import type { HostModel, HostProvider } from "../src/tui-models";
import { openBrowser } from "../src/tui-session";

interface MockNode {
  tag?: string;
  props?: Record<string, unknown>;
  children?: MockNode[];
  content?: unknown;
}

interface Command {
  id?: string;
  title?: string;
  palette?: true;
  slash?: { name: string };
  bind?: false | string;
  run: () => void | false | Promise<void>;
}

interface Layer {
  mode?: string;
  commands?: readonly Command[];
}

const PROJECT = { directory: "/work/project" };
const GENERATED_AT = "2026-10-11T08:00:00.000Z";

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

/** Text of a node, from its StyledText chunks or its plain content. */
/**
 * Text of a node. A focused selection is a background band without a
 * glyph; its first column reads as "▌" here, like the bar of an unfocused
 * selection, so tests can find the selected row either way.
 */
function textOf(node: MockNode | undefined): string {
  const content = node?.content;
  if (content && typeof content === "object" && "chunks" in content) {
    const chunks = (
      content as { chunks: Array<{ text: string; bg?: unknown }> }
    ).chunks;
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

/** The visible lines of a row list or text pane. */
function lines(root: unknown, id: string): string[] {
  const box = findNodeById(root, id);
  if (!visible(box)) return [];
  return (box?.children ?? [])
    .filter(visible)
    .map((child) => textOf(child).trimEnd());
}

function listRows(root: unknown): string[] {
  return lines(root, "modelscout-list");
}

function pane(root: unknown): string {
  return lines(root, "modelscout-pane").join("\n");
}

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

function surface(base = "text.base") {
  return {
    text: {
      base: color(base),
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

const atlasProvider: HostProvider = {
  id: "atlas",
  name: "Atlas",
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: "https://atlas.test/openai/v1" },
};

function hostModel(
  id = "atlas-model",
  name = "Atlas Model",
  input: string[] = ["text"],
): HostModel {
  return {
    id,
    providerID: "atlas",
    name,
    enabled: true,
    capabilities: { tools: true, input, output: ["text"] },
    variants: [],
    cost: [],
    limit: { context: 8192, output: 32_000 },
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
    models: [
      {
        id: "atlas-model",
        origin: "discovered",
        enabled: true,
        identity: knownScalar("atlas-model", "server-list", "reported"),
        name: unknownScalar(),
        modelType: unknownScalar(),
        context: knownScalar(8192, "provider-probe", "authoritative"),
        output: knownScalar(32_000, "host-default", "assumed"),
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
      },
    ],
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
  record: Partial<CatalogProviderRecord> = {},
  generatedAt = GENERATED_AT,
): CatalogPayload {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    packageVersion: "2.0.0",
    instanceID: "instance",
    generatedAt,
    status: "complete",
    completedAt: GENERATED_AT,
    builtIn: { actualyze: "managed" },
    providers: [providerRecord(record)],
  };
}

interface HarnessOptions {
  location?: { directory: string } | undefined;
  terminalWidth?: number;
  terminalHeight?: number;
}

function harness(options: HarnessOptions = {}) {
  const layers: Array<() => Layer> = [];
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
  const renderer = {
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

  let hostModels: HostModel[] = [hostModel()];
  const modelList = vi.fn(
    async (input: { location: { directory: string } }) => ({
      location: input.location,
      data: hostModels,
    }),
  );
  const providerList = vi.fn(
    async (input: { location: { directory: string } }) => ({
      location: input.location,
      data: [atlasProvider],
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
  const stopRpc = vi.fn();
  const on = vi.fn((name: string, handler: (event: unknown) => void) => {
    const set = rpcHandlers.get(name) ?? new Set();
    set.add(handler);
    rpcHandlers.set(name, set);
    return () => {
      stopRpc();
      set.delete(handler);
    };
  });
  const rpc = vi.fn(() => ({ catalog, refresh, events: { on } }));
  const modelHandlers = new Set<(event: unknown) => void>();
  const stopData = vi.fn();
  const dataOn = vi.fn((_type: string, handler: (event: unknown) => void) => {
    modelHandlers.add(handler);
    return () => {
      stopData();
      modelHandlers.delete(handler);
    };
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
  let currentModel: { providerID: string; modelID: string } | undefined;
  let tokens = surface();

  const context = {
    location: "location" in options ? options.location : PROJECT,
    data: {
      on: dataOn,
      location: { default: () => ({ directory: "/default/project" }) },
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
    keymap: {
      layer: (factory: () => Layer) => layers.push(factory),
      dispatch: vi.fn(),
    },
    storage: { memory },
    renderer,
    theme: { surface: () => tokens },
    themeMode: "dark",
  };

  const cleanup = plugin.setup(context as unknown as Plugin.Context);
  const command = (): Command => {
    const found = layers[0]?.().commands?.[0];
    if (!found) throw new Error("command not registered");
    return found;
  };
  const run = async (): Promise<unknown> => {
    await command().run();
    return open?.render();
  };
  /** Open the dialog and wait until the host lists and the catalog arrived. */
  const ready = async (): Promise<unknown> => {
    const root = await run();
    await vi.waitFor(() => expect(listRows(root).length).toBeGreaterThan(0));
    return root;
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
    layers,
    dialog,
    toast,
    keyInput,
    keyListeners,
    resizeListeners,
    renderer,
    modelList,
    providerList,
    catalog,
    refresh,
    memory,
    stopRpc,
    stopData,
    cleanup: () => {
      if (typeof cleanup === "function") void cleanup();
    },
    command,
    run,
    ready,
    press,
    current: () => open,
    setHostModels: (models: HostModel[]) => {
      hostModels = models;
    },
    setCurrentModel: (
      model: { providerID: string; modelID: string } | undefined,
    ) => {
      currentModel = model;
    },
    setTokens: (next: ReturnType<typeof surface>) => {
      tokens = next;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin definition and command", () => {
  it("shares the plugin ID with the server half", () => {
    expect(plugin.id).toBe(PLUGIN_ID);
  });

  it("registers /modelscout and /actualyze as global slash and palette commands without any I/O", () => {
    const h = harness();
    const layer = h.layers[0]?.();
    expect(layer?.mode).toBe("global");
    expect(layer?.commands).toHaveLength(2);
    expect(h.command()).toMatchObject({
      id: `${COMMAND_NAME}.show`,
      title: "Model Scout",
      slash: { name: COMMAND_NAME },
      palette: true,
    });
    const actualyze = layer?.commands?.[1];
    expect(actualyze).toMatchObject({
      id: "actualyze.show",
      title: "Actualyze",
      slash: { name: "actualyze" },
      palette: true,
    });
    expect(actualyze?.bind).toBeUndefined();
    expect(h.modelList).not.toHaveBeenCalled();
    expect(h.catalog).not.toHaveBeenCalled();
  });
});

describe("opening the dialog", () => {
  it("shows a loading state before the host lists answer, then fills in", async () => {
    const h = harness();
    const models = deferred<{ location: unknown; data: HostModel[] }>();
    h.modelList.mockReturnValueOnce(models.promise as never);
    const root = await h.run();
    expect(line(root, "modelscout-header")).toMatch(
      /^Model Scout .*○ loading$/,
    );
    expect(pane(root)).toContain("○ Reading models from OpenCode and scout…");

    models.resolve({ location: PROJECT, data: [hostModel()] });
    await vi.waitFor(() =>
      expect(listRows(root).some((row) => row.includes("Atlas Model"))).toBe(
        true,
      ),
    );
    expect(line(root, "modelscout-header")).toMatch(/1 provider · 1 model$/);
  });

  it("shows the dialog first and then sets its size and placement", async () => {
    const h = harness();
    await h.run();
    expect(h.dialog.set).toHaveBeenCalledWith({
      size: "xlarge",
      centered: true,
    });
    expect(h.dialog.show.mock.invocationCallOrder[0]).toBeLessThan(
      h.dialog.set.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("reads host rows and evidence for the plugin's location", async () => {
    const h = harness();
    await h.ready();
    expect(h.modelList).toHaveBeenCalledWith(
      { location: PROJECT },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(h.catalog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        location: PROJECT,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("falls back to the default location when the plugin has none", async () => {
    const h = harness({ location: undefined });
    await h.ready();
    expect(h.catalog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ location: { directory: "/default/project" } }),
    );
  });

  it("selects the prompt's current model on the first open", async () => {
    const h = harness();
    h.setHostModels([
      hostModel("a-first", "A First"),
      hostModel("z-current", "Z Current"),
    ]);
    h.setCurrentModel({ providerID: "atlas", modelID: "z-current" });
    const root = await h.ready();
    expect(listRows(root).find((row) => row.startsWith("▌"))).toMatch(
      /^▌● Z Current/,
    );
    expect(pane(root)).toContain("● Current model");
  });

  it("keeps the host rows and says why when scout's server half does not answer", async () => {
    const h = harness();
    h.catalog.mockRejectedValue({ type: "rpc.unavailable", message: "" });
    const root = await h.ready();
    expect(line(root, "modelscout-notice")).toBe(
      "▲ Discovery details unavailable: scout's server half did not answer. Showing OpenCode's model list.",
    );
    h.press({ name: "r" });
    expect(h.refresh).not.toHaveBeenCalled();
    expect(line(root, "modelscout-notice")).toContain(
      "Refresh needs scout's server half",
    );
    expect(h.toast.show).not.toHaveBeenCalled();
  });

  it("treats evidence that fails validation like a missing server half", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({ ...payload(), schemaVersion: 4 });
    const root = await h.ready();
    expect(line(root, "modelscout-notice")).toContain(
      "Discovery details unavailable: scout's answer failed validation",
    );
  });

  it("keeps the dialog open when the host lists fail, and r reads them again", async () => {
    const h = harness();
    h.modelList.mockRejectedValueOnce(new Error("service down"));
    const root = await h.run();
    await vi.waitFor(() =>
      expect(pane(root)).toContain("Could not load models from OpenCode."),
    );
    expect(pane(root)).toContain("service down");
    expect(h.toast.show).not.toHaveBeenCalled();

    h.press({ name: "r" });
    await vi.waitFor(() =>
      expect(listRows(root).some((row) => row.includes("Atlas Model"))).toBe(
        true,
      ),
    );
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("toasts when showing the dialog throws", async () => {
    const h = harness();
    h.dialog.show.mockImplementationOnce(() => {
      throw new Error("dialog unavailable");
    });
    await expect(h.command().run()).resolves.toBeUndefined();
    expect(h.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dialog unavailable" }),
    );
  });
});

describe("layout", () => {
  it("shows the detail pane beside the list from 120 columns and a summary line below", async () => {
    const h = harness();
    const root = await h.ready();
    expect(findNodeById(root, "modelscout-browser")?.props).toMatchObject({
      width: 116,
      height: 30,
    });
    expect(pane(root)).toContain("atlas/atlas-model");
    expect(visible(findNodeById(root, "modelscout-summary"))).toBe(false);

    h.resize(80, 24);
    expect(findNodeById(root, "modelscout-browser")?.props).toMatchObject({
      width: 78,
      height: 19,
    });
    expect(visible(findNodeById(root, "modelscout-pane"))).toBe(false);
    expect(line(root, "modelscout-summary")).toMatch(/^Atlas Model/);
    expect(listRows(root).every((row) => row.length <= 72)).toBe(true);
  });

  it("turns the narrow detail screen into the focused pane when the terminal widens", async () => {
    const h = harness({ terminalWidth: 80, terminalHeight: 24 });
    const root = await h.ready();
    h.press({ name: "down" });
    h.press({ name: "return" });
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(false);
    expect(pane(root)).toContain("atlas/atlas-model");

    h.resize(120, 36);
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(true);
    expect(line(root, "modelscout-footer")).toMatch(/^back backspace/);
  });

  it("keeps a scrolled detail where it was when the terminal crosses 120 columns", async () => {
    // 16 rows leave a 6-row body, shorter than the model's details.
    const h = harness({ terminalWidth: 120, terminalHeight: 16 });
    const root = await h.ready();
    h.press({ name: "down" });
    h.press({ name: "return" });
    for (let step = 0; step < 3; step += 1) h.press({ name: "down" });
    // The top row says how many lines are hidden above; the first shown line follows.
    expect(lines(root, "modelscout-pane")[0]).toBe("↑ 3 more");
    const first = (): string | undefined => lines(root, "modelscout-pane")[1];
    expect(first()).toMatch(/^Context/);

    h.resize(80, 16);
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(false);
    expect(first()).toMatch(/^Context/);

    h.resize(120, 16);
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(true);
    expect(first()).toMatch(/^Context/);
  });

  it("returns to the list when a reload removes the model a detail screen shows", async () => {
    const h = harness({ terminalWidth: 80, terminalHeight: 24 });
    h.setHostModels([
      hostModel("a-first", "A First"),
      hostModel("b-second", "B Second"),
    ]);
    const root = await h.ready();
    h.press({ name: "end" });
    h.press({ name: "d" });
    expect(pane(root)).toContain("atlas/b-second");

    h.setHostModels([hostModel("a-first", "A First")]);
    h.emitRpc("updated", { location: PROJECT, data: {} });
    await vi.waitFor(() =>
      expect(visible(findNodeById(root, "modelscout-list"))).toBe(true),
    );
    expect(pane(root)).not.toContain("atlas/a-first");
    expect(listRows(root).some((row) => row.includes("B Second"))).toBe(false);
  });

  it("keeps a detail screen open when a reload keeps its model", async () => {
    const h = harness({ terminalWidth: 80, terminalHeight: 24 });
    const root = await h.ready();
    h.press({ name: "down" });
    h.press({ name: "d" });
    h.emitRpc("updated", { location: PROJECT, data: {} });
    await vi.waitFor(() => expect(h.modelList).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(false);
    expect(pane(root)).toContain("Atlas Model · Evidence");
  });

  it("leaves no key or resize listener behind when the first paint throws", async () => {
    const h = harness();
    await h.command().run();
    const surfaceOf = h.context.theme.surface;
    let failed = false;
    h.context.theme.surface = () => {
      // The browser's first paint fails; the fallback after it paints.
      if (!failed) {
        failed = true;
        throw new Error("theme unavailable");
      }
      return surfaceOf();
    };
    h.current()?.render();
    expect(failed).toBe(true);
    expect(h.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "theme unavailable" }),
    );
    expect(h.keyListeners.size).toBe(0);
    expect(h.resizeListeners.size).toBe(0);
    expect(h.press({ name: "m" }).preventDefault).not.toHaveBeenCalled();
    expect(h.context.keymap.dispatch).not.toHaveBeenCalled();
  });

  it("re-reads the theme when it repaints", async () => {
    const h = harness();
    const root = await h.ready();
    h.setTokens(surface("text.base.light"));
    h.emitRpc("updated", { location: PROJECT, data: {} });
    await vi.waitFor(() => {
      const header = findNodeById(root, "modelscout-header")?.content as {
        chunks: Array<{ fg?: { name: string } }>;
      };
      expect(header.chunks[0]?.fg?.name).toBe("text.base.light");
    });
  });
});

describe("keys", () => {
  it("lets every printable key edit a focused search, and enter returns to the list", async () => {
    const h = harness();
    const root = await h.ready();
    const slash = h.press({ name: "/" });
    expect(slash.preventDefault).toHaveBeenCalled();
    expect(findNodeById(root, "modelscout-search")?.props?.focused).toBe(true);

    const typed = h.press({ name: "m" });
    expect(typed.preventDefault).not.toHaveBeenCalled();
    expect(h.context.keymap.dispatch).not.toHaveBeenCalled();

    const onInput = findNodeById(root, "modelscout-search")?.props?.onInput as (
      value: string,
    ) => void;
    onInput("nothing-matches");
    expect(pane(root)).toContain(
      'No models match "nothing-matches" with these filters.',
    );

    h.press({ name: "return" });
    expect(findNodeById(root, "modelscout-search")?.props?.focused).toBe(false);
    h.press({ name: "x" });
    expect(listRows(root).some((row) => row.includes("Atlas Model"))).toBe(
      true,
    );
    expect(findNodeById(root, "modelscout-search")?.props?.value).toBe("");
  });

  it("consumes m before opening the host model picker", async () => {
    const h = harness();
    await h.ready();
    const order: string[] = [];
    h.context.keymap.dispatch.mockImplementationOnce(() =>
      order.push("dispatch"),
    );
    h.press({ name: "m", preventDefault: () => order.push("consumed") });
    expect(order).toEqual(["consumed", "dispatch"]);
    expect(h.context.keymap.dispatch).toHaveBeenCalledWith("model.list");
  });

  it("does not open the picker for an embedding model", async () => {
    const h = harness();
    h.catalog.mockResolvedValue({
      ...payload(),
      providers: [
        providerRecord({
          models: [
            {
              ...providerRecord().models[0],
              modelType: knownScalar(
                "embedding",
                "provider-probe",
                "authoritative",
              ),
            },
          ],
        }),
      ],
    });
    const root = await h.run();
    await vi.waitFor(() =>
      expect(line(root, "modelscout-filters")).toContain("1 embedding hidden"),
    );
    h.press({ name: "f" });
    h.press({ name: "down" });
    h.press({ name: "left" });
    h.press({ name: "backspace" });
    h.press({ name: "down" });
    h.press({ name: "m" });
    expect(h.context.keymap.dispatch).not.toHaveBeenCalled();
    expect(line(root, "modelscout-notice")).toBe(
      "Embedding model; not in the chat picker",
    );
  });

  it("copies provider/model with y and the raw ID with Y", async () => {
    const h = harness();
    const root = await h.ready();
    h.press({ name: "down" });
    h.press({ name: "y" });
    expect(h.renderer.copyToClipboardOSC52).toHaveBeenLastCalledWith(
      "atlas/atlas-model",
    );
    expect(line(root, "modelscout-notice")).toBe(
      "Copy sent to terminal: atlas/atlas-model",
    );
    h.press({ name: "y", sequence: "Y", shift: true });
    expect(h.renderer.copyToClipboardOSC52).toHaveBeenLastCalledWith(
      "atlas-model",
    );
  });

  it("shows the whole text below the notice when the terminal does not accept OSC 52", async () => {
    const id = `atlas-${"x".repeat(90)}`;
    const h = harness({ terminalWidth: 80, terminalHeight: 24 });
    h.setHostModels([hostModel(id, "Long ID")]);
    const root = await h.ready();
    h.renderer.isOsc52Supported.mockReturnValue(false);
    h.press({ name: "down" });
    h.press({ name: "y" });
    expect(h.renderer.copyToClipboardOSC52).not.toHaveBeenCalled();
    expect(line(root, "modelscout-notice")).toBe(
      "Terminal copy (OSC 52) is unavailable; select the text below:",
    );
    const banner = lines(root, "modelscout-banner");
    expect(banner.join("")).toBe(`atlas/${id}`);
    expect(banner.every((part) => part.length <= 72)).toBe(true);
    // The list keeps the selection while the banner takes rows from it.
    expect(listRows(root).some((row) => row.startsWith("▌"))).toBe(true);
  });

  it("leaves a without an Actualyze hook unconsumed, and runs the hook when given", async () => {
    const h = harness();
    await openBrowser(h.context as unknown as Plugin.Context, { kind: "all" });
    h.current()?.render();
    await vi.waitFor(() => expect(h.modelList).toHaveBeenCalled());
    expect(h.press({ name: "a" }).preventDefault).not.toHaveBeenCalled();

    h.current()?.onClose?.();
    const actualyze = vi.fn();
    await openBrowser(
      h.context as unknown as Plugin.Context,
      { kind: "all" },
      { actualyze },
    );
    h.current()?.render();
    const event = h.press({ name: "a" });
    expect(actualyze).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("opens /actualyze in place of /modelscout when a is pressed", async () => {
    const h = harness();
    await h.ready();
    const before = h.dialog.show.mock.calls.length;
    const event = h.press({ name: "a" });
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(h.dialog.show.mock.calls.length).toBe(before + 1),
    );
    const root = h.current()?.render();
    expect(line(root, "modelscout-header")).toMatch(/^● ACTUALYZE/);
  });

  it("opens evidence with d and returns with backspace", async () => {
    const h = harness();
    const root = await h.ready();
    h.press({ name: "down" });
    h.press({ name: "d" });
    expect(pane(root)).toMatch(/Context +8,192 +probe/);
    expect(pane(root)).toMatch(/Max output +32,000 +OpenCode default/);
    h.press({ name: "backspace" });
    expect(visible(findNodeById(root, "modelscout-list"))).toBe(true);
  });
});

describe("navigation memory", () => {
  it("restores query and selection on the next open in the same location", async () => {
    const h = harness();
    h.setHostModels([
      hostModel("a-first", "A First"),
      hostModel("b-second", "B Second"),
    ]);
    const root = await h.ready();
    h.press({ name: "end" });
    h.press({ name: "s" });
    h.current()?.onClose?.();

    const again = await h.ready();
    expect(root).not.toBe(again);
    expect(listRows(again).find((row) => row.startsWith("▌"))).toMatch(
      /B Second/,
    );
    expect(line(again, "modelscout-filters")).toContain("sort context");
  });
});

describe("live updates", () => {
  it.each(["updated", "status"])(
    "reloads in place on the RPC %s event for the same location",
    async (name) => {
      const h = harness();
      const root = await h.ready();
      h.setHostModels([hostModel(), hostModel("atlas-new", "Atlas New")]);
      h.emitRpc(name, { location: PROJECT, data: {} });
      await vi.waitFor(() =>
        expect(listRows(root).some((row) => row.includes("Atlas New"))).toBe(
          true,
        ),
      );
    },
  );

  it("reloads on model.updated and ignores other or missing locations", async () => {
    const h = harness();
    await h.ready();
    h.emitRpc("updated", { location: { directory: "/elsewhere" }, data: {} });
    h.emitModelUpdated({ type: "model.updated" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.modelList).toHaveBeenCalledOnce();
    h.emitModelUpdated({ type: "model.updated", location: PROJECT });
    await vi.waitFor(() => expect(h.modelList).toHaveBeenCalledTimes(2));
  });

  it("coalesces a burst of events into one follow-up reload", async () => {
    const h = harness();
    await h.ready();
    for (let index = 0; index < 4; index++)
      h.emitRpc("status", { location: PROJECT, data: {} });
    await vi.waitFor(() => expect(h.modelList).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.modelList).toHaveBeenCalledTimes(3);
  });

  it("keeps the last rows and says so when a reload fails", async () => {
    const h = harness();
    const root = await h.ready();
    h.modelList.mockRejectedValueOnce(new Error("offline"));
    h.emitRpc("updated", { location: PROJECT, data: {} });
    await vi.waitFor(() =>
      expect(line(root, "modelscout-notice")).toBe(
        "▲ Update failed; showing the last result",
      ),
    );
    expect(listRows(root).some((row) => row.includes("Atlas Model"))).toBe(
      true,
    );
  });
});

describe("refresh keys", () => {
  it("refreshes the selected provider with r and every provider with R", async () => {
    const h = harness();
    const root = await h.ready();
    h.press({ name: "r" });
    await vi.waitFor(() =>
      expect(line(root, "modelscout-notice")).toBe("○ Refreshing Atlas…"),
    );
    expect(h.refresh).toHaveBeenLastCalledWith(
      { providerID: "atlas" },
      expect.objectContaining({ location: PROJECT }),
    );
    h.press({ name: "r", sequence: "R", shift: true });
    await vi.waitFor(() =>
      expect(h.refresh).toHaveBeenLastCalledWith({}, expect.anything()),
    );
  });

  it("counts down a throttled refresh from nextRefreshAt and generatedAt", async () => {
    const h = harness();
    const root = await h.ready();
    h.refresh.mockResolvedValueOnce({ accepted: false, reason: "throttled" });
    // The server clock runs an hour behind the client; only the offset counts.
    h.catalog.mockResolvedValue(
      payload(
        { nextRefreshAt: "2026-10-11T08:00:40.000Z" },
        "2026-10-11T08:00:00.000Z",
      ),
    );
    h.press({ name: "r" });
    await vi.waitFor(() =>
      expect(line(root, "modelscout-notice")).toBe(
        "Refresh skipped: Atlas was checked recently. Try again in 40 s.",
      ),
    );
  });

  it.each([
    [
      { accepted: false, reason: "no-targets" },
      "Refresh skipped: Atlas is not a discovery target",
    ],
  ])("explains a declined refresh", async (answer, notice) => {
    const h = harness();
    const root = await h.ready();
    h.refresh.mockResolvedValueOnce(answer);
    h.press({ name: "r" });
    await vi.waitFor(() =>
      expect(line(root, "modelscout-notice")).toBe(notice),
    );
  });

  it("explains a refresh that failed", async () => {
    const h = harness();
    const root = await h.ready();
    h.refresh.mockRejectedValueOnce({ type: "rpc.internal", message: "" });
    h.press({ name: "r" });
    await vi.waitFor(() =>
      expect(line(root, "modelscout-notice")).toBe(
        "▲ Refresh failed: scout's server half failed (rpc.internal)",
      ),
    );
  });
});

describe("dialog lifecycle", () => {
  it("removes its listeners, subscriptions, and timer once when the host closes it", async () => {
    const clear = vi.spyOn(globalThis, "clearInterval");
    const h = harness();
    await h.ready();
    expect(h.keyListeners.size).toBe(1);
    expect(h.resizeListeners.size).toBe(1);

    h.current()?.onClose?.();
    h.current()?.onClose?.();

    expect(h.keyListeners.size).toBe(0);
    expect(h.resizeListeners.size).toBe(0);
    expect(h.stopRpc).toHaveBeenCalledTimes(2);
    expect(h.stopData).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(h.dialog.clear).not.toHaveBeenCalled();
  });

  it("keeps one key listener when the host renders the dialog again", async () => {
    const h = harness();
    await h.ready();
    h.current()?.render();
    expect(h.keyListeners.size).toBe(1);
  });

  it("closes its own open dialog on plugin cleanup", async () => {
    const h = harness();
    await h.ready();
    h.cleanup();
    expect(h.dialog.clear).toHaveBeenCalledOnce();
    expect(h.keyListeners.size).toBe(0);
  });

  it("leaves a dialog that replaced its own alone on cleanup", async () => {
    const h = harness();
    await h.ready();
    h.context.ui.dialog.show(() => undefined);
    h.cleanup();
    expect(h.dialog.clear).not.toHaveBeenCalled();
  });

  it("does not open a dialog after cleanup ran during loading", async () => {
    const h = harness();
    const running = h.command().run();
    h.cleanup();
    await running;
    expect(h.dialog.show).not.toHaveBeenCalled();
    expect(h.stopRpc).toHaveBeenCalled();
  });

  it("falls back to flat content when the browser cannot be built", async () => {
    const h = harness();
    await h.command().run();
    h.keyInput.on.mockImplementationOnce(() => {
      throw new Error("key input unavailable");
    });
    const root = h.current()?.render();
    expect(h.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "key input unavailable" }),
    );
    const body = (node: unknown): MockNode | undefined => {
      const candidate = node as MockNode;
      if (
        candidate.tag === "text" &&
        typeof candidate.props?.content === "string" &&
        candidate.props.content.includes("(interactive browser unavailable)")
      )
        return candidate;
      for (const child of candidate.children ?? []) {
        const found = body(child);
        if (found) return found;
      }
      return undefined;
    };
    await vi.waitFor(() =>
      expect(body(root)?.props?.content).toContain("Atlas — 1 model"),
    );
    expect(body(root)?.props?.fg).toEqual(color("text.feedback.error.base"));
  });

  it("keeps forged provider and model strings on their fallback lines", async () => {
    const h = harness();
    h.setHostModels([
      hostModel("atlas-model\r\n  forged-standalone-row", "Atlas\u2028Forged"),
    ]);
    h.catalog.mockRejectedValue({ type: "rpc.unavailable", message: "" });
    await h.command().run();
    h.keyInput.on.mockImplementationOnce(() => {
      throw new Error("forced fallback\nForged Error — standalone line");
    });
    const root = h.current()?.render() as MockNode;
    const find = (node: MockNode): string | undefined => {
      const content = node.props?.content;
      if (
        typeof content === "string" &&
        content.includes("(interactive browser unavailable)")
      )
        return content;
      for (const child of node.children ?? []) {
        const found = find(child);
        if (found) return found;
      }
      return undefined;
    };
    await vi.waitFor(() =>
      expect(find(root)).toContain("forged-standalone-row"),
    );
    const content = find(root) ?? "";
    expect(content.replaceAll("\n", "")).not.toMatch(
      /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u,
    );
    const contentLines = content.split("\n");
    expect(contentLines).not.toContain("  forged-standalone-row");
    expect(contentLines).toContain("  atlas-model   forged-standalone-row");
  });

  it("toasts when OpenTUI cannot be loaded", async () => {
    vi.resetModules();
    vi.doMock("@opentui/solid", () => {
      throw new Error("opentui unavailable");
    });
    try {
      const fresh = (await import("../src/tui")).default;
      const h = harness();
      const layers: Array<() => Layer> = [];
      void fresh.setup({
        ...h.context,
        keymap: { layer: (factory: () => Layer) => layers.push(factory) },
      } as unknown as Plugin.Context);
      await layers[0]?.().commands?.[0]?.run();
      expect(h.dialog.show).not.toHaveBeenCalled();
      expect(h.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "error", title: "Model Scout" }),
      );
    } finally {
      vi.resetModules();
      vi.doMock("@opentui/solid", reconcilerMock);
    }
  });
});
