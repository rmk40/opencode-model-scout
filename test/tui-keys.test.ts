import { describe, expect, it } from "vitest";
import {
  routeKey,
  type BrowserFocus,
  type BrowserScreen,
  type RouteContext,
  type RoutedKey,
} from "../src/tui-keys";

/** A key as OpenTUI reports it: single-character names carry their sequence. */
function key(name: string, extra: Partial<RoutedKey> = {}): RoutedKey {
  return { name, sequence: name.length === 1 ? name : "", ...extra };
}

function shifted(letter: string): RoutedKey {
  return { name: letter, sequence: letter.toUpperCase(), shift: true };
}

const LIST: RouteContext = { screen: "list", focus: "list" };
const SEARCH: RouteContext = { screen: "list", focus: "search" };
const DETAIL: RouteContext = { screen: "detail", focus: "list" };
const EVIDENCE: RouteContext = { screen: "evidence", focus: "list" };
const HELP: RouteContext = { screen: "help", focus: "list" };
const FILTERS: RouteContext = { screen: "filters", focus: "list" };

const EVERY_CONTEXT: readonly RouteContext[] = [
  LIST,
  SEARCH,
  DETAIL,
  EVIDENCE,
  HELP,
  FILTERS,
];

describe("routeKey while search has focus", () => {
  const printable = [
    key("m"),
    key("i"),
    key("a"),
    key("x"),
    key("f"),
    key("?"),
    key("/"),
    key("slash"),
    key("space", { sequence: " " }),
    shifted("r"),
    shifted("y"),
  ];

  it.each(printable.map((item) => [item.sequence || item.name, item]))(
    "lets %j edit the query instead of running an action",
    (_label, typed) => {
      expect(
        routeKey({ ...SEARCH, extraKeys: new Set(["k"]) }, typed),
      ).toBeUndefined();
    },
  );

  it("leaves a registered extra letter to the query too", () => {
    expect(
      routeKey({ ...SEARCH, extraKeys: new Set(["k"]) }, key("k")),
    ).toBeUndefined();
  });

  it("returns to the list on enter under either key name, and on down", () => {
    expect(routeKey(SEARCH, key("enter"))).toEqual({ type: "leave-search" });
    expect(routeKey(SEARCH, key("return"))).toEqual({ type: "leave-search" });
    expect(routeKey(SEARCH, key("down"))).toEqual({ type: "leave-search" });
  });

  it("leaves list moves other than down to the input", () => {
    for (const name of [
      "up",
      "pageup",
      "pagedown",
      "home",
      "end",
      "left",
      "right",
    ])
      expect(routeKey(SEARCH, key(name))).toBeUndefined();
  });
});

describe("routeKey with command modifiers", () => {
  const modifiers = ["ctrl", "meta", "option", "super", "hyper"] as const;

  it.each(modifiers)(
    "leaves %s chords to the host on every screen and focus",
    (modifier) => {
      for (const context of EVERY_CONTEXT)
        for (const name of ["r", "y", "i", "return", "down", "backspace", "?"])
          expect(
            routeKey(
              { ...context, extraKeys: new Set(["r"]) },
              key(name, { [modifier]: true }),
            ),
          ).toBeUndefined();
    },
  );

  it("treats shift alone as part of the typed character", () => {
    expect(routeKey(LIST, shifted("r"))).toEqual({ type: "refresh-all" });
  });
});

describe("routeKey on the list", () => {
  it.each([
    ["i", { type: "open" }],
    ["m", { type: "picker" }],
    ["x", { type: "clear" }],
    ["s", { type: "sort" }],
    ["d", { type: "evidence" }],
    ["r", { type: "refresh" }],
    ["a", { type: "actualyze" }],
    ["?", { type: "help" }],
  ] as const)("maps %s to its action", (name, action) => {
    expect(routeKey(LIST, key(name))).toEqual(action);
  });

  it("selects with enter under either key name, and collapses with left", () => {
    expect(routeKey(LIST, key("return"))).toEqual({ type: "select" });
    expect(routeKey(LIST, key("enter"))).toEqual({ type: "select" });
    expect(routeKey(LIST, key("left"))).toEqual({ type: "collapse" });
  });

  it("reads ? and / from the sequence when the key name differs", () => {
    expect(routeKey(LIST, { name: "question", sequence: "?" })).toEqual({
      type: "help",
    });
    expect(routeKey(LIST, { name: "slash" })).toEqual({
      type: "focus-search",
    });
  });

  it("expands with right and moves the selection with every move key, never scrolling", () => {
    expect(routeKey(LIST, key("right"))).toEqual({ type: "expand" });
    for (const move of [
      "up",
      "down",
      "pageup",
      "pagedown",
      "home",
      "end",
    ] as const)
      expect(routeKey(LIST, key(move))).toEqual({ type: "move", move });
  });

  it("ignores letters it has no action for", () => {
    for (const name of ["k", "q", "z", "F", "X", "I"])
      expect(routeKey(LIST, key(name))).toBeUndefined();
    expect(routeKey(LIST, key("space", { sequence: " " }))).toBeUndefined();
  });

  it("does not route a shifted extra letter", () => {
    expect(
      routeKey({ ...LIST, extraKeys: new Set(["k"]) }, shifted("k")),
    ).toBeUndefined();
  });
});

