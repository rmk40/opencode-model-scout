/** Format a number with comma separators: 262144 → "262,144" */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Compact a token count for dense display: 262144 → "262K", 1000000 → "1M",
 * 1500000 → "1.5M". Values under 1000 are passed through `formatNumber`.
 */
export function compactCount(n: number): string {
  // Round to thousands first so values like 999_999 (→ 1000K) roll over into
  // the millions branch instead of rendering an awkward "1000K".
  const thousands = Math.round(n / 1000);
  if (thousands >= 1000) {
    // 1_048_576 is 1.049M; one decimal rounds it to "1.0", which is trimmed.
    return `${trimZeros((thousands / 1000).toFixed(1))}M`;
  }
  if (n >= 1_000) return `${thousands}K`;
  return formatNumber(n);
}

/**
 * A context limit for a fixed-width column. A limit that is OpenCode's
 * default rather than a reported value gets a `~` prefix: "~200K".
 */
export function formatContextCell(tokens: number, assumed: boolean): string {
  const count = compactCount(tokens);
  return assumed ? `~${count}` : count;
}

/** Columns of the list's price cell. */
export const PRICE_CELL_WIDTH = 15;

/** Drop trailing fractional zeros, and the point when nothing follows it. */
function trimZeros(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Decimals that show `value` (0 < value < 1) with three significant digits. */
function significantDecimals(value: number): number {
  return Math.max(0, 2 - Math.floor(Math.log10(value)));
}

function isPrice(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Nonzero prices below this render as a bound instead of digits. */
const TINY_PRICE = 1e-12;
const TINY_PRICE_LABEL = "<$0.000000000001";

/**
 * A USD price per 1M tokens for dense lists: integers bare ("$3"), up to two
 * decimals under 10 ("$1.25"), one decimal from 10 ("$12.5"), and three
 * significant digits under 0.1 ("$0.075"), with trailing zeros trimmed. A
 * nonzero price never renders as "$0"; one below $1e-12 is "<$0.000000000001".
 * Negative or non-finite input is "?".
 */
export function formatPrice(value: number): string {
  if (!isPrice(value)) return "?";
  if (Number.isInteger(value)) return `$${value}`;
  if (value < TINY_PRICE) return TINY_PRICE_LABEL;
  const decimals =
    value < 0.1 ? significantDecimals(value) : value < 10 ? 2 : 1;
  return `$${trimZeros(value.toFixed(decimals))}`;
}

/**
 * A USD price per 1M tokens for details: two fixed decimals ("$3.00"), or
 * three significant digits under 0.1 ("$0.075", never fewer than two
 * decimals); one below $1e-12 is "<$0.000000000001". Negative or non-finite
 * input is "?".
 */
export function formatDetailPrice(value: number): string {
  if (!isPrice(value)) return "?";
  if (value === 0 || value >= 0.1) return `$${value.toFixed(2)}`;
  if (value < TINY_PRICE) return TINY_PRICE_LABEL;
  const fixed = trimZeros(value.toFixed(significantDecimals(value)));
  const decimals = fixed.length - fixed.indexOf(".") - 1;
  return `$${decimals < 2 ? value.toFixed(2) : fixed}`;
}

function decimalsOf(price: string): number {
  const point = price.indexOf(".");
  return point < 0 ? 0 : price.length - point - 1;
}

/**
 * `in/out` with `formatPrice` per side, an unknown side as "?". When one
 * side shows cents, the other shows cents too ("$0.15/$0.60",
 * "$1.25/$10.00"), so a pair reads as one figure; a side with more digits
 * (three significant digits under 0.1) keeps them. Both unknown is empty.
 */
export function formatPricePair(
  input: number | undefined,
  output: number | undefined,
): string {
  if (input === undefined && output === undefined) return "";
  const side = (value: number | undefined): string =>
    value === undefined ? "?" : formatPrice(value);
  let left = side(input);
  let right = side(output);
  const matchable = (value: number | undefined, text: string): boolean =>
    value !== undefined && text.startsWith("$");
  if (matchable(input, left) && matchable(output, right)) {
    const target = Math.max(decimalsOf(left), decimalsOf(right)) > 0 ? 2 : 0;
    if (decimalsOf(left) < target)
      left = `$${(input as number).toFixed(target)}`;
    if (decimalsOf(right) < target)
      right = `$${(output as number).toFixed(target)}`;
  }
  return `${left}/${right}`;
}

/**
 * The list's `in/out` price cell, unpadded, at most `width` columns. An
 * unknown side is "?", and both unknown is empty. `tiered` adds a `+` for
 * context-priced tiers above the first; when the pair does not fit, the `+`
 * goes first, then the pair is cut with "…".
 */
export function formatPriceCell(
  input: number | undefined,
  output: number | undefined,
  tiered: boolean,
  width: number = PRICE_CELL_WIDTH,
): string {
  if (input === undefined && output === undefined) return "";
  const columns = Math.max(0, Math.floor(width));
  const side = (value: number | undefined): string =>
    value === undefined ? "?" : formatPrice(value);
  // Matched cents read better, but each side's own format is shorter; it
  // comes before a cut.
  const pairs = [
    formatPricePair(input, output),
    `${side(input)}/${side(output)}`,
  ];
  for (const pair of pairs) {
    const full = tiered ? `${pair}+` : pair;
    if (full.length <= columns) return full;
  }
  for (const pair of pairs) if (pair.length <= columns) return pair;
  if (columns === 0) return "";
  const shortest = pairs[1] ?? "";
  return `${shortest.slice(0, columns - 1)}…`;
}

/**
 * An endpoint origin for display: without "https://", while "http://"
 * stays visible because it marks an endpoint without TLS.
 */
export function displayOrigin(origin: string): string {
  return origin.startsWith("https://")
    ? origin.slice("https://".length)
    : origin;
}

/** Format bytes as human-readable: 20285680936 → "18.9 GB" */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

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

/** A one- or two-digit token, a candidate half of a version number. */
const SHORT_NUMBER = /^\d{1,2}$/;

/**
 * Join a pair of short numeric tokens into one version ("4", "5" → "4.5"),
 * so "claude-sonnet-4-5" reads "Claude Sonnet 4.5". Runs that follow another
 * number or continue past two parts (dates such as "2024-08-06") stay apart.
 */
function joinVersionParts(tokens: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const previous = tokens[index - 1];
    const after = tokens[index + 2];
    if (
      SHORT_NUMBER.test(token) &&
      next !== undefined &&
      SHORT_NUMBER.test(next) &&
      (previous === undefined || !/^\d+$/.test(previous)) &&
      (after === undefined || !/^\d+$/.test(after))
    ) {
      result.push(`${token}.${next}`);
      index += 1;
      continue;
    }
    result.push(token);
  }
  return result;
}

/**
 * Format model ID for display.
 * Turns "qwen/qwen3-30b-a3b" into "Qwen3 30B A3B".
 */
export function formatModelName(id: string): string {
  // Extract part after slash (if any)
  const slash = id.indexOf("/");
  const modelPart = slash > 0 ? id.slice(slash + 1) : id;

  return joinVersionParts(modelPart.split(/[-_:]/).filter(Boolean))
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
