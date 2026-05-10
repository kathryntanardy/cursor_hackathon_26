1. MCP Tool Signature
Mirrors Nia's lookup_codebase_context exactly so Cursor doesn't know we exist.
typescript// Tool name: lookup_codebase_context
// Exposed by: our MCP server (TypeScript, @modelcontextprotocol/sdk)
// Consumed by: Cursor's coding agent

interface LookupCodebaseContextInput {
  user_query: string;
}

interface LookupCodebaseContextOutput {
  content: string;       // The codebase context (code snippets, explanations)
  sources: string[];     // File paths or URLs the content came from
}

// MCP tool definition (for SDK registration)
{
  name: "lookup_codebase_context",
  description: "Retrieves relevant code snippets and context from the indexed codebase based on a user query.",
  inputSchema: {
    type: "object",
    properties: {
      user_query: {
        type: "string",
        description: "A natural-language query about the codebase."
      }
    },
    required: ["user_query"]
  }
}
Behavior: on every call, our MCP server checks the cache (Person 2's FastAPI). On hit → return cached payload. On miss → forward to real Nia, cache result, return.

2. WebSocket Events (Server → Dashboard)
Server: Person 1's MCP server, broadcasting on ws://localhost:8001.
Client: Person 3's webview dashboard inside the Cursor extension.
typescript// Shared record type
interface QueryRecord {
  query_id: string;          // uuid
  query: string;             // the user_query string (truncated to 200 chars for display)
  status: CacheStatus;
  similarity: number | null; // null on EXACT_HIT and MISS
  latency_ms: number;        // total time from MCP call to response
  cost_saved_usd: number;    // 0 on MISS
  latency_saved_ms: number;  // 0 on MISS
  timestamp: number;         // unix ms
}

type CacheStatus =
  | "EXACT_HIT"        // similarity > 0.97, no verifier call
  | "SEMANTIC_HIT"     // similarity 0.80–0.97, verifier said YES
  | "VERIFIED_REJECT"  // similarity 0.80–0.97, verifier said NO → forwarded to Nia
  | "MISS";            // similarity < 0.80, forwarded to Nia

// Events
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
      hit_rate: number;          // 0..1, (EXACT_HIT + SEMANTIC_HIT) / total
      total_saved_usd: number;   // cumulative
      total_saved_ms: number;    // cumulative
      total_queries: number;     // cumulative
      last_5: QueryRecord[];     // most recent first
    }
  | {
      type: "reset_complete";    // sent after /reset, dashboard clears state
    };
Broadcast rules:

After every MCP tool call: emit query_complete first, then metrics_update.
After /reset is hit: emit reset_complete, then a metrics_update with zeroed values.
Heartbeat: emit metrics_update every 30s even with no activity (keeps the websocket alive).

Cost calculation (use these exact numbers):
SONNET_INPUT_USD_PER_TOKEN  = 0.000003   // $3/MTok
SONNET_OUTPUT_USD_PER_TOKEN = 0.000015   // $15/MTok
HAIKU_INPUT_USD_PER_TOKEN   = 0.0000008  // $0.80/MTok
HAIKU_OUTPUT_USD_PER_TOKEN  = 0.000004   // $4/MTok

// On a hit, cost_saved = what the Nia call would have cost downstream.
// Approximate as: avg_nia_response_tokens (1500) × SONNET_INPUT (since the
// agent feeds the result back into Sonnet) plus the avoided Nia API spend.
// For the demo, use a flat estimate: cost_saved_usd = 0.012 per hit.
// On a VERIFIED_REJECT, cost_saved_usd = 0 (we still made the Nia call).
Latency calculation:
// Measure once at startup: average Nia response time over 3 warmup calls.
// Store as AVG_NIA_LATENCY_MS (typically 1500–2500).
// On a hit: latency_saved_ms = AVG_NIA_LATENCY_MS - actual_cache_lookup_ms
// On a miss/reject: latency_saved_ms = 0

3. Cache Engine HTTP API
Owner: Person 2. Python FastAPI service on http://localhost:8000.
Consumed by: Person 1's MCP server.
pythonfrom typing import Literal, Optional
from pydantic import BaseModel

CacheStatus = Literal["EXACT_HIT", "SEMANTIC_HIT", "VERIFIED_REJECT", "MISS"]

