# cache-wrapped-nia MCP (Person 1)

Node MCP server that wraps **Nia** (official local server: `pipx run --no-cache nia-mcp-server` per [TryNia MCP docs](https://docs.trynia.ai/integrations/installation/mcp#cursor)) with Person 2’s **HTTP cache** and broadcasts metrics to Person 3’s dashboard over **WebSocket**. Behavior matches the repo root [**CONTRACTS.md**](../CONTRACTS.md).

## Prerequisites

- **Node.js 18+** and **`npm install`** in **`nia-passthrough-mcp`** (installs **`nia-codebase-mcp`** locally so the gateway can spawn it with **`node`, avoiding flaky **`npx`** under Cursor on Windows).
- **pipx** with **`nia-mcp-server`** (macOS / Linux default for the Nia child). On **Windows** the default child is **`nia-codebase-mcp`** run via **`node`** from this package’s `node_modules` (not pipx — avoids `OSError: [Errno 22]` on Python stdio). Set **`NIA_WINDOWS_USE_PIPX=1`** to force TryNia’s pipx path on Windows.
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
| `NIA_API_URL` | No | Nia API base URL for the child. Default `https://apigcp.trynia.ai/`. |
| `NIA_MCP_REMOTE_URL` | No | **Remote upstream only** (`NIA_USE_REMOTE_UPSTREAM=1`): streamable HTTP MCP URL. Default `https://apigcp.trynia.ai/mcp`. Not used for **`mcp:install:remote`** (that writes URL into Cursor `mcp.json` instead). |
| `NIA_USE_REMOTE_UPSTREAM` | No | Set `1` / `true` / `yes` so **this gateway** talks to TryNia’s **hosted MCP** over HTTP instead of spawning a local Nia child. **Keeps cache + WebSocket.** Cursor still uses **`npm run mcp:install`** (stdio to this process). |
| `CACHE_API_URL` | No | Person 2 cache base URL. Default `http://localhost:8000`. |
| `WS_PORT` | No | WebSocket dashboard port. Default `8001`. |
| `NIA_MCP_PACKAGE` | No | Force **npx** to run this package (any OS), instead of the default (pipx on Unix; Windows npx default below). Use **`NIA_API_KEY`** in env (optional **`NIA_LEGACY_CLI_API_KEY`** for `--api-key`). |
| `NIA_WINDOWS_USE_PIPX` | No | **Windows only:** set `1` / `true` / `yes` to use **`pipx run nia-mcp-server`** (TryNia docs). Default is **`npx`** + **`NIA_NPX_PACKAGE`** because pipx + Python stdio from Node often crashes. |
| `NIA_NPX_PACKAGE` | No | **Windows** default npx spec when `NIA_MCP_PACKAGE` is unset. Default `nia-codebase-mcp@1.0.2`. |
| `NIA_FORCE_NPX` | No | `1` / `true` / `yes`: skip **local** `node_modules/nia-codebase-mcp` and use **npx** / **cmd** (only for debugging spawn issues). |
| `NIA_COMMAND` | No | With **`NIA_FORCE_NPX`**: **npx** executable (**Unix** default `npx`; **Windows** first token after `cmd /c`). Use a full path if **`npx`** is missing from Cursor’s PATH. |
| `NIA_CHILD_STDERR` | No | Nia child stderr: unset or `pipe` (default) pipes and forwards to logs; `inherit` uses parent stderr only. |
| `NIA_LEGACY_CLI_API_KEY` | No | Rare: set to `1` / `true` / `yes` to add `--api-key` for **npx** (key visible in `ps`). Official **`nia-codebase-mcp`** already uses `NIA_API_KEY` from env when the flag is omitted. |
| `NIA_TOOL_TIMEOUT_MS` | No | Timeout for each Nia tool call (ms). Default `300000`. |
| `NIA_MCP_CONNECT_TIMEOUT_MS` | No | MCP `initialize` to the Nia child (ms). Default `300000`. Raise if cold `pipx` install is slow. |
| `CACHE_LOOKUP_TIMEOUT_MS` | No | `POST /lookup` timeout (ms). Default `8000`. |
| `CACHE_INSERT_TIMEOUT_MS` | No | `POST /insert` timeout (ms). Default `8000`. |
| `NIA_WARMUP_QUERY` | No | Warmup string for average Nia latency measurement. |

## 3. Wire Cursor to this MCP

### Option A — **Remote Nia in Cursor only** (no gateway)

TryNia’s recommended setup connects Cursor **directly** to `https://apigcp.trynia.ai/mcp`. That **does not** run this package, so you **lose Person 2 cache and Person 3 WebSocket**.

```bash
npm run mcp:install:remote
```

**If you need cache + WebSocket**, skip this and use Option B with **`NIA_USE_REMOTE_UPSTREAM=1`** in `.env` (hosted Nia **inside** the gateway).

### Option B — **cache-wrapped-nia** (local gateway: cache + WebSocket + Nia)

Cursor runs **`run-gateway.mjs`**. Nia can be either a **local subprocess** (default) or **TryNia hosted MCP** (set **`NIA_USE_REMOTE_UPSTREAM=1`** — same URL as the docs, Bearer `NIA_API_KEY`).

```bash
npm run mcp:install
```

Put in **`nia-passthrough-mcp/.env`**:

- **`NIA_API_KEY`**
- **`NIA_USE_REMOTE_UPSTREAM=1`** — optional; use TryNia **remote** as the upstream from the gateway (still need **`npm run mcp:install`**, not `mcp:install:remote`).
- **`NIA_MCP_REMOTE_URL`** — optional; default `https://apigcp.trynia.ai/mcp`.

**Restart Cursor** after any `mcp.json` or `.env` change.

On Windows, the `mcp.json` path is **`%USERPROFILE%\.cursor\mcp.json`**.

## 4. Startup order (full stack)

1. Start **Person 2** FastAPI on **port 8000** (so `/lookup` and `/insert` work).
2. **Restart Cursor** (or reload MCP servers) so **cache-wrapped-nia** starts. On boot it also:
   - connects to **Nia** (local subprocess, unless **`NIA_USE_REMOTE_UPSTREAM=1`** — then TryNia **streamable HTTP**);
   - runs **3 warmup** Nia calls to estimate average latency;
   - listens on **WebSocket** `ws://localhost:8001` (or `WS_PORT`).
3. Person 3 dashboard connects to that WebSocket and shows **`query_complete` / `metrics_update`** events.

**Person 2 not running:** the server still starts; cache HTTP calls fail open and tools still call Nia (see logs).

## 5. Smoke test

- In Cursor, enable **`cache-wrapped-nia`** and use the Nia codebase tool (e.g. **`lookup_codebase_context`**) with `user_query`. (If you used **`mcp:install:remote`** only, the server is **`nia`** — no cache/WebSocket from this repo.)
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
| `MCP error -32000: Connection closed` on startup | With **local** Nia: run **`npm install`** / **`npm run build`**. On **Windows**, bundled `nia-codebase-mcp` is spawned via **`scripts/nia-bundled-launch.mjs`** so its startup guard sees a matching `process.argv[1]`. Still stuck: **`NIA_USE_REMOTE_UPSTREAM=1`** (hosted Nia) or **`NIA_FORCE_NPX=1`**. |
| `MCP error -32001: Request timed out` on startup | Often **pipx** still installing on first run (MCP defaults to 60s). This gateway uses **5m** by default; increase `NIA_MCP_CONNECT_TIMEOUT_MS` or run `pipx run --no-cache nia-mcp-server` once to warm the venv. |
| Python **`OSError: [Errno 22] Invalid argument`** on stdout (pipx / **nia-mcp-server**, Windows) | Common when the Python child speaks MCP over stdio under this Node gateway. **Default fix:** use the Windows **npx** child (do not set `NIA_WINDOWS_USE_PIPX`). Or set **`NIA_MCP_PACKAGE=nia-codebase-mcp@…`**. |
| Legacy **`NIA_MCP_PACKAGE`** — worried auth is broken without `--api-key` | **`nia-codebase-mcp`** uses **`--api-key` or `NIA_API_KEY`** (either works). This gateway sets **`NIA_API_KEY`** in the child env only. Use **`NIA_LEGACY_CLI_API_KEY=1`** only if you run a fork that ignores env. |
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
| `npm run mcp:install` | Merge Cursor **`mcp.json`** entry for **`cache-wrapped-nia`** (removes remote **`nia`**). |
| `npm run mcp:install:remote` | TryNia **remote** MCP in `mcp.json` (Bearer key from `.env`; removes **`cache-wrapped-nia`**). |
