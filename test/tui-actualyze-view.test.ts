import { afterEach, describe, expect, it, vi } from "vitest";

// The reconciler needs a live renderer; the mock records the
// createElement/setProp/insert calls the plugin makes, and the core mock
// stands in for StyledText.
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
import { closeActualyze, openActualyze } from "../src/tui-actualyze-view";
import type { HostModel, HostProvider } from "../src/tui-models";

interface MockNode {
  props?: Record<string, unknown>;
  children?: MockNode[];
  content?: unknown;
}

const PROJECT = { directory: "/work/project" };
const AT = "2026-10-17T08:00:00.000Z";
/** Content rows of the dialog at 120x36: `min(30, rows - 4)`. */
const FULL_HEIGHT = 30;

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

function textOf(node: MockNode | undefined): string {
  const content = node?.content;
  if (content && typeof content === "object" && "chunks" in content)
    return (content as { chunks: Array<{ text: string }> }).chunks
      .map((chunk) => chunk.text)
      .join("");
  return "";
}

function visible(node: MockNode | undefined): boolean {
  return node?.props?.visible !== false;
}

function pane(root: unknown): string {
  const box = findNodeById(root, "modelscout-pane");
  if (!visible(box)) return "";
  return (box?.children ?? [])
    .filter(visible)
    .map((child) => textOf(child).trimEnd())
    .join("\n");
}

function rootHeight(root: unknown): unknown {
  return findNodeById(root, "modelscout-browser")?.props?.height;
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

function surface() {
  return {
    text: {
      base: color("text.base"),
      muted: color("text.muted"),
      action: { primary: stateful("text.action.primary") },
      formfield: stateful("text.formfield"),
      feedback: {
        success: { base: color("success") },
        warning: { base: color("warning") },
        error: { base: color("error") },
        info: { base: color("info") },
      },
    },
    background: {
      action: { primary: stateful("background.action.primary") },
      formfield: stateful("background.formfield"),
    },
    border: { base: color("border.base") },
  };
}

const actualyzeProvider: HostProvider = {
  id: "actualyze",
  name: "Actualyze",
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: "https://app.actualyze.ai/openai/v1" },
};

const hostModel: HostModel = {
  id: "claude-haiku",
  providerID: "actualyze",
  name: "Claude Haiku",
  enabled: true,
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  cost: [],
  limit: { context: 200_000, output: 64_000 },
};

const modelRecord: CatalogModelRecord = {
  id: "claude-haiku",
  origin: "discovered",
  enabled: true,
  identity: knownScalar("claude-haiku", "server-list", "reported"),
  name: unknownScalar(),
  modelType: unknownScalar(),
  context: knownScalar(200_000, "provider-probe", "authoritative"),
  output: knownScalar(64_000, "provider-probe", "authoritative"),
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
};

function record(
  overrides: Partial<CatalogProviderRecord> = {},
): CatalogProviderRecord {
  return {
    id: "actualyze",
    endpointOrigin: knownScalar(
      "https://app.actualyze.ai",
      "pre-existing",
      "configured",
    ),
    configuredProbe: knownScalar("actualyze", "pre-existing", "configured"),
    resolvedProbe: knownScalar("actualyze", "provider-probe", "reported"),
    lastGoodAt: AT,
    failure: null,
    modelListAttempt: "ready",
    probeAttempt: "complete",
    skippedModelIds: [],
    models: [modelRecord],
    discovering: false,
    lastAttemptAt: AT,
    nextRefreshAt: null,
    credentialSource: "connection",
    credentialEpoch: 1,
    resultEpoch: 1,
    ...overrides,
  };
}

function payload(
  provider: CatalogProviderRecord | undefined,
  builtIn: "managed" | "foreign" = "managed",
): CatalogPayload {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    packageVersion: "2.0.0",
    instanceID: "instance",
    generatedAt: AT,
    status: "complete",
    completedAt: AT,
    builtIn: { actualyze: builtIn },
    providers: provider ? [provider] : [],
  };
}

