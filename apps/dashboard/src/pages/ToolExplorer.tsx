import { useEffect, useMemo, useState } from "react";
import { api, HttpError } from "../api";
import type { Me } from "../App";
import { Badge, Card, CopyButton, Empty, ErrorNote, Field, JsonView, Spinner, TabPanel, Tabs } from "../components";

interface Cap {
  name: string; call: string; title: string; description: string; domain: string; kind: "read" | "write"; requiresApproval: boolean; permission: string;
  availability: "live" | "mock-only"; availableNow: boolean; notes?: string; inputSchema: any; typescript: string; examples: string[];
}
interface Discovery { mode: string; capabilities: Cap[]; denied: Array<{ name: string; permission: string; domain: string }>; typescript: string }

const SAMPLE_IDS: Record<string, string> = { accountId: "001000000000001AAA", caseId: "500000000000001AAA", opportunityId: "006000000000001AAA", contactId: "003000000000001AAA" };

function skeleton(schema: any): unknown {
  if (!schema || typeof schema !== "object") return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (t === "string") return "";
  if (t === "number" || t === "integer") return schema.minimum ?? 0;
  if (t === "boolean") return false;
  if (t === "array") return [];
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const k of schema.required ?? []) out[k] = SAMPLE_IDS[k] ?? skeleton(schema.properties?.[k]);
    return out;
  }
  if (schema.anyOf) return skeleton(schema.anyOf.find((s: any) => s.type !== "null") ?? schema.anyOf[0]);
  return null;
}

