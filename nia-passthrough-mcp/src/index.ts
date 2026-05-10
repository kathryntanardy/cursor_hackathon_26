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

  if (envTruthy("NIA_USE_REMOTE_UPSTREAM")) {
    const raw = (process.env.NIA_MCP_REMOTE_URL ?? "https://apigcp.trynia.ai/mcp").trim();
    if (!/^https?:\/\//i.test(raw)) {
      throw new Error("NIA_MCP_REMOTE_URL must be an http(s) URL when NIA_USE_REMOTE_UPSTREAM is set.");
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

async function forwardLookupFromNia(niaClient: Client, user_query: string): Promise<CachedResponse> {
  const niaTimeoutMs = Number.parseInt(process.env.NIA_TOOL_TIMEOUT_MS ?? "300000", 10);
  const resUnknown: UnknownToolResult = (await niaClient.callTool(
    {
      name: NIA_TOOL,
      arguments: { user_query },
    },
    undefined,
    { timeout: niaTimeoutMs },
  )) as UnknownToolResult;

  if (resUnknown.isError) {
    let errText = "nia tool reported isError=true";
    const first = Array.isArray(resUnknown.content) ? resUnknown.content[0] : undefined;
    if (first && typeof first === "object" && "type" in first && (first as { type: unknown }).type === "text") {
      const text = (first as { text?: unknown }).text;
      if (typeof text === "string") errText = text;
    }
    throw new Error(errText);
  }

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
  niaClient: Client,
  user_query: string,
): Promise<{ out: CachedResponse; niaMs: number; usedFailOpen: boolean }> {
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

  const niaClient = await spawnNiaMcpClient();

  console.error("[cache-wrapped-nia] Warmup: measuring average Nia latency (3 calls)...");
  session.avgNiaLatencyMs = await avgNiaLatencyMs(niaClient);
  console.error(`[cache-wrapped-nia] AVG_NIA_LATENCY_MS ≈ ${session.avgNiaLatencyMs}`);

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
