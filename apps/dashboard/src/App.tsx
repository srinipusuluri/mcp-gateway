import { useCallback, useEffect, useState } from "react";
import { api, getToken, HttpError, setToken } from "./api";
import { Badge, Card, ErrorNote, Field } from "./components";
import { Monitoring } from "./pages/Monitoring";
import { Overview } from "./pages/Overview";
import { Playground } from "./pages/Playground";
import { Security } from "./pages/Security";
import { ToolExplorer } from "./pages/ToolExplorer";

export interface Me {
  userId: string;
  email?: string;
  roles: string[];
  permissions: string[];
  salesforceConnected: boolean;
  mode: "mock" | "live";
}

const PAGES = [
  { id: "overview", label: "Overview" },
  { id: "tools", label: "Tool Explorer" },
  { id: "playground", label: "Code Mode Playground" },
  { id: "security", label: "Security Center" },
  { id: "monitoring", label: "Monitoring" },
] as const;
type PageId = (typeof PAGES)[number]["id"];

const ROLES = ["analyst", "sales_rep", "service_agent", "approver", "admin", "viewer"] as const;

function useTheme() {
  const [theme, setThemeState] = useState<"auto" | "light" | "dark">(() => {
    try {
      return (localStorage.getItem("sfcm.theme") as "auto" | "light" | "dark") ?? "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("sfcm.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, setThemeState] as const;
}

function pageFromHash(): PageId {
  const h = window.location.hash.replace("#/", "");
  return (PAGES.find((p) => p.id === h)?.id ?? "overview") as PageId;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authState, setAuthState] = useState<"checking" | "anonymous" | "ready">(getToken() ? "checking" : "anonymous");
  const [page, setPage] = useState<PageId>(pageFromHash());
  const [theme, setTheme] = useTheme();

  const loadMe = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/me"));
      setAuthState("ready");
    } catch {
      setToken(null);
      setMe(null);
      setAuthState("anonymous");
    }
  }, []);

  useEffect(() => {
    if (getToken()) void loadMe();
  }, [loadMe]);
  useEffect(() => {
    const on = () => setPage(pageFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    document.title = `${PAGES.find((p) => p.id === page)?.label ?? ""} · Salesforce Code Mode Console`;
  }, [page]);

  const go = (id: PageId) => {
    window.location.hash = `#/${id}`;
    setPage(id);
  };

  if (authState === "checking") return <div className="main" role="status">Checking session…</div>;
  if (authState === "anonymous" || !me) return <SignIn onSignedIn={loadMe} />;

  return (
    <div className="shell">
      <a className="skip" href="#content">Skip to content</a>
      <aside className="side">
        <div className="brand"><span className="brand-mark" aria-hidden="true">{"</>"}</span> Code Mode Console</div>
        <nav className="nav" aria-label="Primary">
          {PAGES.map((p) => (
            <button key={p.id} aria-current={page === p.id ? "page" : undefined} onClick={() => go(p.id)}>{p.label}</button>
          ))}
        </nav>
        <div className="side-foot">
          <div>
            <div><strong style={{ color: "var(--text)" }}>{me.userId}</strong></div>
            <div>{me.roles.join(", ")}</div>
          </div>
          <label className="row" style={{ gap: 6 }}>
            <span className="sr-only">Theme</span>
            <select value={theme} onChange={(e) => setTheme(e.target.value as "auto" | "light" | "dark")} aria-label="Theme" style={{ padding: "4px 8px" }}>
              <option value="auto">Theme: system</option>
              <option value="light">Theme: light</option>
              <option value="dark">Theme: dark</option>
            </select>
          </label>
          <button className="btn btn-sm" onClick={() => { setToken(null); setMe(null); setAuthState("anonymous"); }}>Sign out</button>
        </div>
      </aside>
      <main className="main" id="content" tabIndex={-1}>
        {me.mode === "mock" && (
          <div className="banner-mock" role="note">
            <strong>MOCK MODE</strong>: every result comes from the built-in mock Salesforce org, not a live org. Mock profiles simulate CRUD, field-level security and sharing per role.
          </div>
        )}
        {page === "overview" && <Overview me={me} onRefreshMe={loadMe} />}
        {page === "tools" && <ToolExplorer me={me} />}
        {page === "playground" && <Playground me={me} goSecurity={() => go("security")} />}
        {page === "security" && <Security me={me} />}
        {page === "monitoring" && <Monitoring me={me} />}
      </main>
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setTok] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (t: string) => {
    setBusy(true);
    setError(null);
    setToken(t.trim());
    try {
      await api("/api/me", { token: t.trim() });
      onSignedIn();
    } catch (e) {
      setToken(null);
      setError(e instanceof HttpError ? e.message : "Could not reach the gateway.");
    } finally {
      setBusy(false);
    }
  };
  const demo = async (role: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>("/api/dev/token", { body: { role } });
      await submit(r.token);
    } catch (e) {
      setError(e instanceof HttpError ? `${e.message} Demo tokens are only available when ALLOW_DEV_TOKENS=true (mock mode).` : "Could not reach the gateway.");
      setBusy(false);
    }
  };

  return (
    <main className="login" id="content">
      <Card title="Sign in to the Code Mode Console">
        <p style={{ color: "var(--muted)", marginTop: 0 }}>Paste a gateway bearer token (JWT issued by your identity provider), or pick a demo persona when the gateway runs in mock mode.</p>
        <ErrorNote error={error} />
        <form onSubmit={(e) => { e.preventDefault(); void submit(token); }}>
          <Field label="Gateway token">{(id) => <textarea id={id} className="mono" rows={3} value={token} onChange={(e) => setTok(e.target.value)} placeholder="eyJhbGciOi…" autoComplete="off" spellCheck={false} />}</Field>
          <button className="btn btn-primary" disabled={busy || !token.trim()} type="submit">Sign in</button>
        </form>
        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "18px 0" }} />
        <h3 style={{ marginBottom: 8 }}>Demo personas <Badge tone="mock">mock mode only</Badge></h3>
        <div className="row">
          {ROLES.map((r) => <button key={r} className="btn btn-sm" disabled={busy} onClick={() => void demo(r)}>{r}</button>)}
        </div>
      </Card>
    </main>
  );
}
