import type { ProbeResult } from "./types";

/**
 * Set a header, replacing any existing entry whose name differs only in case.
 * HTTP header names are case-insensitive, and a plain-object init that holds
 * both spellings would send the values joined into one header.
 */
export function setHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): Record<string, string> {
  const lowerName = name.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === lowerName) delete headers[existing];
  }
  headers[name] = value;
  return headers;
}

/**
 * Build request headers: `Authorization: Bearer <apiKey>` when an API key is
 * set, then the provider's headers on top, so an explicit provider
 * `Authorization` replaces the derived one.
 * Does NOT include Content-Type — add locally when needed (e.g., Ollama POST).
 */
export function buildHeaders(
  apiKey?: string,
  providerHeaders?: Readonly<Record<string, string>>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (providerHeaders) {
    for (const [name, value] of Object.entries(providerHeaders)) {
      if (typeof value === "string") setHeader(headers, name, value);
    }
  }
  return headers;
}

/** Runtime guard for numeric fields from untrusted provider JSON. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Options for probeFetch.
 */
export interface ProbeFetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number; // default 2000
}

/**
 * Links each Response to the AbortController that owns its underlying fetch, so
 * a body-read timeout (`raceBody`) can abort the fetch itself. Aborting the
 * controller reliably rejects an in-flight `res.json()`/`res.text()` and tears
 * down the socket, whereas `res.body.cancel()` is disturbed by the reader lock
 * that the body-consuming method already holds. A WeakMap avoids retaining
 * Responses beyond their normal lifetime.
 */
const responseAborters = new WeakMap<Response, AbortController>();

/**
 * Thin wrapper around fetch with timeout and abort signal support.
 * Returns undefined on any failure (network error, timeout, abort).
 * Does NOT check res.ok — that's the caller's decision.
 *
 * The composed `AbortSignal.timeout` bounds the connection + headers phase; the
 * response body is bounded separately by `readBody`/`readJson`, since a signal
 * that fires late leaves almost no budget for reading the body. Both phases
 * share one AbortController so a stalled body read can abort the live fetch.
 */
export async function probeFetch(
  url: string,
  options?: ProbeFetchOptions,
): Promise<Response | undefined> {
  const controller = new AbortController();
  try {
    const signals: AbortSignal[] = [
      controller.signal,
      AbortSignal.timeout(options?.timeoutMs ?? 2000),
    ];
    if (options?.signal) signals.push(options.signal);

    const res = await fetch(url, {
      method: options?.method,
      headers: options?.headers,
      body: options?.body,
      signal: AbortSignal.any(signals),
    });
    responseAborters.set(res, controller);
    return res;
  } catch {
    return undefined;
  }
}

/**
 * Race an arbitrary body-read promise against a hard timeout. A provider can
 * send headers quickly and then stall the body (e.g. a broken SSE/stream),
 * which would otherwise block `res.text()`/`res.json()` indefinitely. On
 * timeout, aborts the underlying fetch (releasing the socket and rejecting the
 * in-flight read) and returns the `onTimeout` sentinel.
 *
 * Aborting the fetch's own AbortController is what actually terminates a stalled
 * `res.json()`/`res.text()`: once that method owns the body reader, a bare
 * `res.body.cancel()` is disturbed by the lock and may not tear down the read.
 * `res.body.cancel()` is kept as a best-effort fallback for Responses created
 * outside `probeFetch` (e.g. mocks) that have no registered aborter.
 */
