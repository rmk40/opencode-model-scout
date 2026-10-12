import type { BaseRenderable } from "@opentui/core";
import { describe, expect, it, vi } from "vitest";
import {
  TuiRenderer,
  type ReconcilerBridge,
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
