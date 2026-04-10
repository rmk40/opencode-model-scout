/**
 * Extract owner from model ID (e.g., "qwen" from "qwen/qwen3-30b").
 * Returns undefined if there's no slash separator.
 */
export function extractModelOwner(id: string): string | undefined {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : undefined;
}

/** Acronyms that should be uppercased in model names. */
const ACRONYMS = new Set([
  "gpt",
  "oss",
  "api",
  "gguf",
  "ggml",
  "nomic",
  "vl",
  "it",
  "mlx",
]);

/**
 * Format model ID for display.
 * Turns "qwen/qwen3-30b-a3b" into "Qwen3 30B A3B".
 */
export function formatModelName(id: string): string {
  // Extract part after slash (if any)
  const slash = id.indexOf("/");
  const modelPart = slash > 0 ? id.slice(slash + 1) : id;

  return modelPart
    .split(/[-_:]/)
    .filter(Boolean)
    .map((token) => {
      const lower = token.toLowerCase();
      if (ACRONYMS.has(lower)) return token.toUpperCase();
      // Size suffixes like "30b", "7b", "0.6b"
      if (/^\d+\.?\d*[bkmg]$/i.test(token)) return token.toUpperCase();
      // Quantization like "q4", "q8"
      if (/^q\d+$/i.test(token)) return token.toUpperCase();
      // Version numbers like "3.2"
      if (/^\d+\.\d+/.test(token)) return token;
      // Patterns like "a3b", "3n"
      if (/^[a-z]\d+[a-z]$/i.test(token) || /^\d+[a-z]$/i.test(token))
        return token.toUpperCase();
      // Default: capitalize first letter
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    })
    .join(" ");
}