describe("routeKey on the details screen", () => {
  const detailViews: readonly [string, RouteContext][] = [
    ["detail screen", DETAIL],
  ];

  it.each(detailViews)("runs shared actions in the %s", (_label, context) => {
    expect(routeKey(context, key("y"))).toEqual({
      type: "copy",
      what: "qualified",
    });
    expect(routeKey(context, shifted("y"))).toEqual({
      type: "copy",
      what: "id",
    });
    expect(routeKey(context, key("r"))).toEqual({ type: "refresh" });
    expect(routeKey(context, shifted("r"))).toEqual({ type: "refresh-all" });
    expect(routeKey(context, key("d"))).toEqual({ type: "evidence" });
    expect(routeKey(context, key("a"))).toEqual({ type: "actualyze" });
    expect(routeKey(context, key("?"))).toEqual({ type: "help" });
    expect(routeKey(context, key("/"))).toEqual({ type: "focus-search" });
  });

  it.each(detailViews)(
    "selects with enter under either key name in the %s",
    (_label, context) => {
      expect(routeKey(context, key("return"))).toEqual({ type: "select" });
      expect(routeKey(context, key("enter"))).toEqual({ type: "select" });
      expect(routeKey(context, key("m"))).toEqual({ type: "picker" });
    },
  );

  it.each(detailViews)(
    "goes back with i, left, or backspace in the %s",
    (_label, context) => {
      for (const name of ["i", "left", "backspace"])
        expect(routeKey(context, key(name))).toEqual({ type: "back" });
      expect(routeKey(context, shifted("i"))).toBeUndefined();
    },
  );

  it.each(detailViews)(
    "keeps list-only keys and expand out of the %s",
    (_label, context) => {
      for (const name of ["x", "s", "right"])
        expect(routeKey(context, key(name))).toBeUndefined();
    },
  );

  it.each(detailViews)(
    "scrolls with every list move in the %s",
    (_label, context) => {
      for (const move of [
        "up",
        "down",
        "pageup",
        "pagedown",
        "home",
        "end",
      ] as const)
        expect(routeKey(context, key(move))).toEqual({ type: "scroll", move });
    },
  );

  it("routes caller extra letters in details", () => {
    expect(
      routeKey({ ...DETAIL, extraKeys: new Set(["k"]) }, key("k")),
    ).toEqual({ type: "extra", key: "k" });
  });

  it("treats a DEL or BS sequence as backspace", () => {
    expect(routeKey(DETAIL, { name: "", sequence: "\x7f" })).toEqual({
      type: "back",
    });
    expect(routeKey(DETAIL, { name: "", sequence: "\b" })).toEqual({
      type: "back",
    });
  });
});

describe("routeKey on Evidence", () => {
  it("scrolls, goes back, copies, and opens help or search", () => {
    expect(routeKey(EVIDENCE, key("pagedown"))).toEqual({
      type: "scroll",
      move: "pagedown",
    });
    expect(routeKey(EVIDENCE, key("backspace"))).toEqual({ type: "back" });
    expect(routeKey(EVIDENCE, key("y"))).toEqual({
      type: "copy",
      what: "qualified",
    });
    expect(routeKey(EVIDENCE, shifted("y"))).toEqual({
      type: "copy",
      what: "id",
    });
    expect(routeKey(EVIDENCE, key("?"))).toEqual({ type: "help" });
    expect(routeKey(EVIDENCE, key("/"))).toEqual({ type: "focus-search" });
  });

  it("runs no other action, including caller extras", () => {
    for (const name of [
      "m",
      "i",
      "r",
      "d",
      "a",
      "f",
      "x",
      "s",
      "return",
      "left",
    ])
      expect(
        routeKey({ ...EVIDENCE, extraKeys: new Set(["k"]) }, key(name)),
      ).toBeUndefined();
    expect(
      routeKey({ ...EVIDENCE, extraKeys: new Set(["k"]) }, key("k")),
    ).toBeUndefined();
  });
});

describe("routeKey on the key list", () => {
  it("returns with backspace or ? and scrolls with list moves", () => {
    expect(routeKey(HELP, key("backspace"))).toEqual({ type: "back" });
    expect(routeKey(HELP, key("?"))).toEqual({ type: "back" });
    expect(routeKey(HELP, key("down"))).toEqual({
      type: "scroll",
      move: "down",
    });
  });

  it("runs no action from the key list", () => {
    for (const name of ["m", "i", "y", "/", "r", "return", "left", "f"])
      expect(routeKey(HELP, key(name))).toBeUndefined();
  });
});

describe("routeKey on the filter screen", () => {
  it("moves between fields with up, down, home, and end only", () => {
    for (const move of ["up", "down", "home", "end"] as const)
      expect(routeKey(FILTERS, key(move))).toEqual({ type: "move", move });
    expect(routeKey(FILTERS, key("pagedown"))).toBeUndefined();
  });

  it("steps a value forward with right", () => {
    expect(routeKey(FILTERS, key("right"))).toEqual({
      type: "filter-change",
      direction: 1,
    });
  });

  it("returns to the list with backspace or f, and opens help with ?", () => {
    expect(routeKey(FILTERS, key("backspace"))).toEqual({ type: "back" });
    expect(routeKey(FILTERS, key("f"))).toEqual({ type: "back" });
    expect(routeKey(FILTERS, key("?"))).toEqual({ type: "help" });
  });

  it("runs no list or detail action", () => {
    for (const name of ["/", "y", "r", "d", "s", "a", "i", "m"])
      expect(routeKey(FILTERS, key(name))).toBeUndefined();
  });
});

describe("routeKey screen and focus coverage", () => {
  it("leaves backspace alone only on the list itself", () => {
    const screens: readonly [BrowserScreen, BrowserFocus][] = [
      ["detail", "list"],
      ["evidence", "list"],
      ["help", "list"],
      ["filters", "list"],
    ];
    for (const [screen, focus] of screens)
      expect(routeKey({ screen, focus }, key("backspace"))).toEqual({
        type: "back",
      });
    expect(routeKey(LIST, key("backspace"))).toBeUndefined();
    expect(routeKey(SEARCH, key("backspace"))).toBeUndefined();
  });
});
