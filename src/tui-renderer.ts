import type {
  BaseRenderable,
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  TextRenderable,
} from "@opentui/core";
import type { JSX } from "@opentui/solid";

/** Intrinsics used by Model Scout, all declared by @opentui/solid. */
export type TuiTag = "box" | "text" | "scrollbox" | "input" | "select";

type PropsByTag = {
  [Tag in TuiTag]: JSX.IntrinsicElements[Tag];
};

type RenderableByTag = {
  box: BoxRenderable;
  text: TextRenderable;
  scrollbox: ScrollBoxRenderable;
  input: InputRenderable;
  select: SelectRenderable;
};

/** A typed handle around the reconciler's otherwise untyped imperative node. */
export interface TuiNode<Tag extends TuiTag = TuiTag> {
  readonly tag: Tag;
  readonly renderable: RenderableByTag[Tag];
}

/** Runtime surface exported by the lazy @opentui/solid reconciler. */
export interface ReconcilerBridge {
  createElement: (tag: string) => BaseRenderable;
  setProp: (
    node: BaseRenderable,
    name: string,
    value: unknown,
    previous?: unknown,
  ) => unknown;
  insert: (parent: BaseRenderable, child: BaseRenderable) => unknown;
}

/**
 * Small typed adapter for imperative reconciler use. It keeps intrinsic names,
 * property mutation, and child insertion out of the browser's state logic.
 * Children must be renderables, so callers cannot accidentally insert orphaned
 * string nodes under boxes; text is always supplied through `<text content>`.
 *
 * `create` must run inside a dialog render callback: the reconciler's
 * `createElement` reads the renderer from the Solid owner and throws outside
 * one. `set` only mutates an existing node and works anywhere.
 */
export class TuiRenderer {
  readonly #bridge: ReconcilerBridge;

  constructor(bridge: ReconcilerBridge) {
    this.#bridge = bridge;
  }

  create<Tag extends TuiTag>(
    tag: Tag,
    props: PropsByTag[Tag],
    ...children: readonly TuiNode[]
  ): TuiNode<Tag> {
    const renderable = this.#bridge.createElement(tag) as RenderableByTag[Tag];
    const node = { tag, renderable } as const;

    const entries = Object.entries(props) as Array<[string, unknown]>;
    for (const [name, value] of entries) {
      if (name === "children" || value === undefined) continue;
      if (name === "ref") {
        if (typeof value === "function") {
          const assignRef = value as (node: BaseRenderable) => void;
          assignRef(renderable);
        }
        continue;
      }
      this.#bridge.setProp(renderable, name, value);
    }

    for (const child of children) {
      this.#bridge.insert(renderable, child.renderable);
    }
    return node;
  }

  set<Tag extends TuiTag, Name extends Extract<keyof PropsByTag[Tag], string>>(
    node: TuiNode<Tag>,
    name: Name,
    value: PropsByTag[Tag][Name],
    previous?: PropsByTag[Tag][Name],
  ): void {
    this.#bridge.setProp(node.renderable, name, value, previous);
  }

  raw(node: TuiNode): BaseRenderable {
    return node.renderable;
  }

  setSelectedIndex(node: TuiNode<"select">, index: number): void {
    node.renderable.setSelectedIndex(index);
  }

  getSelectedIndex(node: TuiNode<"select">): number {
    return node.renderable.getSelectedIndex();
  }
}
