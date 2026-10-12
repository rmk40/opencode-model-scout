import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL(
    "../scripts/report-actualyze-model-capabilities.mjs",
    import.meta.url,
  ),
);
const isolatedEnvironmentKeys = [
  "ACTUALYZE_API_KEY",
  "ACTUALYZE_API_KEY_FILE",
  "ACTUALYZE_BASE_URL",
  "ACTUALYZE_REPORT_MAX_RETRY_DELAY_MS",
  "ACTUALYZE_REPORT_REQUEST_BUDGET_MS",
] as const;

interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ReportModel {
  id: string;
  advertised_capabilities: Record<string, unknown>;
  list_advertisement: unknown;
  detail_advertisement?: unknown;
  detail_error?: string;
  detail_warning?: string;
}

interface CapabilityReport {
  base_url: string;
  list_response_fields: string[];
  list_response: Record<string, unknown>;
  list_entries: { total: number; reportable: number; invalid: number };
  detail_requests: { attempted: number; skipped: number };
  models: ReportModel[];
}

type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function startServer(handler: RequestHandler): Promise<string> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.keepAliveTimeout = 1;
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

function json(
  response: ServerResponse,
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function isolatedEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of isolatedEnvironmentKeys) delete environment[key];
  return { ...environment, ...overrides };
}

async function runScript(
  baseUrl: string,
  args: string[] = [],
  environment: NodeJS.ProcessEnv = {},
  timeoutMs = 8_000,
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [scriptPath, "--base-url", baseUrl, ...args],
      {
        env: isolatedEnvironment(environment),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(
            `report subprocess exceeded ${timeoutMs}ms and was killed; stderr: ${stderr}`,
          ),
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function writePreloadModule(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "model-scout-preload-"));
  temporaryDirectories.push(directory);
  const preloadPath = path.join(directory, "preload.mjs");
  await writeFile(preloadPath, source, "utf8");
  return pathToFileURL(preloadPath).href;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReport(result: ScriptResult): CapabilityReport {
  expect(result.code, `subprocess stderr: ${result.stderr}`).toBe(0);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to parse report JSON (${message}); stderr: ${result.stderr}`,
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.base_url !== "string" ||
    !Array.isArray(parsed.list_response_fields) ||
    !isRecord(parsed.list_response) ||
    !isRecord(parsed.list_entries) ||
    !isRecord(parsed.detail_requests) ||
    !Array.isArray(parsed.models)
  ) {
    throw new Error(
      `report JSON had an unexpected shape; stderr: ${result.stderr}`,
    );
  }
  return parsed as unknown as CapabilityReport;
}

describe("Actualyze capability report script", () => {
  it("documents bounded retry and request-budget tuning", async () => {
    const result = await runScript("http://example.invalid", ["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("ACTUALYZE_REPORT_MAX_RETRY_DELAY_MS");
    expect(result.stdout).toContain("0-60000");
    expect(result.stdout).toContain("(default: 60000)");
    expect(result.stdout).toContain("ACTUALYZE_REPORT_REQUEST_BUDGET_MS");
    expect(result.stdout).toContain("1-120000");
    expect(result.stdout).toContain("(default: 120000)");
  });

  it.each([
    ["ACTUALYZE_REPORT_MAX_RETRY_DELAY_MS", ""],
    ["ACTUALYZE_REPORT_MAX_RETRY_DELAY_MS", "1.5"],
    ["ACTUALYZE_REPORT_REQUEST_BUDGET_MS", "not-an-integer"],
    ["ACTUALYZE_REPORT_REQUEST_BUDGET_MS", "9007199254740992"],
  ])("rejects malformed %s=%j", async (name, value) => {
    const result = await runScript("http://example.invalid", ["--json"], {
      ACTUALYZE_API_KEY: "tuning-secret",
      [name]: value,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`${name} must be a base-10 safe integer`);
  });

  it.each([
    { configured: "-1", expected: 0 },
    { configured: "999999999", expected: 60_000 },
  ])(
    "clamps the retry-delay cap $configured to $expected milliseconds",
    async ({ configured, expected }) => {
      const preloadUrl = await writePreloadModule(`
let requests = 0;
globalThis.fetch = async () => {
  requests += 1;
  if (requests === 1) {
    return {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: (name) => name === "retry-after" ? "999999999" : "application/json" },
    };
  }
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (name) => name === "content-type" ? "application/json" : null },
    json: async () => ({ data: [] }),
  };
};
globalThis.setTimeout = (callback, milliseconds, ...args) => {
  if (milliseconds !== ${expected}) {
    throw new Error("unexpected retry delay: " + milliseconds);
  }
  queueMicrotask(() => callback(...args));
  return 0;
};
`);

      const result = await runScript("http://example.invalid", ["--json"], {
        ACTUALYZE_API_KEY: "retry-bound-secret",
        ACTUALYZE_REPORT_MAX_RETRY_DELAY_MS: configured,
        NODE_OPTIONS: `--import=${preloadUrl}`,
      });

      expect(result.code, result.stderr).toBe(0);
      expect(parseReport(result).models).toEqual([]);
    },
  );

  it.each([
    { configured: "0", expected: 1 },
    { configured: "999999999", expected: 120_000 },
  ])(
    "clamps the request budget $configured to $expected milliseconds",
    async ({ configured, expected }) => {
      const preloadUrl = await writePreloadModule(`
