/**
 * Diagnostic: verifies Nia MCP child survives after StdioClientTransport.start().
 * Usage:
 *   node scripts/probe-nia-spawn.mjs [apiKey] [commandOverride]
 *
 * Env:
 *   PROBE_COMMAND — e.g. npx.cmd (Windows), npx (Unix), or absolute path.
 */
import process from "node:process";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const apiKey = process.argv[2] ?? process.env.NIA_API_KEY ?? "test-key-plain";
const cmd =
  process.argv[3] ??
  process.env.PROBE_COMMAND ??
  (process.platform === "win32" ? "npx.cmd" : "npx");

let stderrBuf = "";
const transport = new StdioClientTransport({
  command: cmd,
  args: ["-y", "nia-codebase-mcp@1.0.2", `--api-key=${apiKey}`, "--transport=stdio"],
  stderr: "pipe",
  env: { ...process.env, NIA_API_KEY: apiKey },
});
transport.stderr?.on("data", (chunk) => {
  stderrBuf += chunk.toString();
  process.stderr.write(chunk);
});

await transport.start();
console.error(`[probe-nia-spawn] command=${cmd} pid=${transport.pid}`);
await new Promise((r) => setTimeout(r, 800));
console.error(`[probe-nia-spawn] after 800ms still have pid? ${transport.pid}`);
console.error(`[probe-nia-spawn] stderr len so far: ${stderrBuf.length}`);
await transport.close();
console.error("[probe-nia-spawn] done");
