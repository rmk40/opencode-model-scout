import type {
  CapabilityEvidence,
  CatalogProviderRecord,
  MetadataSource,
  ProviderFailure,
  ScalarEvidence,
} from "./catalog-evidence";
import {
  compactCount,
  formatBytes,
  formatDetailPrice,
  formatNumber,
  formatPrice,
  formatPriceCell,
} from "./format";
import { padText, sanitizeInline, textWidth, type Segment } from "./tui-list";
import {
  modelCertainty,
  type CapabilityName,
  type Certainty,
  type ModelRow,
  type ProviderGroup,
} from "./tui-models";
import type { ForegroundRole } from "./tui-theme";

/** One rendered line: role-tagged segments, left to right. */
export type Line = readonly Segment[];

const LABEL_COLUMNS = 14;

function seg(text: string, role: ForegroundRole = "base"): Segment {
  return { text, role };
}

/** Split `text` into lines of at most `width` columns, breaking at spaces. */
export function wrapText(text: string, width: number): string[] {
  const columns = Math.max(1, Math.floor(width));
  const words = sanitizeInline(text).split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (textWidth(next) <= columns) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/** A wrapped paragraph in one role. */
export function paragraph(
  text: string,
  width: number,
  role: ForegroundRole = "base",
): Line[] {
  return wrapText(text, width).map((line) => [seg(line, role)]);
}

/**
 * A `Label        value` line; a value too long for the line wraps under
 * itself, indented past the label.
 */
export function labeled(
  label: string,
  value: string,
  width: number,
  role: ForegroundRole = "base",
): Line[] {
  const valueWidth = Math.max(8, width - LABEL_COLUMNS);
  return wrapText(value, valueWidth).map((part, index) => [
    seg(
      index === 0 ? padText(label, LABEL_COLUMNS) : " ".repeat(LABEL_COLUMNS),
      "muted",
    ),
    seg(part, role),
  ]);
}

// ── Time ────────────────────────────────────────────────────────────────

/** "just now", "4 min ago", "2 h ago", or the date for anything older. */
export function relativeAge(
  iso: string | null | undefined,
  now: number,
): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `on ${new Date(at).toISOString().slice(0, 10)}`;
}

// ── Provider status ─────────────────────────────────────────────────────

export interface StatusLabel {
  readonly text: string;
  readonly role: ForegroundRole;
}

/** Short failure labels for provider header rows. */
export function failureLabel(failure: ProviderFailure): StatusLabel {
  switch (failure.kind) {
    case "unauthorized":
      return { text: "▲ key rejected", role: "error" };
    case "forbidden":
      return { text: "▲ access denied", role: "error" };
    case "payment-required":
      return { text: "▲ budget blocked", role: "warn" };
    case "rate-limited":
      return { text: "▲ rate limited", role: "warn" };
    case "not-found":
      return { text: "▲ no model list", role: "warn" };
    case "server-error":
      return { text: "▲ server error", role: "warn" };
    case "http-error":
      return { text: "▲ unexpected answer", role: "warn" };
    case "unreachable":
      return { text: "▲ unreachable", role: "warn" };
    case "timeout":
      return { text: "▲ timed out", role: "warn" };
    case "aborted":
      return { text: "▲ interrupted", role: "warn" };
    case "invalid-response":
      return { text: "▲ invalid answer", role: "warn" };
    case "error":
      return { text: "▲ failed", role: "warn" };
  }
}

/**
 * The status shown at the right edge of a provider header. A record whose
 * result belongs to an earlier credential, or that has none yet, shows as
 * checking rather than with the earlier result.
 */
export function providerStatus(
  record: CatalogProviderRecord | undefined,
): StatusLabel | undefined {
  if (!record) return undefined;
  if (record.discovering) return { text: "○ checking", role: "info" };
  if (record.credentialSource === "unresolved")
    return { text: "○ resolving", role: "info" };
  if (record.resultEpoch !== record.credentialEpoch)
    return { text: "○ waiting", role: "info" };
  if (record.failure) return failureLabel(record.failure);
  if (record.lastGoodAt) return { text: "● ready", role: "ok" };
  return { text: "○ waiting", role: "info" };
}

