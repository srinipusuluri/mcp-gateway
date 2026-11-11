import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function Badge({ tone = "neutral", children, title }: { tone?: "neutral" | "good" | "warn" | "bad" | "info" | "mock"; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Card({ title, children, actions, className = "" }: { title?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ? `tone-${tone}` : ""}`}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: string; badge?: number }>; value: T; onChange: (t: T) => void; label: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el;
          }}
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          className={value === t.id ? "tab active" : "tab"}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (!dir) return;
            const next = tabs[(i + dir + tabs.length) % tabs.length]!;
            onChange(next.id);
            refs.current[next.id]?.focus();
          }}
        >
          {t.label}
          {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="tabpanel">
      {children}
    </div>
  );
}

export function JsonView({ value, maxHeight = 360 }: { value: unknown; maxHeight?: number }) {
  return (
    <pre className="code" style={{ maxHeight }} tabIndex={0}>
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? (
    <div className="note note-bad" role="alert">
      {error}
    </div>
  ) : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="spinner-row" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}…
    </div>
  );
}

/** Horizontal bar chart. The SVG has a text alternative; callers also render the data as a table nearby. */
export function BarChart({ data, unit = "", label, max }: { data: Array<{ label: string; value: number; tone?: "bad" }>; unit?: string; label: string; max?: number }) {
  const top = max ?? Math.max(1, ...data.map((d) => d.value));
  const rowH = 26;
  return (
    <svg role="img" aria-label={`${label}: ${data.map((d) => `${d.label} ${d.value}${unit}`).join(", ")}`} width="100%" viewBox={`0 0 520 ${Math.max(1, data.length) * rowH}`} className="chart">
      {data.map((d, i) => {
        const w = Math.max(2, (d.value / top) * 300);
        return (
          <g key={d.label} transform={`translate(0 ${i * rowH})`}>
            <text x="0" y="17" className="chart-label">
              {d.label.length > 24 ? d.label.slice(0, 23) + "…" : d.label}
            </text>
            <rect x="170" y="4" width={w} height="16" rx="3" className={d.tone === "bad" ? "bar bar-bad" : "bar"} />
            <text x={176 + w} y="17" className="chart-value">
              {d.value}
              {unit}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Vertical bars over time (execution latency), failures highlighted. */
export function TimeBars({ data, label }: { data: Array<{ ts: string; value: number; ok: boolean }>; label: string }) {
  const W = 560, H = 140, pad = 24;
  const top = Math.max(1, ...data.map((d) => d.value));
  const bw = data.length ? Math.max(3, Math.min(18, (W - pad * 2) / data.length - 2)) : 0;
  return (
    <svg role="img" aria-label={`${label}. ${data.length} executions, max ${Math.round(top)} ms`} viewBox={`0 0 ${W} ${H}`} width="100%" className="chart">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="axis" />
      <text x={pad} y="12" className="chart-label">
        {Math.round(top)} ms
      </text>
      {data.map((d, i) => {
        const h = Math.max(2, (d.value / top) * (H - pad * 2));
        const x = pad + i * ((W - pad * 2) / Math.max(1, data.length));
        return (
          <rect key={`${d.ts}-${i}`} x={x} y={H - pad - h} width={bw} height={h} rx="2" className={d.ok ? "bar" : "bar bar-bad"}>
            <title>{`${new Date(d.ts).toLocaleTimeString()}: ${Math.round(d.value)} ms${d.ok ? "" : " (failed)"}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
