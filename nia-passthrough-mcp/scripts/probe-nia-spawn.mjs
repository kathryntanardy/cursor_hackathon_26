/**
 * Diagnostic: verifies Nia MCP child survives after StdioClientTransport.start().
 *
 * Default Nia child:
 * - macOS/Linux: pipx run --no-cache nia-mcp-server
 * - Windows: cmd /c npx … nia-codebase-mcp@latest (pipx Python stdio under Node often OSError 22)
 *
 * Usage:
 *   node scripts/probe-nia-spawn.mjs
 *
 * Env:
 *   NIA_API_KEY, NIA_API_URL (optional)
 *   NIA_MCP_PACKAGE — force this npm package via npx (overrides Windows default)
 *   NIA_NPX_PACKAGE — Windows default npx package (default: nia-codebase-mcp@latest)
 *   NIA_WINDOWS_USE_PIPX=1 — on Windows use pipx nia-mcp-server instead
 *   NIA_COMMAND — unix: npx binary; win32: token after cmd /c (default npx)
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
  process.platform === "win32" && /^(?:1|true|yes)$/i.test(process.env.NIA_WINDOWS_USE_PIPX?.trim() ?? "");

const childEnv = { ...process.env, NIA_API_KEY: apiKey, NIA_API_URL: niaApiUrl };

/**
 * @param {string} pkg
 * @returns {{ command: string; args: string[]; env: NodeJS.ProcessEnv }}
 */
function npxTransportConfig(pkg) {
  const args = ["-y", pkg];
  if (/^(?:1|true|yes)$/i.test(process.env.NIA_LEGACY_CLI_API_KEY?.trim() ?? "")) {
    args.push(`--api-key=${apiKey}`);
  }
  args.push("--transport=stdio");

  if (process.platform === "win32") {
    const comspec = process.env.ComSpec?.trim() || "cmd.exe";
    const npxBin = process.env.NIA_COMMAND?.trim() || "npx";
    return {
      command: comspec,
      args: ["/d", "/s", "/c", npxBin, ...args],
      env: childEnv,
    };
  }
  const npx = process.env.NIA_COMMAND?.trim() || "npx";
  return { command: npx, args, env: childEnv };
}

/** @type {{ command: string; args: string[]; env: NodeJS.ProcessEnv }} */
let cfg;
/** @type {string} */
let mode;

if (legacyPkg) {
  cfg = npxTransportConfig(legacyPkg);
  mode = "npx-forced-package";
} else if (process.platform === "win32" && !winUsePipx) {
  const pkg = process.env.NIA_NPX_PACKAGE?.trim() || "nia-codebase-mcp@latest";
  cfg = npxTransportConfig(pkg);
  mode = `win32-npx-${pkg}`;
} else if (process.platform === "win32") {
  cfg = {
    command: "cmd",
    args: ["/c", "pipx", "run", "--no-cache", "nia-mcp-server"],
    env: childEnv,
  };
  mode = "win32-pipx";
} else {
  cfg = {
    command: "pipx",
    args: ["run", "--no-cache", "nia-mcp-server"],
    env: childEnv,
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