/** Whether a provider's latest discovery failed and needs the user. */
export function needsAttention(
  record: CatalogProviderRecord | undefined,
): boolean {
  return (
    record !== undefined &&
    record.failure !== null &&
    record.resultEpoch === record.credentialEpoch
  );
}

/** Headline and advice for a failed discovery, for provider details. */
export function failureSentences(
  failure: ProviderFailure,
  origin: string | undefined,
  retryInSeconds: number | undefined,
): { headline: string; advice: string; role: ForegroundRole } {
  const host = origin ?? "the endpoint";
  const status = failure.httpStatus;
  switch (failure.kind) {
    case "unauthorized":
      return {
        headline: "Key rejected (401)",
        advice:
          "The server refused the API key. Fix settings.apiKey or connect another key, then press r.",
        role: "error",
      };
    case "forbidden":
      return {
        headline: "Access denied (403)",
        advice: "The server accepted the key but did not allow the model list.",
        role: "error",
      };
    case "payment-required":
      return {
        headline: "Budget or entitlement blocked (402)",
        advice:
          "The server did not allow this catalog request. No balance or reset date is available through this key.",
        role: "warn",
      };
    case "rate-limited":
      return {
        headline:
          retryInSeconds === undefined
            ? "Catalog rate limited (429)"
            : `Catalog rate limited · retry in ${retryInSeconds} s`,
        advice: "This limits the model list only, not inference.",
        role: "warn",
      };
    case "not-found":
      return {
        headline: "No model list at this endpoint (404)",
        advice:
          "Check settings.baseURL: it should end at the API root that serves /models, usually /v1.",
        role: "warn",
      };
    case "server-error":
      return {
        headline: `Server error (${status ?? "5xx"})`,
        advice: "The server failed to list its models. Try again later.",
        role: "warn",
      };
    case "http-error":
      return {
        headline: `Unexpected answer (${status ?? "HTTP"})`,
        advice: "The model list request did not succeed.",
        role: "warn",
      };
    case "unreachable":
      return {
        headline: `Can't reach ${host}`,
        advice:
          "Check the network, VPN, or proxy and settings.baseURL, then press r.",
        role: "warn",
      };
    case "timeout":
      return {
        headline: `${host} did not answer in time`,
        advice: "The model list timed out. Check the server, then press r.",
        role: "warn",
      };
    case "aborted":
      return {
        headline: "Discovery was interrupted",
        advice: "It runs again on the next refresh.",
        role: "warn",
      };
    case "invalid-response":
      return {
        headline: "Invalid model list",
        advice:
          "The endpoint answered, but not with an OpenAI-compatible model list.",
        role: "warn",
      };
    case "error":
      return {
        headline: "Discovery failed",
        advice: "It runs again on the next refresh.",
        role: "warn",
      };
  }
}

// ── Capabilities ────────────────────────────────────────────────────────

const CAPABILITY_WORDS: Readonly<Record<CapabilityName, string>> = {
  tools: "tools",
  image: "images",
  pdf: "PDFs",
  audio: "audio",
  video: "video",
  reasoning: "reasoning",
  temperature: "temperature",
  text: "text",
};

/** Capabilities in detail order; text input is implied for chat models. */
const DETAIL_CAPABILITIES: readonly CapabilityName[] = [
  "tools",
  "image",
  "pdf",
  "audio",
  "video",
  "reasoning",
  "temperature",
];

function capabilitiesBy(model: ModelRow, certainty: Certainty): string[] {
  const all = modelCertainty(model).capabilities;
  return DETAIL_CAPABILITIES.filter((name) => all[name] === certainty).map(
    (name) => CAPABILITY_WORDS[name],
  );
}

/** One capability letter: uppercase confirmed, lowercase uncertain, `·` otherwise. */
export function capabilityCell(certainty: Certainty, letter: string): Segment {
  switch (certainty) {
    case "confirmed":
      return seg(letter.toUpperCase(), "base");
    case "assumed":
    case "inferred":
      return seg(letter.toLowerCase(), "muted");
    case "unsupported":
    case "not-reported":
      return seg("·", "faint");
  }
}

