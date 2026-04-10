/** Plugin name — used in package.json, README, error messages. */
export const PLUGIN_NAME = "opencode-model-scout";

/** Log prefix for all console.warn/error calls. */
export const LOG_PREFIX = `[${PLUGIN_NAME}]`;

/** Slash command name (without leading slash). */
export const COMMAND_NAME = "modelscout";

/** Slash command template shown in the TUI. */
export const COMMAND_TEMPLATE = `/${COMMAND_NAME}`;

/** Slash command description. */
export const COMMAND_DESCRIPTION =
  "Show discovered models with metadata (use --json for raw output)";

/** Sentinel error message thrown to signal command completion. */
export const COMMAND_SENTINEL = `__${COMMAND_NAME.toUpperCase()}_COMMAND_HANDLED__`;
