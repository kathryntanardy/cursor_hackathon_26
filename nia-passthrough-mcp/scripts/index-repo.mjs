import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import dotenv from "dotenv";

const env = { ...process.env };
const parsed = dotenv.parse(fs.readFileSync(".env", "utf8"));
for (const [k,v] of Object.entries(parsed)) { if (!(k in env)) env[k] = v; }

const transport = new StdioClientTransport({
  command: "pipx", args: ["run", "--no-cache", "nia-mcp-server"],
  stderr: "pipe", env
});
transport.stderr?.on("data", () => {});

const client = new Client({ name: "indexer", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport, { timeout: 60000 });

// Index the local repo
const result = await client.callTool({
  name: "index",
  arguments: {
    folder_path: "/Users/verrill/Documents/Nerding/Hackathon/Cursor AI Hackathon/cursor_hackathon_26"
  }
});
console.log("INDEX RESULT:", JSON.stringify(result, null, 2));

await client.close();
process.exit(0);
