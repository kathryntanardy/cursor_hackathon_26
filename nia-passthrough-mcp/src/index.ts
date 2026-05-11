/**
 * Person 1 MCP — behavior and types per repo root CONTRACTS.md (§1–2, §5).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket, WebSocketServer } from "ws";
import * as z from "zod/v4";

const NIA_TOOL = "lookup_codebase_context" as const;

const DEMO_COST_SAVED_USD_PER_HIT = 0.012;

type CacheStatus = "EXACT_HIT" | "SEMANTIC_HIT" | "VERIFIED_REJECT" | "MISS";

interface CachedResponse {
  content: string;
  sources: string[];
}

interface LookupResponse {
  status: CacheStatus;
  similarity: number | null;
  cached_response: CachedResponse | null;
  cached_query: string | null;
}

interface QueryRecord {
  query_id: string;
  query: string;
  status: CacheStatus;
  similarity: number | null;
  latency_ms: number;
  cost_saved_usd: number;
  latency_saved_ms: number;
  timestamp: number;
}

type WSEvent =
  | {
      type: "query_complete";
      query_id: string;
      query: string;
      status: CacheStatus;
      similarity: number | null;
      latency_ms: number;
      cost_saved_usd: number;
      latency_saved_ms: number;
    }
  | {
      type: "metrics_update";
      hit_rate: number;
      total_saved_usd: number;
      total_saved_ms: number;
      total_queries: number;
      last_5: QueryRecord[];
    }
  | { type: "reset_complete" };

const toolOutputSchema = {
  content: z.string(),
  sources: z.array(z.string()),
};

type UnknownToolResult = {
  content?: unknown;
  isError?: boolean;
  structuredContent?: unknown;
};

/** Running aggregates + last-5 for §2 metrics_update */
const session = {
  avgNiaLatencyMs: 2000,
  total_queries: 0,
  /** EXACT_HIT + SEMANTIC_HIT */
  hit_count: 0,
  total_saved_usd: 0,
  total_saved_ms: 0,
  last_5: [] as QueryRecord[],
  prev_cache_size: null as number | null,
};

function truncateQuery(q: string, max = 200): string {
  return q.length <= max ? q : q.slice(0, max);
}

function broadcastWss(wss: WebSocketServer, ev: WSEvent): void {
  const raw = JSON.stringify(ev);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
    }
  }
}

function buildMetricsUpdate(): WSEvent {
  const hit_rate = session.total_queries === 0 ? 0 : session.hit_count / session.total_queries;
  return {
    type: "metrics_update",
    hit_rate,
    total_saved_usd: session.total_saved_usd,
    total_saved_ms: session.total_saved_ms,
    total_queries: session.total_queries,
    last_5: session.last_5.map((r) => ({ ...r })),
  };
}

function pushQueryRecord(r: QueryRecord): void {
  session.last_5.unshift(r);
  session.last_5 = session.last_5.slice(0, 5);
}

function zeroSessionFromReset(): void {
  session.total_queries = 0;
  session.hit_count = 0;
  session.total_saved_usd = 0;
  session.total_saved_ms = 0;
  session.last_5 = [];
}

