import type {
  BaseRenderable,
  BoxRenderable,
  ColorInput,
  InputRenderable,
  RGBA,
  ScrollBoxRenderable,
  SelectRenderable,
  StyledText,
  TextChunk,
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

/** Runtime surface of the lazy @opentui/core module used for styled text. */
export interface StyleBridge {
  StyledText: new (chunks: TextChunk[]) => StyledText;
  parseColor: (color: ColorInput) => RGBA;
  TextAttributes: { readonly BOLD: number };
}

/** One run of text with its own colors in a styled `<text>` node. */
export interface StyledSpan {
  readonly text: string;
  readonly fg?: ColorInput;
  readonly bg?: ColorInput;
  readonly bold?: boolean;
}

/**
 * Small typed adapter for imperative reconciler use. It keeps intrinsic names,
 * property mutation, and child insertion out of the browser's state logic.
 * Children must be renderables, so callers cannot accidentally insert orphaned
 * string nodes under boxes; text is always supplied through `<text content>`.
 *
 * `create` must run inside a dialog render callback: the reconciler's
 * `createElement` reads the renderer from the Solid owner and throws outside
 * one. `set` and `setStyledText` only mutate an existing node and work
 * anywhere.
 */
export class TuiRenderer {
  readonly #bridge: ReconcilerBridge;
  readonly #style: StyleBridge | undefined;

  constructor(bridge: ReconcilerBridge, style?: StyleBridge) {
    this.#bridge = bridge;
    this.#style = style;
  }

  /** Whether `setStyledText` is available (the renderer has a StyleBridge). */
  get styled(): boolean {
    return this.#style !== undefined;
  }

  /**
   * Replace a text node's content with colored spans. The reconciler's
   * `setProp("content")` stringifies anything but a string, so the
   * StyledText is assigned to the renderable directly; OpenTUI 0.5.17
   * repaints on that assignment, including after the first render.
   */
  setStyledText(node: TuiNode<"text">, spans: readonly StyledSpan[]): void {
    const style = this.#style;
    if (!style) throw new Error("styled text needs @opentui/core");
    const chunks = spans.map(
      (span): TextChunk => ({
        __isChunk: true,
        text: span.text,
        ...(span.fg === undefined ? {} : { fg: style.parseColor(span.fg) }),
        ...(span.bg === undefined ? {} : { bg: style.parseColor(span.bg) }),
        ...(span.bold ? { attributes: style.TextAttributes.BOLD } : {}),
      }),
    );
    node.renderable.content = new style.StyledText(chunks);
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

/**
 * Load the host's OpenTUI modules. Imported lazily so command registration
 * never depends on OpenTUI; the host injects its own `@opentui/solid` and
 * `@opentui/core` for these specifiers at runtime.
 */
export async function loadTuiRenderer(): Promise<TuiRenderer> {
  const [reconciler, core] = await Promise.all([
    import("@opentui/solid") as Promise<unknown> as Promise<ReconcilerBridge>,
    import("@opentui/core") as Promise<unknown> as Promise<StyleBridge>,
  ]);
  return new TuiRenderer(reconciler, core);
}