# ─── POST /lookup ────────────────────────────────────────────────────────────
class LookupRequest(BaseModel):
    query: str

class CachedResponse(BaseModel):
    content: str
    sources: list[str]

class LookupResponse(BaseModel):
    status: CacheStatus
    similarity: Optional[float]        # None for MISS
    cached_response: Optional[CachedResponse]  # None for MISS and VERIFIED_REJECT
    cached_query: Optional[str]        # the original query that was matched, None for MISS

# ─── POST /insert ────────────────────────────────────────────────────────────
class InsertRequest(BaseModel):
    query: str
    response: CachedResponse

class InsertResponse(BaseModel):
    ok: bool

# ─── POST /reset ─────────────────────────────────────────────────────────────
class ResetResponse(BaseModel):
    ok: bool
    cleared_count: int

# ─── GET /metrics (optional, for debugging) ──────────────────────────────────
class MetricsResponse(BaseModel):
    cache_size: int
    hit_count: int
    miss_count: int
    reject_count: int
CacheEngine class (internal to FastAPI):
pythonclass CacheEngine:
    """Owns Chroma + sentence-transformers + Haiku verifier."""

    EXACT_THRESHOLD = 0.97       # ≥ this → EXACT_HIT, skip verifier
    SEMANTIC_FLOOR  = 0.80       # ≥ this and < EXACT → gray zone, call verifier
    # < SEMANTIC_FLOOR → MISS

    def lookup(self, query: str) -> dict:
        """
        Returns dict matching LookupResponse:
          {
            "status": "EXACT_HIT" | "SEMANTIC_HIT" | "VERIFIED_REJECT" | "MISS",
            "similarity": float | None,
            "cached_response": {"content": str, "sources": list[str]} | None,
            "cached_query": str | None
          }
        """

    def insert(self, query: str, response: dict) -> None:
        """response is {'content': str, 'sources': list[str]}"""

    def reset(self) -> int:
        """Returns count of entries cleared."""
Verifier prompt (Haiku, exact text):
A previous query "{cached_query}" returned this codebase context:
---
{cached_content_truncated_to_2000_chars}
---
Sources: {cached_sources}

Would this same context correctly and completely answer the new query "{new_query}"?
Consider whether the relevant files, functions, and symbols overlap.

Respond with exactly one word: YES or NO.
Parse: response uppercased, contains "YES" → SEMANTIC_HIT, else VERIFIED_REJECT.

4. Demo Triplet
Indexed repo: [your hackathon repo] indexed in Nia before hour 0.
Pick three queries. The third one is the most important — it must land in the gray zone (similarity 0.85–0.95) so the verifier actually runs and rejects it. Tune wording during eval.
TRIPLET = {
    "first_query":  "How does authentication work in this codebase?",
    # → MISS on first run, populates cache

    "semantic_hit": "Walk me through the auth flow in this app.",
    # → SEMANTIC_HIT, similarity ~0.93, verifier says YES

    "near_miss":    "How does authentication work for the admin panel specifically?",
    # → VERIFIED_REJECT, similarity ~0.88, verifier says NO
    # (admin panel auth uses different files than general auth)
}
Tuning rule: if near_miss similarity comes back > 0.97, it'll auto-EXACT_HIT and skip the verifier — your demo punchline dies. Rephrase until it lands in the gray zone. If it comes back < 0.80, it'll auto-MISS and the verifier never gets called — same problem.
Backup queries (in case any of the above misbehave on stage, swap to these — they target the same repo):
backup_first:        "What does the database layer look like?"
backup_semantic_hit: "Explain how data persistence works here."
backup_near_miss:    "What does the database layer look like for write operations?"
Test all six against your indexed repo during eval. Pick whichever triplet behaves most reliably.

5. Process / Port Map
Lock these so nobody picks the same port by accident:
Cursor extension (webview)        — runs inside Cursor
MCP server (Person 1, Node)       — stdio to Cursor + ws on localhost:8001
FastAPI cache (Person 2, Python)  — http on localhost:8000
ChromaDB                          — embedded in FastAPI process, persistent at ./chroma_data
Nia MCP                           — spawned as subprocess by our MCP server
Cursor MCP config (.cursor/mcp.json in your repo, checked in):
json{
  "mcpServers": {
    "cache-wrapped-nia": {
      "command": "node",
      "args": ["./mcp-server/dist/index.js"],
      "env": {
        "NIA_API_KEY": "${NIA_API_KEY}",
        "CACHE_API_URL": "http://localhost:8000",
        "WS_PORT": "8001"
      }
    }
  }
}

