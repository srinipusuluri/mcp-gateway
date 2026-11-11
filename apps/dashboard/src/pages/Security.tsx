import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, HttpError } from "../api";
import type { Me } from "../App";
import { Badge, Card, Empty, ErrorNote, JsonView, Spinner, TabPanel, Tabs } from "../components";

type TabId = "approvals" | "users" | "permissions" | "audit" | "policies";

export function Security({ me }: { me: Me }) {
  const [tab, setTab] = useState<TabId>("approvals");
  const [pending, setPending] = useState(0);
  return (
    <>
      <div className="topbar"><div><h1>Security Center</h1><div className="sub">Who can do what, what is waiting for a human, and what already happened</div></div></div>
      <Tabs<TabId> label="Security sections" value={tab} onChange={setTab} tabs={[{ id: "approvals", label: "Approval queue", badge: pending || undefined }, { id: "users", label: "Connected users" }, { id: "permissions", label: "Tool permissions" }, { id: "audit", label: "Audit log" }, { id: "policies", label: "Execution policies" }]} />
      {tab === "approvals" && <TabPanel id="approvals"><Approvals me={me} onPending={setPending} /></TabPanel>}
      {tab === "users" && <TabPanel id="users"><Users /></TabPanel>}
      {tab === "permissions" && <TabPanel id="permissions"><Permissions /></TabPanel>}
      {tab === "audit" && <TabPanel id="audit"><Audit /></TabPanel>}
      {tab === "policies" && <TabPanel id="policies"><Policies /></TabPanel>}
    </>
  );
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const load = useCallback(async () => {
    try { setData(await api<T>(path)); setError(null); setForbidden(false); }
    catch (e) { if (e instanceof HttpError && e.status === 403) setForbidden(true); else setError(e instanceof Error ? e.message : "Failed to load"); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, forbidden, load };
}

const statusTone = (s: string) => (s === "approved" || s === "consumed" ? "good" : s === "rejected" ? "bad" : s === "pending" ? "warn" : "neutral") as "good" | "bad" | "warn" | "neutral";

function Approvals({ me, onPending }: { me: Me; onPending: (n: number) => void }) {
  const { data, error, load } = useLoad<{ approvals: Array<{ id: string; tool: string; args: unknown; requestedBy: string; requestedAt: string; status: string; decidedBy?: string; reason?: string; expiresAt: string }>; canDecide: boolean }>("/api/approvals");
  const [reason, setReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err2, setErr2] = useState<string | null>(null);
  useEffect(() => { onPending(data?.approvals.filter((a) => a.status === "pending").length ?? 0); }, [data, onPending]);
  const decide = async (id: string, verb: "approve" | "reject") => {
    setErr2(null); setMsg(null);
    try { await api(`/api/approvals/${id}/${verb}`, { body: { reason: reason[id] || undefined } }); setMsg(`Request ${verb === "approve" ? "approved" : "rejected"}.`); await load(); }
    catch (e) { setErr2(e instanceof Error ? e.message : "Failed"); }
  };
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;
  return (
    <Card title="Write approvals" actions={<button className="btn btn-sm" onClick={() => void load()}>Refresh</button>}>
      <p style={{ marginTop: 0, color: "var(--muted)", fontSize: 14 }}>Every write needs a human decision. An approval authorizes exactly one execution of the exact tool, arguments and requester shown, and expires. Requesters cannot approve their own requests.{!data.canDecide && " You can see your own requests; deciding needs the approver role."}</p>
      {msg && <div className="note note-good" role="status">{msg}</div>}<ErrorNote error={err2} />
      {data.approvals.length === 0 ? <Empty>No approval requests. Try creating a case from the Playground as a service_agent.</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Requested</th><th>Tool &amp; arguments</th><th>By</th><th>Status</th><th>Decision</th></tr></thead>
          <tbody>{data.approvals.map((a) => (
            <tr key={a.id}>
              <td>{fmtTime(a.requestedAt)}<div style={{ color: "var(--muted)", fontSize: 12 }}><code>{a.id}</code></div></td>
              <td><code>{a.tool}</code><details><summary style={{ cursor: "pointer", fontSize: 12.5 }}>arguments</summary><JsonView value={a.args} maxHeight={160} /></details></td>
              <td>{a.requestedBy}</td>
              <td><Badge tone={statusTone(a.status)}>{a.status}</Badge>{a.decidedBy && <div style={{ fontSize: 12, color: "var(--muted)" }}>by {a.decidedBy}{a.reason ? `: ${a.reason}` : ""}</div>}</td>
              <td>
                {a.status === "pending" && data.canDecide ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 190 }}>
                    <label className="sr-only" htmlFor={`r-${a.id}`}>Reason</label>
                    <input id={`r-${a.id}`} placeholder="Reason (optional)" value={reason[a.id] ?? ""} onChange={(e) => setReason({ ...reason, [a.id]: e.target.value })} />
                    <div className="row">
                      <button className="btn btn-sm btn-primary" disabled={a.requestedBy === me.userId} title={a.requestedBy === me.userId ? "Cannot approve your own request" : undefined} onClick={() => void decide(a.id, "approve")}>Approve</button>
                      <button className="btn btn-sm btn-danger" onClick={() => void decide(a.id, "reject")}>Reject</button>
                    </div>
                  </div>
                ) : <span style={{ color: "var(--muted)" }}>—</span>}
              </td>
            </tr>))}</tbody>
        </table></div>
      )}
    </Card>
  );
}

