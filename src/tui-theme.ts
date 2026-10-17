import type { RGBA } from "@opentui/core";

/** Color roles that view code tags text with; `tui-theme` maps them to tokens. */
export type ThemeRole =
  | "base"
  /** `base`, bold: card titles and the key list's keys. */
  | "strong"
  | "muted"
  | "faint"
  | "selected"
  | "selectedBg"
  | "current"
  | "group"
  | "ok"
  | "warn"
  | "error"
  | "info"
  | "field"
  | "fieldBg"
  | "key"
  | "disabled"
  | "rule"
  | "brand";

/** Roles that only color backgrounds. */
export type BackgroundRole = "selectedBg" | "fieldBg";

/** Roles a text segment can carry as its foreground. */
export type ForegroundRole = Exclude<ThemeRole, BackgroundRole>;

/**
 * A color the renderer accepts: a theme token, or a hex string for the
 * brand color, which no theme token carries.
 */
export type RoleColor = RGBA | string;

export type RolePalette = Readonly<Record<ThemeRole, RoleColor>>;

/** Roles rendered bold in addition to their color. */
export const BOLD_ROLES: ReadonlySet<ThemeRole> = new Set<ThemeRole>([
  "strong",
  "group",
  "brand",
]);

/** Actualyze purple for dark and light themes. */
export const BRAND_COLORS = { dark: "#a855f7", light: "#7c3aed" } as const;

interface StatefulTokens {
  readonly focused: RGBA;
  readonly disabled: RGBA;
  readonly selected: RGBA;
}

/**
 * The dialog-surface tokens the palette reads. OpenCode's resolved theme
 * satisfies it. `text.faint` exists from OpenCode 2.0.32; the pinned 2.0.26
 * types lack it, so it is read as `unknown` and checked.
 */
export interface DialogSurfaceTokens {
  readonly text: {
    readonly base: RGBA;
    readonly muted: RGBA;
    readonly faint?: unknown;
    readonly action: { readonly primary: StatefulTokens };
    readonly formfield: StatefulTokens;
    readonly feedback: Readonly<
      Record<"success" | "warning" | "error" | "info", { readonly base: RGBA }>
    >;
  };
  readonly background: {
    readonly action: { readonly primary: StatefulTokens };
    readonly formfield: StatefulTokens;
  };
  readonly border: { readonly base: RGBA };
}

/** The part of the TUI plugin context the palette depends on. */
export interface ThemeSource {
  readonly theme: { surface(name: "dialog"): DialogSurfaceTokens };
  readonly themeMode: "dark" | "light";
}

/** Structural check for an OpenTUI color; the class is not loaded here. */
function isColor(value: unknown): value is RGBA {
  if (typeof value !== "object" || value === null) return false;
  const color = value as Partial<Record<"r" | "g" | "b" | "a", unknown>>;
  return (
    typeof color.r === "number" &&
    typeof color.g === "number" &&
    typeof color.b === "number" &&
    typeof color.a === "number"
  );
}

/**
 * Map every role to its dialog-surface token. It reads the theme on each
 * call, so callers get the active theme by calling it again rather than
 * keeping an old palette.
 */
export function rolePalette(source: ThemeSource): RolePalette {
  const tokens = source.theme.surface("dialog");
  const { text, background } = tokens;
  return {
    base: text.base,
    strong: text.base,
    muted: text.muted,
    faint: isColor(text.faint) ? text.faint : text.muted,
    selected: text.action.primary.focused,
    selectedBg: background.action.primary.focused,
    current: text.formfield.selected,
    group: text.muted,
    ok: text.feedback.success.base,
    warn: text.feedback.warning.base,
    error: text.feedback.error.base,
    info: text.feedback.info.base,
    field: text.formfield.focused,
    fieldBg: background.formfield.focused,
    key: text.muted,
    disabled: text.action.primary.disabled,
    rule: tokens.border.base,
    brand:
      source.themeMode === "light" ? BRAND_COLORS.light : BRAND_COLORS.dark,
  };
}
