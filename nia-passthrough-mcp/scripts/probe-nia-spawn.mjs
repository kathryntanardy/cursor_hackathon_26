/**
 * Diagnostic: verifies Nia MCP child survives after StdioClientTransport.start().
 * Matches TryNia local MCP: pipx run --no-cache nia-mcp-server (+ NIA_API_URL).
 *
 * Usage:
 *   node scripts/probe-nia-spawn.mjs
 *
 * Env:
 *   NIA_API_KEY, NIA_API_URL (optional)
 *   NIA_MCP_PACKAGE — if set, legacy npx probe instead (optional NIA_COMMAND)
 */
import process from "node:process";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const apiKey = process.argv[2] ?? process.env.NIA_API_KEY ?? "test-key-plain";
const niaApiUrl =
  (process.env.NIA_API_URL ?? "https://apigcp.trynia.ai/").trim() ||
  "https://apigcp.trynia.ai/";
const legacyPkg = process.env.NIA_MCP_PACKAGE?.trim();

/** @type {{ command: string; args: string[]; env: NodeJS.ProcessEnv }} */
let cfg;
if (legacyPkg) {
  const cmd =
    process.env.NIA_COMMAND?.trim() ||
    (process.platform === "win32" ? "npx.cmd" : "npx");
  cfg = {
    command: cmd,
    args: ["-y", legacyPkg, "--transport=stdio"],
    env: { ...process.env, NIA_API_KEY: apiKey, NIA_API_URL: niaApiUrl },
  };
} else if (process.platform === "win32") {
  cfg = {
    command: "cmd",
    args: ["/c", "pipx", "run", "--no-cache", "nia-mcp-server"],
    env: { ...process.env, NIA_API_KEY: apiKey, NIA_API_URL: niaApiUrl },
  };
} else {
  cfg = {
    command: "pipx",
    args: ["run", "--no-cache", "nia-mcp-server"],
    env: { ...process.env, NIA_API_KEY: apiKey, NIA_API_URL: niaApiUrl },
  };
}

let stderrBuf = "";
const transport = new StdioClientTransport({
  command: cfg.command,
  args: cfg.args,
  stderr: "pipe",
  env: cfg.env,
});
transport.stderr?.on("data", (chunk) => {
  stderrBuf += chunk.toString();
  process.stderr.write(chunk);
});

await transport.start();
console.error(
  `[probe-nia-spawn] mode=${legacyPkg ? "legacy-npx" : "pipx"} command=${cfg.command} pid=${transport.pid}`,
);
await new Promise((r) => setTimeout(r, 800));
console.error(`[probe-nia-spawn] after 800ms still have pid? ${transport.pid}`);
console.error(`[probe-nia-spawn] stderr len so far: ${stderrBuf.length}`);
await transport.close();
console.error("[probe-nia-spawn] done");
