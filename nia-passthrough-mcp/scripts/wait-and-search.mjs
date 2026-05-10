import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import dotenv from "dotenv";

const env = { ...process.env };
const parsed = dotenv.parse(fs.readFileSync(".env", "utf8"));
for (const [k,v] of Object.entries(parsed)) { if (!(k in env)) env[k] = v; }

const RESOURCE_ID = "233551f3-6052-4e9e-bcf1-4b69760b38d5";

const transport = new StdioClientTransport({
  command: "pipx", args: ["run", "--no-cache", "nia-mcp-server"],
  stderr: "pipe", env
});
transport.stderr?.on("data", () => {});

const client = new Client({ name: "searcher", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport, { timeout: 60000 });

// Poll status
for (let i = 0; i < 10; i++) {
  const status = await client.callTool({
    name: "manage_resource",
    arguments: { action: "status", identifier: RESOURCE_ID }
  });
  const text = status.content?.[0]?.text ?? "";
  console.error(`[poll ${i+1}] ${text.slice(0, 100)}`);
  if (text.includes("ready") || text.includes("completed") || text.includes("indexed")) break;
  if (text.includes("failed") || text.includes("error")) { console.error("FAILED:", text); break; }
  await new Promise(r => setTimeout(r, 5000));
}

// Search
const result = await client.callTool({
  name: "search",
  arguments: {
    query: "How does routing work in this project?",
    sources: [RESOURCE_ID]
  }
});
console.log("SEARCH RESULT:", JSON.stringify(result, null, 2));

await client.close();
process.exit(0);