const startedAt = Date.now();
let clockReads = 0;
Date.now = () => clockReads++ === 0 ? startedAt : startedAt + ${expected};
globalThis.fetch = async () => {
  throw new Error("fetch should not run after the budget is exhausted");
};
`);

      const result = await runScript("http://example.invalid", ["--json"], {
        ACTUALYZE_API_KEY: "budget-bound-secret",
        ACTUALYZE_REPORT_REQUEST_BUDGET_MS: configured,
        NODE_OPTIONS: `--import=${preloadUrl}`,
      });

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        `GET /models exceeded its ${expected}ms wall-clock budget`,
      );
      expect(result.stderr).not.toContain("fetch should not run");
    },
  );

  it("prefers the environment PAT and never exposes it in output", async () => {
    const environmentKey = "environment-secret-pat";
    const directory = await mkdtemp(path.join(tmpdir(), "model-scout-report-"));
    temporaryDirectories.push(directory);
    const keyFile = path.join(directory, "api-key");
    await writeFile(keyFile, "file-secret-pat\n", "utf8");
    const authorizations: Array<string | undefined> = [];
    const baseUrl = await startServer((request, response) => {
      authorizations.push(request.headers.authorization);
      json(response, { data: [] });
    });

    const result = await runScript(
      baseUrl,
      ["--api-key-file", keyFile, "--json"],
      { ACTUALYZE_API_KEY: `  ${environmentKey}  ` },
    );

    expect(result.code).toBe(0);
    expect(authorizations).toEqual([`Bearer ${environmentKey}`]);
    expect(result.stdout + result.stderr).not.toContain(environmentKey);
    expect(result.stdout + result.stderr).not.toContain("file-secret-pat");
  });

  it("loads and trims the fallback PAT from a key file", async () => {
    const fileKey = "file-secret-pat";
    const directory = await mkdtemp(path.join(tmpdir(), "model-scout-report-"));
    temporaryDirectories.push(directory);
    const keyFile = path.join(directory, "api-key");
    await writeFile(keyFile, `  ${fileKey}\n`, "utf8");
    let authorization: string | undefined;
    const baseUrl = await startServer((request, response) => {
      authorization = request.headers.authorization;
      json(response, { data: [] });
    });

    const result = await runScript(baseUrl, [
      "--api-key-file",
      keyFile,
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(authorization).toBe(`Bearer ${fileKey}`);
    expect(result.stdout + result.stderr).not.toContain(fileKey);
  });

  it("rejects invalid PATs without sending or printing them", async () => {
    const invalidKey = "secret-part\nheader-injection";
    let requests = 0;
    const baseUrl = await startServer((_request, response) => {
      requests += 1;
      json(response, { data: [] });
    });

    const result = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: invalidKey,
    });

    expect(result.code).toBe(1);
    expect(requests).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid API key from ACTUALYZE_API_KEY");
    expect(result.stderr).not.toContain("secret-part");
    expect(result.stderr).not.toContain("header-injection");
    expect(result.stderr).not.toContain(invalidKey);
  });

  it("URL-encodes model IDs and preserves normalized and raw JSON evidence", async () => {
    const apiKey = "json-report-secret";
    const modelId = "owner/model ?#%";
    const listAdvertisement = {
      id: modelId,
      type: "chat",
      nullable_list_field: null,
      unknown_list_field: { nested: null },
      capabilities: {
        vision: false,
        tool_use: null,
        thinking: false,
        thinking_adaptive: false,
      },
    };
    const detailAdvertisement = {
      id: modelId,
      object: "model",
      context_window: null,
      max_completion_tokens: 4096,
      family: null,
      owned_by: "actualyze",
      modalities: { input: ["text", "image"], output: ["text"] },
      unknown_detail_field: { enabled: true, value: null },
      capabilities: {
        vision: true,
        tool_use: false,
        thinking: true,
        thinking_adaptive: null,
      },
    };
    const expectedDetailPath = `/v1/models/${encodeURIComponent(modelId)}`;
    const requestedPaths: string[] = [];
    const authorizations: Array<string | undefined> = [];
    const listPayload = {
      object: "list",
      unknown_top_level: null,
      data: [null, { id: "" }, { id: 42 }, listAdvertisement],
    };
    const baseUrl = await startServer((request, response) => {
      requestedPaths.push(request.url ?? "");
      authorizations.push(request.headers.authorization);
      if (request.url === "/v1/models") {
        json(response, listPayload);
        return;
      }
      if (request.url === expectedDetailPath) {
        json(response, detailAdvertisement);
        return;
      }
      response.writeHead(404).end();
    });

    const result = await runScript(`${baseUrl}/v1///`, ["--json"], {
      ACTUALYZE_API_KEY: apiKey,
    });
    const report = parseReport(result);

    expect(requestedPaths).toEqual(["/v1/models", expectedDetailPath]);
    expect(authorizations).toEqual([`Bearer ${apiKey}`, `Bearer ${apiKey}`]);
    expect(report.base_url).toBe(`${baseUrl}/v1`);
    expect(report.list_response_fields).toEqual([
      "data",
      "object",
      "unknown_top_level",
    ]);
    expect(report.list_response).toEqual(listPayload);
    expect(report.list_entries).toEqual({
      total: 4,
      reportable: 1,
      invalid: 3,
    });
    expect(report.detail_requests).toEqual({ attempted: 1, skipped: 0 });
    expect(report.models).toHaveLength(1);
    expect(report.models[0]).toEqual({
      id: modelId,
      advertised_capabilities: {
        context_window: null,
        max_output_tokens: 4096,
        vision: true,
        tool_use: false,
        thinking: true,
        thinking_adaptive: null,
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        model_type: "chat",
        family: null,
        owned_by: "actualyze",
      },
      list_advertisement: listAdvertisement,
      detail_advertisement: detailAdvertisement,
    });
    expect(result.stdout + result.stderr).not.toContain(apiKey);
  });

  it("omits raw advertisements only from summary-only text", async () => {
    const listAdvertisement = {
      id: "summary-model",
      context_length: 8192,
      unknown_list_marker: "preserve-in-full-text",
    };
    const detailAdvertisement = {
      id: "summary-model",
      object: "model",
      output_token_limit: 1024,
      unknown_detail_marker: "preserve-in-full-text",
    };
    const baseUrl = await startServer((request, response) => {
      if (request.url === "/models") {
        json(response, { data: [listAdvertisement] });
      } else {
        json(response, detailAdvertisement);
      }
    });
    const environment = { ACTUALYZE_API_KEY: "summary-secret" };

    const full = await runScript(baseUrl, [], environment);
    const summary = await runScript(baseUrl, ["--summary-only"], environment);

    expect(full.code).toBe(0);
    expect(full.stdout).toContain("List advertisement:");
    expect(full.stdout).toContain(
      '"unknown_list_marker": "preserve-in-full-text"',
    );
    expect(full.stdout).toContain(
      '"unknown_detail_marker": "preserve-in-full-text"',
    );
    expect(summary.code).toBe(0);
    expect(summary.stdout).toContain("context_window: 8192");
    expect(summary.stdout).toContain("max_output_tokens: 1024");
    expect(summary.stdout).not.toContain("List advertisement:");
    expect(summary.stdout).not.toContain("Detail advertisement:");
    expect(summary.stdout).not.toContain("preserve-in-full-text");
  });

  it("retries 429s using Retry-After and fallback backoff before succeeding", async () => {
    let requests = 0;
    const baseUrl = await startServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        json(response, { error: "rate limited" }, 429, { "retry-after": "0" });
        return;
      }
      if (requests === 2) {
        json(response, { error: "rate limited again" }, 429);
        return;
      }
      json(response, { data: [] });
    });

    const result = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: "retry-secret",
    });

    expect(result.code).toBe(0);
    expect(requests).toBe(3);
    expect(parseReport(result).models).toEqual([]);
  });

  it("honors a 36-second Retry-After without exceeding the default cap", async () => {
    const preloadUrl = await writePreloadModule(`
let requests = 0;
globalThis.fetch = async () => {
  requests += 1;
  if (requests === 1) {
    return {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: (name) => name === "retry-after" ? "36" : "application/json" },
    };
  }
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (name) => name === "content-type" ? "application/json" : null },
    json: async () => ({ data: [] }),
  };
};
globalThis.setTimeout = (callback, milliseconds, ...args) => {
  if (milliseconds !== 36000) {
    throw new Error("unexpected retry delay: " + milliseconds);
  }
  queueMicrotask(() => callback(...args));
  return 0;
};
`);

    const result = await runScript("http://example.invalid", ["--json"], {
      ACTUALYZE_API_KEY: "retry-after-secret",
      NODE_OPTIONS: `--import=${preloadUrl}`,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(parseReport(result).models).toEqual([]);
  });

  it("caps huge Retry-After values and stops after four bounded attempts", async () => {
    let requests = 0;
    const baseUrl = await startServer((_request, response) => {
      requests += 1;
      const retryAfter =
        requests % 2 === 0
          ? new Date(Date.now() + 86_400_000).toUTCString()
          : "999999999";
      json(response, { error: "rate limited" }, 429, {
        "retry-after": retryAfter,
      });
    });
    const startedAt = Date.now();

    const result = await runScript(
      baseUrl,
      ["--json"],
      {
        ACTUALYZE_API_KEY: "bounded-retry-secret",
        ACTUALYZE_REPORT_MAX_RETRY_DELAY_MS: "1000",
        ACTUALYZE_REPORT_REQUEST_BUDGET_MS: "12000",
      },
      7_000,
    );

    expect(result.code).toBe(1);
    expect(requests).toBe(4);
    expect(Date.now() - startedAt).toBeLessThan(6_500);
    expect(result.stderr).toContain(
      "GET /models returned 429 Too Many Requests",
    );
  });

  it("rejects non-JSON bodies and wraps malformed JSON with resource context", async () => {
    let requests = 0;
    const baseUrl = await startServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("not json");
        return;
      }
      response.writeHead(200, { "content-type": "application/problem+json" });
      response.end("{broken");
    });

    const nonJsonResult = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: "content-type-secret",
    });
    const malformedResult = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: "malformed-json-secret",
    });

    expect(nonJsonResult.code).toBe(1);
    expect(nonJsonResult.stderr).toContain(
      "GET /models returned non-JSON content (text/plain)",
    );
    expect(malformedResult.code).toBe(1);
    expect(malformedResult.stderr).toContain(
      "GET /models returned malformed JSON",
    );
  });

  it("handles a rejected body cancellation after the deadline is exhausted", async () => {
    const preloadUrl = await writePreloadModule(`
const startedAt = Date.now();
let deadlineExpired = false;
Date.now = () => deadlineExpired ? startedAt + 12_000 : startedAt;
globalThis.fetch = async () => {
  deadlineExpired = true;
  return {
    ok: false,
    status: 500,
    statusText: "Injected Failure",
    headers: { get: () => null },
    body: {
      cancel: () => Promise.reject(new Error("escaped-cancel-rejection")),
    },
  };
};
`);

    const result = await runScript("http://example.invalid", ["--json"], {
      ACTUALYZE_API_KEY: "cancel-secret",
      ACTUALYZE_REPORT_REQUEST_BUDGET_MS: "12000",
      NODE_OPTIONS: `--unhandled-rejections=strict --import=${preloadUrl}`,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "GET /models returned 500 Injected Failure",
    );
    expect(result.stderr).not.toContain("escaped-cancel-rejection");
    expect(result.stderr).not.toContain("UnhandledPromiseRejection");
  });

  it("reports a safe transport code without exposing the raw error or PAT", async () => {
    const apiKey = "transport-secret-pat";
    const preloadUrl = await writePreloadModule(`
globalThis.fetch = async (_url, options) => {
  const error = new TypeError(
    "raw transport message with " + options.headers.Authorization,
  );
  error.cause = {
    code: "ECONNREFUSED",
    headers: options.headers,
  };
  throw error;
};
`);

    const result = await runScript("http://example.invalid", ["--json"], {
      ACTUALYZE_API_KEY: apiKey,
      NODE_OPTIONS: `--unhandled-rejections=strict --import=${preloadUrl}`,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "GET /models failed before receiving a response (ECONNREFUSED)",
    );
    expect(result.stderr).not.toContain("raw transport message");
    expect(result.stderr).not.toContain("Authorization");
    expect(result.stderr).not.toContain(apiKey);
  });

  it("does not retry an unauthorized list request or expose its PAT", async () => {
    const apiKey = "unauthorized-secret";
    let requests = 0;
    const baseUrl = await startServer((_request, response) => {
      requests += 1;
      response.statusMessage = `Unauthorized ${apiKey}`;
      json(response, { error: "unauthorized" }, 401);
    });

    const result = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: apiKey,
    });

    expect(result.code).toBe(1);
    expect(requests).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("GET /models returned 401 Unauthorized");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(apiKey);
  });

  it("rejects a malformed list document before requesting details", async () => {
    let requests = 0;
    const baseUrl = await startServer((_request, response) => {
      requests += 1;
      json(response, { data: { id: "not-an-array" } });
    });

    const result = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: "malformed-secret",
    });

    expect(result.code).toBe(1);
    expect(requests).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "GET /models did not return an object with a data array",
    );
  });

  it("reports one detail failure without failing or discarding other models", async () => {
    const failedModel = {
      id: "broken/model",
      context_length: 2048,
      capabilities: { thinking: false, thinking_adaptive: false },
    };
    const healthyModel = { id: "healthy-model", unknown_list_field: null };
    const healthyDetail = {
      id: "healthy-model",
      object: "model",
      max_output_tokens: 512,
      unknown_detail_field: null,
    };
    let failedDetailRequests = 0;
    const baseUrl = await startServer((request, response) => {
      if (request.url === "/models") {
        json(response, { data: [failedModel, healthyModel] });
        return;
      }
      if (request.url === "/models/broken%2Fmodel") {
        failedDetailRequests += 1;
        json(response, { error: "detail unavailable" }, 503);
        return;
      }
      json(response, healthyDetail);
    });

    const result = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: "detail-failure-secret",
    });
    const report = parseReport(result);

    expect(result.stderr).toBe("");
    expect(failedDetailRequests).toBe(1);
    expect(report.models).toHaveLength(2);
    expect(report.models[0]).toEqual({
      id: "broken/model",
      advertised_capabilities: {
        context_window: 2048,
        thinking: false,
        thinking_adaptive: false,
        reasoning: false,
      },
      list_advertisement: failedModel,
      detail_error:
        "GET /models/broken%2Fmodel returned 503 Service Unavailable",
    });
    expect(report.models[1]).toEqual({
      id: "healthy-model",
      advertised_capabilities: { max_output_tokens: 512 },
      list_advertisement: healthyModel,
      detail_advertisement: healthyDetail,
    });
  });

  it("skips dot-segment IDs while preserving them in the raw list envelope", async () => {
    const listPayload = {
      object: "list",
      page_token: "next-page",
      data: [
        { id: ".", context_window: 1 },
        { id: "..", context_window: 2 },
        { id: "safe", context_window: 3 },
      ],
    };
    const requestedPaths: string[] = [];
    const baseUrl = await startServer((request, response) => {
      requestedPaths.push(request.url ?? "");
      if (request.url === "/models") {
        json(response, listPayload);
        return;
      }
      json(response, { id: "safe", object: "model", context_window: 4 });
    });

    const result = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: "dot-segment-secret",
    });
    const report = parseReport(result);

    expect(requestedPaths).toEqual(["/models", "/models/safe"]);
    expect(report.list_response).toEqual(listPayload);
    expect(report.detail_requests).toEqual({ attempted: 1, skipped: 2 });
    expect(report.models.map((model) => model.id)).toEqual([".", "..", "safe"]);
    expect(report.models[0]?.detail_error).toContain("unsafe dot-segment");
    expect(report.models[1]?.detail_error).toContain("unsafe dot-segment");
    expect(report.models[0]?.advertised_capabilities).toEqual({
      context_window: 1,
    });
  });

  it("preserves a non-record detail document and normalizes from list data only", async () => {
    const malformedList = {
      id: "malformed",
      context_window: 1024,
      capabilities: { vision: false },
    };
    const malformedDetail = ["not", "a", "record"];
    const baseUrl = await startServer((request, response) => {
      if (request.url === "/models") {
        json(response, { data: [malformedList] });
        return;
      }
      json(response, malformedDetail);
    });

    const result = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: "invalid-detail-secret",
    });
    const report = parseReport(result);

    expect(report.models[0]).toEqual({
      id: "malformed",
      advertised_capabilities: { context_window: 1024, vision: false },
      list_advertisement: malformedList,
      detail_advertisement: malformedDetail,
      detail_error: "detail validation failed: expected a record",
    });
  });

  it("accepts a detail document whose object field is absent", async () => {
    const listAdvertisement = {
      id: "object-optional",
      context_window: 1024,
    };
    const detailAdvertisement = {
      id: "object-optional",
      max_output_tokens: 512,
    };
    const baseUrl = await startServer((request, response) => {
      json(
        response,
        request.url === "/models"
          ? { data: [listAdvertisement] }
          : detailAdvertisement,
      );
    });

    const result = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: "missing-object-secret",
    });
    const report = parseReport(result);

    expect(report.models[0]).toEqual({
      id: "object-optional",
      advertised_capabilities: {
        context_window: 1024,
        max_output_tokens: 512,
      },
      list_advertisement: listAdvertisement,
      detail_advertisement: detailAdvertisement,
    });
  });

  it("retains alias detail data with an advertised ID mismatch warning", async () => {
    const listAdvertisement = {
      id: "requested-alias",
      context_window: 1024,
      capabilities: { vision: false },
    };
    const detailAdvertisement = {
      id: "canonical-model",
      object: "model",
      context_window: 8192,
      capabilities: { vision: true },
    };
    const baseUrl = await startServer((request, response) => {
      json(
        response,
        request.url === "/models"
          ? { data: [listAdvertisement] }
          : detailAdvertisement,
      );
    });

    const result = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: "alias-secret",
    });
    const report = parseReport(result);

    expect(report.models[0]).toEqual({
      id: "requested-alias",
      advertised_capabilities: { context_window: 8192, vision: true },
      list_advertisement: listAdvertisement,
      detail_advertisement: detailAdvertisement,
      detail_warning:
        'detail advertised id "canonical-model" does not match requested/list id "requested-alias"; retained detail for alias-compatible normalization',
    });
  });

  it.each([
    { label: "null", detailId: null },
    { label: "number", detailId: 42 },
    { label: "object", detailId: { canonical: "list-model" } },
    { label: "empty string", detailId: "" },
  ])(
    "rejects a $label detail ID and normalizes from list data only",
    async ({ detailId }) => {
      const listAdvertisement = {
        id: "list-model",
        context_window: 1024,
        capabilities: { vision: false, tool_use: true },
      };
      const detailAdvertisement = {
        id: detailId,
        object: "model",
        context_window: 8192,
        capabilities: { vision: true, tool_use: false },
      };
      const baseUrl = await startServer((request, response) => {
        json(
          response,
          request.url === "/models"
            ? { data: [listAdvertisement] }
            : detailAdvertisement,
        );
      });

      const result = await runScript(baseUrl, ["--json"], {
        ACTUALYZE_API_KEY: "invalid-detail-id-secret",
      });
      const report = parseReport(result);

      expect(report.models[0]).toEqual({
        id: "list-model",
        advertised_capabilities: {
          context_window: 1024,
          vision: false,
          tool_use: true,
        },
        list_advertisement: listAdvertisement,
        detail_advertisement: detailAdvertisement,
        detail_error:
          "detail validation failed: expected id to be absent or a non-empty string",
      });
    },
  );

  it("rejects an invalid detail object and normalizes from list data only", async () => {
    const listAdvertisement = {
      id: "invalid-object",
      context_window: 1024,
      capabilities: { tool_use: true },
    };
    const detailAdvertisement = {
      id: "invalid-object",
      object: "collection",
      context_window: 8192,
      capabilities: { tool_use: false },
    };
    const baseUrl = await startServer((request, response) => {
      json(
        response,
        request.url === "/models"
          ? { data: [listAdvertisement] }
          : detailAdvertisement,
      );
    });

    const result = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: "invalid-object-secret",
    });
    const report = parseReport(result);

    expect(report.models[0]).toEqual({
      id: "invalid-object",
      advertised_capabilities: { context_window: 1024, tool_use: true },
      list_advertisement: listAdvertisement,
      detail_advertisement: detailAdvertisement,
      detail_error:
        'detail validation failed: expected object to be absent or "model"',
    });
  });

  it("merges partial detail capabilities per key without losing false or null", async () => {
    const listAdvertisement = {
      id: "partial-capabilities",
      capabilities: {
        vision: false,
        tool_use: true,
        thinking: false,
        thinking_adaptive: false,
      },
    };
    const detailAdvertisement = {
      id: "partial-capabilities",
      object: "model",
      capabilities: { vision: null, thinking: true },
    };
    const baseUrl = await startServer((request, response) => {
      json(
        response,
        request.url === "/models"
          ? { data: [listAdvertisement] }
          : detailAdvertisement,
      );
    });

    const result = await runScript(baseUrl, ["--json"], {
      ACTUALYZE_API_KEY: "capability-merge-secret",
    });
    const report = parseReport(result);

    expect(report.models[0]?.advertised_capabilities).toEqual({
      vision: null,
      tool_use: true,
      thinking: true,
      thinking_adaptive: false,
      reasoning: true,
    });
  });

  it("renders terminal control and bidi characters visibly in text output", async () => {
    const unsafeId =
      "model\u001b]8;;https://example.test\u0007link\u009b\u202e";
    const listAdvertisement = {
      id: unsafeId,
      family: "family\u001b[31mred\u001b[0m\u2066",
    };
    const detailAdvertisement = {
      id: unsafeId,
      object: "model",
      owned_by: "owner\u0000name\u200f",
    };
    const baseUrl = await startServer((request, response) => {
      json(
        response,
        request.url === "/models"
          ? { data: [listAdvertisement] }
          : detailAdvertisement,
      );
    });

    const result = await runScript(baseUrl, [], {
      ACTUALYZE_API_KEY: "terminal-safety-secret",
    });

    expect(result.code).toBe(0);
    for (const unsafeCharacter of [
      "\u001b",
      "\u0007",
      "\u009b",
      "\u202e",
      "\u2066",
      "\u0000",
      "\u200f",
    ]) {
      expect(result.stdout).not.toContain(unsafeCharacter);
    }
    expect(result.stdout).toContain("\\u{001b}");
    expect(result.stdout).toContain("\\u{0007}");
    expect(result.stdout).toContain("\\u{009b}");
    expect(result.stdout).toContain("\\u{202e}");
    expect(result.stdout).toContain("\\u{2066}");
    expect(result.stdout).toContain("\\u{0000}");
    expect(result.stdout).toContain("\\u{200f}");
  });

  it("limits concurrent detail requests while preserving list order", async () => {
    const ids = ["first", "second", "third"];
    let activeDetails = 0;
    let maximumActiveDetails = 0;
    const baseUrl = await startServer((request, response) => {
      if (request.url === "/models") {
        json(response, { data: ids.map((id) => ({ id })) });
        return;
      }

      activeDetails += 1;
      maximumActiveDetails = Math.max(maximumActiveDetails, activeDetails);
      setTimeout(() => {
        activeDetails -= 1;
        json(response, {
          id: request.url?.split("/").at(-1),
          object: "model",
        });
      }, 100);
    });

    const result = await runScript(baseUrl, ["--json", "--concurrency", "2"], {
      ACTUALYZE_API_KEY: "concurrency-secret",
    });
    const report = parseReport(result);

    expect(maximumActiveDetails).toBe(2);
    expect(report.models.map((model) => model.id)).toEqual(ids);
  });
});