function extractTextBlocks(result: UnknownToolResult): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const parts = blocks.filter((b): b is { type: "text"; text: string } => {
    return !!b && typeof b === "object" && "type" in b && (b as { type: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string";
  });
  return parts.map((b) => b.text).join("\n");
}

function parseNiaPlaintextResponse(raw: string): { content: string; sources: string[] } {
  const sourcesMarker = "\n\nSources:\n";
  const idx = raw.lastIndexOf(sourcesMarker);
  if (idx === -1) {
    return { content: raw.trim(), sources: [] };
  }
  const main = raw.slice(0, idx).trim();
  const sourcesPart = raw.slice(idx + sourcesMarker.length);
  const sources = sourcesPart
    .split("\n")
    .map((line) => line.replace(/^\-\s*/, "").trim())
    .filter(Boolean);
  return { content: main, sources };
}

function stripLeadingContextBanner(body: string, user_query: string): string {
  const quoted = `Context for "${user_query}":`;
  const unquoted = "Context for ";
  if (body.startsWith(quoted)) {
    return body.slice(quoted.length).trimStart();
  }
  if (body.startsWith(unquoted)) {
    const after = body.indexOf(":", unquoted.length);
    if (after !== -1) {
      return body.slice(after + 1).trimStart();
    }
  }
  return body;
}

function isCachedResponse(val: unknown): val is CachedResponse {
  return (
    !!val &&
    typeof val === "object" &&
    typeof (val as CachedResponse).content === "string" &&
    Array.isArray((val as CachedResponse).sources) &&
    (val as CachedResponse).sources.every((s) => typeof s === "string")
  );
}

/** Must match `dependencies.nia-codebase-mcp` in package.json for bundled spawn. */
const BUNDLED_NIA_CODEBASE_ARG = "nia-codebase-mcp@1.0.2";

function gatewayPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function bundledNiaCodebaseMcpCliJs(): string | null {
  const p = path.join(gatewayPackageRoot(), "node_modules", "nia-codebase-mcp", "dist", "index.js");
  return fs.existsSync(p) ? p : null;
}

function envTruthy(name: string): boolean {
  return /^(?:1|true|yes)$/i.test(process.env[name]?.trim() ?? "");
}

/** TryNia recommends hosted MCP (`/mcp`). Bundled `nia-codebase-mcp` calls `/chat/completions`, which 404s on current apigcp — default remote avoids that. Set `NIA_USE_REMOTE_UPSTREAM=0` for a local subprocess (pipx / bundled). */
function useRemoteNiaUpstream(): boolean {
  const v = process.env.NIA_USE_REMOTE_UPSTREAM?.trim();
  if (v === undefined || v === "") {
    return true;
  }
  return envTruthy("NIA_USE_REMOTE_UPSTREAM");
}

/** One token in the string passed to `cmd.exe /c "..."` (avoid broken parsing when args are split). */
function windowsCmdExeToken(token: string): string {
  if (token === "") return '""';
  if (/[\s^&|()<>"]/u.test(token)) {
    return `"${token.replace(/"/gu, '\\"')}"`;
  }
  return token;
}

function npxNiaSpawnConfig(
  pkg: string,
  apiKey: string,
  baseEnv: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const cliKeyLegacy = envTruthy("NIA_LEGACY_CLI_API_KEY");
  const forceNpx = envTruthy("NIA_FORCE_NPX");

  if (!forceNpx && pkg === BUNDLED_NIA_CODEBASE_ARG) {
    const cli = bundledNiaCodebaseMcpCliJs();
    if (cli) {
      // Windows: spawn via launcher so nia-codebase-mcp's argv[1] guard matches import.meta.url
      // (see scripts/nia-bundled-launch.mjs).
      const launcher = path.join(gatewayPackageRoot(), "scripts", "nia-bundled-launch.mjs");
      const useLauncher = process.platform === "win32" && fs.existsSync(launcher);
      const args: string[] = [];
      if (cliKeyLegacy) {
        args.push(`--api-key=${apiKey}`);
      }
      args.push("--transport=stdio");
      return {
        command: process.execPath,
        args: [useLauncher ? launcher : cli, ...args],
        env: baseEnv,
      };
    }
  }

  const npxArgs: string[] = ["-y", pkg];
  if (cliKeyLegacy) {
    npxArgs.push(`--api-key=${apiKey}`);
  }
  npxArgs.push("--transport=stdio");

  if (process.platform === "win32") {
    const comspec = process.env.ComSpec?.trim() || "cmd.exe";
    const npxBin = process.env.NIA_COMMAND?.trim() || "npx";
    const cmdline = [npxBin, ...npxArgs].map(windowsCmdExeToken).join(" ");
    return {
      command: comspec,
      // One argv tail after /c: cmd only treats the remainder as the command when passed this way reliably.
      args: ["/d", "/s", "/c", cmdline],
      env: baseEnv,
    };
  }

  const npx = process.env.NIA_COMMAND?.trim() || "npx";
  return {
    command: npx,
    // Upstream nia-codebase-mcp resolves key as CLI --api-key OR process.env.NIA_API_KEY.
    // NIA_LEGACY_CLI_API_KEY=1 opts into argv (visible in ps) for odd forks.
    args: npxArgs,
    env: baseEnv,
  };
}

function niaChildSpawnConfig(apiKey: string): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const niaApiUrl =
    (process.env.NIA_API_URL ?? "https://apigcp.trynia.ai/").trim() ||
    "https://apigcp.trynia.ai/";
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NIA_API_KEY: apiKey,
    NIA_API_URL: niaApiUrl,
  };

  const legacyPkg = process.env.NIA_MCP_PACKAGE?.trim();
  if (legacyPkg) {
    return npxNiaSpawnConfig(legacyPkg, apiKey, baseEnv);
  }

  // Windows: pipx Python nia-mcp-server + MCP stdio under Node often raises
  // OSError [Errno 22] on stdout (anyio). Default to Node nia-codebase-mcp via npx unless opted in.
  const winUsePipx = process.platform === "win32" && envTruthy("NIA_WINDOWS_USE_PIPX");
  if (process.platform === "win32" && !winUsePipx) {
    const pkg = process.env.NIA_NPX_PACKAGE?.trim() || BUNDLED_NIA_CODEBASE_ARG;
    return npxNiaSpawnConfig(pkg, apiKey, baseEnv);
  }

  if (process.platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "pipx", "run", "--no-cache", "nia-mcp-server"],
      env: baseEnv,
    };
  }
  return {
    command: "pipx",
    args: ["run", "--no-cache", "nia-mcp-server"],
    env: baseEnv,
  };
}

