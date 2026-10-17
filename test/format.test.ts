import { describe, it, expect } from "vitest";
import {
  PRICE_CELL_WIDTH,
  compactCount,
  extractModelOwner,
  formatBytes,
  formatContextCell,
  formatDetailPrice,
  formatModelName,
  formatNumber,
  formatPrice,
  formatPriceCell,
  formatPricePair,
} from "../src/format";

describe("formatNumber", () => {
  it("should format numbers with commas", () => {
    expect(formatNumber(262144)).toBe("262,144");
    expect(formatNumber(42)).toBe("42");
  });
});

describe("formatBytes", () => {
  it("should pick the unit by magnitude", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1572864)).toBe("1.5 MB");
    expect(formatBytes(20285680936)).toBe("18.9 GB");
  });
});

describe("compactCount", () => {
  it("compacts thousands and millions", () => {
    expect(compactCount(262144)).toBe("262K");
    expect(compactCount(1000000)).toBe("1M");
    expect(compactCount(1500000)).toBe("1.5M");
  });

  it("passes small values through with commas", () => {
    expect(compactCount(512)).toBe("512");
  });

  it("rolls over to millions instead of rendering 1000K", () => {
    expect(compactCount(999999)).toBe("1M");
    expect(compactCount(999499)).toBe("999K");
  });

  it("drops a trailing .0 from millions", () => {
    expect(compactCount(1_048_576)).toBe("1M");
    expect(compactCount(2_000_000)).toBe("2M");
    expect(compactCount(2_400_000)).toBe("2.4M");
  });
});

describe("formatContextCell", () => {
  it("marks OpenCode's assumed default with a tilde", () => {
    expect(formatContextCell(200_000, true)).toBe("~200K");
  });

  it("shows a reported limit plainly", () => {
    expect(formatContextCell(200_000, false)).toBe("200K");
    expect(formatContextCell(1_048_576, false)).toBe("1M");
  });
});