// ── Prices ──────────────────────────────────────────────────────────────

function knownNumber(
  evidence: ScalarEvidence<number> | undefined,
): number | undefined {
  return evidence?.state === "known" ? evidence.value : undefined;
}

/** The model's list price cell, unpadded. */
export function priceCell(model: ModelRow, width?: number): string {
  return formatPriceCell(
    knownNumber(model.cost?.input),
    knownNumber(model.cost?.output),
    (model.priceTiers?.length ?? 0) > 0,
    width,
  );
}

function pricePair(
  input: number | undefined,
  output: number | undefined,
  inWord: string,
  outWord: string,
): string | undefined {
  if (input === undefined && output === undefined) return undefined;
  const side = (value: number | undefined, word: string): string =>
    value === undefined
      ? `${word} not reported`
      : `${formatDetailPrice(value)} ${word}`;
  return `${side(input, inWord)} · ${side(output, outWord)}`;
}

function priceLines(model: ModelRow, width: number): Line[] {
  const cost = model.cost;
  const lines: Line[] = [];
  const main = pricePair(
    knownNumber(cost?.input),
    knownNumber(cost?.output),
    "in",
    "out",
  );
  lines.push(
    ...labeled(
      "Price per 1M",
      main ?? "Not reported",
      width,
      main ? "base" : "faint",
    ),
  );
  const cache = pricePair(
    knownNumber(cost?.cacheRead),
    knownNumber(cost?.cacheWrite),
    "read",
    "write",
  );
  if (cache) lines.push(...labeled("Cache per 1M", cache, width));
  // Each tier's cache prices share its line, so they stay with its threshold.
  for (const tier of model.priceTiers ?? []) {
    const pair = pricePair(tier.input, tier.output, "in", "out");
    const tierCache = pricePair(
      tier.cacheRead,
      tier.cacheWrite,
      "read",
      "write",
    );
    const value = [pair, tierCache && `cache ${tierCache}`]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    if (value)
      lines.push(...labeled(`Above ${compactCount(tier.above)}`, value, width));
  }
  return lines;
}

// ── Model details ───────────────────────────────────────────────────────

export interface ModelDetailContext {
  readonly width: number;
  readonly current: boolean;
  /** Why `m` cannot open the picker for this model, if it cannot. */
  readonly pickerBlocked?: string;
}

function contextValue(model: ModelRow): { text: string; role: ForegroundRole } {
  const certainty = modelCertainty(model).context;
  if (model.context === undefined || certainty === "not-reported")
    return { text: "Not reported", role: "faint" };
  if (certainty === "assumed")
    return {
      text: `Not reported; OpenCode uses ${formatNumber(model.context)}`,
      role: "faint",
    };
  const suffix = certainty === "inferred" ? " (inferred)" : "";
  return {
    text: `${compactCount(model.context)} tokens${suffix}`,
    role: "base",
  };
}

function outputValue(model: ModelRow): { text: string; role: ForegroundRole } {
  const certainty = modelCertainty(model).output;
  if (model.output === undefined || certainty === "not-reported")
    return {
      text: "Not reported; OpenCode fits output to the remaining context",
      role: "faint",
    };
  if (certainty === "assumed")
    return {
      text: `${compactCount(model.output)} tokens (assumed)`,
      role: "faint",
    };
  const suffix = certainty === "inferred" ? " (inferred)" : "";
  return {
    text: `${compactCount(model.output)} tokens${suffix}`,
    role: "base",
  };
}

