import { afterEach, describe, expect, it, vi } from "vitest";

// The reconciler needs a live renderer; the mock records the same
// createElement/setProp/insert calls the plugin makes against OpenTUI.
const { reconcilerMock } = vi.hoisted(() => ({
  reconcilerMock: () => ({
    createElement: (tag: string) => ({
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
}));
vi.mock("@opentui/solid", reconcilerMock);

import type { Plugin } from "@opencode/plugin/tui";
import {
  CATALOG_SCHEMA_VERSION,
  knownScalar,
  unknownCapability,
  unknownScalar,
  type CatalogPayload,
} from "../src/catalog-evidence";
import { COMMAND_NAME, PLUGIN_ID } from "../src/constants";
import plugin from "../src/tui";
import type { HostModel, HostProvider } from "../src/tui-models";

type MockNode = {
  tag?: string;
  props?: Record<string, unknown>;
  children?: unknown[];
};

interface Command {
  id?: string;
  title?: string;
  palette?: true;
  slash?: { name: string };
  run: () => void | false | Promise<void>;
}

interface Layer {
  mode?: string;
  commands?: readonly Command[];
}

const PROJECT = { directory: "/work/project" };

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

function color(name: string) {
  return { name };
}

const tokens = {
  text: {
    base: color("text.base"),
    muted: color("text.muted"),
    feedback: { error: { base: color("text.feedback.error.base") } },
    action: { primary: { focused: color("text.action.primary.focused") } },
  },
  background: {
    base: color("background.base"),
    raised: { high: color("background.raised.high") },
    action: {
      primary: { focused: color("background.action.primary.focused") },
    },
  },
  hue: { accent: { 200: color("hue.accent.200") } },
};

const atlasProvider: HostProvider = {
  id: "atlas",
  name: "Atlas",
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: "https://atlas.test/openai/v1" },
};

function hostModel(id = "atlas-model", name = "Atlas Model"): HostModel {
  return {
    id,
    providerID: "atlas",
    name,
    enabled: true,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    cost: [],
    limit: { context: 8192, output: 32_000 },
  };
}

function payload(
  status: CatalogPayload["status"] = "complete",
): CatalogPayload {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    packageVersion: "2.0.0",
    status,
    ...(status === "complete"
      ? { completedAt: "2026-10-11T08:00:00.000Z" }
      : { startedAt: "2026-10-11T08:00:00.000Z" }),
    providers: [
      {
        id: "atlas",
        endpointOrigin: knownScalar(
          "https://atlas.test",
          "pre-existing",
          "configured",
        ),
        configuredProbe: unknownScalar(),
        resolvedProbe: knownScalar("actualyze", "provider-probe", "reported"),
        lastGoodAt: "2026-10-11T08:00:00.000Z",
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
      },
    ],
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
  const rpcHandlers = new Set<(event: unknown) => void>();
  const stopRpc = vi.fn();
  const on = vi.fn((_name: string, handler: (event: unknown) => void) => {
    rpcHandlers.add(handler);
    return () => {
      stopRpc();
      rpcHandlers.delete(handler);
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
    ui: { dialog, toast },
    keymap: { layer: (factory: () => Layer) => layers.push(factory) },
    renderer: {
      terminalWidth: options.terminalWidth ?? 140,
      terminalHeight: options.terminalHeight ?? 40,
      keyInput,
    },
    theme: { surface: () => tokens },
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
  const press = (key: Record<string, unknown>) => {
    const event = {
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      super: false,
      hyper: false,
      sequence: "",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...key,
    };
    for (const listener of keyListeners) listener(event);
  };

  return {
    context,
    layers,
    dialog,
    toast,
    keyInput,
    keyListeners,
    modelList,
    providerList,
    catalog,
    refresh,
    stopRpc,
    stopData,
    cleanup: () => {
      if (typeof cleanup === "function") void cleanup();
    },
    command,
    run,
    press,
    current: () => open,
    setHostModels: (models: HostModel[]) => {
      hostModels = models;
    },
    emitRpc: (event: unknown) => {
      for (const handler of rpcHandlers) handler(event);
    },
    emitModelUpdated: (event: unknown) => {
      for (const handler of modelHandlers) handler(event);
    },
  };
}

function summary(root: unknown): string {
  return findNodeById(root, "modelscout-summary")?.props?.content as string;
}

function openDetail(root: unknown, index: number): string {
  const results = findNodeById(root, "modelscout-results");
  (results?.props?.onSelect as (index: number) => void)(index);
  return findNodeById(root, "modelscout-detail-text")?.props?.content as string;
}

function optionNames(root: unknown): string[] {
  const options = findNodeById(root, "modelscout-results")?.props
    ?.options as Array<{ name: string }>;
  return options.map((option) => option.name);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin definition and command", () => {
  it("shares the plugin ID with the server half", () => {
    expect(plugin.id).toBe(PLUGIN_ID);
  });

  it("registers one global slash and palette command without any I/O", () => {
    const h = harness();
    expect(h.layers).toHaveLength(1);
    const layer = h.layers[0]?.();
    expect(layer?.mode).toBe("global");
    expect(layer?.commands).toHaveLength(1);
    expect(h.command()).toMatchObject({
      id: `${COMMAND_NAME}.show`,
      title: "Model Scout",
      slash: { name: COMMAND_NAME },
      palette: true,
    });
    expect(h.modelList).not.toHaveBeenCalled();
    expect(h.catalog).not.toHaveBeenCalled();
  });
});

describe("opening the dialog", () => {
  it("reads host rows and evidence for the plugin's location", async () => {
    const h = harness();
    await h.run();
    expect(h.modelList).toHaveBeenCalledWith(
      { location: PROJECT },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(h.providerList).toHaveBeenCalledWith(
      { location: PROJECT },
      expect.anything(),
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
    await h.run();
    expect(h.catalog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ location: { directory: "/default/project" } }),
    );
  });

  it("shows the dialog first and sizes it afterwards", async () => {
    const h = harness();
    await h.run();
    expect(h.dialog.set).toHaveBeenCalledWith({ size: "xlarge" });
    expect(h.dialog.show.mock.invocationCallOrder[0]).toBeLessThan(
      h.dialog.set.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("renders server evidence next to host rows", async () => {
    const h = harness();
    const root = await h.run();
    const detail = openDetail(root, 1);
    expect(detail).toContain("Model ID: atlas-model [server]");
    expect(detail).toContain("Context: 8K [probe]");
    expect(detail).toContain("Max output: 32K [host default]");
    expect(summary(root)).toMatch(/^Model Scout · 1\/1 models/);
  });

  it("names a running discovery in the summary", async () => {
    const h = harness();
    h.catalog.mockResolvedValueOnce(payload("running"));
    expect(summary(await h.run())).toContain("discovery running");
  });

  it("says discovery is starting until the updated event brings evidence", async () => {
    const h = harness();
    h.catalog.mockResolvedValueOnce({
      schemaVersion: CATALOG_SCHEMA_VERSION,
      packageVersion: "2.0.0",
      status: "pending",
      providers: [],
    });
    const root = await h.run();
    expect(summary(root)).toContain("discovery starting");
    expect(openDetail(root, 1)).toContain("Model ID: atlas-model [host]");

    h.emitRpc({ location: PROJECT, data: { completedAt: "x" } });
    await vi.waitFor(() =>
      expect(summary(root)).not.toContain("discovery starting"),
    );
    expect(openDetail(root, 1)).toContain("Model ID: atlas-model [server]");
  });

  it.each([
    [
      "the server half is unavailable",
      { type: "rpc.unavailable", message: "RPC is unavailable" },
      "host state only: server plugin unavailable",
    ],
    [
      "the handler fails",
      { type: "rpc.internal", message: "RPC call failed" },
      "host state only: server error (rpc.internal)",
    ],
    [
      "the call times out",
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      "host state only: server timed out",
    ],
    [
      "the transport fails",
      new TypeError("fetch failed"),
      "host state only: server unreachable",
    ],
  ])("degrades to host rows when %s", async (_label, error, notice) => {
    const h = harness();
    h.catalog.mockRejectedValueOnce(error);
    const root = await h.run();
    expect(summary(root)).toContain(notice);
    expect(openDetail(root, 0)).toContain(
      "evidence unavailable; showing host state only",
    );
    expect(h.toast.show).not.toHaveBeenCalled();
  });

  it("degrades to host rows when the evidence fails validation", async () => {
    const h = harness();
    h.catalog.mockResolvedValueOnce({ ...payload(), schemaVersion: 3 });
    const root = await h.run();
    expect(summary(root)).toContain("host state only: invalid server evidence");
    expect(openDetail(root, 1)).toContain("Model ID: atlas-model [host]");
  });

  it("toasts and opens nothing when the host lists fail", async () => {
    const h = harness();
    h.modelList.mockRejectedValueOnce(new Error("service down"));
    await h.command().run();
    expect(h.dialog.show).not.toHaveBeenCalled();
    expect(h.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "error",
        title: "Model Scout",
        message: "service down",
      }),
    );
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

  it("maps the dialog surface tokens onto the browser colors", async () => {
    const h = harness();
    const results = findNodeById(await h.run(), "modelscout-results");
    expect(results?.props).toMatchObject({
      backgroundColor: tokens.background.base,
      focusedBackgroundColor: tokens.background.base,
      selectedBackgroundColor: tokens.background.action.primary.focused,
      textColor: tokens.text.base,
      selectedTextColor: tokens.text.action.primary.focused,
    });
  });

  it.each([
    [160, 40, 112, 25],
    [80, 24, 74, 12],
  ])(
    "sizes a %i×%i terminal to a content-sized root",
    async (columns, rows, width, height) => {
      const h = harness({ terminalWidth: columns, terminalHeight: rows });
      expect(
        findNodeById(await h.run(), "modelscout-browser")?.props,
      ).toMatchObject({ width, height, maxHeight: height });
    },
  );
});

describe("dialog lifecycle", () => {
  it("disposes the key listener and subscriptions once when the host closes it", async () => {
    const h = harness();
    await h.run();
    expect(h.keyListeners.size).toBe(1);

    h.current()?.onClose?.();
    h.current()?.onClose?.();

    expect(h.keyListeners.size).toBe(0);
    expect(h.keyInput.off).toHaveBeenCalledTimes(1);
    expect(h.stopRpc).toHaveBeenCalledOnce();
    expect(h.stopData).toHaveBeenCalledOnce();
    expect(h.dialog.clear).not.toHaveBeenCalled();
  });

  it("keeps one key listener when the host renders the dialog again", async () => {
    const h = harness();
    await h.run();
    h.current()?.render();
    expect(h.keyListeners.size).toBe(1);
  });

  it("closes its own open dialog on plugin cleanup", async () => {
    const h = harness();
    await h.run();
    h.cleanup();
    expect(h.dialog.clear).toHaveBeenCalledOnce();
    expect(h.keyListeners.size).toBe(0);
    expect(h.stopRpc).toHaveBeenCalledOnce();
  });

  it("leaves a dialog that replaced its own alone on cleanup", async () => {
    const h = harness();
    await h.run();
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
    const body = findTextContaining(root, "(interactive browser unavailable)");
    expect(body?.props?.content).toContain("Atlas — 1 model");
    expect(body?.props?.fg).toBe(tokens.text.feedback.error.base);
  });

  it("keeps forged provider and model strings on their fallback lines", async () => {
    const h = harness();
    h.setHostModels([
      hostModel("atlas-model\r\n  forged-standalone-row", "Atlas\u2028Forged"),
    ]);
    h.catalog.mockRejectedValueOnce({ type: "rpc.unavailable", message: "" });
    await h.command().run();
    h.keyInput.on.mockImplementationOnce(() => {
      throw new Error("forced fallback\nForged Error — standalone line");
    });
    const content = findTextContaining(
      h.current()?.render(),
      "(interactive browser unavailable)",
    )?.props?.content as string;
    expect(content.replaceAll("\n", "")).not.toMatch(
      /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u,
    );
    const lines = content.split("\n");
    expect(lines).not.toContain("  forged-standalone-row");
    expect(lines).toContain("  atlas-model   forged-standalone-row");
    expect(
      lines.some((line) =>
        line.includes("forced fallback Forged Error — standalone line"),
      ),
    ).toBe(true);
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

describe("live updates", () => {
  it("reloads in place on an updated event for the same location", async () => {
    const h = harness();
    const root = await h.run();
    h.setHostModels([hostModel(), hostModel("atlas-new", "Atlas New")]);

    h.emitRpc({ location: PROJECT, data: { completedAt: "x" } });

    await vi.waitFor(() =>
      expect(optionNames(root).some((name) => name.includes("Atlas New"))).toBe(
        true,
      ),
    );
    expect(h.catalog).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({ location: PROJECT }),
    );
  });

  it("reloads on model.updated for the same location", async () => {
    const h = harness();
    const root = await h.run();
    h.setHostModels([hostModel(), hostModel("atlas-new", "Atlas New")]);
    h.emitModelUpdated({ type: "model.updated", location: PROJECT });
    await vi.waitFor(() =>
      expect(optionNames(root).some((name) => name.includes("Atlas New"))).toBe(
        true,
      ),
    );
  });

  it("ignores events for other or missing locations", async () => {
    const h = harness();
    await h.run();
    h.emitRpc({ location: { directory: "/elsewhere" }, data: {} });
    h.emitModelUpdated({ type: "model.updated" });
    h.emitModelUpdated({
      type: "model.updated",
      location: { directory: "/elsewhere" },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.modelList).toHaveBeenCalledOnce();
  });

  it("coalesces a burst of events into one follow-up reload", async () => {
    const h = harness();
    await h.run();
    for (let index = 0; index < 4; index++)
      h.emitRpc({ location: PROJECT, data: {} });
    await vi.waitFor(() => expect(h.modelList).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.modelList).toHaveBeenCalledTimes(3);
  });

  it("keeps the last rows and says so when a reload fails", async () => {
    const h = harness();
    const root = await h.run();
    h.modelList.mockRejectedValueOnce(new Error("offline"));
    h.emitRpc({ location: PROJECT, data: {} });
    await vi.waitFor(() =>
      expect(summary(root)).toContain("update failed; showing the last result"),
    );
    expect(optionNames(root)).toHaveLength(2);
  });

  it("reloads once after opening when an update arrived during the first reads", async () => {
    const h = harness();
    h.modelList.mockImplementationOnce(async (input) => {
      // The catalog changes while the first read is in flight.
      h.setHostModels([hostModel(), hostModel("atlas-new", "Atlas New")]);
      h.emitRpc({ location: PROJECT, data: { completedAt: "x" } });
      h.emitModelUpdated({ type: "model.updated", location: PROJECT });
      return { location: input.location, data: [hostModel()] };
    });
    const root = await h.run();
    await vi.waitFor(() =>
      expect(optionNames(root).some((name) => name.includes("Atlas New"))).toBe(
        true,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.modelList).toHaveBeenCalledTimes(2);
  });

  it("stops listening when the dialog never opens", async () => {
    const h = harness();
    h.modelList.mockRejectedValueOnce(new Error("service down"));
    await h.command().run();
    expect(h.stopRpc).toHaveBeenCalledOnce();
    expect(h.stopData).toHaveBeenCalledOnce();
  });

  it("stops reacting to events after the dialog closes", async () => {
    const h = harness();
    await h.run();
    h.current()?.onClose?.();
    h.emitRpc({ location: PROJECT, data: {} });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.modelList).toHaveBeenCalledOnce();
  });
});

describe("refresh key", () => {
  it("requests a refresh for the captured location and reloads when accepted", async () => {
    const h = harness();
    const root = await h.run();
    h.press({ name: "r", sequence: "R", shift: true });
    await vi.waitFor(() => expect(h.modelList).toHaveBeenCalledTimes(2));
    expect(h.refresh).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        location: PROJECT,
        signal: expect.any(AbortSignal),
      }),
    );
    await vi.waitFor(() =>
      expect(summary(root)).toMatch(/^Model Scout · 1\/1 models/),
    );
  });

  it.each([
    ["throttled", "refresh skipped: the last one was under a minute ago"],
    ["no-targets", "refresh skipped: no providers to discover"],
  ])("explains a refresh the server declined as %s", async (reason, notice) => {
    const h = harness();
    const root = await h.run();
    h.refresh.mockResolvedValueOnce({ accepted: false, reason });
    h.press({ name: "r", sequence: "R", shift: true });
    await vi.waitFor(() => expect(summary(root)).toContain(notice));
    expect(h.modelList).toHaveBeenCalledOnce();
  });

  it("explains a refresh that failed", async () => {
    const h = harness();
    const root = await h.run();
    h.refresh.mockRejectedValueOnce({
      type: "rpc.unavailable",
      message: "RPC is unavailable",
    });
    h.press({ name: "r", sequence: "R", shift: true });
    await vi.waitFor(() =>
      expect(summary(root)).toContain(
        "refresh failed: server plugin unavailable",
      ),
    );
  });
});
