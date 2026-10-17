import type { RGBA } from "@opentui/core";
import { describe, expect, it } from "vitest";
import {
  BRAND_COLORS,
  rolePalette,
  type DialogSurfaceTokens,
  type ThemeSource,
} from "../src/tui-theme";

/** A distinct color per token, so every mapping is identifiable. */
function color(r: number): RGBA {
  return { r, g: 0, b: 0, a: 1 } as unknown as RGBA;
}

const C = {
  base: color(1),
  muted: color(2),
  faint: color(3),
  actionFocused: color(4),
  actionDisabled: color(5),
  actionSelected: color(6),
  fieldFocused: color(7),
  fieldDisabled: color(8),
  fieldSelected: color(9),
  success: color(10),
  warning: color(11),
  error: color(12),
  info: color(13),
  bgActionFocused: color(14),
  bgFieldFocused: color(15),
  border: color(16),
};

function tokens(
  override: { readonly faint: unknown } = { faint: C.faint },
): DialogSurfaceTokens {
  const { faint } = override;
  return {
    text: {
      base: C.base,
      muted: C.muted,
      faint,
      action: {
        primary: {
          focused: C.actionFocused,
          disabled: C.actionDisabled,
          selected: C.actionSelected,
        },
      },
      formfield: {
        focused: C.fieldFocused,
        disabled: C.fieldDisabled,
        selected: C.fieldSelected,
      },
      feedback: {
        success: { base: C.success },
        warning: { base: C.warning },
        error: { base: C.error },
        info: { base: C.info },
      },
    },
    background: {
      action: {
        primary: {
          focused: C.bgActionFocused,
          disabled: color(90),
          selected: color(91),
        },
      },
      formfield: {
        focused: C.bgFieldFocused,
        disabled: color(92),
        selected: color(93),
      },
    },
    border: { base: C.border },
  };
}

function source(
  surface: DialogSurfaceTokens,
  themeMode: "dark" | "light" = "dark",
): ThemeSource {
  return { theme: { surface: () => surface }, themeMode };
}

describe("rolePalette", () => {
  it("maps every role to its dialog-surface token", () => {
    expect(rolePalette(source(tokens()))).toEqual({
      base: C.base,
      strong: C.base,
      muted: C.muted,
      faint: C.faint,
      selected: C.actionFocused,
      selectedBg: C.bgActionFocused,
      current: C.fieldSelected,
      group: C.muted,
      ok: C.success,
      warn: C.warning,
      error: C.error,
      info: C.info,
      field: C.fieldFocused,
      fieldBg: C.bgFieldFocused,
      key: C.muted,
      disabled: C.actionDisabled,
      rule: C.border,
      brand: BRAND_COLORS.dark,
    });
  });

  it("reads the dialog surface", () => {
    const requested: string[] = [];
    rolePalette({
      theme: {
        surface: (name) => {
          requested.push(name);
          return tokens();
        },
      },
      themeMode: "dark",
    });
    expect(requested).toEqual(["dialog"]);
  });

  it.each([
    ["absent", undefined],
    ["not a color", "#888888"],
    ["missing a channel", { r: 1, g: 2, b: 3 }],
    ["null", null],
  ])("falls back to text.muted when text.faint is %s", (_label, faint) => {
    expect(rolePalette(source(tokens({ faint }))).faint).toBe(C.muted);
  });

  it("picks the brand color by theme mode", () => {
    expect(rolePalette(source(tokens(), "dark")).brand).toBe("#a855f7");
    expect(rolePalette(source(tokens(), "light")).brand).toBe("#7c3aed");
  });

  it("returns the active theme's tokens on each call", () => {
    let surface = tokens();
    const live: ThemeSource = {
      theme: { surface: () => surface },
      themeMode: "dark",
    };
    expect(rolePalette(live).base).toBe(C.base);

    const replacement = color(77);
    surface = { ...tokens(), text: { ...tokens().text, base: replacement } };
    expect(rolePalette(live).base).toBe(replacement);
  });
});