interface Entry {
  render: () => unknown;
  onClose?: () => void;
  prompt?: true;
}

interface State {
  connected: boolean;
  catalog: CatalogPayload;
  hostProviders: HostProvider[];
  hostModels: HostModel[];
}

const NO_KEY: State = {
  connected: false,
  catalog: payload(undefined),
  hostProviders: [],
  hostModels: [],
};

const READY: State = {
  connected: true,
  catalog: payload(record()),
  hostProviders: [actualyzeProvider],
  hostModels: [hostModel],
};

function harness(initial: State = NO_KEY) {
  let state = initial;
  let open: Entry | undefined;
  let root: unknown;
  let resolvePrompt: ((value: string | undefined) => void) | undefined;
  /** The host closes whatever it replaces before showing the next dialog. */
  const replace = (entry: Entry | undefined): void => {
    const previous = open;
    open = undefined;
    previous?.onClose?.();
    open = entry;
  };
  const dialog = {
    show: vi.fn((render: () => unknown, onClose?: () => void) => {
      replace({ render, ...(onClose ? { onClose } : {}) });
      root = render();
    }),
    set: vi.fn(),
    clear: vi.fn(() => replace(undefined)),
    prompt: vi.fn(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolvePrompt = resolve;
          replace({
            render: () => null,
            onClose: () => resolve(undefined),
            prompt: true,
          });
        }),
    ),
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
  const rpcHandlers = new Map<string, Set<(event: unknown) => void>>();
  const connectKey = vi.fn(
    async (_input: unknown, _options: unknown): Promise<void> => undefined,
  );
  const dispatch = vi.fn();
  const integration = () => ({
    id: "actualyze",
    name: "Actualyze",
    methods: [{ type: "key" }, { type: "env", names: ["ACTUALYZE_API_KEY"] }],
    connections: state.connected
      ? [{ type: "credential", id: "c1", label: "Laptop", method: "key" }]
      : [],
  });
  const memories = new Map<
    string,
    readonly [object, (fn: (draft: object) => void) => void]
  >();
  const context = {
    location: PROJECT as { directory: string },
    data: {
      on: vi.fn(() => () => {}),
      location: {
        default: () => PROJECT,
        integration: {
          sync: vi.fn(async () => {}),
          list: vi.fn(() => [integration()]),
          invalidate: vi.fn(),
        },
        provider: {
          sync: vi.fn(async () => {}),
          list: vi.fn(() => state.hostProviders),
          invalidate: vi.fn(),
        },
      },
    },
    client: {
      rpc: vi.fn(() => ({
        catalog: vi.fn(async () => state.catalog),
        refresh: vi.fn(async () => ({ accepted: true })),
        events: {
          on: vi.fn((name: string, handler: (event: unknown) => void) => {
            const set = rpcHandlers.get(name) ?? new Set();
            set.add(handler);
            rpcHandlers.set(name, set);
            return () => set.delete(handler);
          }),
        },
      })),
      model: {
        list: vi.fn(async (input: { location: unknown }) => ({
          location: input.location,
          data: state.hostModels,
        })),
      },
      provider: {
        list: vi.fn(async (input: { location: unknown }) => ({
          location: input.location,
          data: state.hostProviders,
        })),
      },
      integration: { connect: { key: connectKey } },
    },
    ui: { dialog, toast, model: { current: () => undefined } },
    keymap: { dispatch },
    storage: {
      memory: vi.fn((key: string, input: { initial: object }) => {
        const existing = memories.get(key);
        if (existing) return existing;
        const value = structuredClone(input.initial);
        const entry = [
          value,
          (fn: (draft: object) => void) => fn(value),
        ] as const;
        memories.set(key, entry);
        return entry;
      }),
    },
    renderer: {
      terminalWidth: 120,
      terminalHeight: 36,
      keyInput,
      on: vi.fn(),
      off: vi.fn(),
      copyToClipboardOSC52: vi.fn(() => true),
      isOsc52Supported: vi.fn(() => true),
    },
    theme: { surface },
    themeMode: "dark",
  };
  const plugin = context as unknown as Plugin.Context;
  const openModelScout = vi.fn();

  return {
    context,
    plugin,
    dialog,
    toast,
    connectKey,
    dispatch,
    openModelScout,
    root: () => root,
    current: () => open,
    open: () => openActualyze(plugin, { openModelScout }),
    setState: (next: State) => {
      state = next;
    },
    emitRpc: (name: string) => {
      for (const handler of rpcHandlers.get(name) ?? [])
        handler({ location: PROJECT });
    },
    submitPrompt: (value: string | undefined) => resolvePrompt?.(value),
    press: (name: string) => {
      const event = {
        name,
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        super: false,
        hyper: false,
        sequence: name.length === 1 ? name : "",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      for (const listener of [...keyListeners]) listener(event);
      return event;
    },
  };
}

