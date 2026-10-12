/**
 * Plugin ID shared by the server and TUI halves, and the RPC contract ID.
 * OpenCode dedupes a package listed in both `opencode.json` and `cli.json`
 * by this ID, so both halves must keep it identical.
 */
export const PLUGIN_ID = "opencode-model-scout";

/** Plugin name — used in package.json, README, error messages. */
export const PLUGIN_NAME = PLUGIN_ID;

/** Slash command name (without leading slash): `/modelscout`. */
export const COMMAND_NAME = "modelscout";

/** Probe ID for Actualyze (the Atlas platform). */
export const ACTUALYZE_PROBE_ID = "actualyze";

/**
 * Deprecated probe IDs accepted in `settings.probe` for the 2.x line, mapped
 * to their current ID.
 */
export const PROBE_ID_ALIASES: Readonly<Record<string, string>> = {
  atlas: ACTUALYZE_PROBE_ID,
};

/**
 * Provider IDs scout never probes: the host's own local discovery providers
 * (`ollama`, `lmstudio`, `vllm`) already list every served model, and the
 * built-in `opencode` provider hides paid models on purpose when there is no
 * key.
 */
export const NEVER_PROBED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "ollama",
  "lmstudio",
  "vllm",
  "opencode",
]);

/**
 * Provider package names that make a provider auto-eligible for discovery
 * and enable reasoning-effort variants.
 */
export const OPENAI_COMPATIBLE_PACKAGES: ReadonlySet<string> = new Set([
  "@opencode/ai/providers/openai-compatible",
  "aisdk:@ai-sdk/openai-compatible",
  "@ai-sdk/openai-compatible",
]);
