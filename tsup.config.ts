import { defineConfig } from "tsup";

// The host supplies @opentui/* and solid-js at runtime. @opencode/* and effect
// are type-only, and keeping them external leaves any runtime import visible
// to scripts/check-dist.mjs instead of bundling it. A string external matches
// only that exact specifier or its subpaths, with no glob support, so scopes
// need patterns. Splitting is off so each entry is one self-contained file;
// the modules they share are small and stateless.
export default defineConfig({
  entry: ["src/server.ts", "src/tui.ts", "src/rpc.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  splitting: false,
  external: [/^@opencode\//, /^effect(\/|$)/, /^@opentui\//, /^solid-js(\/|$)/],
});