6. Quickstart Snippets to Paste into Agent Prompts
For Person 1 (MCP server, TypeScript)

"Build a Node.js MCP server using @modelcontextprotocol/sdk (latest). Expose one tool lookup_codebase_context(user_query: string) → {content, sources}. On every call: (1) measure start time, (2) POST to ${CACHE_API_URL}/lookup with {query: user_query}, (3) if status is EXACT_HIT or SEMANTIC_HIT, return cached_response, (4) otherwise spawn npx -y nia-codebase-mcp@latest --api-key=${NIA_API_KEY} --transport=stdio (or reuse a long-lived subprocess), forward the query, get response, POST to ${CACHE_API_URL}/insert, return response. (5) Broadcast a query_complete WSEvent on ws://localhost:${WS_PORT} matching the contract in CONTRACTS.md (paste section 2). Then broadcast a metrics_update event. Use uuid for query_id. Use the cost/latency calculation rules in CONTRACTS.md section 2."

For Person 2 (FastAPI cache, Python)

"Build a FastAPI service on port 8000 with endpoints POST /lookup, POST /insert, POST /reset matching the contract in CONTRACTS.md (paste section 3). Use ChromaDB PersistentClient at ./chroma_data and sentence-transformers/all-MiniLM-L6-v2 for embeddings. Pre-warm by embedding a dummy string at FastAPI startup (lifespan event). Thresholds: EXACT_THRESHOLD=0.97, SEMANTIC_FLOOR=0.80. On gray-zone hits, call Anthropic's claude-haiku-4-5 with the verifier prompt in CONTRACTS.md section 3 to decide SEMANTIC_HIT vs VERIFIED_REJECT. Use the Anthropic Python SDK; read ANTHROPIC_API_KEY from env."

For Person 3 (Cursor extension + dashboard)

"Build a Cursor (VS Code) extension in TypeScript that registers a command 'cache.showDashboard' which opens a webview panel. Inside the webview, render a self-contained React app via CDN (React, ReactDOM, Tailwind via CDN script tags — no build step) with two panels: left = chat-style log of agent queries with color-coded badges (🟢 EXACT_HIT, 🟡 SEMANTIC_HIT, 🔴 VERIFIED_REJECT, ⚫ MISS), right = four counter cards (Hit Rate %, $ Saved, Latency Saved seconds, Total Queries) and a rolling list of last 5 queries. The webview connects to ws://localhost:8001 and consumes WSEvent messages per CONTRACTS.md section 2 (paste it). Animate counter values when they change (count up over 400ms). Use VS Code theme variables for colors so it looks native. Add a 'Reset Cache' button that POSTs to http://localhost:8000/reset. Reconnect on websocket close after 1s."

For Person 4 (eval harness, Python)

"Build a Python script eval.py that runs 25 hand-crafted queries against http://localhost:8000/lookup and asserts each returns the expected status. Categories: 8 expected EXACT_HIT (same query run twice in sequence — first call inserts, second should EXACT_HIT), 8 expected SEMANTIC_HIT (paraphrases of seeded queries), 9 expected VERIFIED_REJECT (semantically near but with a specifier that changes intent, e.g. adds 'admin' or 'write operations' or 'unit tests' to a query about general functionality). Print a pass/fail report. Use the demo triplet from CONTRACTS.md section 4 as queries 1–3."


7. Definitions of Done
A piece is "done" when:

Person 1's MCP: Cursor agent calls lookup_codebase_context, gets a real Nia response back through our cache, websocket broadcasts the event correctly. Verified by Person 4 running the eval.
Person 2's cache: All four statuses fire correctly against eval queries. Pre-warm works (no 5-second cold start on first lookup).
Person 3's extension: Dashboard renders inside Cursor, websocket connects, all four badge types display, counters animate, Reset button works.
Person 4's eval: ≥22/25 queries pass on first run after threshold tuning. Backup video recorded and saved locally.