async function spawnNiaMcpClient(): Promise<Client> {
  const apiKey = process.env.NIA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "NIA_API_KEY is required so the subprocess can authenticate to Nia. Set it in the environment passed to this MCP.",
    );
  }

  const connectTimeoutMs = Number.parseInt(
    process.env.NIA_MCP_CONNECT_TIMEOUT_MS ?? "300000",
    10,
  );

  const client = new Client(
    {
      name: "cache-wrapped-nia",
      version: "1.0.0",
    },
    { capabilities: {} },
  );

  if (useRemoteNiaUpstream()) {
    const raw = (process.env.NIA_MCP_REMOTE_URL ?? "https://apigcp.trynia.ai/mcp").trim();
    if (!/^https?:\/\//i.test(raw)) {
      throw new Error("NIA_MCP_REMOTE_URL must be an http(s) URL when using hosted Nia upstream.");
    }
    const url = new URL(raw);
    console.error(
      `[cache-wrapped-nia] Connecting to Nia upstream (streamable HTTP) ${url.origin}${url.pathname} …`,
    );
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json, text/event-stream",
        },
      },
    });
    await client.connect(transport, { timeout: connectTimeoutMs });
    return client;
  }

  const stderrMode = process.env.NIA_CHILD_STDERR?.trim().toLowerCase();
  const stderr = stderrMode === "inherit" ? "inherit" : "pipe";
  const { command, args, env: childEnv } = niaChildSpawnConfig(apiKey);

  console.error("[cache-wrapped-nia] Connecting to Nia MCP subprocess…");
  const transport = new StdioClientTransport({
    command,
    args,
    stderr,
    env: childEnv as Record<string, string>,
  });

  if (stderr === "pipe") {
    transport.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
  }

  await client.connect(transport, { timeout: connectTimeoutMs });
  return client;
}

function failOpenNiaPayload(reason: string): CachedResponse {
  return {
    content: `Temporary Nia outage (timeout, rate limit, or transport error). No codebase context retrieved — treat as cache miss.\n${reason}`,
    sources: [],
  };
}

function isDemoMode(): boolean {
  return /^(?:1|true|yes)$/i.test(process.env.DEMO_MODE?.trim() ?? "");
}

