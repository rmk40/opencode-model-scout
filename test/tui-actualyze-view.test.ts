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

function line(root: unknown, id: string): string {
  return textOf(findNodeById(root, id)).trimEnd();
}

/** Let queued microtasks and pending continuations run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
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
  /** Unsubscribes of the session's fact events; four per session. */
  const stopFacts = vi.fn();
  const catalog = vi.fn(async (): Promise<unknown> => state.catalog);
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
      // The browser's own `model.updated` subscription is not a fact event.
      on: vi.fn((type: string) =>
        type === "model.updated" ? () => {} : stopFacts,
      ),
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
        catalog,
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
    stopFacts,
    catalog,
    copied: context.renderer.copyToClipboardOSC52,
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
    await settle();
    expect(h.dialog.clear).toHaveBeenCalledOnce();
    expect(h.current()).toBeUndefined();
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
    await settle();
    expect(h.dialog.clear).not.toHaveBeenCalled();
    expect(h.current()?.render()).toBe("other");
  });

  it("leaves a dialog that replaced the prompt in the same tick as the cleanup alone", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("k");
    h.dialog.clear.mockClear();
    // No await between: the prompt has settled, but its continuation has not run.
    h.dialog.show(() => "other");
    closeActualyze(h.plugin);
    await settle();
    expect(h.dialog.clear).not.toHaveBeenCalled();
    expect(h.current()?.render()).toBe("other");
    expect(h.toast.show).not.toHaveBeenCalled();
  });
});