/** Plain-language details for one model, `width` columns wide. */
export function modelDetailLines(
  group: ProviderGroup,
  model: ModelRow,
  context: ModelDetailContext,
): Line[] {
  const { width } = context;
  const lines: Line[] = [];
  lines.push(...paragraph(model.name, width, "base"));
  lines.push(...paragraph(`${group.id}/${model.id}`, width, "muted"));
  if (context.current) lines.push([seg("● Current model", "current")]);
  else if (context.pickerBlocked)
    lines.push(...paragraph(context.pickerBlocked, width, "faint"));
  lines.push([]);

  const embedding = model.type === "embedding";
  const contextCell = contextValue(model);
  lines.push(...labeled("Context", contextCell.text, width, contextCell.role));
  if (!embedding) {
    const output = outputValue(model);
    lines.push(...labeled("Max output", output.text, width, output.role));
  }
  lines.push(...priceLines(model, width));
  lines.push([]);

  if (embedding) {
    lines.push(
      ...labeled("Type", "Embedding model; not available for chat", width),
    );
  } else {
    const supports = capabilitiesBy(model, "confirmed");
    const assumed = capabilitiesBy(model, "assumed");
    const inferred = capabilitiesBy(model, "inferred");
    const unsupported = capabilitiesBy(model, "unsupported");
    const unknown = capabilitiesBy(model, "not-reported");
    if (supports.length > 0)
      lines.push(...labeled("Supports", supports.join(", "), width));
    if (assumed.length > 0)
      lines.push(
        ...labeled(
          "Assumed",
          `${assumed.join(", ")} (OpenCode default)`,
          width,
          "muted",
        ),
      );
    if (inferred.length > 0)
      lines.push(
        ...labeled(
          "Inferred",
          `${inferred.join(", ")} (from models.dev or the name)`,
          width,
          "muted",
        ),
      );
    if (unsupported.length > 0)
      lines.push(...labeled("Not supported", unsupported.join(", "), width));
    if (unknown.length > 0)
      lines.push(
        ...labeled("Not reported", unknown.join(", "), width, "faint"),
      );
  }
  lines.push([]);

  const provider = group.endpoint
    ? `${group.provider} · ${group.endpoint.replace(/^https?:\/\//, "")}`
    : group.provider;
  lines.push(...labeled("Provider", provider, width));
  const descriptors = [
    model.family,
    model.parameterSize,
    model.quantization,
  ].filter((part): part is string => Boolean(part));
  if (descriptors.length > 0)
    lines.push(...labeled("Family", descriptors.join(" · "), width));
  if (model.sizeBytes !== undefined)
    lines.push(...labeled("Size", formatBytes(model.sizeBytes), width));
  if (!model.enabled && !embedding)
    lines.push(
      ...labeled(
        "Picker",
        "Hidden from OpenCode's model picker",
        width,
        "muted",
      ),
    );
  return lines;
}

/**
 * The one-line summary under the list below 120 columns: name, price,
 * output limit, then capabilities, so a cut at the right edge loses the
 * capability list first; the row already shows `T I R`.
 */
export function modelSummaryLine(model: ModelRow): Line {
  const parts: string[] = [model.name];
  const input = knownNumber(model.cost?.input);
  const output = knownNumber(model.cost?.output);
  if (input !== undefined || output !== undefined)
    parts.push(
      `${input === undefined ? "?" : formatPrice(input)}/${output === undefined ? "?" : formatPrice(output)} per 1M`,
    );
  if (model.type === "embedding") parts.push("embedding model");
  else {
    const certainty = modelCertainty(model).output;
    if (model.output !== undefined && certainty !== "not-reported")
      parts.push(`${compactCount(model.output)} out`);
    const supports = capabilitiesBy(model, "confirmed");
    if (supports.length > 0) parts.push(supports.join(", "));
  }
  return [
    seg(parts[0] ?? "", "base"),
    seg(parts.length > 1 ? ` · ${parts.slice(1).join(" · ")}` : "", "muted"),
  ];
}

// ── Provider details ────────────────────────────────────────────────────

export interface ProviderDetailContext {
  readonly width: number;
  readonly now: number;
  /** Seconds until a refresh may start, when one is throttled. */
  readonly retryInSeconds?: number;
  /** False when scout's server half did not answer. */
  readonly serverAvailable: boolean;
}

const PROBE_NAMES: Readonly<Record<string, string>> = {
  actualyze: "Actualyze",
  vllm: "vLLM",
  sglang: "SGLang",
  omlx: "oMLX",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  litellm: "LiteLLM",
};

function probeName(id: string): string {
  return PROBE_NAMES[id] ?? id;
}

