#!/usr/bin/env node
/**
 * nia-codebase-mcp only calls main() when `import.meta.url.includes(process.argv[1])`.
 * On Windows, Node passes argv[1] with backslashes; import.meta.url uses forward slashes,
 * so the check fails and the server exits immediately (MCP client sees -32000).
 * Normalize argv[1] to forward slashes, then load the real entry.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, "..");
const niaIndex = path.join(gatewayRoot, "node_modules", "nia-codebase-mcp", "dist", "index.js");
const argv1 = niaIndex.replace(/\\/g, "/");
process.argv = [process.argv[0] ?? "node", argv1, ...process.argv.slice(2)];
await import(pathToFileURL(niaIndex).href);
