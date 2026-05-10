/**
 * Diagnostic: verifies Nia MCP child survives after StdioClientTransport.start().
 *
 * Default Nia child:
 * - macOS/Linux: pipx run --no-cache nia-mcp-server
 * - Windows: npx nia-codebase-mcp@latest (pipx Python stdio under Node often OSError 22 on stdout)
 *
 * Usage:
 *   node scripts/probe-nia-spawn.mjs
 *
 * Env:
 *   NIA_API_KEY, NIA_API_URL (optional)
 *   NIA_MCP_PACKAGE — force this npm package via npx (overrides Windows default)
 *   NIA_NPX_PACKAGE — Windows default npx package (default: nia-codebase-mcp@latest)
 *   NIA_WINDOWS_USE_PIPX=1 — on Windows use pipx nia-mcp-server instead
 *   NIA_LEGACY_CLI_API_KEY=1 — include --api-key in argv for npx (optional; exposes key in process list)
 */
import process from "node:process";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const apiKey = process.argv[2] ?? process.env.NIA_API_KEY ?? "test-key-plain";
const niaApiUrl =
  (process.env.NIA_API_URL ?? "https://apigcp.trynia.ai/").trim() ||
  "https://apigcp.trynia.ai/";
const legacyPkg = process.env.NIA_MCP_PACKAGE?.trim();
const winUsePipx =
  process.platform === "win32" &&
  /^(?:1|true|yes)$/i.test(process.env.NIA_WINDOWS_USE_PIPX?.trim() ?? "");

/** @type {{ command: string; args: string[]; env: NodeJS.ProcessEnv }} */
let cfg;
/** @type {string} */
let mode;

if (legacyPkg) {
  const cmd =
    process.env.NIA_COMMAND?.trim() ||
    (process.platform === "win32" ? "npx.cmd" : "npx");
  const args = ["-y", legacyPkg];
  if (/^(?:1|true|yes)$/i.test(process.env.NIA_LEGACY_CLI_API_KEY?.trim() ?? "")) {
    args.push(`--api-key=${apiKey}`);
  }
  args.push("--transport=stdio");
  cfg = {
    command: cmd,
    args,
    env: { ...process.env, NIA_API_KEY: apiKey, NIA_API_URL: niaApiUrl },
  };
  mode = "npx-forced-package";
} else if (process.platform === "win32" && !winUsePipx) {
  const cmd = process.env.NIA_COMMAND?.trim() || "npx.cmd";
  const pkg = process.env.NIA_NPX_PACKAGE?.trim() || "nia-codebase-mcp@latest";
  const args = ["-y", pkg];
  if (/^(?:1|true|yes)$/i.test(process.env.NIA_LEGACY_CLI_API_KEY?.trim() ?? "")) {
    args.push(`--api-key=${apiKey}`);
  }
  args.push("--transport=stdio");
  cfg = {
    command: cmd,
    args,
    env: { ...process.env, NIA_API_KEY: apiKey, NIA_API_URL: niaApiUrl },
  };
  mode = `win32-npx-${pkg}`;
} else if (process.platform === "win32") {
  cfg = {
    command: "cmd",
    args: ["/c", "pipx", "run", "--no-cache", "nia-mcp-server"],
    env: { ...process.env, NIA_API_KEY: apiKey, NIA_API_URL: niaApiUrl },
  };
  mode = "win32-pipx";
} else {
  cfg = {
    command: "pipx",
    args: ["run", "--no-cache", "nia-mcp-server"],
    env: { ...process.env, NIA_API_KEY: apiKey, NIA_API_URL: niaApiUrl },
  };
  mode = "pipx";
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
console.error(`[probe-nia-spawn] mode=${mode} command=${cfg.command} pid=${transport.pid}`);
await new Promise((r) => setTimeout(r, 800));
console.error(`[probe-nia-spawn] after 800ms still have pid? ${transport.pid}`);
console.error(`[probe-nia-spawn] stderr len so far: ${stderrBuf.length}`);
await transport.close();
console.error("[probe-nia-spawn] done");
