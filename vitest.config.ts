import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["test/setup.ts"],
    // The embedded-host lane runs separately (vitest.e2e.config.ts).
    exclude: ["**/node_modules/**", "test/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "test/", "**/*.d.ts"],
    },
    testTimeout: 10000,
  },
});