describe("formatPrice", () => {
  it("shows integers bare", () => {
    expect(formatPrice(3)).toBe("$3");
    expect(formatPrice(15)).toBe("$15");
    expect(formatPrice(0)).toBe("$0");
  });

  it("uses up to two decimals under 10, trimming trailing zeros", () => {
    expect(formatPrice(1.25)).toBe("$1.25");
    expect(formatPrice(1.256)).toBe("$1.26");
    expect(formatPrice(0.6)).toBe("$0.6");
    expect(formatPrice(0.1)).toBe("$0.1");
  });

  it("uses up to one decimal from 10, trimming a trailing zero", () => {
    expect(formatPrice(12.5)).toBe("$12.5");
    expect(formatPrice(12.34)).toBe("$12.3");
    expect(formatPrice(10.04)).toBe("$10");
  });

  it("uses three significant digits under 0.1", () => {
    expect(formatPrice(0.075)).toBe("$0.075");
    expect(formatPrice(0.01234)).toBe("$0.0123");
    expect(formatPrice(0.0001234)).toBe("$0.000123");
    expect(formatPrice(0.05)).toBe("$0.05");
  });

  it.each([0.0049, 0.001, 1e-9])(
    "never shows the nonzero price %s as $0",
    (value) => {
      const text = formatPrice(value);
      expect(text).not.toBe("$0");
      expect(Number(text.slice(1))).toBeGreaterThan(0);
    },
  );

  it("formats an extremely small nonzero price without throwing", () => {
    expect(() => formatPrice(1e-120)).not.toThrow();
    expect(formatPrice(1e-120)).not.toBe("$0");
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "shows %s as unknown",
    (value) => {
      expect(formatPrice(value)).toBe("?");
    },
  );
});

describe("formatDetailPrice", () => {
  it("uses two fixed decimals from 0.1", () => {
    expect(formatDetailPrice(3)).toBe("$3.00");
    expect(formatDetailPrice(15)).toBe("$15.00");
    expect(formatDetailPrice(0.6)).toBe("$0.60");
    expect(formatDetailPrice(0.1)).toBe("$0.10");
  });

  it("shows zero with two decimals", () => {
    expect(formatDetailPrice(0)).toBe("$0.00");
  });

  it("uses three significant digits under 0.1", () => {
    expect(formatDetailPrice(0.075)).toBe("$0.075");
    expect(formatDetailPrice(0.0001234)).toBe("$0.000123");
  });

  it("never shows fewer than two decimals under 0.1", () => {
    expect(formatDetailPrice(0.05)).toBe("$0.05");
    // Three significant digits round 0.09999 up to 0.1.
    expect(formatDetailPrice(0.09999)).toBe("$0.10");
  });

  it("formats an extremely small nonzero price without throwing", () => {
    expect(() => formatDetailPrice(1e-120)).not.toThrow();
  });

  it.each([-0.5, Number.NaN, Number.NEGATIVE_INFINITY])(
    "shows %s as unknown",
    (value) => {
      expect(formatDetailPrice(value)).toBe("?");
    },
  );
});

describe("formatPriceCell", () => {
  it("is 15 columns wide by default", () => {
    expect(PRICE_CELL_WIDTH).toBe(15);
  });

  it("joins input and output prices", () => {
    expect(formatPriceCell(3, 15, false)).toBe("$3/$15");
    expect(formatPriceCell(2.5, 10, false)).toBe("$2.50/$10.00");
  });

  it("gives both sides cents when one side shows cents", () => {
    expect(formatPricePair(0.15, 0.6)).toBe("$0.15/$0.60");
    expect(formatPricePair(1.25, 10)).toBe("$1.25/$10.00");
    expect(formatPricePair(12.5, 3)).toBe("$12.50/$3.00");
    expect(formatPricePair(1, 5)).toBe("$1/$5");
    // Three significant digits stay; the other side gets cents.
    expect(formatPricePair(0.075, 0.3)).toBe("$0.075/$0.30");
    expect(formatPricePair(0.15, undefined)).toBe("$0.15/?");
  });

  it("adds + for context-priced tiers", () => {
    expect(formatPriceCell(3, 15, true)).toBe("$3/$15+");
  });

  it("shows ? for an unknown side and nothing when both are unknown", () => {
    expect(formatPriceCell(3, undefined, false)).toBe("$3/?");
    expect(formatPriceCell(undefined, 15, true)).toBe("?/$15+");
    expect(formatPriceCell(undefined, undefined, true)).toBe("");
  });

  it("shows ? for an invalid price", () => {
    expect(formatPriceCell(-1, 2, false)).toBe("?/$2");
  });

  it("drops the + first when the tiered pair does not fit", () => {
    // "$1.25/$0.000123" is exactly 15 columns.
    expect(formatPriceCell(1.25, 0.0001234, true)).toBe("$1.25/$0.000123");
  });

  it("gives up matched cents before cutting a pair that does not fit", () => {
    // "$125.50/$600.00" is 15 columns; "$125.5/$600" fits in 14.
    expect(formatPricePair(125.5, 600)).toBe("$125.50/$600.00");
    expect(formatPriceCell(125.5, 600, false, 14)).toBe("$125.5/$600");
    expect(formatPriceCell(125.5, 600, true, 14)).toBe("$125.5/$600+");
    // Matched cents stay whenever they fit.
    expect(formatPriceCell(0.15, 0.6, false, 14)).toBe("$0.15/$0.60");
  });

  it("cuts a pair that still does not fit with an ellipsis", () => {
    const cell = formatPriceCell(0.0001234, 0.0004567, true);
    expect(cell).toBe("$0.000123/$0.0…");
    expect(cell).toHaveLength(PRICE_CELL_WIDTH);
  });

  it("honors a narrower width", () => {
    expect(formatPriceCell(3, 15, true, 6)).toBe("$3/$15");
    expect(formatPriceCell(3, 15, false, 4)).toBe("$3/…");
    expect(formatPriceCell(3, 15, false, 0)).toBe("");
  });
});

describe("extractModelOwner", () => {
  it("should extract owner from 'org/model' format", () => {
    expect(extractModelOwner("qwen/qwen3-30b")).toBe("qwen");
    expect(extractModelOwner("meta-llama/llama-3.1-8b")).toBe("meta-llama");
  });

  it("should return undefined for plain model IDs", () => {
    expect(extractModelOwner("qwen3-30b")).toBeUndefined();
    expect(extractModelOwner("llama3:8b")).toBeUndefined();
  });
});

describe("formatModelName", () => {
  it("should format model names with capitalization", () => {
    expect(formatModelName("qwen3-30b-a3b")).toBe("Qwen3 30B A3B");
  });

  it("should handle model IDs with owner prefix", () => {
    expect(formatModelName("qwen/qwen3-30b")).toBe("Qwen3 30B");
  });

  it("should uppercase known acronyms", () => {
    expect(formatModelName("nomic-embed-text")).toBe("NOMIC Embed Text");
  });

  it("should split on colons for Ollama-style IDs", () => {
    expect(formatModelName("qwen3:0.6b")).toBe("Qwen3 0.6B");
    expect(formatModelName("qwen3:30b-a3b")).toBe("Qwen3 30B A3B");
    expect(formatModelName("smollm2:135m")).toBe("Smollm2 135M");
  });

  it.each([
    ["claude-sonnet-4-5", "Claude Sonnet 4.5"],
    ["anthropic/claude-opus-4-1", "Claude Opus 4.1"],
    ["claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet 20241022"],
    ["llama-3-1-8b", "Llama 3.1 8B"],
    ["glm-4-5", "Glm 4.5"],
  ])("reads the paired version numbers in %s as one decimal", (id, name) => {
    expect(formatModelName(id)).toBe(name);
  });

  it.each([
    // A date: the pair follows another number.
    ["gpt-4o-2024-08-06", "GPT 4O 2024 08 06"],
    // Three short numbers in a row are not a version pair.
    ["model-1-2-3", "Model 1 2 3"],
    // Only one- and two-digit parts pair up.
    ["model-100-5", "Model 100 5"],
    // A lone number stays as it is.
    ["gemma-3-12b", "Gemma 3 12B"],
  ])("keeps the numbers in %s apart", (id, name) => {
    expect(formatModelName(id)).toBe(name);
  });
});
