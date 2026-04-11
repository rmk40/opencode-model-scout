/**
 * Shared test setup — loaded automatically via vitest.config.ts setupFiles.
 *
 * Provides:
 * - `global.mockFetch` (vi.fn()) assigned to `global.fetch`
 * - AbortSignal.timeout polyfill (Node <18.x test compat)
 * - AbortSignal.any polyfill (Node <20.x test compat)
 * - beforeEach: resets mockFetch + silences console.warn
 * - afterEach: restores all mocks
 */
import { vi, beforeEach, afterEach } from "vitest";

export const mockFetch = vi.fn();
global.fetch = mockFetch;

// Expose on globalThis so test files can import from setup or reference directly
declare global {
  var mockFetch: ReturnType<typeof vi.fn>;
}
globalThis.mockFetch = mockFetch;

// Polyfill AbortSignal.timeout for test environments that lack it
if (!global.AbortSignal.timeout) {
  global.AbortSignal.timeout = vi.fn(() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    return controller.signal;
  });
}

// Polyfill AbortSignal.any for test environments that lack it
if (!global.AbortSignal.any) {
  global.AbortSignal.any = vi.fn(() => {
    const controller = new AbortController();
    return controller.signal;
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});
