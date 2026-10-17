import { describe, expect, it } from "vitest";
import {
  knownScalar,
  unknownCapability,
  unknownScalar,
  type CapabilityEvidence,
  type CatalogProviderRecord,
  type ProviderFailure,
  type ProviderFailureKind,
} from "../src/catalog-evidence";
import {
  capabilityCell,
  failureLabel,
  failureSentences,
  helpLines,
  modelDetailLines,
  modelEvidenceLines,
  modelSummaryLine,
  needsAttention,
  providerDetailLines,
  providerEvidenceLines,
  providerStatus,
  relativeAge,
  wrapText,
  type Line,
} from "../src/tui-detail";
import type { ModelRow, ProviderGroup } from "../src/tui-models";

const NOW = Date.parse("2026-10-11T08:10:00.000Z");
const AT = "2026-10-11T08:00:00.000Z";

const CONFIRMED: CapabilityEvidence = {
  state: "supported",
  source: "provider-probe",
  strength: "authoritative",
};
const ASSUMED: CapabilityEvidence = {
  state: "supported",
  source: "host-default",
  strength: "assumed",
};
const INFERRED: CapabilityEvidence = {
  state: "supported",
  source: "models.dev",
  strength: "inferred",
};
const UNSUPPORTED: CapabilityEvidence = {
  state: "unsupported",
  source: "provider-probe",
  strength: "authoritative",
};

function inputs(overrides: Partial<NonNullable<ModelRow["inputModalities"]>>) {
  return {
    text: unknownCapability(),
    image: unknownCapability(),
    pdf: unknownCapability(),
    audio: unknownCapability(),
    video: unknownCapability(),
    ...overrides,
  };
}

function model(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id: "m-1",
    name: "Model One",
    enabled: true,
    type: "llm",
    context: 128_000,
    output: 16_000,
    flags: [],
    capabilities: {
      toolCall: unknownCapability(),
      reasoning: unknownCapability(),
      temperature: unknownCapability(),
    },
    inputModalities: inputs({}),
    ...overrides,
  };
}

function group(overrides: Partial<ProviderGroup> = {}): ProviderGroup {
  return {
    id: "atlas",
    provider: "Atlas",
    hasEvidence: true,
    endpoint: "https://atlas.test",
    models: [model()],
    ...overrides,
  };
}

function record(
  overrides: Partial<CatalogProviderRecord> = {},
): CatalogProviderRecord {
  return {
    id: "atlas",
    endpointOrigin: unknownScalar(),
    configuredProbe: unknownScalar(),
    resolvedProbe: unknownScalar(),
    lastGoodAt: AT,
    failure: null,
    modelListAttempt: "ready",
    probeAttempt: "complete",
    skippedModelIds: [],
    models: [],
    discovering: false,
    lastAttemptAt: AT,
    nextRefreshAt: null,
    credentialSource: "connection",
    credentialEpoch: 1,
    resultEpoch: 1,
    ...overrides,
  };
}

function failure(
  kind: ProviderFailureKind,
  httpStatus?: number,
): ProviderFailure {
  return { kind, at: AT, ...(httpStatus ? { httpStatus } : {}) };
}

/** Each line's text, joined, with trailing padding removed. */
function text(lines: readonly Line[]): string[] {
  return lines.map((line) =>
    line
      .map((segment) => segment.text)
      .join("")
      .trimEnd(),
  );
}

/** Every line joined by spaces with runs of spaces collapsed, for wrapped text. */
function flat(lines: readonly Line[]): string {
  return text(lines).join(" ").replace(/ +/g, " ");
}

/** The role of the first non-label segment on the line that contains `needle`. */
function roleOf(lines: readonly Line[], needle: string): string | undefined {
  const line = lines.find((item) =>
    item.some((segment) => segment.text.includes(needle)),
  );
  return line?.find((segment) => segment.text.includes(needle))?.role;
}