function Users() {
  const { data, error, forbidden } = useLoad<{ users: Array<{ userId: string; email?: string; roles: string[]; lastSeen: string }> }>("/api/security/users");
  if (forbidden) return <Empty>Listing users requires the audit.read permission (approver or admin).</Empty>;
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;
  return (
    <Card title="Connected users"><div className="table-wrap"><table>
      <caption>Principals that have authenticated to the gateway</caption>
      <thead><tr><th>User</th><th>Roles</th><th>Last seen</th></tr></thead>
      <tbody>{data.users.map((u) => <tr key={u.userId}><td>{u.userId}{u.email && <div style={{ color: "var(--muted)", fontSize: 12 }}>{u.email}</div>}</td><td>{(u.roles as string[]).map((r) => <Badge key={r} tone="info">{r}</Badge>)}</td><td>{fmtTime(u.lastSeen)}</td></tr>)}</tbody>
    </table></div></Card>
  );
}

function Permissions() {
  const { data, error } = useLoad<{ rolePermissions: Record<string, string[]>; toolPermissions: Array<{ tool: string; kind: string; permission: string; availability: string; requiresApproval: boolean; allowedForYou: boolean }>; yourPermissions: string[] }>("/api/security/overview");
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;
  const roles = Object.keys(data.rolePermissions);
  return (
    <div className="grid">
      <Card title="Tool permissions"><div className="table-wrap"><table>
        <caption>Each tool, the permission it needs, and whether it is open to you</caption>
        <thead><tr><th>Tool</th><th>Kind</th><th>Permission</th><th>Approval</th><th>Allowed for you</th></tr></thead>
        <tbody>{data.toolPermissions.map((t) => (
          <tr key={t.tool}><td><code>{t.tool}</code>{t.availability === "mock-only" && <> <Badge tone="mock">mock-only</Badge></>}</td><td>{t.kind}</td><td><code>{t.permission}</code></td><td>{t.requiresApproval ? <Badge tone="warn">required</Badge> : "—"}</td><td>{t.allowedForYou ? <Badge tone="good">yes</Badge> : <Badge tone="bad">no</Badge>}</td></tr>))}</tbody>
      </table></div></Card>
      <Card title="Role → permission matrix"><div className="table-wrap"><table>
        <caption>Deny by default: a permission not listed is not granted</caption>
        <thead><tr><th>Permission</th>{roles.map((r) => <th key={r}>{r}</th>)}</tr></thead>
        <tbody>{[...new Set(Object.values(data.rolePermissions).flat())].sort().map((p) => (
          <tr key={p}><td><code>{p}</code></td>{roles.map((r) => <td key={r}>{data.rolePermissions[r]!.includes(p) ? <span aria-label="granted">●</span> : <span aria-label="not granted" style={{ color: "var(--border)" }}>○</span>}</td>)}</tr>))}</tbody>
      </table></div></Card>
    </div>
  );
}

