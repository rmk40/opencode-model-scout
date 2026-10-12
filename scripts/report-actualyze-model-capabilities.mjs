#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_BASE_URL = "https://customer.actualyze.ai/openai/v1";
const DEFAULT_KEY_FILE = "~/.config/opencode/secrets/actualyze_api_key";
const DEFAULT_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_GET_JSON_BUDGET_MS = 120_000;
const MIN_GET_JSON_BUDGET_MS = 1;
const MAX_GET_JSON_BUDGET_MS = 120_000;
const MAX_GET_ATTEMPTS = 4;
const INITIAL_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const MIN_MAX_RETRY_DELAY_MS = 0;
const MAX_MAX_RETRY_DELAY_MS = 60_000;

function boundedEnvironmentInteger(name, defaultValue, minimum, maximum) {
  const rawValue = process.env[name];
  if (rawValue === undefined) return defaultValue;
  if (!/^-?\d+$/u.test(rawValue)) {
    throw new Error(`${name} must be a base-10 safe integer`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a base-10 safe integer`);
  }
  return Math.min(maximum, Math.max(minimum, value));
}

const MAX_RETRY_DELAY_MS = boundedEnvironmentInteger(
  "ACTUALYZE_REPORT_MAX_RETRY_DELAY_MS",
  DEFAULT_MAX_RETRY_DELAY_MS,
  MIN_MAX_RETRY_DELAY_MS,
  MAX_MAX_RETRY_DELAY_MS,
);
const GET_JSON_BUDGET_MS = boundedEnvironmentInteger(
  "ACTUALYZE_REPORT_REQUEST_BUDGET_MS",
  DEFAULT_GET_JSON_BUDGET_MS,
  MIN_GET_JSON_BUDGET_MS,
  MAX_GET_JSON_BUDGET_MS,
);

function usage() {
  return `Usage: node scripts/report-actualyze-model-capabilities.mjs [options]

Queries Actualyze directly, fetches every model detail document, and reports
both normalized capability fields and the complete advertised JSON payloads.

Options:
  --base-url <url>       OpenAI-compatible base URL
                         (default: ${DEFAULT_BASE_URL})
  --api-key-file <path>  PAT file used when ACTUALYZE_API_KEY is unset
                         (default: ${DEFAULT_KEY_FILE})
  --concurrency <n>      Parallel detail requests, 1-32 (default: 4)
  --json                 Emit one machine-readable JSON document
  --summary-only         Omit complete list/detail JSON from text output
  --help                 Show this help

Environment:
  ACTUALYZE_API_KEY                         Bearer PAT (preferred for CI)
  ACTUALYZE_API_KEY_FILE                    PAT file path
  ACTUALYZE_BASE_URL                        OpenAI-compatible base URL
  ACTUALYZE_REPORT_MAX_RETRY_DELAY_MS       Retry delay cap in milliseconds,
                                             ${MIN_MAX_RETRY_DELAY_MS}-${MAX_MAX_RETRY_DELAY_MS}
                                             (default: ${DEFAULT_MAX_RETRY_DELAY_MS})
  ACTUALYZE_REPORT_REQUEST_BUDGET_MS        Per-request wall-clock budget in
                                             milliseconds,
                                             ${MIN_GET_JSON_BUDGET_MS}-${MAX_GET_JSON_BUDGET_MS}
                                             (default: ${DEFAULT_GET_JSON_BUDGET_MS})
`;
}

function requireValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseArgs(args) {
  const options = {
    baseUrl: process.env.ACTUALYZE_BASE_URL ?? DEFAULT_BASE_URL,
    keyFile: process.env.ACTUALYZE_API_KEY_FILE ?? DEFAULT_KEY_FILE,
    concurrency: DEFAULT_CONCURRENCY,
    json: false,
    summaryOnly: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--base-url":
        options.baseUrl = requireValue(args, index, argument);
        index += 1;
        break;
      case "--api-key-file":
        options.keyFile = requireValue(args, index, argument);
        index += 1;
        break;
      case "--concurrency": {
        const value = Number(requireValue(args, index, argument));
        if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
          throw new Error("--concurrency must be an integer from 1 through 32");
        }
        options.concurrency = value;
        index += 1;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--summary-only":
        options.summaryOnly = true;
        break;
      case "--help":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }

  options.baseUrl = options.baseUrl.replace(/\/+$/u, "");
  return options;
}

function expandHome(filePath) {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return path.join(homedir(), filePath.slice(2));
  return filePath;
}

function validatedApiKey(value, source) {
  const token = value.trim();
  if (!/^[!-~]+$/u.test(token)) {
    throw new Error(
      `invalid API key from ${source}: expected a non-empty visible-ASCII token without whitespace`,
    );
  }
  return token;
}

async function loadApiKey(keyFile) {
  if (process.env.ACTUALYZE_API_KEY !== undefined) {
    return validatedApiKey(process.env.ACTUALYZE_API_KEY, "ACTUALYZE_API_KEY");
  }

  const resolvedPath = expandHome(keyFile);
  let fileContents;
  try {
    fileContents = await readFile(resolvedPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read API key from ${resolvedPath}: ${message}`);
  }
  return validatedApiKey(fileContents, `API key file ${resolvedPath}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTransportErrorIdentifier(error, apiKey) {
  if (!isRecord(error)) return undefined;

  const code = isRecord(error.cause) ? error.cause.code : undefined;
  if (
    typeof code === "string" &&
    /^[A-Z][A-Z0-9_]{1,63}$/u.test(code) &&
    !code.includes(apiKey)
  ) {
    return code;
  }

  const name = error.name;
  return typeof name === "string" &&
    /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name) &&
    !name.includes(apiKey)
    ? name
    : undefined;
}

function retryAfterDelayMs(value) {
  if (value === null) return undefined;

  if (/^\d+(?:\.\d+)?$/u.test(value.trim())) {
    const seconds = Number(value);
    return Number.isFinite(seconds)
      ? Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS)
      : undefined;
  }

  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt)
    ? undefined
    : Math.min(Math.max(0, retryAt - Date.now()), MAX_RETRY_DELAY_MS);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cancelResponseBody(response, deadline) {
  let cancellation;
  try {
    cancellation = response.body?.cancel();
  } catch {
    // Best-effort cleanup for a response body the report will not consume.
    return;
  }
  if (!cancellation) return;

  const settledCancellation = cancellation.then(
    () => undefined,
    () => undefined,
  );

  const remaining = remainingMilliseconds(deadline);
  if (remaining === 0) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, remaining);
    void settledCancellation.then(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function remainingMilliseconds(deadline) {
  return Math.max(0, deadline - Date.now());
}

function getJsonBudgetError(resource) {
  return new Error(
    `GET ${resource} exceeded its ${GET_JSON_BUDGET_MS}ms wall-clock budget`,
  );
}

function isJsonMediaType(contentType) {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType === "application/json" ||
    /^[^/\s]+\/[^/\s]+\+json$/u.test(mediaType)
  );
}

async function getJson(baseUrl, resource, apiKey) {
  const deadline = Date.now() + GET_JSON_BUDGET_MS;

  for (let attempt = 1; attempt <= MAX_GET_ATTEMPTS; attempt += 1) {
    const remaining = remainingMilliseconds(deadline);
    if (remaining === 0) throw getJsonBudgetError(resource);

    const signal = AbortSignal.timeout(
      Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining)),
    );
    let response;
    try {
      response = await fetch(`${baseUrl}${resource}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
    } catch (error) {
      if (signal.aborted || remainingMilliseconds(deadline) === 0) {
        throw getJsonBudgetError(resource);
      }
      const identifier = safeTransportErrorIdentifier(error, apiKey);
      throw new Error(
        `GET ${resource} failed before receiving a response${identifier ? ` (${identifier})` : ""}`,
      );
    }

    if (!response.ok) {
      const shouldRetry = response.status === 429 && attempt < MAX_GET_ATTEMPTS;
      const retryDelay = shouldRetry
        ? (retryAfterDelayMs(response.headers.get("retry-after")) ??
          Math.min(
            INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
            MAX_RETRY_DELAY_MS,
          ))
        : undefined;

      await cancelResponseBody(response, deadline);
      if (retryDelay !== undefined) {
        const delayBudget = remainingMilliseconds(deadline);
        if (delayBudget === 0) throw getJsonBudgetError(resource);
        await delay(Math.min(retryDelay, delayBudget));
        if (remainingMilliseconds(deadline) === 0) {
          throw getJsonBudgetError(resource);
        }
        continue;
      }

      const statusText = response.statusText
        .replaceAll(apiKey, "[REDACTED]")
        .trim();
      throw new Error(
        `GET ${resource} returned ${response.status}${statusText ? ` ${statusText}` : ""}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!isJsonMediaType(contentType)) {
      await cancelResponseBody(response, deadline);
      const safeContentType = contentType.replaceAll(apiKey, "[REDACTED]");
      throw new Error(
        `GET ${resource} returned non-JSON content (${safeContentType || "missing Content-Type"})`,
      );
    }
    try {
      return await response.json();
    } catch {
      await cancelResponseBody(response, deadline);
      if (signal.aborted || remainingMilliseconds(deadline) === 0) {
        throw getJsonBudgetError(resource);
      }
      throw new Error(`GET ${resource} returned malformed JSON`);
    }
  }

  throw new Error(`GET ${resource} exhausted retry attempts`);
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return results;
}

function firstAdvertised(records, ...keys) {
  for (const record of records) {
    if (!isRecord(record)) continue;
    for (const key of keys) {
      if (Object.hasOwn(record, key)) return record[key];
    }
  }
  return undefined;
}

function normalizedCapabilities(listAdvertisement, detailAdvertisement) {
  const records = [detailAdvertisement, listAdvertisement];
  const detailCapabilities = isRecord(detailAdvertisement?.capabilities)
    ? detailAdvertisement.capabilities
    : {};
  const listCapabilities = isRecord(listAdvertisement?.capabilities)
    ? listAdvertisement.capabilities
    : {};
  const capabilityRecords = [detailCapabilities, listCapabilities];

  const vision = firstAdvertised(capabilityRecords, "vision");
  const toolUse = firstAdvertised(capabilityRecords, "tool_use");
  const thinking = firstAdvertised(capabilityRecords, "thinking");
  const adaptiveThinking = firstAdvertised(
    capabilityRecords,
    "thinking_adaptive",
  );
  const reasoning =
    thinking === true || adaptiveThinking === true
      ? true
      : thinking === false && adaptiveThinking === false
        ? false
        : undefined;

  return {
    context_window: firstAdvertised(
      records,
      "context_window",
      "context_length",
      "max_context_tokens",
    ),
    max_output_tokens: firstAdvertised(
      records,
      "max_output_tokens",
      "max_completion_tokens",
      "output_token_limit",
    ),
    vision,
    tool_use: toolUse,
    thinking,
    thinking_adaptive: adaptiveThinking,
    reasoning,
    modalities: firstAdvertised(records, "modalities"),
    model_type: firstAdvertised(records, "model_type", "type"),
    family: firstAdvertised(records, "family"),
    parameter_size: firstAdvertised(records, "parameter_size", "parameters"),
    quantization: firstAdvertised(records, "quantization"),
    owned_by: firstAdvertised(records, "owned_by"),
  };
}

function compactSummary(summary) {
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined),
  );
}

function escapeTerminalText(value) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    const unsafe =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    return unsafe
      ? `\\u{${codePoint.toString(16).padStart(4, "0")}}`
      : character;
  }).join("");
}

function terminalSafeValue(value) {
  if (typeof value === "string") return escapeTerminalText(value);
  if (Array.isArray(value)) return value.map(terminalSafeValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      escapeTerminalText(key),
      terminalSafeValue(entry),
    ]),
  );
}

function terminalSafeJson(value) {
  return JSON.stringify(terminalSafeValue(value), null, 2);
}

function displayValue(value) {
  return typeof value === "string"
    ? escapeTerminalText(value)
    : JSON.stringify(terminalSafeValue(value));
}

function printTextReport(report, summaryOnly) {
  console.log("Actualyze model capability report");
  console.log(`Base URL: ${escapeTerminalText(report.base_url)}`);
  console.log(`Retrieved: ${report.retrieved_at}`);
  console.log(`Models: ${report.models.length}`);
  console.log(
    `Detail requests: ${report.detail_requests.attempted} attempted, ${report.detail_requests.skipped} skipped`,
  );

  if (!summaryOnly) {
    console.log("\nComplete /models response:");
    console.log(terminalSafeJson(report.list_response));
  }

  for (const model of report.models) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(escapeTerminalText(model.id));
    console.log("-".repeat(80));

    const entries = Object.entries(model.advertised_capabilities);
    if (entries.length === 0) {
      console.log("Normalized capabilities: none advertised");
    } else {
      console.log("Normalized capabilities:");
      for (const [name, value] of entries) {
        console.log(`  ${name}: ${displayValue(value)}`);
      }
    }

    if (model.detail_error) {
      console.log(`Detail request: ${escapeTerminalText(model.detail_error)}`);
    }
    if (model.detail_warning) {
      console.log(
        `Detail warning: ${escapeTerminalText(model.detail_warning)}`,
      );
    }

    if (!summaryOnly) {
      console.log("\nList advertisement:");
      console.log(terminalSafeJson(model.list_advertisement));
      console.log("\nDetail advertisement:");
      console.log(
        model.detail_advertisement === undefined
          ? "(unavailable)"
          : terminalSafeJson(model.detail_advertisement),
      );
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = await loadApiKey(options.keyFile);
  const listPayload = await getJson(options.baseUrl, "/models", apiKey);
  if (!isRecord(listPayload) || !Array.isArray(listPayload.data)) {
    throw new Error("GET /models did not return an object with a data array");
  }

  const listModels = listPayload.data.filter(
    (model) => isRecord(model) && typeof model.id === "string" && model.id,
  );
  let attemptedDetailRequests = 0;
  let skippedDetailRequests = 0;
  const models = await mapConcurrent(
    listModels,
    options.concurrency,
    async (listAdvertisement) => {
      let detailAdvertisement;
      let normalizedDetailAdvertisement;
      let detailError;
      let detailWarning;
      let encodedId;
      if (listAdvertisement.id === "." || listAdvertisement.id === "..") {
        skippedDetailRequests += 1;
        detailError = "detail request skipped: unsafe dot-segment model id";
      } else {
        try {
          encodedId = encodeURIComponent(listAdvertisement.id);
        } catch {
          skippedDetailRequests += 1;
          detailError = "detail request skipped: model id is not URL-encodable";
        }
      }

      if (encodedId !== undefined) {
        attemptedDetailRequests += 1;
        try {
          detailAdvertisement = await getJson(
            options.baseUrl,
            `/models/${encodedId}`,
            apiKey,
          );
          if (!isRecord(detailAdvertisement)) {
            detailError = "detail validation failed: expected a record";
          } else if (
            Object.hasOwn(detailAdvertisement, "object") &&
            detailAdvertisement.object !== "model"
          ) {
            detailError =
              'detail validation failed: expected object to be absent or "model"';
          } else if (
            Object.hasOwn(detailAdvertisement, "id") &&
            (typeof detailAdvertisement.id !== "string" ||
              detailAdvertisement.id.length === 0)
          ) {
            detailError =
              "detail validation failed: expected id to be absent or a non-empty string";
          } else {
            normalizedDetailAdvertisement = detailAdvertisement;
            if (
              Object.hasOwn(detailAdvertisement, "id") &&
              detailAdvertisement.id !== listAdvertisement.id
            ) {
              detailWarning = `detail advertised id ${JSON.stringify(detailAdvertisement.id)} does not match requested/list id ${JSON.stringify(listAdvertisement.id)}; retained detail for alias-compatible normalization`;
            }
          }
        } catch (error) {
          detailError = error instanceof Error ? error.message : String(error);
        }
      }

      return {
        id: listAdvertisement.id,
        advertised_capabilities: compactSummary(
          normalizedCapabilities(
            listAdvertisement,
            normalizedDetailAdvertisement,
          ),
        ),
        list_advertisement: listAdvertisement,
        detail_advertisement: detailAdvertisement,
        ...(detailError ? { detail_error: detailError } : {}),
        ...(detailWarning ? { detail_warning: detailWarning } : {}),
      };
    },
  );

  const report = {
    base_url: options.baseUrl,
    retrieved_at: new Date().toISOString(),
    list_response_fields: Object.keys(listPayload).sort(),
    list_response: listPayload,
    list_entries: {
      total: listPayload.data.length,
      reportable: listModels.length,
      invalid: listPayload.data.length - listModels.length,
    },
    detail_requests: {
      attempted: attemptedDetailRequests,
      skipped: skippedDetailRequests,
    },
    models,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTextReport(report, options.summaryOnly);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `actualyze capability report failed: ${escapeTerminalText(message)}`,
  );
  process.exitCode = 1;
});