type Harness = ReturnType<typeof harness>;

async function openedAt(h: Harness, text: string | RegExp): Promise<void> {
  await h.open();
  await vi.waitFor(() => expect(pane(h.root())).toMatch(text));
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

/** Press k, submit a key, and wait until the dialog shows again. */
async function submitKey(h: Harness): Promise<void> {
  h.press("k");
  expect(h.dialog.prompt).toHaveBeenCalledOnce();
  const shows = h.dialog.show.mock.calls.length;
  h.submitPrompt("aai_pat_test");
  await vi.waitFor(() =>
    expect(h.dialog.show.mock.calls.length).toBe(shows + 1),
  );
  expect(h.connectKey).toHaveBeenCalledOnce();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin unload while the key prompt is open", () => {
  it("closes the prompt, saves nothing, and shows nothing again", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("k");
    expect(h.current()?.prompt).toBe(true);
    const shows = h.dialog.show.mock.calls.length;

    closeActualyze(h.plugin);
    expect(h.dialog.clear).toHaveBeenCalledOnce();
    expect(h.current()).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.connectKey).not.toHaveBeenCalled();
    expect(h.dialog.show.mock.calls.length).toBe(shows);
    expect(h.toast.show).not.toHaveBeenCalled();
  });

  it("says a key submitted as the plugin unloaded was not saved", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("k");
    // The host has not closed the prompt yet when the answer arrives.
    h.dialog.clear.mockImplementationOnce(() => {});
    closeActualyze(h.plugin);
    h.submitPrompt("aai_pat_test");
    await vi.waitFor(() => expect(h.toast.show).toHaveBeenCalledOnce());
    expect(h.toast.show.mock.calls[0]?.[0]).toMatchObject({
      variant: "warning",
      message: expect.stringContaining("not saved"),
    });
    expect(JSON.stringify(h.toast.show.mock.calls)).not.toContain(
      "aai_pat_test",
    );
    expect(h.connectKey).not.toHaveBeenCalled();
  });

  it("leaves a dialog that replaced the prompt alone", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("k");
    h.dialog.show(() => "other");
    await Promise.resolve();
    h.dialog.clear.mockClear();
    closeActualyze(h.plugin);
    expect(h.dialog.clear).not.toHaveBeenCalled();
    expect(h.current()?.render()).toBe("other");
  });
});