describe("failureLabel and failureSentences", () => {
  // Every v5 failure kind, with the header label and the detail headline it gets.
  const kinds: readonly [
    ProviderFailureKind,
    number | undefined,
    string,
    string,
    string,
  ][] = [
    ["unauthorized", 401, "▲ key rejected", "Key rejected (401)", "error"],
    ["forbidden", 403, "▲ access denied", "Access denied (403)", "error"],
    [
      "payment-required",
      402,
      "▲ budget blocked",
      "Budget or entitlement blocked (402)",
      "warn",
    ],
    [
      "rate-limited",
      429,
      "▲ rate limited",
      "Catalog rate limited (429)",
      "warn",
    ],
    [
      "not-found",
      404,
      "▲ no model list",
      "No model list at this endpoint (404)",
      "warn",
    ],
    ["server-error", 503, "▲ server error", "Server error (503)", "warn"],
    [
      "http-error",
      418,
      "▲ unexpected answer",
      "Unexpected answer (418)",
      "warn",
    ],
    [
      "unreachable",
      undefined,
      "▲ unreachable",
      "Can't reach https://atlas.test",
      "warn",
    ],
    [
      "timeout",
      undefined,
      "▲ timed out",
      "https://atlas.test did not answer in time",
      "warn",
    ],
    [
      "aborted",
      undefined,
      "▲ interrupted",
      "Discovery was interrupted",
      "warn",
    ],
    [
      "invalid-response",
      undefined,
      "▲ invalid answer",
      "Invalid model list",
      "warn",
    ],
    ["error", undefined, "▲ failed", "Discovery failed", "warn"],
  ];

  it.each(kinds)(
    "labels %s and explains it",
    (kind, status, label, headline, role) => {
      const item = failure(kind, status);
      const short = failureLabel(item);
      expect(short.text).toBe(label);
      expect(short.text.startsWith("▲ ")).toBe(true);
      const sentences = failureSentences(item, "https://atlas.test", undefined);
      expect(sentences.headline).toBe(headline);
      expect(sentences.role).toBe(role);
      expect(sentences.advice.length).toBeGreaterThan(0);
    },
  );

  it("colors only rejected and denied keys as errors in the header", () => {
    const errors = kinds
      .filter(
        ([kind, status]) =>
          failureLabel(failure(kind, status)).role === "error",
      )
      .map(([kind]) => kind);
    expect(errors).toEqual(["unauthorized", "forbidden"]);
  });

  it("counts a rate limit down when the wait is known and says it limits the list, not inference", () => {
    const sentences = failureSentences(
      failure("rate-limited", 429),
      undefined,
      42,
    );
    expect(sentences.headline).toBe("Catalog rate limited · retry in 42 s");
    expect(sentences.advice).toContain("not inference");
  });

  it("names the endpoint generically when the origin is unknown", () => {
    expect(
      failureSentences(failure("unreachable"), undefined, undefined).headline,
    ).toBe("Can't reach the endpoint");
    expect(
      failureSentences(failure("timeout"), undefined, undefined).headline,
    ).toBe("the endpoint did not answer in time");
  });

  it("uses timeout wording only for the timeout kind", () => {
    for (const [kind, status] of kinds) {
      if (kind === "timeout") continue;
      const sentences = failureSentences(
        failure(kind, status),
        "https://atlas.test",
        undefined,
      );
      expect(`${sentences.headline} ${sentences.advice}`).not.toMatch(
        /time(d)? ?out|in time/i,
      );
    }
  });

  it("falls back to a class word when an HTTP kind carries no status", () => {
    expect(
      failureSentences(failure("server-error"), undefined, undefined).headline,
    ).toBe("Server error (5xx)");
    expect(
      failureSentences(failure("http-error"), undefined, undefined).headline,
    ).toBe("Unexpected answer (HTTP)");
  });
});

describe("providerStatus", () => {
  it("shows nothing for a provider scout has no record of", () => {
    expect(providerStatus(undefined)).toBeUndefined();
  });

  it("shows checking while discovering, even over a current failure", () => {
    expect(
      providerStatus(
        record({ discovering: true, failure: failure("unauthorized", 401) }),
      ),
    ).toEqual({ text: "○ checking", role: "info" });
  });

  it("shows waiting before the first result", () => {
    expect(
      providerStatus(
        record({ lastGoodAt: null, resultEpoch: null, credentialEpoch: 0 }),
      ),
    ).toEqual({ text: "○ waiting", role: "info" });
    expect(providerStatus(record({ lastGoodAt: null }))).toEqual({
      text: "○ waiting",
      role: "info",
    });
  });

  it("shows a current failure over the last good inventory", () => {
    expect(
      providerStatus(record({ failure: failure("rate-limited", 429) }))?.text,
    ).toBe("▲ rate limited");
  });
});