/** Pre-seeded codebase context responses for demo mode — mirrors eval.py SEED_RESPONSES. */
const DEMO_RESPONSES: Array<{ keywords: string[]; content: string; sources: string[] }> = [
  {
    keywords: ["auth", "authentication", "login", "jwt", "token"],
    content: "Authentication uses JWT tokens. The auth middleware (src/middleware/auth.py) validates Bearer tokens on every protected route. Login is handled by POST /auth/login which calls verify_password() and returns a signed JWT. The token payload includes user_id, email, and role. Tokens expire after 24 hours. AuthService (src/services/auth.py) handles token generation and validation via the python-jose library.",
    sources: ["src/middleware/auth.py", "src/services/auth.py", "src/routers/auth.py"],
  },
  {
    keywords: ["database", "db", "sql", "orm", "persistence", "sqlalchemy", "postgres"],
    content: "The database layer uses SQLAlchemy ORM with a PostgreSQL backend. Models are in src/models/ and inherit from Base (src/database.py). DatabaseService provides get_db() as a FastAPI dependency. Connection pooling is handled automatically with pool_size=10. Migrations are managed via Alembic (alembic/versions/). Sessions use context managers to ensure connections are properly closed after each request.",
    sources: ["src/database.py", "src/models/", "alembic/versions/"],
  },
  {
    keywords: ["route", "routing", "endpoint", "api", "router", "fastapi"],
    content: "API routes are defined using FastAPI routers in src/routers/. Each module (users.py, items.py, etc.) creates an APIRouter and is registered in src/main.py via app.include_router(). Routes use Pydantic models for request/response validation. HTTP methods follow REST conventions. Route dependencies (auth, pagination) are injected via FastAPI Depends().",
    sources: ["src/main.py", "src/routers/users.py", "src/routers/items.py"],
  },
  {
    keywords: ["error", "exception", "handling", "failure", "500", "422"],
    content: "Error handling uses FastAPI exception handlers registered in src/main.py. Custom exception classes in src/exceptions.py extend HTTPException with structured responses. Unhandled exceptions return 500 with a generic message. Pydantic validation errors return 422 with field-level details. ErrorResponse (src/schemas/errors.py) standardises the JSON shape: {code, message, details}. Server errors are logged with full stack traces.",
    sources: ["src/main.py", "src/exceptions.py", "src/schemas/errors.py"],
  },
  {
    keywords: ["cache", "caching", "chromadb", "semantic", "embedding"],
    content: "The caching layer uses ChromaDB for semantic lookup and sentence-transformers (all-MiniLM-L6-v2) for embeddings. The CacheEngine class (cache-engine/main.py) manages EXACT_HIT (similarity ≥ 0.97), SEMANTIC_HIT (0.80–0.97 with CLōD verifier), VERIFIED_REJECT, and MISS tiers. Cache keys are SHA-256 hashed query strings. The store persists across restarts via PersistentClient at ./chroma_data.",
    sources: ["cache-engine/main.py", "CONTRACTS.md"],
  },
  {
    keywords: ["file", "folder", "structure", "directory", "layout", "organization"],
    content: "The project root contains: src/ (application code), tests/ (pytest suite), alembic/ (migrations), and config/ (environment settings). Inside src/: main.py (FastAPI entry point), routers/ (route handlers), services/ (business logic), models/ (ORM models), schemas/ (Pydantic models), middleware/ (auth, logging, CORS), and utils/ (shared helpers). Static assets are served from src/static/.",
    sources: ["src/", "src/main.py", "src/routers/", "src/services/"],
  },
  {
    keywords: ["env", "environment", "config", "secret", "variable", "dotenv"],
    content: "Environment variables are managed via python-dotenv. A .env file at the project root defines DATABASE_URL, SECRET_KEY, CLOD_API_KEY, and other config values. The config module (src/config.py) loads these with Pydantic BaseSettings for type validation and defaults. Sensitive values are never committed — .env is in .gitignore.",
    sources: ["src/config.py", ".env.example", ".gitignore"],
  },
  {
    keywords: ["test", "testing", "pytest", "unit", "integration", "coverage"],
    content: "The project uses pytest as the test runner. Tests live in tests/ organised into unit/ and fixtures/. conftest.py sets up an in-memory SQLite test database. Run the suite with: pytest tests/ -v. Coverage is measured with pytest-cov. The CI pipeline runs tests on every PR via GitHub Actions (.github/workflows/test.yml).",
    sources: ["tests/conftest.py", "tests/unit/", ".github/workflows/test.yml"],
  },
  {
    keywords: ["log", "logging", "trace", "debug", "audit"],
    content: "The logging system uses Python's standard logging module configured in src/logging_config.py. Log levels are DEBUG in development and INFO in production. The middleware/logging.py adds request_id to every log line for traceability. FastAPI access logs capture method, path, status code, and latency.",
    sources: ["src/logging_config.py", "src/middleware/logging.py"],
  },
  {
    keywords: ["dashboard", "ui", "webview", "extension", "websocket", "react"],
    content: "The dashboard is a VS Code/Cursor webview extension (pho-and-gang/src/extension.ts). It renders a React app via CDN with Tailwind CSS. Left panel shows a live query log with color-coded badges (🟢 EXACT_HIT, 🟡 SEMANTIC_HIT, 🔴 VERIFIED_REJECT, ⚫ MISS). Right panel shows animated counter cards: Hit Rate %, $ Saved, Latency Saved, Total Queries. It connects to ws://localhost:8001 for live updates and has a Reset Cache button that POSTs to http://localhost:8000/reset.",
    sources: ["pho-and-gang/src/extension.ts", "CONTRACTS.md"],
  },
  {
    keywords: ["mcp", "model context protocol", "server", "tool", "cursor agent"],
    content: "The MCP server (nia-passthrough-mcp/src/index.ts) exposes one tool: lookup_codebase_context(user_query). On every call it: (1) checks the cache via POST http://localhost:8000/lookup, (2) on EXACT_HIT or SEMANTIC_HIT returns the cached response, (3) on MISS or VERIFIED_REJECT forwards to Nia, inserts the result, and returns. It also broadcasts WebSocket events to ws://localhost:8001 after each call.",
    sources: ["nia-passthrough-mcp/src/index.ts", "CONTRACTS.md"],
  },
];

