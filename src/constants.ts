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
 * The built-in Actualyze provider. Scout adds it to every catalog that does
 * not already have an `actualyze` provider; it stays hidden until scout's
 * Actualyze integration has a connection (a stored key or the environment
 * variable).
 */
export const ACTUALYZE_PROVIDER_ID = "actualyze";
/**
 * The Actualyze integration. Its ID is the provider ID because the host's
 * config provider plugin registers an integration under the provider ID for
 * every `providers.<id>` config entry unless one exists, and
 * `opencode auth login actualyze` resolves an integration by exact ID before
 * name. With any other ID, a `providers.actualyze` entry would add a second
 * integration whose stored key the built-in provider never reads.
 */
export const ACTUALYZE_INTEGRATION_ID = ACTUALYZE_PROVIDER_ID;
export const ACTUALYZE_NAME = "Actualyze";
export const ACTUALYZE_BASE_URL = "https://app.actualyze.ai/openai/v1";
/** The host's native Chat Completions package for openai-compatible APIs. */
export const ACTUALYZE_PACKAGE = "@opencode/ai/providers/openai-compatible";
export const ACTUALYZE_ENV = "ACTUALYZE_API_KEY";

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