describe("needsAttention", () => {
  it("is true only for a failure that belongs to the current credential", () => {
    expect(needsAttention(undefined)).toBe(false);
    expect(needsAttention(record())).toBe(false);
    expect(needsAttention(record({ failure: failure("timeout") }))).toBe(true);
    expect(
      needsAttention(
        record({
          failure: failure("timeout"),
          credentialEpoch: 2,
          resultEpoch: 1,
        }),
      ),
    ).toBe(false);
  });
});

describe("relativeAge", () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
    ["not a date", undefined],
    ["2026-10-11T08:09:30.000Z", "just now"],
    // A server clock ahead of the client still reads as just now.
    ["2026-10-11T08:20:00.000Z", "just now"],
    ["2026-10-11T08:06:00.000Z", "4 min ago"],
    ["2026-10-11T06:10:00.000Z", "2 h ago"],
    ["2026-10-09T08:10:00.000Z", "on 2026-10-09"],
  ])("reads %s as %s", (iso, expected) => {
    expect(relativeAge(iso, NOW)).toBe(expected);
  });
});

describe("capabilityCell", () => {
  it.each([
    ["confirmed", "T", "base"],
    ["assumed", "t", "muted"],
    ["inferred", "t", "muted"],
    ["unsupported", "·", "faint"],
    ["not-reported", "·", "faint"],
  ] as const)("renders %s as %s", (certainty, letter, role) => {
    expect(capabilityCell(certainty, "t")).toEqual({ text: letter, role });
  });
});