describe("the key prompt's answer", () => {
  it("ends the session without showing the dialog again when the prompt is cancelled", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("k");
    const shows = h.dialog.show.mock.calls.length;
    h.submitPrompt(undefined);
    await settle();
    expect(h.dialog.show.mock.calls.length).toBe(shows);
    expect(h.stopFacts).toHaveBeenCalledTimes(4);
    expect(h.connectKey).not.toHaveBeenCalled();
  });

  it("ends the session when another dialog replaced the prompt, and leaves that dialog open", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("k");
    const shows = h.dialog.show.mock.calls.length;
    h.dialog.show(() => "other");
    await settle();
    expect(h.dialog.show.mock.calls.length).toBe(shows + 1);
    expect(h.current()?.render()).toBe("other");
    expect(h.stopFacts).toHaveBeenCalledTimes(4);
  });

  it("shows the dialog again unchanged after an empty answer", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    const before = pane(h.root());
    h.press("k");
    const shows = h.dialog.show.mock.calls.length;
    h.submitPrompt("   ");
    await vi.waitFor(() =>
      expect(h.dialog.show.mock.calls.length).toBe(shows + 1),
    );
    await vi.waitFor(() => expect(pane(h.root())).toBe(before));
    expect(h.connectKey).not.toHaveBeenCalled();
    expect(h.stopFacts).not.toHaveBeenCalled();
  });

  it("shows the save as unconfirmed when OpenCode does not answer within 15 s", async () => {
    const h = harness();
    h.connectKey.mockReturnValueOnce(new Promise<void>(() => {}));
    await openedAt(h, /Connect an Actualyze API key/);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await submitKey(h);
      await vi.waitFor(() =>
        expect(pane(h.root())).toMatch(/OpenCode is storing the key/),
      );
      await vi.advanceTimersByTimeAsync(14_000);
      expect(pane(h.root())).toMatch(/OpenCode is storing the key/);
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.waitFor(() =>
        expect(pane(h.root())).toMatch(
          /OpenCode did not confirm the key was saved/,
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("y", () => {
  it("copies the card's link on a card and the model ID in the list", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("y");
    expect(h.copied).toHaveBeenLastCalledWith(
      "https://app.actualyze.ai/account/settings?tab=security",
    );

    h.setState(READY);
    h.emitRpc("updated");
    await vi.waitFor(() => expect(rootHeight(h.root())).toBe(FULL_HEIGHT));
    h.press("y");
    expect(h.copied).toHaveBeenLastCalledWith("actualyze/claude-haiku");
  });
});

describe("a base URL that is not http(s)", () => {
  it("offers no links and never falls back to production", async () => {
    const h = harness({
      ...NO_KEY,
      hostProviders: [
        { ...actualyzeProvider, settings: { baseURL: "ftp://gw.example/v1" } },
      ],
    });
    await openedAt(h, /Connect an Actualyze API key/);
    await vi.waitFor(() =>
      expect(line(h.root(), "modelscout-header")).toMatch(
        /settings\.baseURL is not a URL/,
      ),
    );
    expect(pane(h.root())).not.toMatch(/https?:\/\//);
    expect(line(h.root(), "modelscout-footer")).not.toMatch(/copy link/);
    h.press("y");
    h.press("l");
    await vi.waitFor(() => expect(pane(h.root())).toMatch(/No app links/));
    h.press("y");
    h.press("return");
    expect(h.copied).not.toHaveBeenCalled();
    expect(pane(h.root())).not.toMatch(/app\.actualyze\.ai/);
  });
});

describe("a save that completes after the location changed", () => {
  it("ends the session and closes its dialog after a confirmed save", async () => {
    const h = harness();
    const save = deferred<void>();
    h.connectKey.mockReturnValueOnce(save.promise);
    await openedAt(h, /Connect an Actualyze API key/);
    await submitKey(h);
    await vi.waitFor(() =>
      expect(pane(h.root())).toMatch(/OpenCode is storing the key/),
    );

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
    await vi.waitFor(() =>
      expect(pane(h.root())).toMatch(/Actualyze app links/),
    );
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

describe("status line", () => {
  const chunks = (root: unknown): Array<{ text: string; fg?: unknown }> => {
    const content = findNodeById(root, "modelscout-status")?.content;
    return content && typeof content === "object" && "chunks" in content
      ? (content as { chunks: Array<{ text: string; fg?: unknown }> }).chunks
      : [];
  };

  it("colors only the glyph and writes the headline in base", async () => {
    const h = harness({
      ...READY,
      catalog: payload(
        record({
          lastGoodAt: null,
          models: [],
          failure: { kind: "unauthorized", at: AT, httpStatus: 401 },
        }),
      ),
      hostModels: [],
    });
    await openedAt(h, /Actualyze did not accept this key/);
    const [glyph, headline] = chunks(h.root());
    expect(glyph).toMatchObject({ text: "▲", fg: { name: "error" } });
    expect(headline).toMatchObject({
      text: " Key rejected (401)",
      fg: { name: "text.base" },
    });
  });

  it("counts the chat models the list shows, not hidden embeddings", async () => {
    const embedding: HostModel = {
      ...hostModel,
      id: "embed",
      name: "Embed",
      capabilities: { tools: false, input: ["text"], output: ["embedding"] },
    };
    const h = harness({
      ...READY,
      catalog: payload(
        record({
          models: [
            modelRecord,
            {
              ...modelRecord,
              id: "embed",
              modelType: knownScalar("embedding", "provider-probe", "reported"),
            },
          ],
        }),
      ),
      hostModels: [hostModel, embedding],
    });
    await h.open();
    await vi.waitFor(() =>
      expect(line(h.root(), "modelscout-status")).toMatch(
        /^● Catalog accessible · key "Laptop" · 1 model · checked/,
      ),
    );
  });
});

describe("copy notice", () => {
  it("wraps a copied link onto the rows below instead of cutting it", async () => {
    const h = harness();
    h.context.renderer.terminalWidth = 80;
    await openedAt(h, /Connect an Actualyze API key/);
    h.press("y");
    const url = "https://app.actualyze.ai/account/settings?tab=security";
    expect(line(h.root(), "modelscout-notice")).toBe("Copy sent to terminal:");
    const banner = findNodeById(h.root(), "modelscout-banner");
    const shown = (banner?.children ?? [])
      .filter(visible)
      .map((child) => textOf(child).trimEnd());
    expect(shown).toContain(url);
  });
});

describe("small terminals", () => {
  const size = (h: Harness, columns: number, rows: number): void => {
    h.context.renderer.terminalWidth = columns;
    h.context.renderer.terminalHeight = rows;
  };
  const shownLines = (root: unknown, id: string): string[] =>
    (findNodeById(root, id)?.children ?? [])
      .filter(visible)
      .map((child) => textOf(child).trimEnd());

  it("shows the text to select when OSC 52 is unavailable, even at 80x16", async () => {
    const h = harness(READY);
    size(h, 80, 16);
    h.context.renderer.isOsc52Supported.mockReturnValue(false);
    await h.open();
    await vi.waitFor(() =>
      expect(line(h.root(), "modelscout-status")).toMatch(/Catalog accessible/),
    );
    h.press("y");
    expect(line(h.root(), "modelscout-notice")).toMatch(
      /select the text below/,
    );
    expect(shownLines(h.root(), "modelscout-banner")).toContain(
      "actualyze/claude-haiku",
    );
  });

  it("scrolls an overflowing card with the movement keys and says so in the footer", async () => {
    const h = harness();
    size(h, 80, 20);
    await openedAt(h, /Connect an Actualyze API key/);
    const footer = (): string => line(h.root(), "modelscout-footer");
    expect(footer()).toMatch(/^scroll ↑↓ {2}connect key k/);
    const before = pane(h.root()).split("\n");
    expect(before.at(-1)).toMatch(/^↓ \d+ more$/);
    const down = h.press("down");
    expect(down.preventDefault).toHaveBeenCalled();
    const after = pane(h.root()).split("\n");
    expect(after[0]).toMatch(/^↑ /);
    h.press("end");
    expect(pane(h.root())).toMatch(/background service\./);
    h.press("?");
    expect(pane(h.root())).toMatch(
      /scroll the card when it runs past the dialog/,
    );
  });

  it("leaves the movement keys alone and the footer quiet when the card fits", async () => {
    const h = harness();
    await openedAt(h, /Connect an Actualyze API key/);
    expect(line(h.root(), "modelscout-footer")).not.toMatch(/scroll/);
    expect(h.press("down").preventDefault).not.toHaveBeenCalled();
  });

  it("reaches every line of the key list at 80x16", async () => {
    /** Every row the key list shows while scrolling from top to end. */
    const scrolled = async (rows: number): Promise<Set<string>> => {
      const h = harness(READY);
      size(h, 80, rows);
      await h.open();
      await vi.waitFor(() =>
        expect(line(h.root(), "modelscout-status")).toMatch(
          /Catalog accessible/,
        ),
      );
      h.press("?");
      const seen = new Set<string>();
      for (let step = 0; step < 80; step += 1) {
        for (const row of pane(h.root()).split("\n"))
          if (!/^[↑↓] /.test(row)) seen.add(row);
        h.press("down");
      }
      return seen;
    };
    // At 80x40 every entry fits whole between the indicators, so scrolling
    // shows every line; the same width wraps the same lines at 80x16.
    const reference = await scrolled(40);
    const small = await scrolled(16);
    expect(reference.size).toBeGreaterThan(10);
    for (const row of reference) expect(small).toContain(row);
  });
});

describe("card action row", () => {
  const revoked: State = {
    ...READY,
    catalog: payload(
      record({
        lastGoodAt: null,
        models: [],
        failure: { kind: "unauthorized", at: AT, httpStatus: 401 },
      }),
    ),
    hostModels: [],
  };

  it("is left out when the footer fits every key", async () => {
    const h = harness(revoked);
    await openedAt(h, /Actualyze did not accept this key/);
    const card = pane(h.root()).split("\n");
    // Title and body only; no spacer, no action row.
    expect(card.at(-1)).toMatch(/Actualyze environment\.$/);
    expect(line(h.root(), "modelscout-footer")).toMatch(
      /^another key k {2}retry r {2}copy link y {2}links l {2}connections c {2}all providers b {2}keys \?/,
    );
  });

  it("lists only the keys the footer cannot fit, in footer order", async () => {
    const h = harness(revoked);
    h.context.renderer.terminalWidth = 80;
    h.context.renderer.terminalHeight = 24;
    await openedAt(h, /Actualyze did not accept this key/);
    const footer = line(h.root(), "modelscout-footer");
    expect(footer).toMatch(
      /^another key k {2}retry r {2}copy link y {2}links l {2}keys \?/,
    );
    const card = pane(h.root()).split("\n");
    expect(card.at(-2)).toBe("▌");
    expect(card.at(-1)).toBe("▌ connections c  all providers b");
    expect(footer).not.toMatch(/connections|all providers/);
  });

  it("titles the empty card Empty catalog, apart from the status line", async () => {
    const h = harness({
      ...READY,
      catalog: payload(record({ models: [] })),
      hostModels: [],
    });
    await openedAt(h, /Empty catalog/);
    expect(line(h.root(), "modelscout-status")).toMatch(
      /^▲ No models for this key/,
    );
    expect(pane(h.root())).not.toMatch(/No models for this key/);
  });
});

describe("key list at 80x24", () => {
  it("scrolls by whole entries and counts entries in its more lines", async () => {
    const h = harness(READY);
    h.context.renderer.terminalWidth = 80;
    h.context.renderer.terminalHeight = 24;
    await h.open();
    await vi.waitFor(() =>
      expect(line(h.root(), "modelscout-status")).toMatch(/Catalog accessible/),
    );
    h.press("?");
    /** Entries shown (rows that start with a key) and the hidden counts. */
    const read = () => {
      const rows = pane(h.root())
        .split("\n")
        .filter((row) => row.length > 0);
      const count = (pattern: RegExp): number =>
        Number(pattern.exec(rows.join("\n"))?.[1] ?? 0);
      const body = rows.filter(
        (row, index) => index > 0 && !/^[↑↓] \d+ more$/.test(row),
      );
      return {
        rows,
        shown: body.filter((row) => /^\S/.test(row)).length,
        above: count(/^↑ (\d+) more$/m),
        below: count(/^↓ (\d+) more$/m),
      };
    };
    /** The "/" entry wraps to two lines; it never shows without its second. */
    const whole = (rows: string[]): boolean => {
      const search = rows.findIndex((row) => /^\/ +search name/.test(row));
      return search < 0 || /returns to the list/.test(rows[search + 1] ?? "");
    };

    const top = read();
    expect(top.rows[0]).toMatch(/^Keys · Actualyze/);
    expect(top.below).toBeGreaterThan(0);
    expect(whole(top.rows)).toBe(true);

    for (let step = 0; step < 3; step += 1) h.press("down");
    const middle = read();
    expect(middle.rows[0]).toMatch(/^Keys · Actualyze/);
    expect(middle.above).toBe(3);
    expect(whole(middle.rows)).toBe(true);

    h.press("end");
    const end = read();
    expect(end.below).toBe(0);
    expect(whole(end.rows)).toBe(true);
    // Counts are entries: every view accounts for the same entries.
    const total = top.shown + top.below;
    expect(middle.above + middle.shown + middle.below).toBe(total);
    expect(end.above + end.shown).toBe(total);
  });
});

describe("cards", () => {
  it("offers retry r on the server-unavailable card and reads the catalog again with it", async () => {
    const h = harness();
    h.catalog.mockRejectedValue({ type: "rpc.unavailable", message: "down" });
    await openedAt(h, /server half did not answer/);
    expect(line(h.root(), "modelscout-footer")).toMatch(/retry r/);
    const reads = h.catalog.mock.calls.length;
    const event = h.press("r");
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.catalog.mock.calls.length).toBe(reads + 1));
  });

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
    // The pane shows the card's lines and nothing more; the body adds the
    // one blank row before the footer.
    expect(card.at(-1)).not.toBe("");
    const body = findNodeById(h.root(), "modelscout-body")?.props?.height;
    expect(body).toBe(card.length + 1);

    h.setState(READY);
    h.emitRpc("updated");
    await vi.waitFor(() => expect(rootHeight(h.root())).toBe(FULL_HEIGHT));

    h.setState(NO_KEY);
    h.emitRpc("updated");
    await vi.waitFor(() => expect(rootHeight(h.root())).toBe(cardHeight));
  });
});