function serverType(group: ProviderGroup): string {
  if (group.resolvedProbe) {
    const name = probeName(group.resolvedProbe);
    return group.configuredProbe ? name : `${name}, detected automatically`;
  }
  if (group.configuredProbe)
    return `${probeName(group.configuredProbe)} (not resolved yet)`;
  return "OpenAI-compatible, no probe";
}

function credentialWords(
  source: CatalogProviderRecord["credentialSource"],
): string {
  switch (source) {
    case "connection":
      return "connected key";
    case "settings":
      return "settings.apiKey";
    case "headers":
      return "provider headers";
    case "none":
      return "no key";
    case "unresolved":
      return "not resolved yet";
  }
}

/** Status, failure, and inventory of one provider, `width` columns wide. */
export function providerDetailLines(
  group: ProviderGroup,
  record: CatalogProviderRecord | undefined,
  context: ProviderDetailContext,
): Line[] {
  const { width, now } = context;
  const lines: Line[] = [];
  lines.push(...paragraph(group.provider, width, "base"));
  lines.push(
    ...paragraph(
      group.endpoint ? `${group.id} · ${group.endpoint}` : group.id,
      width,
      "muted",
    ),
  );
  const current =
    record !== undefined && record.resultEpoch === record.credentialEpoch;
  const checked = relativeAge(
    record?.lastAttemptAt ?? record?.failure?.at,
    now,
  );

  if (!context.serverAvailable) {
    lines.push(
      ...paragraph(
        "Discovery details unavailable; showing OpenCode's model list.",
        width,
        "warn",
      ),
    );
  } else if (!record) {
    lines.push(
      ...paragraph(
        "Not discovered by scout; showing OpenCode's model list.",
        width,
        "muted",
      ),
    );
  } else if (record.discovering) {
    lines.push([seg("○ Checking the model list…", "info")]);
  } else if (record.credentialSource === "unresolved" || !current) {
    lines.push([seg("○ Waiting for the current credential", "info")]);
  } else if (record.failure) {
    const sentences = failureSentences(
      record.failure,
      group.endpoint,
      context.retryInSeconds,
    );
    lines.push(
      ...paragraph(
        `▲ ${sentences.headline}${checked ? ` · checked ${checked}` : ""}`,
        width,
        sentences.role,
      ),
    );
    lines.push([]);
    lines.push(...paragraph(sentences.advice, width, "base"));
    if (record.lastGoodAt) {
      const age = relativeAge(record.lastGoodAt, now);
      lines.push([]);
      lines.push(
        ...paragraph(
          `Showing ${group.models.length} ${group.models.length === 1 ? "model" : "models"} from the last good check${age ? `, ${age}` : ""}.`,
          width,
          "warn",
        ),
      );
    }
  } else if (record.lastGoodAt) {
    lines.push([
      seg("● Ready", "ok"),
      seg(checked ? ` · checked ${checked}` : "", "muted"),
    ]);
  }
  lines.push([]);

  const chat = group.models.filter(
    (model) => model.type !== "embedding",
  ).length;
  const embeddings = group.models.length - chat;
  const declared = group.models.filter(
    (model) => model.origin === "pre-existing",
  ).length;
  lines.push(...labeled("Server type", serverType(group), width));
  lines.push(
    ...labeled(
      "Models",
      group.models.length === 0
        ? "none"
        : [
            chat > 0 ? `${chat} chat` : "",
            embeddings > 0 ? `${embeddings} embedding` : "",
          ]
            .filter(Boolean)
            .join(" · "),
      width,
    ),
  );
  if (declared > 0)
    lines.push(
      ...labeled(
        "Unchanged",
        `${declared} declared in your config`,
        width,
        "muted",
      ),
    );
  if (record)
    lines.push(
      ...labeled("Key", credentialWords(record.credentialSource), width),
    );
  if (context.serverAvailable && record) {
    lines.push(
      ...labeled(
        "Refresh",
        context.retryInSeconds === undefined
          ? "r now"
          : `available in ${context.retryInSeconds} s`,
        width,
        context.retryInSeconds === undefined ? "base" : "muted",
      ),
    );
  }
  for (const warning of new Set(group.warnings ?? []))
    lines.push(...paragraph(`• ${warning}`, width, "faint"));
  return lines;
}