async function raceBody<T>(
  res: Response,
  read: () => Promise<T>,
  timeoutMs: number,
  onTimeout: T,
  onError: T = onTimeout,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        responseAborters.get(res)?.abort();
        void res.body?.cancel().catch(() => {});
        resolve(onTimeout);
      }, timeoutMs);
    });
    return await Promise.race([read(), timeout]);
  } catch {
    return onError;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Read a response body as text with a hard timeout. Returns undefined if the
 * body does not arrive within `timeoutMs`.
 */
export async function readBody(
  res: Response,
  timeoutMs = 2000,
): Promise<string | undefined> {
  return raceBody(res, () => res.text(), timeoutMs, undefined);
}

/**
 * Read + parse a response body as JSON with a hard timeout on the body read.
 * Returns undefined on timeout, empty body, or malformed JSON. Uses `res.json()`
 * when available (falling back to `res.text()` + `JSON.parse`), both bounded by
 * the same timeout.
 */
export async function readJson<T>(
  res: Response,
  timeoutMs = 2000,
): Promise<T | undefined> {
  if (typeof res.json === "function") {
    return raceBody<T | undefined>(
      res,
      async () => (await res.json()) as T,
      timeoutMs,
      undefined,
    );
  }
  const text = await readBody(res, timeoutMs);
  if (text === undefined || text === "") return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * Fetch + parse JSON in one call. Returns undefined on any failure:
 * network error, timeout, non-OK status, slow/hanging body, or malformed JSON.
 * Never writes to stdout/stderr.
 */
export async function probeFetchJson<T>(
  url: string,
  _label: string,
  options?: ProbeFetchOptions,
): Promise<T | undefined> {
  const res = await probeFetch(url, options);
  if (!res) return undefined;
  if (!res.ok) return undefined;
  return readJson<T>(res, options?.timeoutMs ?? 2000);
}

/**
 * Outcome of {@link fetchOutcome}: a successful response; a non-success
 * status, whose body is already cancelled; the request's own timer fired;
 * the request failed without a response (refused connection, DNS, TLS); or
 * the caller's signal aborted it.
 */
export type FetchOutcome =
  | { readonly type: "ok"; readonly response: Response }
  | {
      readonly type: "status";
      readonly status: number;
      readonly headers: Headers | undefined;
    }
  | { readonly type: "timeout" }
  | { readonly type: "network" }
  | { readonly type: "aborted" };

/**
 * {@link probeFetch} with a typed outcome instead of `undefined`, so a
 * caller can tell a timeout from an unreachable server. The timeout covers
 * only the connection and headers phase: it is cleared once headers
 * arrive, so a stalled body is bounded and reported by the body-read timer
 * of {@link readJsonOutcome} (or `readJson`), which can abort the fetch.
 */
export async function fetchOutcome(
  url: string,
  options?: ProbeFetchOptions,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const headerPhase = new AbortController();
  const timer = setTimeout(() => {
    headerPhase.abort(new DOMException("timed out", "TimeoutError"));
  }, options?.timeoutMs ?? 2000);
  try {
    const signals: AbortSignal[] = [controller.signal, headerPhase.signal];
    if (options?.signal) signals.push(options.signal);
    const res = await fetch(url, {
      method: options?.method,
      headers: options?.headers,
      body: options?.body,
      signal: AbortSignal.any(signals),
    });
    responseAborters.set(res, controller);
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return {
        type: "status",
        status: res.status,
        headers: res.headers instanceof Headers ? res.headers : undefined,
      };
    }
    return { type: "ok", response: res };
  } catch {
    if (options?.signal?.aborted) return { type: "aborted" };
    if (headerPhase.signal.aborted) return { type: "timeout" };
    return { type: "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Outcome of {@link readJsonOutcome}: the parsed value, the body-read timer
 * fired, or the body could not be read or parsed.
 */
export type JsonOutcome =
  | { readonly type: "ok"; readonly value: unknown }
  | { readonly type: "timeout" }
  | { readonly type: "invalid" };

/**
 * {@link readJson} with a typed outcome: a fired body-read timeout is
 * `timeout`, and an empty, malformed, or failed body is `invalid`. The
 * timeout aborts the fetch the same way.
 */
export async function readJsonOutcome(
  res: Response,
  timeoutMs = 2000,
): Promise<JsonOutcome> {
  const read =
    typeof res.json === "function"
      ? async (): Promise<unknown> => res.json()
      : async (): Promise<unknown> => JSON.parse(await res.text());
  return raceBody<JsonOutcome>(
    res,
    async () => ({ type: "ok", value: await read() }),
    timeoutMs,
    { type: "timeout" },
    { type: "invalid" },
  );
}

/** Frozen empty probe result — shared constant for early returns. */
export const EMPTY_RESULT: ProbeResult = Object.freeze({
  models: Object.freeze({}),
});
