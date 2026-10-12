#!/usr/bin/env node
// Fails when a built dist/*.js file loads @opencode/* or effect at runtime.
// The plugin uses those packages for types only and does not depend on them,
// so a runtime import would fail to resolve in an installed copy.
//
//   npm run compile:dev && npm run check:dist

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
);
const FORBIDDEN = /^(?:@opencode\/|effect(?:\/|$))/;
const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /require\s*\(\s*["']([^"']+)["']\s*\)/g,
];

let entries;
try {
  entries = await readdir(DIST, { withFileTypes: true });
} catch {
  console.log("dist/ is missing; run `npm run compile:dev` first");
  process.exit(1);
}

const files = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => entry.name)
  .sort();
if (files.length === 0) {
  console.log("dist/ has no .js files; run `npm run compile:dev` first");
  process.exit(1);
}

const violations = [];
for (const file of files) {
  const source = await readFile(path.join(DIST, file), "utf8");
  const specifiers = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  for (const specifier of [...specifiers].sort()) {
    if (FORBIDDEN.test(specifier)) violations.push(`${file}: ${specifier}`);
  }
}

if (violations.length > 0) {
  console.log("dist loads type-only packages at runtime:");
  for (const violation of violations) console.log(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`dist OK (${files.length} files checked)`);
}
