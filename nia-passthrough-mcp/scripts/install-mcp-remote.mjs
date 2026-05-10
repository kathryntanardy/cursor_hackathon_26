#!/usr/bin/env node
/**
 * Cursor MCP: TryNia **remote** Nia server (HTTP) per
 * https://docs.trynia.ai/integrations/installation/mcp#cursor
 *
 * Reads NIA_API_KEY from nia-passthrough-mcp/.env (same as run-gateway) or from the environment.
 * Removes `cache-wrapped-nia` so you do not run two Nia stacks; run `npm run mcp:install` to restore the gateway.
 * Need cache + WebSocket + hosted Nia? Skip this script; run `npm run mcp:install` and set `NIA_USE_REMOTE_UPSTREAM=1` in `.env`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const envPath = path.join(packageRoot, ".env");

/** @type {NodeJS.ProcessEnv} */
let merged = { ...process.env };
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (!(k in merged)) {
      merged[k] = v;
    }
  }
}

const apiKey = merged.NIA_API_KEY?.trim();
if (!apiKey) {
  console.error(
    "[install-mcp-remote] Set NIA_API_KEY in nia-passthrough-mcp/.env (or export it) before running this script.",
  );
  process.exit(1);
}

const remoteUrl = (merged.NIA_MCP_REMOTE_URL ?? "https://apigcp.trynia.ai/mcp").trim();
if (!/^https?:\/\//i.test(remoteUrl)) {
  console.error("[install-mcp-remote] NIA_MCP_REMOTE_URL must be an http(s) URL.");
  process.exit(1);
}

const mcpDir = path.join(os.homedir(), ".cursor");
const mcpPath = path.join(mcpDir, "mcp.json");

/** @type {{ mcpServers?: Record<string, unknown> }} */
let data = { mcpServers: {} };
if (fs.existsSync(mcpPath)) {
  try {
    data = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  } catch (e) {
    console.error("[install-mcp-remote] Could not parse existing mcp.json:", e);
    process.exit(1);
  }
}

if (!data.mcpServers || typeof data.mcpServers !== "object") {
  data.mcpServers = {};
}

delete data.mcpServers["nia-cache-gateway"];
delete data.mcpServers["cache-wrapped-nia"];

data.mcpServers.nia = {
  url: remoteUrl,
  headers: {
    Authorization: `Bearer ${apiKey}`,
  },
};

fs.mkdirSync(mcpDir, { recursive: true });
fs.writeFileSync(mcpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

console.error(`[install-mcp-remote] Wrote remote server "nia" → ${mcpPath}`);
console.error(`[install-mcp-remote] URL: ${remoteUrl}`);
console.error(
  "[install-mcp-remote] Restart Cursor. For the cache-wrapped gateway again: npm run mcp:install",
);