// ── Evidence ────────────────────────────────────────────────────────────

const SOURCE_LABELS: Readonly<Record<MetadataSource, string>> = {
  "provider-probe": "probe",
  "pre-existing": "your config",
  "server-list": "server list",
  "models.dev": "models.dev",
  heuristic: "heuristic",
  "policy-default": "scout default",
  "host-default": "OpenCode default",
  "unmatched-host": "OpenCode",
};

function scalarSource(
  evidence: ScalarEvidence<string | number> | undefined,
): string {
  return evidence?.state === "known" ? SOURCE_LABELS[evidence.source] : "—";
}

function capabilitySource(evidence: CapabilityEvidence | undefined): string {
  return evidence && evidence.state !== "unknown"
    ? SOURCE_LABELS[evidence.source]
    : "—";
}

function capabilityState(evidence: CapabilityEvidence | undefined): string {
  if (!evidence || evidence.state === "unknown") return "not reported";
  return evidence.state;
}

function evidenceRow(
  field: string,
  value: string,
  source: string,
  width: number,
): Line {
  const sourceColumns = Math.min(18, Math.max(8, Math.floor(width / 4)));
  const valueColumns = Math.min(
    48,
    Math.max(4, width - LABEL_COLUMNS - sourceColumns - 2),
  );
  const known = source !== "—";
  return [
    seg(padText(field, LABEL_COLUMNS), "muted"),
    seg(padText(value, valueColumns), known ? "base" : "faint"),
    seg("  "),
    seg(padText(source, sourceColumns), "muted"),
  ];
}

function priceEvidence(evidence: ScalarEvidence<number> | undefined): string {
  return evidence?.state === "known"
    ? formatDetailPrice(evidence.value)
    : "not reported";
}

/** Field, value, and source of every model fact, plus origin and conflicts. */
export function modelEvidenceLines(
  group: ProviderGroup,
  model: ModelRow,
  width: number,
): Line[] {
  const lines: Line[] = [];
  lines.push(...paragraph(`${model.name} · Evidence`, width, "base"));
  lines.push(...paragraph(`${group.id}/${model.id}`, width, "muted"));
  lines.push([]);
  lines.push(
    evidenceRow("FIELD", "VALUE", "SOURCE", width).map((part) => ({
      ...part,
      role: "muted",
    })),
  );
  const p = model.provenance ?? {};
  const scalar = (
    field: string,
    value: string | undefined,
    evidence: ScalarEvidence<string | number> | undefined,
  ): void => {
    lines.push(
      evidenceRow(
        field,
        value ?? "not reported",
        value === undefined ? "—" : scalarSource(evidence),
        width,
      ),
    );
  };
  scalar("ID", model.id, p.identity);
  scalar("Name", model.name, p.name);
  scalar("Type", model.type, p.type);
  scalar(
    "Context",
    model.context === undefined ? undefined : formatNumber(model.context),
    p.context,
  );
  scalar(
    "Max output",
    model.output === undefined ? undefined : formatNumber(model.output),
    p.output,
  );
  scalar("Family", model.family, p.family);
  scalar("Parameters", model.parameterSize, p.parameterSize);
  scalar("Quantization", model.quantization, p.quantization);
  scalar(
    "Size",
    model.sizeBytes === undefined ? undefined : formatBytes(model.sizeBytes),
    p.sizeBytes,
  );
  scalar("Probe ID", model.probeIdentity, p.probeIdentity);
  const caps = model.capabilities;
  const input = model.inputModalities;
  const capability = (
    field: string,
    evidence: CapabilityEvidence | undefined,
  ): void => {
    lines.push(
      evidenceRow(
        field,
        capabilityState(evidence),
        capabilitySource(evidence),
        width,
      ),
    );
  };
  capability("Tools", caps?.toolCall);
  capability("Reasoning", caps?.reasoning);
  capability("Temperature", caps?.temperature);
  capability("Image input", input?.image);
  capability("PDF input", input?.pdf);
  capability("Audio input", input?.audio);
  capability("Video input", input?.video);
  const price = (
    field: string,
    evidence: ScalarEvidence<number> | undefined,
  ): void => {
    lines.push(
      evidenceRow(
        field,
        priceEvidence(evidence),
        scalarSource(evidence),
        width,
      ),
    );
  };
  price("Input price", model.cost?.input);
  price("Output price", model.cost?.output);
  price("Cache read", model.cost?.cacheRead);
  price("Cache write", model.cost?.cacheWrite);
  lines.push([]);
  const origin =
    model.origin === "discovered"
      ? "discovered by scout"
      : model.origin === "pre-existing"
        ? "declared in your config; scout leaves it unchanged"
        : "OpenCode only; no discovery record";
  lines.push(...labeled("Origin", origin, width));
  if (group.configuredProbe || group.resolvedProbe)
    lines.push(
      ...labeled(
        "Probe",
        `${group.configuredProbe ?? "auto"} → ${group.resolvedProbe ?? "unresolved"}`,
        width,
      ),
    );
  if (group.endpoint) lines.push(...labeled("Endpoint", group.endpoint, width));
  const conflicts = model.warnings ?? [];
  if (conflicts.length === 0)
    lines.push(...labeled("Conflicts", "none", width, "muted"));
  else
    for (const [index, warning] of conflicts.entries())
      lines.push(
        ...labeled(index === 0 ? "Conflicts" : "", warning, width, "warn"),
      );
  return lines;
}