function Audit() {
  const { data, error, forbidden, load } = useLoad<{ events: Array<{ id: string; ts: string; action: string; userId: string; outcome: string; resource?: string; detail?: Record<string, unknown>; hash: string }> }>("/api/audit?limit=150");
  const [verify, setVerify] = useState<{ valid: boolean; checked: number; brokenAt?: number } | null>(null);
  const [filter, setFilter] = useState("all");
  if (forbidden) return <Empty>The audit log requires the audit.read permission (approver or admin).</Empty>;
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;
  const actions = ["all", ...new Set(data.events.map((e) => e.action))];
  const rows = data.events.filter((e) => filter === "all" || e.action === filter);
  return (
    <Card title="Audit log" actions={<>
      <label className="sr-only" htmlFor="audit-filter">Filter by action</label>
      <select id="audit-filter" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "auto" }}>{actions.map((a) => <option key={a}>{a}</option>)}</select>
      <button className="btn btn-sm" onClick={() => void load()}>Refresh</button>
      <button className="btn btn-sm" onClick={async () => setVerify(await api("/api/audit/verify"))}>Verify hash chain</button>
    </>}>
      {verify && <div className={`note ${verify.valid ? "note-good" : "note-bad"}`} role="status">{verify.valid ? `Chain intact: ${verify.checked} events verified.` : `Chain broken at event #${verify.brokenAt}. The log was modified or truncated.`}</div>}
      <div className="table-wrap"><table>
        <thead><tr><th>Time</th><th>Action</th><th>User</th><th>Outcome</th><th>Resource</th><th>Detail</th></tr></thead>
        <tbody>{rows.map((e) => (
          <tr key={e.id}><td>{fmtTime(e.ts)}</td><td><code>{e.action}</code></td><td>{e.userId}</td><td><Badge tone={e.outcome === "success" ? "good" : e.outcome === "denied" ? "warn" : "bad"}>{e.outcome}</Badge></td><td>{e.resource ?? "—"}</td><td style={{ maxWidth: 320, fontSize: 12, color: "var(--muted)", overflowWrap: "anywhere" }}>{e.detail ? JSON.stringify(e.detail) : ""}</td></tr>))}</tbody>
      </table></div>
      {rows.length === 0 && <Empty>No events.</Empty>}
    </Card>
  );
}

function Policies() {
  const { data, error } = useLoad<{ policy: Record<string, unknown> }>("/api/security/overview");
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;
  const notes: Record<string, string> = {
    writesRequireApproval: "Writes pause for a human decision", allowSelfApproval: "Four-eyes principle when false", writesEnabled: "Master switch for all write tools",
    timeoutMs: "Wall-clock limit per execution", maxResultBytes: "Larger results are truncated or rejected", maxRecordsPerQuery: "Hard cap per tool call page", maxCodeBytes: "Maximum generated program size",
    maxToolCallsPerExecution: "Loop / runaway protection", maxSalesforceApiCallsPerExecution: "Protects the org's API limit", executionsPerMinute: "Per-user rate limit", toolCallsPerMinute: "Per-user rate limit", approvedAgents: "Agentforce agents that may be invoked",
  };
  return (
    <Card title="Execution policies"><div className="table-wrap"><table>
      <caption>Effective policy (configured with the EXECUTION_POLICY_JSON variable; read-only here)</caption>
      <thead><tr><th>Setting</th><th>Value</th><th>Meaning</th></tr></thead>
      <tbody>{Object.entries(data.policy).map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td>{typeof v === "boolean" ? <Badge tone={v ? "good" : "neutral"}>{String(v)}</Badge> : <code>{JSON.stringify(v)}</code>}</td><td style={{ color: "var(--muted)" }}>{notes[k] ?? ""}</td></tr>)}</tbody>
    </table></div></Card>
  );
}