/** Returns rich canned context by matching keywords in the query. */
function demoMissPayload(user_query: string): CachedResponse {
  const q = user_query.toLowerCase();
  for (const entry of DEMO_RESPONSES) {
    if (entry.keywords.some((kw) => q.includes(kw))) {
      return { content: entry.content, sources: entry.sources };
    }
  }
  // Generic fallback
  return {
    content: `This codebase is a FastAPI + ChromaDB semantic cache layer for Cursor agents. It intercepts lookup_codebase_context calls, checks a vector cache, and only forwards to Nia on cache miss. Query: "${user_query}"`,
    sources: ["cache-engine/main.py", "nia-passthrough-mcp/src/index.ts", "CONTRACTS.md"],
  };
}

async function forwardLookupFromNia(niaClient: Client, user_query: string): Promise<CachedResponse> {
  const niaTimeoutMs = Number.parseInt(process.env.NIA_TOOL_TIMEOUT_MS ?? "300000", 10);

  async function callNiaTool(toolName: string, args: Record<string, unknown>): Promise<UnknownToolResult> {
    return (await niaClient.callTool({ name: toolName, arguments: args }, undefined, { timeout: niaTimeoutMs })) as UnknownToolResult;
  }

  function extractError(res: UnknownToolResult): string | null {
    if (!res.isError) return null;
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    if (first && typeof first === "object" && "type" in first && (first as { type: unknown }).type === "text") {
      const text = (first as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
    return "nia tool reported isError=true";
  }

  const niaArgs: Record<string, unknown> = { user_query };
  const folderId = process.env.NIA_FOLDER_ID?.trim();
  if (folderId) {
    niaArgs.local_folders = [folderId];
  }
  let resUnknown = await callNiaTool(NIA_TOOL, niaArgs);
  const primaryErr = extractError(resUnknown);

  // Fallback: if lookup_codebase_context is not available (Python nia-mcp-server uses `search`),
  // retry with the `search` tool using NIA_FOLDER_ID if provided.
  if (primaryErr && (primaryErr.includes("Unknown tool") || primaryErr.includes("not found"))) {
    const folderId = process.env.NIA_FOLDER_ID?.trim();
    if (folderId) {
      console.error(`[cache-wrapped-nia] ${NIA_TOOL} unavailable — retrying with search tool (NIA_FOLDER_ID=${folderId})`);
      const fallbackArgs: Record<string, unknown> = { query: user_query, local_folders: [folderId] };
      const fallbackRes = await callNiaTool("search", fallbackArgs);
      const fallbackErr = extractError(fallbackRes);
      if (fallbackErr) throw new Error(fallbackErr);
      const text = extractTextBlocks(fallbackRes);
      return parseNiaPlaintextResponse(text);
    }
    throw new Error(primaryErr);
  }

  if (primaryErr) throw new Error(primaryErr);

  let text = extractTextBlocks(resUnknown);
  if ("structuredContent" in resUnknown && resUnknown.structuredContent && typeof resUnknown.structuredContent === "object") {
    const sc = resUnknown.structuredContent as Record<string, unknown>;
    if (typeof sc.content === "string" && Array.isArray(sc.sources)) {
      return { content: sc.content, sources: sc.sources.filter((x): x is string => typeof x === "string") };
    }
  }

  text = stripLeadingContextBanner(text, user_query);
  return parseNiaPlaintextResponse(text);
}

async function postLookup(cacheBase: string, query: string): Promise<LookupResponse | null> {
  const lookupTimeoutMs = Number.parseInt(process.env.CACHE_LOOKUP_TIMEOUT_MS ?? "8000", 10);
  try {
    const r = await fetch(`${cacheBase.replace(/\/$/, "")}/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(lookupTimeoutMs),
    });
    if (!r.ok) {
      return null;
    }
    const raw = (await r.json()) as Record<string, unknown>;
    const status = raw.status;
    if (status !== "EXACT_HIT" && status !== "SEMANTIC_HIT" && status !== "VERIFIED_REJECT" && status !== "MISS") {
      return null;
    }
    const similarity =
      raw.similarity === null || raw.similarity === undefined
        ? null
        : typeof raw.similarity === "number"
          ? raw.similarity
          : null;
    const cached = raw.cached_response;
    return {
      status,
      similarity,
      cached_response: isCachedResponse(cached) ? cached : null,
      cached_query:
        typeof raw.cached_query === "string" ? raw.cached_query : null,
    };
  } catch {
    return null;
  }
}

async function postInsert(cacheBase: string, query: string, response: CachedResponse): Promise<void> {
  const insertTimeoutMs = Number.parseInt(process.env.CACHE_INSERT_TIMEOUT_MS ?? "8000", 10);
  try {
    await fetch(`${cacheBase.replace(/\/$/, "")}/insert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, response }),
      signal: AbortSignal.timeout(insertTimeoutMs),
    });
  } catch {
    // fail open — cache populate is best-effort
  }
}

