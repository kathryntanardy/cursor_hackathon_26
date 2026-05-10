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

const client = new Client({ name: "check", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport, { timeout: 60000 });

// List all resources
const list = await client.callTool({ name: "manage_resource", arguments: { action: "list" } });
console.log("LIST:", JSON.stringify(list.content?.[0]?.text, null, 2));

// Status with resource_type
const status = await client.callTool({
  name: "manage_resource",
  arguments: { action: "status", resource_type: "local_folder", identifier: RESOURCE_ID }
});
console.log("STATUS:", JSON.stringify(status.content?.[0]?.text, null, 2));

await client.close();
process.exit(0);