/** Discovery attempts and settings of one provider. */
export function providerEvidenceLines(
  group: ProviderGroup,
  record: CatalogProviderRecord | undefined,
  width: number,
): Line[] {
  const lines: Line[] = [];
  lines.push(...paragraph(`${group.provider} · Evidence`, width, "base"));
  lines.push(...paragraph(group.id, width, "muted"));
  lines.push([]);
  if (!record) {
    lines.push(
      ...paragraph(
        "No discovery record; these rows come from OpenCode's model list.",
        width,
        "muted",
      ),
    );
    return lines;
  }
  const row = (field: string, value: string | null | undefined): void => {
    lines.push(
      ...labeled(field, value ?? "—", width, value ? "base" : "faint"),
    );
  };
  row("Model list", record.modelListAttempt);
  row("Probe run", record.probeAttempt);
  row(
    "Probe",
    `${group.configuredProbe ?? "auto"} → ${group.resolvedProbe ?? "unresolved"}`,
  );
  row("Endpoint", group.endpoint);
  row("Key", credentialWords(record.credentialSource));
  row("Last good", record.lastGoodAt);
  row("Last attempt", record.lastAttemptAt);
  row("Next refresh", record.nextRefreshAt ?? "any time");
  row(
    "Failure",
    record.failure
      ? `${record.failure.kind}${record.failure.httpStatus ? ` (${record.failure.httpStatus})` : ""} at ${record.failure.at}`
      : "none",
  );
  if (record.failure?.retryAt) row("Retry after", record.failure.retryAt);
  row(
    "Skipped",
    record.skippedModelIds.length > 0
      ? `${record.skippedModelIds.length} model IDs`
      : "none",
  );
  row(
    "Epochs",
    `credential ${record.credentialEpoch} · result ${record.resultEpoch ?? "none"}`,
  );
  return lines;
}

// ── Key help ────────────────────────────────────────────────────────────

export interface HelpEntry {
  readonly keys: string;
  readonly action: string;
}

/** The key list screen. */
export function helpLines(
  title: string,
  entries: readonly HelpEntry[],
  width: number,
): Line[] {
  const keyColumns = 25;
  const lines: Line[] = [[seg(title, "base")], []];
  for (const entry of entries) {
    const parts = wrapText(entry.action, Math.max(8, width - keyColumns));
    for (const [index, part] of parts.entries())
      lines.push([
        seg(padText(index === 0 ? entry.keys : "", keyColumns), "key"),
        seg(part, "base"),
      ]);
  }
  return lines;
}