async function avgNiaLatencyMs(niaClient: Client): Promise<number> {
  const q =
    process.env.NIA_WARMUP_QUERY ??
    process.env.CONTRACT_FIRST_QUERY ??
    "How does authentication work in this codebase?";
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      await forwardLookupFromNia(niaClient, q);
      samples.push(Date.now() - t0);
    } catch {
      /* skip failed warmup lap */
    }
  }
  if (samples.length === 0) {
    return 2000;
  }
  return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
}

function similarityForQueryComplete(status: CacheStatus, similarity: number | null): number | null {
  if (status === "EXACT_HIT" || status === "MISS") {
    return null;
  }
  return similarity;
}

async function fetchFromNiaWithFailOpen(
  niaClient: Client | null,
  user_query: string,
): Promise<{ out: CachedResponse; niaMs: number; usedFailOpen: boolean }> {
  // DEMO_MODE=1 → skip Nia entirely, return a canned response that gets cached
  if (isDemoMode() || niaClient === null) {
    console.error("[cache-wrapped-nia] DEMO_MODE — returning canned response for MISS");
    const out = demoMissPayload(user_query);
    return { out, niaMs: 0, usedFailOpen: false };
  }
  const tNia = Date.now();
  try {
    const out = await forwardLookupFromNia(niaClient, user_query);
    return { out, niaMs: Date.now() - tNia, usedFailOpen: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      "[cache-wrapped-nia] Nia error — fail-open MISS-style payload; /insert skipped (avoid poisoning cache).",
      msg,
    );
    return {
      out: failOpenNiaPayload(msg),
      niaMs: Date.now() - tNia,
      usedFailOpen: true,
    };
  }
}

