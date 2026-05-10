#!/usr/bin/env node
/**
 * Patches node_modules/nia-codebase-mcp/dist/index.js to fix the startup guard
 * that fails when the workspace path contains spaces.
 *
 * Root cause: `import.meta.url.includes(process.argv[1])` fails because import.meta.url
 * URL-encodes spaces as %20 while process.argv[1] has literal spaces. main() is never
 * called and the MCP server exits immediately.
 *
 * Fix: also check `decodeURIComponent(import.meta.url).includes(argv[1])` and
 *      `argv[1].endsWith('index.js')` so the bundled binary always starts.
 *
 * This script is run automatically via the `postinstall` npm hook so the patch
 * survives `npm install`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "nia-codebase-mcp",
  "dist",
  "index.js",
);

if (!fs.existsSync(target)) {
  console.error(`[patch] nia-codebase-mcp not found at ${target} — skipping`);
  process.exit(0);
}

const src = fs.readFileSync(target, "utf8");
const ORIG = `if (import.meta.url.includes(process.argv[1]) || process.argv[1]?.endsWith('nia-codebase-mcp')) {`;
const PATCHED = `if (decodeURIComponent(import.meta.url).includes(process.argv[1] ?? '\\x00') || import.meta.url.includes(process.argv[1] ?? '\\x00') || process.argv[1]?.endsWith('nia-codebase-mcp') || process.argv[1]?.endsWith('index.js')) {`;

if (src.includes(PATCHED)) {
  console.error("[patch] nia-codebase-mcp already patched — nothing to do");
  process.exit(0);
}

if (!src.includes(ORIG)) {
  console.error("[patch] WARN: startup guard not found — the package may have changed; skipping patch");
  process.exit(0);
}

fs.writeFileSync(target, src.replace(ORIG, PATCHED), "utf8");
console.error("[patch] nia-codebase-mcp startup guard patched successfully");
