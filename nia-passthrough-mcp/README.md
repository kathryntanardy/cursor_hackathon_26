# cache-wrapped-nia MCP (Person 1)

Node MCP server that wraps **Nia** (`nia-codebase-mcp`) with Person 2’s **HTTP cache** and broadcasts metrics to Person 3’s dashboard over **WebSocket**. Behavior matches the repo root [**CONTRACTS.md**](../CONTRACTS.md).

## Prerequisites

- **Node.js 18+**
- **Cursor** (with MCP support)
- **Nia API key** for your indexed codebase
- **Person 2** (optional but required for caching): FastAPI on `http://localhost:8000` with `/lookup`, `/insert`, `/reset`, and optionally `/metrics`. If it is down, lookups fail open and every request goes to Nia.

## 1. Install and build

From this directory:

```bash
npm install
npm run build
```

You must have `dist/index.js` before Cursor starts this server (`run-gateway.mjs` checks for it).

## 2. Configure environment

Copy the example env file and set your secret:

```bash
cp .env.example .env
```

Edit **`.env`**:

| Variable | Required | Purpose |
|---------|----------|--------|
| `NIA_API_KEY` | Yes | Nia authentication (never commit this file). |
| `CACHE_API_URL` | No | Person 2 cache base URL. Default `http://localhost:8000`. |
| `WS_PORT` | No | WebSocket dashboard port. Default `8001`. |
| `NIA_MCP_PACKAGE` | No | Pin e.g. `nia-codebase-mcp@1.0.2` instead of `@latest`. |
| `NIA_TOOL_TIMEOUT_MS` | No | Timeout for each Nia tool call (ms). Default `300000`. |
| `CACHE_LOOKUP_TIMEOUT_MS` | No | `POST /lookup` timeout (ms). Default `8000`. |
| `CACHE_INSERT_TIMEOUT_MS` | No | `POST /insert` timeout (ms). Default `8000`. |
| `NIA_WARMUP_QUERY` | No | Warmup string for average Nia latency measurement. |

## 3. Wire Cursor to this MCP

Writes **`cache-wrapped-nia`** into your user **`~/.cursor/mcp.json`**. The JSON points at **`scripts/run-gateway.mjs`**, which loads **`.env`** and runs **`dist/index.js`** — so secrets stay out of **`mcp.json`**.

```bash
npm run mcp:install
```

**Restart Cursor** after installing or whenever you change `mcp.json`.

On Windows, the path is **`%USERPROFILE%\.cursor\mcp.json`**.

## 4. Startup order (full stack)

1. Start **Person 2** FastAPI on **port 8000** (so `/lookup` and `/insert` work).
2. **Restart Cursor** (or reload MCP servers) so **cache-wrapped-nia** starts. On boot it also:
   - spawns the **Nia** child MCP;
   - runs **3 warmup** Nia calls to estimate average latency;
   - listens on **WebSocket** `ws://localhost:8001` (or `WS_PORT`).
3. Person 3 dashboard connects to that WebSocket and shows **`query_complete` / `metrics_update`** events.

**Person 2 not running:** the server still starts; cache HTTP calls fail open and tools still call Nia (see logs).

## 5. Smoke test

- In Cursor, confirm MCP **cache-wrapped-nia** is enabled and use tool **`lookup_codebase_context`** with `user_query`.
- Optional: install [`wscat`](https://www.npmjs.com/package/wscat) and run:

  ```bash
  npx -y wscat -c ws://localhost:8001
  ```

  Trigger a lookup and you should see JSON events (`query_complete` then `metrics_update`).

## 6. Troubleshooting

| Issue | What to do |
|------|-------------|
| `Missing dist/index.js` | Run `npm run build`. |
| `NIA_API_KEY` missing | Set it in `.env` next to this package or export it before launching Cursor. |
| `EADDRINUSE` on port 8001 | Change `WS_PORT` in `.env` and point Person 3 at the same port. |
| Cursor still on old MCP name | Run `npm run mcp:install` again; old `nia-cache-gateway` entry was removed when migrating to **`cache-wrapped-nia`**. |

Timing for debugging is logged to **stderr**, for example:

`cache_lookup_ms`, `nia_roundtrip_ms`, `wall_total_ms`, `nia_fail_open`.

## Scripts

| Command | Description |
|---------|--------------|
| `npm run build` | Compile TypeScript → `dist/`. |
| `npm run start` | Run `dist/index.js` directly (normally Cursor uses `run-gateway.mjs`). |
| `npm run dev` | Run `src/index.ts` with `tsx` (dev only). |
| `npm run mcp:install` | Merge Cursor **`mcp.json`** entry for **`cache-wrapped-nia`**. |
