import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import dotenv from "dotenv";

const env = { ...process.env };
const parsed = dotenv.parse(fs.readFileSync(".env", "utf8"));
for (const [k,v] of Object.entries(parsed)) { if (!(k in env)) env[k] = v; }

const FOLDER_ID = "233551f3-6052-4e9e-bcf1-4b69760b38d5";
const query = process.argv[2] ?? "How does routing work in this project?";

const transport = new StdioClientTransport({
  command: "pipx", args: ["run", "--no-cache", "nia-mcp-server"],
  stderr: "pipe", env
});
transport.stderr?.on("data", () => {});

const client = new Client({ name: "searcher", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport, { timeout: 60000 });

const result = await client.callTool({
  name: "search",
  arguments: { query, local_folders: [FOLDER_ID] }
});
console.log(result.content?.[0]?.text ?? JSON.stringify(result));

await client.close();
process.exit(0);