export function ToolExplorer({ me }: { me: Me }) {
  const [d, setD] = useState<Discovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [domain, setDomain] = useState("all");
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "schema" | "types" | "test">("overview");

  useEffect(() => {
    api<Discovery>("/api/tools").then((r) => { setD(r); setSel((s) => s ?? r.capabilities[0]?.name ?? null); }).catch((e) => setError(e instanceof Error ? e.message : "Failed to load tools"));
  }, []);

  const caps = useMemo(() => (d?.capabilities ?? []).filter((c) => (domain === "all" || c.domain === domain) && (!q || `${c.name} ${c.title} ${c.description}`.toLowerCase().includes(q.toLowerCase()))), [d, q, domain]);
  const domains = useMemo(() => ["all", ...new Set((d?.capabilities ?? []).map((c) => c.domain))], [d]);
  const cap = d?.capabilities.find((c) => c.name === sel);

  if (error) return <ErrorNote error={error} />;
  if (!d) return <Spinner />;
  return (
    <>
      <div className="topbar">
        <div><h1>Tool Explorer</h1><div className="sub">{d.capabilities.length} capabilities available to <strong>{me.roles.join(", ")}</strong>{d.denied.length ? ` · ${d.denied.length} hidden by RBAC` : ""}</div></div>
      </div>
      <div className="split">
        <Card>
          <Field label="Search">{(id) => <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. opportunity" />}</Field>
          <Field label="Domain">{(id) => <select id={id} value={domain} onChange={(e) => setDomain(e.target.value)}>{domains.map((x) => <option key={x}>{x}</option>)}</select>}</Field>
          <div className="list" role="listbox" aria-label="Capabilities">
            {caps.length === 0 && <Empty>No capability matches.</Empty>}
            {caps.map((c) => (
              <button key={c.name} role="option" aria-selected={sel === c.name} aria-current={sel === c.name} className="list-item" onClick={() => { setSel(c.name); setTab("overview"); }}>
                <span className="name">{c.call}</span>
                <span className="meta">
                  <Badge tone={c.kind === "write" ? "warn" : "good"}>{c.kind}</Badge>
                  <Badge>{c.domain}</Badge>
                  {c.availability === "mock-only" && <Badge tone="mock">mock-only</Badge>}
                </span>
              </button>
            ))}
          </div>
          {d.denied.length > 0 && (
            <details style={{ marginTop: 12 }}><summary>Hidden for your role ({d.denied.length})</summary>
              <ul style={{ paddingLeft: 18, color: "var(--muted)", fontSize: 13 }}>{d.denied.map((x) => <li key={x.name}>{x.name} <code>{x.permission}</code></li>)}</ul>
            </details>
          )}
        </Card>

        {cap ? (
          <Card title={cap.title} actions={<><Badge tone={cap.kind === "write" ? "warn" : "good"}>{cap.kind}</Badge>{cap.requiresApproval && <Badge tone="warn">needs approval</Badge>}{cap.availability === "mock-only" && <Badge tone="mock">mock-only</Badge>}</>}>
            <Tabs label="Tool details" value={tab} onChange={setTab} tabs={[{ id: "overview", label: "Overview" }, { id: "schema", label: "Input schema" }, { id: "types", label: "TypeScript" }, { id: "test", label: "Test" }]} />
            {tab === "overview" && (
              <TabPanel id="overview">
                <p style={{ marginTop: 0 }}>{cap.description}</p>
                <table><tbody>
                  <tr><th scope="row">Sandbox call</th><td><code>{cap.call}(…)</code></td></tr>
                  <tr><th scope="row">Permission</th><td><code>{cap.permission}</code></td></tr>
                  <tr><th scope="row">Classification</th><td>{cap.kind === "write" ? "Write — human approval required, idempotent per approval" : "Read-only"}</td></tr>
                  <tr><th scope="row">Availability</th><td>{cap.availability === "live" ? "Live Salesforce API (also works against the mock)" : "Mock adapter only — a live adapter must be supplied"}</td></tr>
                </tbody></table>
                {cap.notes && <div className="note note-info">{cap.notes}</div>}
                <h3 style={{ margin: "14px 0 6px" }}>Usage examples</h3>
                {cap.examples.map((e) => <div key={e} style={{ marginBottom: 6 }}><JsonView value={e} maxHeight={120} /></div>)}
              </TabPanel>
            )}
            {tab === "schema" && <TabPanel id="schema"><div className="row" style={{ marginBottom: 8 }}><CopyButton text={JSON.stringify(cap.inputSchema, null, 2)} /></div><JsonView value={cap.inputSchema} maxHeight={480} /></TabPanel>}
            {tab === "types" && <TabPanel id="types"><div className="row" style={{ marginBottom: 8 }}><CopyButton text={cap.typescript} label="Copy signature" /><CopyButton text={d.typescript} label="Copy all declarations" /></div><JsonView value={cap.typescript} maxHeight={480} /></TabPanel>}
            {tab === "test" && <TabPanel id="test"><Tester key={cap.name} cap={cap} /></TabPanel>}
          </Card>
        ) : <Empty>Select a capability.</Empty>}
      </div>
    </>
  );
}

function Tester({ cap }: { cap: Cap }) {
  const [text, setText] = useState(() => JSON.stringify(skeleton(cap.inputSchema), null, 2));
  const [out, setOut] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setError(null);
    let input: unknown;
    try { input = JSON.parse(text || "{}"); } catch { setError("Input must be valid JSON."); return; }
    setBusy(true);
    try { setOut(await api(`/api/tools/${cap.name}/invoke`, { body: { input } })); }
    catch (e) { setError(e instanceof HttpError ? e.message : "Request failed"); }
    finally { setBusy(false); }
  };
  return (
    <>
      {cap.kind === "write" && <div className="note note-warn">This is a write tool. Running it creates an approval request; nothing is written until an approver approves it in the Security Center and you run it again.</div>}
      <Field label="Input (JSON)" hint="Prefilled from the schema. IDs shown are mock-org samples.">{(id) => <textarea id={id} className="mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />}</Field>
      <div className="row"><button className="btn btn-primary" disabled={busy} onClick={() => void run()}>{busy ? "Running…" : "Run tool"}</button></div>
      <ErrorNote error={error} />
      {out && (
        <div style={{ marginTop: 12 }} aria-live="polite">
          <div className="row" style={{ marginBottom: 8 }}>
            <Badge tone={out.ok ? "good" : "bad"}>{out.ok ? "success" : out.error?.code}</Badge>
            <Badge tone={out.mode === "mock" ? "mock" : "info"}>{String(out.mode).toUpperCase()}</Badge>
            {out.trace?.[0] && <span style={{ color: "var(--muted)", fontSize: 13 }}>{Math.round(out.trace[0].durationMs)} ms · {out.trace[0].salesforceApiCalls} SF API call(s)</span>}
          </div>
          {out.ok ? <JsonView value={out.result} /> : <div className="note note-bad">{out.error?.message}{out.error?.approvalId && <> — approval id <code>{out.error.approvalId}</code></>}</div>}
        </div>
      )}
    </>
  );
}
