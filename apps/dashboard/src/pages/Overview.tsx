import { useCallback, useEffect, useState } from "react";
import { api, fmtMs, fmtNum, HttpError } from "../api";
import type { Me } from "../App";
import { Badge, Card, CopyButton, ErrorNote, Spinner, Stat, TimeBars } from "../components";

interface Status {
  mode: "mock" | "live";
  mcp: { status: string; endpoints: { codemode: string; direct: string }; tools: string[] };
  sandbox: { status: string; runtime: string; limits: { timeoutMs: number; maxCodeBytes: number; maxResultBytes: number } };
  salesforce: { mode: string; connected: boolean; apiVersion: string; loginHost: string };
  registry: { total: number; readTools: number; writeTools: number; mockOnly: number };
  metrics: { totalExecutions: number; failedExecutions: number; avgLatencyMs: number };
  claudeApiConfigured: boolean;
  configWarnings: string[];
}

export function Overview({ me, onRefreshMe }: { me: Me; onRefreshMe: () => void }) {
  const [s, setS] = useState<Status | null>(null);
  const [series, setSeries] = useState<Array<{ ts: string; durationMs: number; ok: boolean }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setS(await api<Status>("/api/status"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load status");
    }
    try {
      setSeries((await api<{ series: Array<{ ts: string; durationMs: number; ok: boolean }> }>("/api/metrics")).series);
    } catch (e) {
      if (e instanceof HttpError && e.status === 403) setSeries(null);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  const connect = async () => {
    setBusy(true);
    try {
      const r = await api<{ authorizeUrl: string }>("/api/oauth/start", { method: "POST", body: {} });
      window.location.assign(r.authorizeUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start OAuth");
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await api("/api/oauth/logout", { method: "POST", body: {} });
      onRefreshMe();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Logout failed");
    } finally {
      setBusy(false);
    }
  };

  if (!s) return error ? <ErrorNote error={error} /> : <Spinner />;
  const origin = window.location.origin;
  const mcpJson = JSON.stringify({ mcpServers: { "salesforce-codemode": { type: "http", url: `${origin}${s.mcp.endpoints.codemode}`, headers: { Authorization: "Bearer ${SFCM_TOKEN}" } } } }, null, 2);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Overview</h1>
          <div className="sub">Gateway, sandbox and Salesforce connection health</div>
        </div>
        <button className="btn" onClick={() => void load()}>Refresh</button>
      </div>
      <ErrorNote error={error} />
      {s.configWarnings.length > 0 && <div className="note note-warn" role="alert"><strong>Configuration warnings:</strong> {s.configWarnings.join(" ")}</div>}

      <div className="grid cols-4" aria-label="Key metrics">
        <Card><Stat label="Registered tools" value={s.registry.total} hint={`${s.registry.readTools} read · ${s.registry.writeTools} write · ${s.registry.mockOnly} mock-only`} /></Card>
        <Card><Stat label="Total executions" value={fmtNum(s.metrics.totalExecutions)} hint="execute_code runs" /></Card>
        <Card><Stat label="Failed executions" value={fmtNum(s.metrics.failedExecutions)} tone={s.metrics.failedExecutions ? "bad" : "good"} hint={s.metrics.totalExecutions ? `${((s.metrics.failedExecutions / s.metrics.totalExecutions) * 100).toFixed(1)}% of runs` : "no runs yet"} /></Card>
        <Card><Stat label="Avg execution latency" value={fmtMs(s.metrics.avgLatencyMs)} hint="gateway + sandbox" /></Card>
      </div>

      <div className="grid cols-3" style={{ marginTop: 14 }}>
        <Card title="Salesforce connection" actions={<Badge tone={s.salesforce.mode === "mock" ? "mock" : "info"}>{s.salesforce.mode.toUpperCase()}</Badge>}>
          <div className="row" style={{ marginBottom: 8 }}>
            <Badge tone={s.salesforce.connected ? "good" : "bad"}>{s.salesforce.connected ? "Connected" : "Not connected"}</Badge>
            <span style={{ color: "var(--muted)" }}>API {s.salesforce.apiVersion}</span>
          </div>
          <div style={{ color: "var(--muted)", fontSize: 13.5 }}>Login host: <code>{s.salesforce.loginHost}</code></div>
          {s.mode === "mock" ? (
            <p style={{ fontSize: 13.5 }}>Using the built-in mock org with simulated per-user CRUD / FLS / sharing. Set <code>SF_MODE=live</code> and complete the OAuth setup to use a real org.</p>
          ) : (
            <div className="row" style={{ marginTop: 10 }}>
              {s.salesforce.connected ? (
                <button className="btn" disabled={busy} onClick={() => void disconnect()}>Disconnect &amp; revoke</button>
              ) : (
                <button className="btn btn-primary" disabled={busy} onClick={() => void connect()}>Connect my Salesforce user</button>
              )}
            </div>
          )}
        </Card>
        <Card title="MCP gateway" actions={<Badge tone="good">{s.mcp.status}</Badge>}>
          <div style={{ fontSize: 13.5, color: "var(--muted)" }}>Tools exposed to Claude</div>
          <div className="row" style={{ margin: "6px 0 10px" }}>{s.mcp.tools.map((t) => <Badge key={t} tone="info">{t}</Badge>)}</div>
          <div style={{ fontSize: 13.5, color: "var(--muted)" }}>Endpoint</div>
          <code>{origin}{s.mcp.endpoints.codemode}</code>
          <div className="row" style={{ marginTop: 10 }}><CopyButton text={mcpJson} label="Copy .mcp.json snippet" /></div>
        </Card>
        <Card title="Execution sandbox" actions={<Badge tone="good">{s.sandbox.status}</Badge>}>
          <div style={{ fontSize: 13.5 }}>Runtime: <code>{s.sandbox.runtime}</code></div>
          <table style={{ marginTop: 8 }}><tbody>
            <tr><th scope="row">Timeout</th><td className="num">{fmtMs(s.sandbox.limits.timeoutMs)}</td></tr>
            <tr><th scope="row">Max code</th><td className="num">{fmtNum(s.sandbox.limits.maxCodeBytes)} B</td></tr>
            <tr><th scope="row">Max result</th><td className="num">{fmtNum(s.sandbox.limits.maxResultBytes)} B</td></tr>
          </tbody></table>
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 0 }}>Network egress: blocked. Credentials: host-side only.</p>
        </Card>
      </div>

      <Card title="Recent execution latency" className="" >
        {series === null ? <div className="empty">Latency history requires the audit.read permission (approver or admin).</div> : series.length === 0 ? <div className="empty">No executions yet. Run one from the Code Mode Playground.</div> : (
          <TimeBars data={series.map((r) => ({ ts: r.ts, value: r.durationMs, ok: r.ok }))} label="Execution latency over time" />
        )}
      </Card>
      <p style={{ color: "var(--muted)", fontSize: 13 }}>Signed in as <strong>{me.userId}</strong>. Claude API for the Playground: {s.claudeApiConfigured ? <Badge tone="good">configured</Badge> : <Badge>template generator (no ANTHROPIC_API_KEY)</Badge>}</p>
    </>
  );
}
