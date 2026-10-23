import { keyMove, type ListMove } from "./tui-list";

/**
 * Where the browser is: the list screen (with a preview of the selected row
 * beside it when the terminal has room), the details screen, Evidence, the
 * filter screen, or the key list.
 */
export type BrowserScreen = "list" | "detail" | "evidence" | "filters" | "help";

/** What receives keys on the list screen: the search input or the list. */
export type BrowserFocus = "search" | "list";

/** The fields of an OpenTUI `KeyEvent` the router reads. */
export interface RoutedKey {
  readonly name: string;
  readonly sequence?: string;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly option?: boolean;
  readonly super?: boolean;
  readonly hyper?: boolean;
}

export type BrowserAction =
  | { readonly type: "move"; readonly move: ListMove }
  | { readonly type: "scroll"; readonly move: ListMove }
  /** `picker` on a model row; `open` on a provider header. */
  | { readonly type: "select" }
  | { readonly type: "open" }
  | { readonly type: "back" }
  | { readonly type: "collapse" }
  | { readonly type: "expand" }
  | { readonly type: "focus-search" }
  | { readonly type: "leave-search" }
  | { readonly type: "filters" }
  | { readonly type: "filter-change"; readonly direction: 1 | -1 }
  | { readonly type: "clear" }
  | { readonly type: "sort" }
  | { readonly type: "evidence" }
  | { readonly type: "picker" }
  | { readonly type: "refresh" }
  | { readonly type: "refresh-all" }
  | { readonly type: "actualyze" }
  | { readonly type: "copy"; readonly what: "qualified" | "id" }
  | { readonly type: "help" }
  | { readonly type: "extra"; readonly key: string };

export interface RouteContext {
  readonly screen: BrowserScreen;
  readonly focus: BrowserFocus;
  /** Single lowercase letters a caller adds to the list and detail views. */
  readonly extraKeys?: ReadonlySet<string>;
}

function hasCommandModifier(key: RoutedKey): boolean {
  return Boolean(key.ctrl || key.meta || key.option || key.super || key.hyper);
}

/**
 * The character a key types, if it types one. OpenTUI names a shifted
 * letter by its lowercase name with `shift`, and punctuation such as `?` by
 * its sequence.
 */
function typedChar(key: RoutedKey): string | undefined {
  const sequence = key.sequence ?? "";
  if (sequence.length === 1 && sequence >= " " && sequence !== "\x7f")
    return sequence;
  if (key.name.length === 1)
    return key.shift ? key.name.toUpperCase() : key.name;
  if (key.name === "slash") return "/";
  if (key.name === "space") return " ";
  return undefined;
}

function isEnter(key: RoutedKey): boolean {
  return key.name === "return" || key.name === "enter";
}

function isBackspace(key: RoutedKey): boolean {
  return (
    key.name === "backspace" || key.sequence === "\b" || key.sequence === "\x7f"
  );
}

/** Actions shared by the list and every detail view. */
const ACTION_CHARS: Readonly<Record<string, BrowserAction>> = {
  m: { type: "picker" },
  y: { type: "copy", what: "qualified" },
  Y: { type: "copy", what: "id" },
  r: { type: "refresh" },
  R: { type: "refresh-all" },
  d: { type: "evidence" },
  a: { type: "actualyze" },
  "?": { type: "help" },
  "/": { type: "focus-search" },
};

/** List-only actions. */
const LIST_CHARS: Readonly<Record<string, BrowserAction>> = {
  i: { type: "open" },
  f: { type: "filters" },
  x: { type: "clear" },
  s: { type: "sort" },
};

function charAction(
  char: string | undefined,
  context: RouteContext,
  table: Readonly<Record<string, BrowserAction>>,
): BrowserAction | undefined {
  if (char === undefined) return undefined;
  if (Object.hasOwn(table, char)) return table[char];
  if (context.extraKeys?.has(char)) return { type: "extra", key: char };
  return undefined;
}

/**
 * Map a key to the browser action it triggers in the current view, or
 * undefined when the browser leaves the key alone. Keys with ctrl, meta,
 * option, super, or hyper always belong to the host. While search has
 * focus only `enter` and `down` are routed, and both return to the list;
 * every other key goes to the input.
 */
export function routeKey(
  context: RouteContext,
  key: RoutedKey,
): BrowserAction | undefined {
  if (hasCommandModifier(key)) return undefined;
  const char = typedChar(key);
  const move = keyMove(key.name);

  switch (context.screen) {
    case "list": {
      if (context.focus === "search") {
        if (isEnter(key) || key.name === "down")
          return { type: "leave-search" };
        return undefined;
      }
      if (move) return { type: "move", move };
      if (isEnter(key)) return { type: "select" };
      if (key.name === "left") return { type: "collapse" };
      if (key.name === "right") return { type: "expand" };
      return (
        charAction(char, context, LIST_CHARS) ??
        charAction(char, context, ACTION_CHARS)
      );
    }
    case "detail":
      // `i` closes what `i` opened.
      if (move) return { type: "scroll", move };
      if (isEnter(key)) return { type: "select" };
      if (isBackspace(key) || key.name === "left" || char === "i")
        return { type: "back" };
      return charAction(char, context, ACTION_CHARS);
    case "evidence": {
      if (move) return { type: "scroll", move };
      if (isBackspace(key)) return { type: "back" };
      if (char === "y") return { type: "copy", what: "qualified" };
      if (char === "Y") return { type: "copy", what: "id" };
      if (char === "?") return { type: "help" };
      if (char === "/") return { type: "focus-search" };
      return undefined;
    }
    case "help": {
      if (move) return { type: "scroll", move };
      if (isBackspace(key) || char === "?") return { type: "back" };
      return undefined;
    }
    case "filters": {
      if (key.name === "up" || key.name === "down")
        return { type: "move", move: key.name };
      if (key.name === "home" || key.name === "end")
        return { type: "move", move: key.name };
      if (key.name === "left") return { type: "filter-change", direction: -1 };
      if (key.name === "right" || isEnter(key) || char === " ")
        return { type: "filter-change", direction: 1 };
      if (char === "x") return { type: "clear" };
      if (isBackspace(key) || char === "f") return { type: "back" };
      if (char === "?") return { type: "help" };
      return undefined;
    }
  }
}
