import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('cache.showDashboard', () => {
		CacheDashboardPanel.createOrShow(context.extensionUri);
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}

class CacheDashboardPanel {
	public static currentPanel: CacheDashboardPanel | undefined;
	private static readonly viewType = 'cacheDashboard';

	private readonly _panel: vscode.WebviewPanel;
	private _disposables: vscode.Disposable[] = [];

	public static createOrShow(extensionUri: vscode.Uri) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		if (CacheDashboardPanel.currentPanel) {
			CacheDashboardPanel.currentPanel._panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			CacheDashboardPanel.viewType,
			'Cache Dashboard',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			}
		);

		CacheDashboardPanel.currentPanel = new CacheDashboardPanel(panel);
	}

	private constructor(panel: vscode.WebviewPanel) {
		this._panel = panel;
		this._panel.webview.html = this._getWebviewContent();

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
	}

	public dispose() {
		CacheDashboardPanel.currentPanel = undefined;
		this._panel.dispose();
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) { x.dispose(); }
		}
	}

	private _getWebviewContent(): string {
		return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Cache Dashboard</title>
<script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  :root {
    --vscode-font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
  }
  body {
    font-family: var(--vscode-font);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    margin: 0;
    padding: 0;
    overflow: hidden;
  }
  .card {
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
    border-radius: 8px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }
  .badge-exact { background: #065f46; color: #6ee7b7; }
  .badge-semantic { background: #713f12; color: #fde047; }
  .badge-reject { background: #7f1d1d; color: #fca5a5; }
  .badge-miss { background: #374151; color: #9ca3af; }

  .log-entry {
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
    animation: slideIn 0.3s ease-out;
  }
  @keyframes slideIn {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.05); }
  }
  .counter-bump { animation: pulse 0.4s ease-in-out; }

  .btn-reset {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 6px 16px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-reset:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .connection-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }
  .connected { background: #22c55e; }
  .disconnected { background: #ef4444; }

  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel">
const { useState, useEffect, useRef, useCallback } = React;

function useAnimatedValue(target, duration = 400) {
  const [display, setDisplay] = useState(target);
  const animRef = useRef(null);
  const startVal = useRef(target);
  const startTime = useRef(null);

  useEffect(() => {
    if (target === display && !animRef.current) return;
    startVal.current = display;
    startTime.current = performance.now();

    const animate = (now) => {
      const elapsed = now - startTime.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = startVal.current + (target - startVal.current) * eased;
      setDisplay(current);
      if (progress < 1) {
        animRef.current = requestAnimationFrame(animate);
      } else {
        animRef.current = null;
      }
    };

    if (animRef.current) cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(animate);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [target]);

  return display;
}

function Badge({ status }) {
  const config = {
    EXACT_HIT: { cls: 'badge-exact', icon: '🟢', label: 'EXACT HIT' },
    SEMANTIC_HIT: { cls: 'badge-semantic', icon: '🟡', label: 'SEMANTIC HIT' },
    VERIFIED_REJECT: { cls: 'badge-reject', icon: '🔴', label: 'REJECTED' },
    MISS: { cls: 'badge-miss', icon: '⚫', label: 'MISS' },
  };
  const c = config[status] || config.MISS;
  return <span className={"badge " + c.cls}>{c.icon} {c.label}</span>;
}

function CounterCard({ label, value, format }) {
  const animated = useAnimatedValue(value);
  const [bumping, setBumping] = useState(false);
  const prevValue = useRef(value);

  useEffect(() => {
    if (value !== prevValue.current) {
      setBumping(true);
      const t = setTimeout(() => setBumping(false), 400);
      prevValue.current = value;
      return () => clearTimeout(t);
    }
  }, [value]);

  let displayed;
  if (format === 'percent') displayed = (animated * 100).toFixed(1) + '%';
  else if (format === 'dollar') displayed = '$' + animated.toFixed(4);
  else if (format === 'seconds') displayed = animated.toFixed(2) + 's';
  else displayed = Math.round(animated).toString();

  return (
    <div className={"card p-4 text-center " + (bumping ? 'counter-bump' : '')}>
      <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--vscode-charts-blue, #58a6ff)' }}>
        {displayed}
      </div>
      <div style={{ fontSize: '11px', marginTop: '4px', opacity: 0.7 }}>{label}</div>
    </div>
  );
}

function App() {
  const [logs, setLogs] = useState([]);
  const [metrics, setMetrics] = useState({
    hit_rate: 0,
    total_saved_usd: 0,
    total_saved_ms: 0,
    total_queries: 0,
    last_5: []
  });
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);

  const connect = useCallback(() => {
    const ws = new WebSocket('ws://localhost:8001');
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setTimeout(connect, 1000);
    };
    ws.onerror = () => ws.close();

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'query_complete') {
          setLogs(prev => [{
            query_id: data.query_id,
            query: data.query,
            status: data.status,
            similarity: data.similarity,
            latency_ms: data.latency_ms,
            cost_saved_usd: data.cost_saved_usd,
            latency_saved_ms: data.latency_saved_ms,
            timestamp: Date.now()
          }, ...prev].slice(0, 100));
        }

        if (data.type === 'metrics_update') {
          setMetrics({
            hit_rate: data.hit_rate,
            total_saved_usd: data.total_saved_usd,
            total_saved_ms: data.total_saved_ms,
            total_queries: data.total_queries,
            last_5: data.last_5 || []
          });
        }

        if (data.type === 'reset_complete') {
          setLogs([]);
          setMetrics({
            hit_rate: 0,
            total_saved_usd: 0,
            total_saved_ms: 0,
            total_queries: 0,
            last_5: []
          });
        }
      } catch (e) {
        console.error('WS parse error:', e);
      }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  const handleReset = async () => {
    try {
      await fetch('http://localhost:8000/reset', { method: 'POST' });
    } catch (e) {
      console.error('Reset failed:', e);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', gap: '12px', padding: '12px' }}>
      {/* Left Panel - Query Log */}
      <div style={{ flex: '1 1 55%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', padding: '0 4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600 }}>Query Log</span>
            <span className={"connection-dot " + (connected ? 'connected' : 'disconnected')} title={connected ? 'Connected' : 'Disconnected'}></span>
          </div>
          <button className="btn-reset" onClick={handleReset}>Reset Cache</button>
        </div>
        <div className="card" style={{ flex: 1, overflow: 'auto' }}>
          {logs.length === 0 && (
            <div style={{ padding: '24px', textAlign: 'center', opacity: 0.5, fontSize: '12px' }}>
              Waiting for queries...
            </div>
          )}
          {logs.map((entry) => (
            <div key={entry.query_id} className="log-entry">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <Badge status={entry.status} />
                <span style={{ fontSize: '10px', opacity: 0.5 }}>
                  {entry.latency_ms}ms
                  {entry.similarity !== null && ' · sim ' + entry.similarity.toFixed(3)}
                </span>
              </div>
              <div style={{ fontSize: '12px', lineHeight: '1.4', opacity: 0.9 }}>
                {entry.query}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right Panel - Metrics */}
      <div style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <CounterCard label="Hit Rate" value={metrics.hit_rate} format="percent" />
          <CounterCard label="$ Saved" value={metrics.total_saved_usd} format="dollar" />
          <CounterCard label="Latency Saved" value={metrics.total_saved_ms / 1000} format="seconds" />
          <CounterCard label="Total Queries" value={metrics.total_queries} format="int" />
        </div>

        <div className="card" style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px', opacity: 0.7 }}>
            RECENT QUERIES
          </div>
          {metrics.last_5.length === 0 && (
            <div style={{ fontSize: '11px', opacity: 0.4 }}>No queries yet</div>
          )}
          {metrics.last_5.map((q, i) => (
            <div key={q.query_id || i} style={{ marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border))' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                <Badge status={q.status} />
              </div>
              <div style={{ fontSize: '11px', opacity: 0.8, lineHeight: '1.3' }}>
                {q.query && q.query.slice(0, 80)}{q.query && q.query.length > 80 ? '…' : ''}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
</script>
</body>
</html>`;
	}
}