async function main(): Promise<void> {
  const cacheBase = process.env.CACHE_API_URL ?? "http://localhost:8000";
  const wsPort = Number.parseInt(process.env.WS_PORT ?? "8001", 10);

  let niaClient: Client | null = null;
  if (isDemoMode()) {
    console.error("[cache-wrapped-nia] DEMO_MODE=1 — skipping Nia subprocess, using canned responses on MISS");
    session.avgNiaLatencyMs = 2000; // assumed latency for savings display
  } else {
    niaClient = await spawnNiaMcpClient();
    console.error("[cache-wrapped-nia] Warmup: measuring average Nia latency (3 calls)...");
    session.avgNiaLatencyMs = await avgNiaLatencyMs(niaClient);
    console.error(`[cache-wrapped-nia] AVG_NIA_LATENCY_MS ≈ ${session.avgNiaLatencyMs}`);
  }

  const wss = new WebSocketServer({ port: wsPort });
  console.error(`[cache-wrapped-nia] WebSocket dashboard on ws://localhost:${wsPort}`);

  setInterval(() => {
    broadcastWss(wss, buildMetricsUpdate());
  }, 30_000).unref?.();

  setInterval(async () => {
    try {
      const r = await fetch(`${cacheBase.replace(/\/$/, "")}/metrics`);
      if (!r.ok) return;
      const m = (await r.json()) as { cache_size?: number };
      const size = typeof m.cache_size === "number" ? m.cache_size : 0;
      if (session.prev_cache_size !== null && session.prev_cache_size > 0 && size === 0) {
        broadcastWss(wss, { type: "reset_complete" });
        zeroSessionFromReset();
        broadcastWss(wss, buildMetricsUpdate());
      }
      session.prev_cache_size = size;
    } catch {
      /* cache service may be down during dev */
    }
  }, 3000).unref?.();

  const server = new McpServer({
    name: "cache-wrapped-nia",
    version: "1.0.0",
  });

  server.registerTool(
    NIA_TOOL,
    {
      description:
        "Retrieves relevant code snippets and context from the indexed codebase based on a user query.",
      inputSchema: {
        user_query: z.string().describe("A natural-language query about the codebase."),
      },
      outputSchema: toolOutputSchema,
    },
    async ({ user_query }) => {
      const t0 = Date.now();
      const query_id = randomUUID();

      let cost_saved_usd = 0;
      let latency_saved_ms = 0;
      let out: CachedResponse;
      let status: CacheStatus;
      let similarity: number | null = null;
      let niaRoundtripMs: number | null = null;
      let niaFailOpen = false;

      const lookupT0 = Date.now();
      const lr = await postLookup(cacheBase, user_query);
      const lookupMs = Date.now() - lookupT0;

      if (
        lr &&
        (lr.status === "EXACT_HIT" || lr.status === "SEMANTIC_HIT") &&
        isCachedResponse(lr.cached_response)
      ) {
        out = lr.cached_response;
        status = lr.status;
        similarity = lr.similarity;
        cost_saved_usd = DEMO_COST_SAVED_USD_PER_HIT;
        latency_saved_ms = Math.max(0, Math.round(session.avgNiaLatencyMs - lookupMs));
      } else if (lr?.status === "VERIFIED_REJECT") {
        similarity = lr.similarity;
        const nj = await fetchFromNiaWithFailOpen(niaClient, user_query);
        niaRoundtripMs = nj.niaMs;
        out = nj.out;
        cost_saved_usd = 0;
        latency_saved_ms = 0;
        if (nj.usedFailOpen) {
          status = "MISS";
          similarity = null;
          niaFailOpen = true;
        } else {
          status = "VERIFIED_REJECT";
          void postInsert(cacheBase, user_query, out);
        }
      } else {
        const nj = await fetchFromNiaWithFailOpen(niaClient, user_query);
        niaRoundtripMs = nj.niaMs;
        out = nj.out;
        status = "MISS";
        similarity = null;
        cost_saved_usd = 0;
        latency_saved_ms = 0;
        if (nj.usedFailOpen) {
          niaFailOpen = true;
        } else {
          void postInsert(cacheBase, user_query, out);
        }
      }

      const latency_ms = Date.now() - t0;
      console.error(
        `[timing] query_id=${query_id} cache_lookup_ms=${lookupMs} nia_roundtrip_ms=${niaRoundtripMs ?? "NA"} wall_total_ms=${latency_ms} status=${status} nia_fail_open=${niaFailOpen}`,
      );
      const simEvent = similarityForQueryComplete(status, similarity);

      session.total_queries += 1;
      if (status === "EXACT_HIT" || status === "SEMANTIC_HIT") {
        session.hit_count += 1;
      }
      session.total_saved_usd += cost_saved_usd;
      session.total_saved_ms += latency_saved_ms;

      const record: QueryRecord = {
        query_id,
        query: truncateQuery(user_query),
        status,
        similarity: similarityForQueryComplete(status, similarity),
        latency_ms,
        cost_saved_usd,
        latency_saved_ms,
        timestamp: Date.now(),
      };
      pushQueryRecord(record);

      broadcastWss(wss, {
        type: "query_complete",
        query_id,
        query: truncateQuery(user_query),
        status,
        similarity: simEvent,
        latency_ms,
        cost_saved_usd,
        latency_saved_ms,
      });
      broadcastWss(wss, buildMetricsUpdate());

      const structuredContent = out;
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent: structuredContent as unknown as Record<string, unknown>,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[cache-wrapped-nia] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
