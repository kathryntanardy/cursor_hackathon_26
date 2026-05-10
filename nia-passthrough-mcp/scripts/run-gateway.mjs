#!/usr/bin/env node
/**
 * Cursor MCP entry (CONTRACTS.md §5): loads nia-passthrough-mcp/.env, runs dist/index.js.
 * Keeps NIA_API_KEY (and CACHE_API_URL / WS_PORT) out of ~/.cursor/mcp.json.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

/**
 * @param {string} filePath
 * @param {NodeJS.ProcessEnv} base
 */
function loadDotEnv(filePath, base) {
  /** @type {NodeJS.ProcessEnv} */
  const out = { ...base };
  if (!fs.existsSync(filePath)) {
    return out;
  }
  const parsed = dotenv.parse(fs.readFileSync(filePath, "utf8"));
  for (const [key, val] of Object.entries(parsed)) {
    // Like dotenv: do not override variables already set in the parent environment.
    if (!(key in out)) {
      out[key] = val;
    }
  }
  return out;
}

const env = loadDotEnv(path.join(packageRoot, ".env"), process.env);
if (!env.NIA_API_KEY?.trim()) {
  console.error(
    "[run-gateway] Set NIA_API_KEY in nia-passthrough-mcp/.env or export it before launching Cursor.",
  );
  process.exit(1);
}

const server = path.join(packageRoot, "dist", "index.js");
if (!fs.existsSync(server)) {
  console.error("[run-gateway] Missing dist/index.js — run: npm run build");
  process.exit(1);
}

const child = spawn(process.execPath, [server], {
  stdio: "inherit",
  env,
  windowsHide: true,
});

child.on("error", (err) => {
  console.error("[run-gateway] Failed to start MCP server:", err.message ?? err);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal !== null && signal !== undefined) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null || code === undefined ? 1 : code);
});
