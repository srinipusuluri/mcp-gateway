import { useCallback, useEffect, useState } from "react";
import { api, fmtMs, fmtNum, fmtTime, HttpError } from "../api";
import type { Me } from "../App";
import { Badge, BarChart, Card, Empty, ErrorNote, JsonView, Spinner, Stat, TimeBars } from "../components";

interface Snapshot {
  totalExecutions: number; failedExecutions: number; avgLatencyMs: number; p95LatencyMs: number; totalToolCalls: number; totalSalesforceApiCalls: number; totalRecordsReturned: number;
  perTool: Array<{ tool: string; calls: number; errors: number; avgMs: number; maxMs: number; sfApiCalls: number }>; errorsByCode: Record<string, number>;
  estimatedTokens: { inputBytesProxy: number; outputBytesProxy: number; note: string }; estimatedCostUsd: number; series: Array<{ ts: string; durationMs: number; ok: boolean; toolCalls: number }>;
}
interface Exec { executionId: string; ts: string; userId: string; mode: string; ok: boolean; errorCode?: string; durationMs: number; toolCalls: number; salesforceApiCalls: number; recordsReturned: number; resultBytes: number; runtime: string; trace: Array<{ seq: number; tool: string; durationMs: number; ok: boolean; salesforceApiCalls: number }> }

export function Monitoring({ me }: { me: Me }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [hist, setHist] = useState<Exec[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([api<Snapshot>("/api/metrics"), api<{ executions: Exec[] }>("/api/executions?limit=50")]);
      setSnap(s); setHist(h.executions); setError(null);
    } catch (e) {
      if (e instanceof HttpError && e.status === 403) setForbidden(true); else setError(e instanceof Error ? e.message : "Failed to load metrics");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (forbidden) return <><div className="topbar"><h1>Monitoring</h1></div><Empty>Monitoring requires the audit.read permission. Sign in as <strong>approver</strong> or <strong>admin</strong> (you are {me.roles.join(", ")}).</Empty></>;
  if (error) return <ErrorNote error={error} />;
  if (!snap) return <Spinner />;
  const errRows = Object.entries(snap.errorsByCode).map(([label, value]) => ({ label, value, tone: "bad" as const }));

  return (
    <>
      <div className="topbar"><div><h1>Monitoring</h1><div className="sub">Executions, tool usage, latency and Salesforce API consumption</div></div><button className="btn" onClick={() => void load()}>Refresh</button></div>
      <div className="grid cols-4">
        <Card><Stat label="Executions" value={fmtNum(snap.totalExecutions)} hint={`${snap.failedExecutions} failed`} tone={snap.failedExecutions ? "warn" : undefined} /></Card>
        <Card><Stat label="Latency avg / p95" value={`${fmtMs(snap.avgLatencyMs)} / ${fmtMs(snap.p95LatencyMs)}`} /></Card>
        <Card><Stat label="Salesforce API calls" value={fmtNum(snap.totalSalesforceApiCalls)} hint={`${fmtNum(snap.totalToolCalls)} tool calls · ${fmtNum(snap.totalRecordsReturned)} rows`} /></Card>
        <Card><Stat label="Est. compute cost" value={`$${snap.estimatedCostUsd.toFixed(5)}`} hint="illustrative rate; token usage comes from your model provider" /></Card>
      </div>
      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Card title="Execution latency over time">{snap.series.length ? <TimeBars label="Execution latency" data={snap.series.map((r) => ({ ts: r.ts, value: r.durationMs, ok: r.ok }))} /> : <Empty>No executions yet.</Empty>}</Card>
        <Card title="Tool invocations">{snap.perTool.length ? <BarChart label="Calls per tool" data={snap.perTool.slice(0, 10).map((t) => ({ label: t.tool, value: t.calls }))} /> : <Empty>No tool calls yet.</Empty>}</Card>
        <Card title="Errors by code">{errRows.length ? <BarChart label="Errors by code" data={errRows} /> : <Empty>No errors recorded.</Empty>}</Card>
        <Card title="Salesforce API consumption by tool">{snap.perTool.some((t) => t.sfApiCalls) ? <BarChart label="Salesforce API calls per tool" data={[...snap.perTool].sort((a, b) => b.sfApiCalls - a.sfApiCalls).slice(0, 10).map((t) => ({ label: t.tool, value: t.sfApiCalls }))} /> : <Empty>No API calls yet.</Empty>}</Card>
      </div>
      <Card title="Tool metrics"><div className="table-wrap"><table>
        <thead><tr><th>Tool</th><th className="num">Calls</th><th className="num">Errors</th><th className="num">Avg ms</th><th className="num">Max ms</th><th className="num">SF API calls</th></tr></thead>
        <tbody>{snap.perTool.map((t) => <tr key={t.tool}><td><code>{t.tool}</code></td><td className="num">{t.calls}</td><td className="num">{t.errors || "–"}</td><td className="num">{t.avgMs}</td><td className="num">{t.maxMs}</td><td className="num">{t.sfApiCalls}</td></tr>)}</tbody>
      </table></div></Card>
      <Card title="Execution history">
        {hist.length === 0 ? <Empty>No executions yet.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Time</th><th>User</th><th>Mode</th><th>Status</th><th className="num">ms</th><th className="num">Tools</th><th className="num">SF calls</th><th>Trace</th></tr></thead>
            <tbody>{hist.map((x) => (
              <>
                <tr key={x.executionId}>
                  <td>{fmtTime(x.ts)}</td><td>{x.userId}</td><td><Badge tone={x.mode === "mock" ? "mock" : "info"}>{x.mode}</Badge></td>
                  <td>{x.ok ? <Badge tone="good">ok</Badge> : <Badge tone="bad">{x.errorCode}</Badge>}</td><td className="num">{Math.round(x.durationMs)}</td><td className="num">{x.toolCalls}</td><td className="num">{x.salesforceApiCalls}</td>
                  <td><button className="btn btn-sm btn-ghost" aria-expanded={open === x.executionId} onClick={() => setOpen(open === x.executionId ? null : x.executionId)}>{open === x.executionId ? "Hide" : "Show"}</button></td>
                </tr>
                {open === x.executionId && <tr key={`${x.executionId}-t`}><td colSpan={8}><JsonView value={x.trace} maxHeight={220} /></td></tr>}
              </>))}</tbody>
          </table></div>
        )}
      </Card>
      <p style={{ color: "var(--muted)", fontSize: 12.5 }}>{snap.estimatedTokens.note}</p>
    </>
  );
}
