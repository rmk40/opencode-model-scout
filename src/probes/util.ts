import type { ProbeResult } from "./types";

/**
 * Build request headers, adding Authorization if apiKey is provided.
 * Does NOT include Content-Type — add locally when needed (e.g., Ollama POST).
 */
export function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
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
 * Thin wrapper around fetch with timeout and abort signal support.
 * Returns undefined on any failure (network error, timeout, abort).
 * Does NOT check res.ok — that's the caller's decision.
 */
export async function probeFetch(
  url: string,
  options?: ProbeFetchOptions,
): Promise<Response | undefined> {
  try {
    const signals: AbortSignal[] = [
      AbortSignal.timeout(options?.timeoutMs ?? 2000),
    ];
    if (options?.signal) signals.push(options.signal);

    return await fetch(url, {
      method: options?.method,
      headers: options?.headers,
      body: options?.body,
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    });
  } catch {
    return undefined;
  }
}

/** Frozen empty probe result — shared constant for early returns. */
export const EMPTY_RESULT: ProbeResult = Object.freeze({
  models: Object.freeze({}),
});
