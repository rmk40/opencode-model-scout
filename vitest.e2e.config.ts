import { defineConfig } from "vitest/config";

// Embedded-host E2E lane. Deliberately omits test/setup.ts, which replaces
// global.fetch with a mock for every unit test file.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
