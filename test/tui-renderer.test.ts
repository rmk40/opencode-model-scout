import type { BaseRenderable, TextChunk } from "@opentui/core";
import { describe, expect, it, vi } from "vitest";
import {
  TuiRenderer,
  type ReconcilerBridge,
  type StyleBridge,
  type TuiTag,
} from "../src/tui-renderer";

interface FakeNode {
  tag: string;
  props: Record<string, unknown>;
  children: FakeNode[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  getSelectedIndex: () => number;
}

function fakeBridge() {
  const created: FakeNode[] = [];
  const setProp = vi.fn(
    (node: BaseRenderable, name: string, value: unknown): unknown => {
      (node as unknown as FakeNode).props[name] = value;
      return value;
    },
  );
  const bridge: ReconcilerBridge = {
    createElement: (tag) => {
      const node: FakeNode = {
        tag,
        props: {},
        children: [],
        selectedIndex: 0,
        setSelectedIndex(index) {
          this.selectedIndex = index;
        },
        getSelectedIndex() {
          return this.selectedIndex;
        },
      };
      created.push(node);
      return node as unknown as BaseRenderable;
    },
    setProp,
    insert: (parent, child) => {
      (parent as unknown as FakeNode).children.push(
        child as unknown as FakeNode,
      );
      return child;
    },
  };
  return { bridge, created, setProp };
}

describe("TuiRenderer", () => {
  it("no longer declares the tab_select intrinsic", () => {
    // TuiTag is the closed set of intrinsics Model Scout may construct; the
    // unified browser removed the Models/Providers tabs, so tab_select must
    // be unrepresentable at the type level and unused at runtime.
    const declared: readonly TuiTag[] = [
      "box",
      "text",
      "scrollbox",
      "input",
      "select",
    ];
    // @ts-expect-error tab_select was removed from TuiTag
    const forbidden: TuiTag = "tab_select";
    expect(declared).not.toContain(forbidden);
  });

  it("creates declared intrinsics, assigns props, and inserts only node children", () => {
    const fake = fakeBridge();
    const renderer = new TuiRenderer(fake.bridge);
    const text = renderer.create("text", { content: "Atlas" });
    const box = renderer.create("box", { flexDirection: "column" }, text);

    expect(fake.created.map((node) => node.tag)).toEqual(["text", "box"]);
    expect((renderer.raw(box) as unknown as FakeNode).children).toEqual([
      renderer.raw(text),
    ]);
    expect((renderer.raw(text) as unknown as FakeNode).props.content).toBe(
      "Atlas",
    );
  });

  it("updates declared properties through setProp and uses the selection API", () => {
    const fake = fakeBridge();
    const renderer = new TuiRenderer(fake.bridge);
    const select = renderer.create("select", { options: [] });

    renderer.set(select, "visible", false);
    renderer.setSelectedIndex(select, 3);

    const node = renderer.raw(select) as unknown as FakeNode;
    expect(node.props.visible).toBe(false);
    expect(node.selectedIndex).toBe(3);
    expect(renderer.getSelectedIndex(select)).toBe(3);
    expect(fake.setProp).toHaveBeenLastCalledWith(
      renderer.raw(select),
      "visible",
      false,
      undefined,
    );
  });

  it("resolves a declared ref without forwarding it as a native property", () => {
    const fake = fakeBridge();
    const renderer = new TuiRenderer(fake.bridge);
    const ref = vi.fn();

    const input = renderer.create("input", { ref, value: "atlas" });

    expect(ref).toHaveBeenCalledWith(renderer.raw(input));
    expect(
      (renderer.raw(input) as unknown as FakeNode).props,
    ).not.toHaveProperty("ref");
  });
});

class FakeStyledText {
  constructor(readonly chunks: TextChunk[]) {}
}

/** A style bridge whose parsed colors record their input. */
function fakeStyle() {
  const parseColor = (color: unknown) => ({ parsed: color });
  const style: StyleBridge = {
    StyledText: FakeStyledText as unknown as StyleBridge["StyledText"],
    parseColor: parseColor as unknown as StyleBridge["parseColor"],
    TextAttributes: { BOLD: 1 },
  };
  return { style };
}

describe("TuiRenderer styled text", () => {
  it("reports whether it can render styled text", () => {
    expect(new TuiRenderer(fakeBridge().bridge).styled).toBe(false);
    expect(new TuiRenderer(fakeBridge().bridge, fakeStyle().style).styled).toBe(
      true,
    );
  });

  it("throws on styled text without a style bridge", () => {
    const renderer = new TuiRenderer(fakeBridge().bridge);
    const text = renderer.create("text", { content: "" });
    expect(() => renderer.setStyledText(text, [{ text: "Atlas" }])).toThrow();
  });

  it("assigns the StyledText to the renderable, not through setProp", () => {
    // The reconciler's setProp stringifies non-string content, which would
    // render "[object Object]".
    const fake = fakeBridge();
    const renderer = new TuiRenderer(fake.bridge, fakeStyle().style);
    const text = renderer.create("text", { content: "" });
    fake.setProp.mockClear();

    renderer.setStyledText(text, [{ text: "Atlas" }]);

    const node = renderer.raw(text) as unknown as { content: unknown };
    expect(node.content).toBeInstanceOf(FakeStyledText);
    expect(fake.setProp).not.toHaveBeenCalled();
  });

  it("builds one chunk per span with parsed colors and bold only where asked", () => {
    const { style } = fakeStyle();
    const renderer = new TuiRenderer(fakeBridge().bridge, style);
    const text = renderer.create("text", { content: "" });

    renderer.setStyledText(text, [
      { text: "▌", fg: "#111111", bg: "#222222" },
      { text: "Actualyze", fg: "#a855f7", bold: true },
      { text: "   ", bg: "#222222" },
      { text: "plain", bold: false },
    ]);

    const { chunks } = (
      renderer.raw(text) as unknown as {
        content: FakeStyledText;
      }
    ).content;
    expect(chunks).toEqual([
      {
        __isChunk: true,
        text: "▌",
        fg: { parsed: "#111111" },
        bg: { parsed: "#222222" },
      },
      {
        __isChunk: true,
        text: "Actualyze",
        fg: { parsed: "#a855f7" },
        attributes: 1,
      },
      { __isChunk: true, text: "   ", bg: { parsed: "#222222" } },
      { __isChunk: true, text: "plain" },
    ]);
  });

  it("clears a node with no spans", () => {
    const renderer = new TuiRenderer(fakeBridge().bridge, fakeStyle().style);
    const text = renderer.create("text", { content: "" });
    renderer.setStyledText(text, [{ text: "old" }]);
    renderer.setStyledText(text, []);
    const node = renderer.raw(text) as unknown as { content: FakeStyledText };
    expect(node.content.chunks).toEqual([]);
  });
});