describe("a save that completes after the location changed", () => {
  it("ends the session and closes its dialog after a confirmed save", async () => {
    const h = harness();
    const save = deferred<void>();
    h.connectKey.mockReturnValueOnce(save.promise);
    await openedAt(h, /Connect an Actualyze API key/);
    await submitKey(h);
    await vi.waitFor(() => expect(pane(h.root())).toMatch(/Saving key/));

    h.context.location = { directory: "/elsewhere" };
    h.dialog.clear.mockClear();
    save.resolve();
    await vi.waitFor(() => expect(h.dialog.clear).toHaveBeenCalledOnce());
    expect(h.current()).toBeUndefined();
    expect(h.toast.show).not.toHaveBeenCalled();
  });

  it("ends the session, closes its dialog, and warns after an unconfirmed save", async () => {
    const h = harness();
    const save = deferred<void>();
    h.connectKey.mockReturnValueOnce(save.promise);
    await openedAt(h, /Connect an Actualyze API key/);
    await submitKey(h);

    h.context.location = { directory: "/elsewhere" };
    h.dialog.clear.mockClear();
    save.reject(new Error("socket hang up"));
    await vi.waitFor(() => expect(h.toast.show).toHaveBeenCalledOnce());
    expect(h.dialog.clear).toHaveBeenCalledOnce();
    expect(h.current()).toBeUndefined();
    expect(h.toast.show.mock.calls[0]?.[0]).toMatchObject({
      variant: "warning",
      message: "OpenCode did not confirm the Actualyze key was saved",
    });
  });

  it("does not close a dialog that replaced its own", async () => {
    const h = harness();
    const save = deferred<void>();
    h.connectKey.mockReturnValueOnce(save.promise);
    await openedAt(h, /Connect an Actualyze API key/);
    await submitKey(h);
    h.dialog.show(() => "other");

    h.context.location = { directory: "/elsewhere" };
    h.dialog.clear.mockClear();
    save.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.dialog.clear).not.toHaveBeenCalled();
    expect(h.current()?.render()).toBe("other");
  });
});

describe("keys under a card", () => {
  it("leaves k and c alone on a card that does not offer them", async () => {
    const h = harness({
      ...READY,
      catalog: payload(undefined, "foreign"),
    });
    await openedAt(h, /Another plugin or a models\.dev catalog/);
    const k = h.press("k");
    expect(h.dialog.prompt).not.toHaveBeenCalled();
    expect(k.preventDefault).not.toHaveBeenCalled();
    // `c` is listed on this card.
    h.press("c");
    expect(h.dispatch).toHaveBeenCalledWith("provider.connect");
  });

  it("leaves k and c alone on the links screen", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("l");
    await vi.waitFor(() => expect(pane(h.root())).toMatch(/Links ·/));
    h.press("k");
    h.press("c");
    expect(h.dialog.prompt).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    h.press("b");
    expect(h.openModelScout).toHaveBeenCalledOnce();
  });

  it("runs k and c on the no-key card, which lists both", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("c");
    expect(h.dispatch).toHaveBeenCalledWith("provider.connect");
  });
});

describe("cards", () => {
  it("explains a 403 without guessing its cause", async () => {
    const h = harness({
      ...READY,
      catalog: payload(
        record({
          lastGoodAt: null,
          models: [],
          failure: { kind: "forbidden", at: AT, httpStatus: 403 },
        }),
      ),
      hostModels: [],
    });
    await openedAt(h, /refused the model list request/);
    const text = pane(h.root());
    expect(text).toMatch(/permissions and model access/);
    expect(text).not.toMatch(/read-only/i);
  });

  it("sizes the dialog to a card and grows it to full height for the list, and back", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    const cardHeight = rootHeight(h.root());
    expect(typeof cardHeight).toBe("number");
    expect(cardHeight as number).toBeLessThan(FULL_HEIGHT);
    const card = pane(h.root()).split("\n");
    // The card's lines, one spacer row, and no padding beyond them.
    expect(card.at(-1)).toBe("");
    expect(card.at(-2)).not.toBe("");

    h.setState(READY);
    h.emitRpc("updated");
    await vi.waitFor(() => expect(rootHeight(h.root())).toBe(FULL_HEIGHT));

    h.setState(NO_KEY);
    h.emitRpc("updated");
    await vi.waitFor(() => expect(rootHeight(h.root())).toBe(cardHeight));
  });
});
