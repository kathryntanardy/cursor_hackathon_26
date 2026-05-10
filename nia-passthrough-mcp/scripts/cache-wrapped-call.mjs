/**
 * Simulates cache-wrapped-nia for the Python nia-mcp-server:
 * 1. POST /lookup to cache engine
 * 2. On MISS/REJECT → call Nia search tool
 * 3. On MISS → POST /insert to cache engine
 * 4. Print status + response
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import dotenv from "dotenv";

const env = { ...process.env };
const parsed = dotenv.parse(fs.readFileSync(".env", "utf8"));
for (const [k,v] of Object.entries(parsed)) { if (!(k in env)) env[k] = v; }

const CACHE_URL = env.CACHE_API_URL ?? "http://localhost:8000";
const FOLDER_ID = "233551f3-6052-4e9e-bcf1-4b69760b38d5";
const user_query = process.argv[2] ?? "How does routing work in this project?";

// 1. Cache lookup
const t0 = Date.now();
const lookupRes = await fetch(`${CACHE_URL}/lookup`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query: user_query }),
});
const lookup = await lookupRes.json();
const cacheMs = Date.now() - t0;

console.error(`[cache] status=${lookup.status} similarity=${lookup.similarity ?? "null"} lookup_ms=${cacheMs}`);

if ((lookup.status === "EXACT_HIT" || lookup.status === "SEMANTIC_HIT") && lookup.cached_response) {
  console.log(`\n=== CACHE ${lookup.status} (${cacheMs}ms) ===`);
  console.log(lookup.cached_response.content);
  console.log("\nSources:", lookup.cached_response.sources);
  process.exit(0);
}

// 2. Call Nia
console.error(`[nia] cache ${lookup.status} — forwarding to Nia...`);

const transport = new StdioClientTransport({
  command: "pipx", args: ["run", "--no-cache", "nia-mcp-server"],
  stderr: "pipe", env
});
transport.stderr?.on("data", () => {});

const client = new Client({ name: "cache-wrapped", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport, { timeout: 60000 });

const niaTStart = Date.now();
const result = await client.callTool({
  name: "search",
  arguments: { query: user_query, local_folders: [FOLDER_ID] }
});
const niaMs = Date.now() - niaTStart;
console.error(`[nia] response in ${niaMs}ms`);

await client.close();

const content = result.content?.[0]?.text ?? "";
const response = { content, sources: [FOLDER_ID] };

// 3. Insert into cache (only on clean MISS, not VERIFIED_REJECT)
if (lookup.status === "MISS") {
  await fetch(`${CACHE_URL}/insert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: user_query, response }),
  }).catch(() => {});
  console.error("[cache] inserted result");
}

console.log(`\n=== NIA RESPONSE (cache ${lookup.status}, ${niaMs}ms) ===`);
console.log(content);

process.exit(0);
