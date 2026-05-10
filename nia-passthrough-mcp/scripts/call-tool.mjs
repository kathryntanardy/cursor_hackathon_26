#!/usr/bin/env node
/**
 * One-shot MCP client: starts cache-wrapped-nia via stdio, calls lookup_codebase_context,
 * prints the result, then exits.
 *
 * Usage:
 *   node scripts/call-tool.mjs "Your query here"
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

// Load .env (same logic as run-gateway.mjs)
const envPath = path.join(packageRoot, ".env");
const env = { ...process.env };
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (!(k in env)) env[k] = v;
  }
}

if (!env.NIA_API_KEY?.trim()) {
  console.error("NIA_API_KEY not set. Add it to nia-passthrough-mcp/.env");
  process.exit(1);
}

const user_query = process.argv[2] ?? "How does routing work in this project?";
console.error(`[call-tool] query: "${user_query}"`);

const serverScript = path.join(packageRoot, "dist", "index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverScript],
  stderr: "inherit",
  env: env,
});

const client = new Client({ name: "call-tool-script", version: "1.0.0" }, { capabilities: {} });

try {
  await client.connect(transport, { timeout: 300_000 });
  console.error("[call-tool] Connected. Calling lookup_codebase_context...\n");

  const result = await client.callTool(
    { name: "lookup_codebase_context", arguments: { user_query } },
    undefined,
    { timeout: 300_000 },
  );

  console.log("=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error("[call-tool] Error:", err?.message ?? err);
  process.exit(1);
} finally {
  await client.close().catch(() => {});
  process.exit(0);
}
