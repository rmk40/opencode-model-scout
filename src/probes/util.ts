import type { ProbeResult } from "./types";
import { LOG_PREFIX } from "../constants";

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

/**
 * Fetch + parse JSON in one call. Returns undefined on any failure:
 * network error, timeout, non-OK status, or malformed JSON.
 * Logs a warning on non-OK responses and JSON parse failures.
 */
export async function probeFetchJson<T>(
  url: string,
  label: string,
  options?: ProbeFetchOptions,
): Promise<T | undefined> {
  const res = await probeFetch(url, options);
  if (!res) return undefined;

  if (!res.ok) {
    console.warn(`${LOG_PREFIX} ${label}: HTTP ${res.status}`);
    return undefined;
  }

  try {
    return (await res.json()) as T;
  } catch (error) {
    console.warn(`${LOG_PREFIX} ${label}: JSON parse failed:`, error);
    return undefined;
  }
}

/** Frozen empty probe result — shared constant for early returns. */
export const EMPTY_RESULT: ProbeResult = Object.freeze({
  models: Object.freeze({}),
});
