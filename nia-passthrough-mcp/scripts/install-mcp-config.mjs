#!/usr/bin/env node
/**
 * Merges CONTRACTS.md §5 `cache-wrapped-nia` into ~/.cursor/mcp.json via run-gateway.mjs (secrets in .env only).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const runnerPath = path.resolve(packageRoot, "scripts", "run-gateway.mjs");

const mcpDir = path.join(os.homedir(), ".cursor");
const mcpPath = path.join(mcpDir, "mcp.json");

/** @type {{ mcpServers?: Record<string, unknown> }} */
let data = { mcpServers: {} };
if (fs.existsSync(mcpPath)) {
  try {
    const raw = fs.readFileSync(mcpPath, "utf8");
    data = JSON.parse(raw);
  } catch (e) {
    console.error("[install-mcp-config] Could not parse existing mcp.json:", e);
    process.exit(1);
  }
}

if (!data.mcpServers || typeof data.mcpServers !== "object") {
  data.mcpServers = {};
}

delete data.mcpServers["nia-cache-gateway"];
delete data.mcpServers.nia;
data.mcpServers["cache-wrapped-nia"] = {
  command: process.execPath,
  args: [runnerPath],
};

fs.mkdirSync(mcpDir, { recursive: true });
fs.writeFileSync(mcpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

console.error(`[install-mcp-config] Wrote cache-wrapped-nia → ${mcpPath}`);
console.error(`[install-mcp-config] Runner: ${runnerPath}`);
console.error(
  "[install-mcp-config] Add NIA_API_KEY to nia-passthrough-mcp/.env (see .env.example), run npm run build, restart Cursor.",
);
