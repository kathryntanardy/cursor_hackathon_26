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
transport.stderr?.on("data", () => {}); // suppress stderr

const client = new Client({ name: "probe", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport, { timeout: 60000 });

// First list resources
const resourceList = await client.callTool({ name: "manage_resource", arguments: { action: "list" } });
console.log("RESOURCES:", JSON.stringify(resourceList, null, 2));

await client.close();
process.exit(0);