describe("modelDetailLines", () => {
  const detail = (
    row: ModelRow,
    extra: { current?: boolean; pickerBlocked?: string } = {},
  ) =>
    modelDetailLines(group(), row, {
      width: 49,
      current: extra.current ?? false,
      ...(extra.pickerBlocked ? { pickerBlocked: extra.pickerBlocked } : {}),
    });

  it("marks the current model, and otherwise says why the picker is blocked", () => {
    expect(
      text(detail(model(), { current: true, pickerBlocked: "blocked" })),
    ).toContain("● Current model");
    const blocked = text(
      detail(model(), { pickerBlocked: "Not in OpenCode's model list yet" }),
    );
    expect(blocked).toContain("Not in OpenCode's model list yet");
    expect(blocked).not.toContain("● Current model");
  });

  it("explains OpenCode's assumed context default and an unknown output limit", () => {
    const lines = detail(
      model({
        context: 200_000,
        output: undefined,
        provenance: {
          context: knownScalar(200_000, "host-default", "assumed"),
        },
      }),
    );
    expect(flat(lines)).toContain(
      "Context Not reported; OpenCode uses 200,000",
    );
    expect(flat(lines)).toContain(
      "Max output Not reported; OpenCode fits output to the remaining context",
    );
    expect(roleOf(lines, "OpenCode uses")).toBe("faint");
  });

  it("labels inferred limits and an assumed output limit", () => {
    const lines = text(
      detail(
        model({
          provenance: {
            context: knownScalar(128_000, "models.dev", "inferred"),
            output: knownScalar(16_000, "host-default", "assumed"),
          },
        }),
      ),
    );
    expect(lines).toContain("Context       128K tokens (inferred)");
    expect(lines).toContain("Max output    16K tokens (assumed)");
  });

  it("says Not reported for a context no source states", () => {
    expect(text(detail(model({ context: undefined })))).toContain(
      "Context       Not reported",
    );
  });

  it("groups capabilities by certainty", () => {
    const lines = text(
      detail(
        model({
          capabilities: {
            toolCall: CONFIRMED,
            reasoning: INFERRED,
            temperature: ASSUMED,
          },
          inputModalities: inputs({ image: UNSUPPORTED, pdf: CONFIRMED }),
        }),
      ),
    );
    expect(lines).toContain("Supports      tools, PDFs");
    expect(lines).toContain("Assumed       temperature (OpenCode default)");
    expect(lines.join("\n")).toMatch(
      /Inferred +reasoning \(from models\.dev or/,
    );
    expect(lines).toContain("Not supported images");
    expect(lines).toContain("Not reported  audio, video");
  });

  it("treats a host denial of temperature as unsupported", () => {
    const lines = text(detail(model({ hostTemperature: false })));
    expect(lines).toContain("Not supported temperature");
  });

  it("shows an embedding model's type instead of output and capabilities", () => {
    const lines = text(
      detail(
        model({
          type: "embedding",
          capabilities: {
            toolCall: CONFIRMED,
            reasoning: unknownCapability(),
            temperature: unknownCapability(),
          },
        }),
      ),
    );
    expect(lines.join(" ").replace(/ +/g, " ")).toContain(
      "Type Embedding model; not available for chat",
    );
    expect(lines.some((line) => line.startsWith("Max output"))).toBe(false);
    expect(lines.some((line) => line.startsWith("Supports"))).toBe(false);
  });

  it("prints prices with fixed decimals, cache prices, and every context tier", () => {
    const lines = text(
      detail(
        model({
          cost: {
            input: knownScalar(3, "unmatched-host", "unmatched"),
            output: knownScalar(15, "unmatched-host", "unmatched"),
            cacheRead: knownScalar(0.3, "unmatched-host", "unmatched"),
            cacheWrite: unknownScalar(),
          },
          priceTiers: [{ above: 200_000, input: 6, output: 22.5 }],
        }),
      ),
    );
    expect(lines).toContain("Price per 1M  $3.00 in · $15.00 out");
    expect(lines).toContain("Cache per 1M  $0.30 read · write not reported");
    expect(lines).toContain("Above 200K    $6.00 in · $22.50 out");
  });

  it("keeps a tier's cache prices on its own threshold line", () => {
    const lines = text(
      detail(
        model({
          priceTiers: [
            {
              above: 200_000,
              input: 6,
              output: 22.5,
              cacheRead: 0.6,
              cacheWrite: 7.5,
            },
            { above: 1_000_000, cacheRead: 1.2 },
          ],
        }),
      ),
    );
    expect(lines).toContain(
      "Above 200K    $6.00 in · $22.50 out · cache $0.60",
    );
    expect(lines).toContain("              read · $7.50 write");
    expect(lines).toContain("Above 1M      cache $1.20 read · write not");
    expect(lines).toContain("              reported");
  });

  it("says Not reported for an unpriced model", () => {
    const lines = detail(model());
    expect(text(lines)).toContain("Price per 1M  Not reported");
    expect(roleOf(lines, "Not reported")).toBe("faint");
  });

  it("shows the provider with its origin but no scheme, and notes a model hidden from the picker", () => {
    const lines = text(
      detail(
        model({ enabled: false, family: "llama", quantization: "Q4_K_M" }),
      ),
    );
    expect(lines).toContain("Provider      Atlas · atlas.test");
    expect(lines).toContain("Family        llama · Q4_K_M");
    expect(lines).toContain(
      "Picker        Hidden from OpenCode's model picker",
    );
  });
});

describe("modelSummaryLine", () => {
  const summary = (row: ModelRow): string =>
    modelSummaryLine(row)
      .map((segment) => segment.text)
      .join("");

  it("puts name, price, output, then confirmed capabilities", () => {
    expect(
      summary(
        model({
          cost: {
            input: knownScalar(3, "unmatched-host", "unmatched"),
            output: unknownScalar(),
            cacheRead: unknownScalar(),
            cacheWrite: unknownScalar(),
          },
          capabilities: {
            toolCall: CONFIRMED,
            reasoning: ASSUMED,
            temperature: unknownCapability(),
          },
        }),
      ),
    ).toBe("Model One · $3/? per 1M · 16K out · tools");
  });

  it("calls an embedding model one and skips output and capabilities", () => {
    expect(summary(model({ type: "embedding" }))).toBe(
      "Model One · embedding model",
    );
  });

  it("leaves out an output limit no source reports", () => {
    expect(summary(model({ output: undefined }))).toBe("Model One");
  });
});

describe("providerDetailLines", () => {
  const detail = (
    rec: CatalogProviderRecord | undefined,
    extra: {
      serverAvailable?: boolean;
      retryInSeconds?: number;
      group?: ProviderGroup;
    } = {},
  ): string[] =>
    text(
      providerDetailLines(extra.group ?? group(), rec, {
        width: 72,
        now: NOW,
        serverAvailable: extra.serverAvailable ?? true,
        ...(extra.retryInSeconds === undefined
          ? {}
          : { retryInSeconds: extra.retryInSeconds }),
      }),
    );

  it("says discovery details are unavailable without scout's server half, and offers no refresh", () => {
    const lines = detail(record(), { serverAvailable: false });
    expect(lines).toContain(
      "Discovery details unavailable; showing OpenCode's model list.",
    );
    expect(lines.some((line) => line.startsWith("Refresh"))).toBe(false);
  });

  it("says when scout has no record of the provider", () => {
    const lines = detail(undefined);
    expect(lines).toContain(
      "Not discovered by scout; showing OpenCode's model list.",
    );
    expect(lines.some((line) => line.startsWith("Key"))).toBe(false);
  });

  it("shows checking while discovery runs", () => {
    expect(detail(record({ discovering: true }))).toContain(
      "○ Checking the model list…",
    );
  });

  it.each([
    ["an unresolved credential", { credentialSource: "unresolved" as const }],
    [
      "a result from an earlier credential",
      { credentialEpoch: 2, failure: failure("unauthorized", 401) },
    ],
  ])("waits for the current credential with %s", (_label, overrides) => {
    const lines = detail(record(overrides));
    expect(lines).toContain("○ Waiting for the current credential");
    expect(lines.join("\n")).not.toContain("Key rejected");
  });

  it("explains a current failure, its age, and the last good models", () => {
    const lines = detail(
      record({
        failure: failure("unauthorized", 401),
        lastAttemptAt: "2026-10-11T08:05:00.000Z",
      }),
    );
    expect(lines).toContain("▲ Key rejected (401) · checked 5 min ago");
    expect(lines.join(" ")).toContain(
      "Fix settings.apiKey or connect another key, then press r.",
    );
    expect(lines).toContain(
      "Showing 1 model from the last good check, 10 min ago.",
    );
  });

  it("does not claim a last good check before any success", () => {
    const lines = detail(
      record({ failure: failure("unreachable"), lastGoodAt: null }),
    );
    expect(lines).toContain(
      "▲ Can't reach https://atlas.test · checked 10 min ago",
    );
    expect(lines.join("\n")).not.toContain("last good check");
  });

  it("passes the throttle wait into the rate-limit headline and the refresh line", () => {
    const lines = detail(record({ failure: failure("rate-limited", 429) }), {
      retryInSeconds: 30,
    });
    expect(lines[2]).toMatch(/^▲ Catalog rate limited · retry in 30 s/);
    expect(lines).toContain("Refresh       available in 30 s");
  });

  it("shows ready with its age and r now", () => {
    const lines = detail(record());
    expect(lines).toContain("● Ready · checked 10 min ago");
    expect(lines).toContain("Refresh       r now");
  });

  it.each([
    ["connection", "connected key"],
    ["settings", "settings.apiKey"],
    ["headers", "provider headers"],
    ["none", "no key"],
    ["unresolved", "not resolved yet"],
  ] as const)("names the %s credential source", (source, words) => {
    expect(detail(record({ credentialSource: source }))).toContain(
      `Key           ${words}`,
    );
  });

  it("counts chat, embedding, and declared models and names the server type", () => {
    const lines = detail(record(), {
      group: group({
        resolvedProbe: "vllm",
        models: [
          model({ origin: "pre-existing" }),
          model({ id: "m-2" }),
          model({ id: "e", type: "embedding" }),
        ],
      }),
    });
    expect(lines).toContain("Server type   vLLM, detected automatically");
    expect(lines).toContain("Models        2 chat · 1 embedding");
    expect(lines).toContain("Unchanged     1 declared in your config");
  });

  it.each([
    [{ configuredProbe: "omlx", resolvedProbe: "omlx" }, "oMLX"],
    [{ configuredProbe: "omlx" }, "oMLX (not resolved yet)"],
    [{}, "OpenAI-compatible, no probe"],
  ])("describes the server type for %j", (probes, words) => {
    expect(detail(record(), { group: group(probes) })).toContain(
      `Server type   ${words}`,
    );
  });

  it("says none for a provider with no models and lists each warning once", () => {
    const lines = detail(record(), {
      group: group({
        models: [],
        warnings: [
          "not in the server's discovery catalog",
          "not in the server's discovery catalog",
        ],
      }),
    });
    expect(lines).toContain("Models        none");
    expect(
      lines.filter((line) => line.includes("discovery catalog")),
    ).toHaveLength(1);
  });
});

describe("modelEvidenceLines", () => {
  it("lists each field with its value and source, and dashes for unknowns", () => {
    const lines = text(
      modelEvidenceLines(
        group({ configuredProbe: "vllm", resolvedProbe: "vllm" }),
        model({
          origin: "discovered",
          quantization: "Q4_K_M",
          context: 200_000,
          capabilities: {
            toolCall: ASSUMED,
            reasoning: unknownCapability(),
            temperature: unknownCapability(),
          },
          provenance: {
            context: knownScalar(200_000, "host-default", "assumed"),
            quantization: knownScalar("Q4_K_M", "provider-probe", "reported"),
          },
        }),
        72,
      ),
    );
    expect(lines.join("\n")).toMatch(/Context +200,000 +OpenCode default/);
    expect(lines.join("\n")).toMatch(/Quantization +Q4_K_M +probe/);
    expect(lines.join("\n")).toMatch(/Tools +supported +OpenCode default/);
    expect(lines.join("\n")).toMatch(/Reasoning +not reported +—/);
    expect(lines.join("\n")).toMatch(/Input price +not reported +—/);
    expect(lines).toContain("Origin        discovered by scout");
    expect(lines).toContain("Probe         vllm → vllm");
    expect(lines).toContain("Endpoint      https://atlas.test");
    expect(lines).toContain("Conflicts     none");
  });

  it.each([
    ["pre-existing", "declared in your config; scout leaves it unchanged"],
    [undefined, "OpenCode only; no discovery record"],
  ] as const)("describes origin %s", (origin, words) => {
    expect(
      text(
        modelEvidenceLines(group(), model(origin ? { origin } : {}), 72),
      ).join("\n"),
    ).toMatch(new RegExp(`Origin +${words.replace(/[.;]/g, "\\$&")}`));
  });

  it("lists every conflict and omits the probe line without probes", () => {
    const lines = text(
      modelEvidenceLines(
        group(),
        model({ warnings: ["first conflict", "second conflict"] }),
        72,
      ),
    );
    expect(lines).toContain("Conflicts     first conflict");
    expect(lines).toContain("              second conflict");
    expect(lines.some((line) => /^Probe {9}/.test(line))).toBe(false);
  });
});

describe("providerEvidenceLines", () => {
  it("says the rows come from OpenCode without a record", () => {
    expect(text(providerEvidenceLines(group(), undefined, 72))).toContain(
      "No discovery record; these rows come from OpenCode's model list.",
    );
  });

  it("lists attempts, timings, the failure with status and retry time, and epochs", () => {
    const lines = text(
      providerEvidenceLines(
        group(),
        record({
          failure: {
            kind: "rate-limited",
            at: AT,
            httpStatus: 429,
            retryAt: "2026-10-11T08:01:30.000Z",
          },
          nextRefreshAt: "2026-10-11T08:01:30.000Z",
          skippedModelIds: ["a", "b"],
          resultEpoch: null,
        }),
        72,
      ),
    );
    expect(lines).toContain(`Failure       rate-limited (429) at ${AT}`);
    expect(lines).toContain("Retry after   2026-10-11T08:01:30.000Z");
    expect(lines).toContain("Next refresh  2026-10-11T08:01:30.000Z");
    expect(lines).toContain("Skipped       2 model IDs");
    expect(lines).toContain("Epochs        credential 1 · result none");
  });

  it("says any time and none when nothing is throttled or failed", () => {
    const lines = text(providerEvidenceLines(group(), record(), 72));
    expect(lines).toContain("Next refresh  any time");
    expect(lines).toContain("Failure       none");
    expect(lines.some((line) => line.startsWith("Retry after"))).toBe(false);
  });
});

describe("wrapText and helpLines", () => {
  it("breaks at spaces and keeps a word longer than the line whole", () => {
    expect(wrapText("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrapText("supercalifragilistic", 5)).toEqual([
      "supercalifragilistic",
    ]);
    expect(wrapText("", 10)).toEqual([""]);
  });

  it("turns control characters into spaces instead of line breaks", () => {
    expect(wrapText("a\nb", 10)).toEqual(["a b"]);
  });

  it("wraps a long action under itself, past the key column", () => {
    const lines = text(
      helpLines(
        "Keys",
        [{ keys: "x", action: "clear search and filters now" }],
        41,
      ),
    );
    expect(lines[0]).toBe("Keys");
    expect(lines[2]).toBe(`${"x".padEnd(25)}clear search and`);
    expect(lines[3]).toBe(`${" ".repeat(25)}filters now`);
  });
});
