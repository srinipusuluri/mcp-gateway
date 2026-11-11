import { mean, percentile, wilson } from "./metrics";

/** One scored example. `scores` are 0..1 (higher is better); `pass` is the gate decision. */
export interface EvalCaseResult {
  suite: string;
  id: string;
  pass: boolean;
  scores: Record<string, number>;
  latencyMs?: number;
  /** Short facts for debugging (never raw customer data). */
  notes?: string[];
  error?: string;
}

export interface SuiteSummary {
  suite: string;
  kind: "deterministic" | "llm";
  cases: number;
  passed: number;
  passRate: number;
  passRateCI95: { low: number; high: number };
  metrics: Record<string, number>;
  latencyMs?: { p50: number; p95: number };
  thresholds: Record<string, number>;
  gatePassed: boolean;
  skipped?: string;
}

export interface EvalReport {
  generatedAt: string;
  gateway: { mode: string; runtime: string };
  judge?: { model: string };
  suites: SuiteSummary[];
  cases: EvalCaseResult[];
}

/** Aggregate case results; every metric is averaged, and the gate checks each threshold (metric >= value). */
export function summarize(suite: string, kind: SuiteSummary["kind"], results: EvalCaseResult[], thresholds: Record<string, number>, extra: Record<string, number> = {}): SuiteSummary {
  const keys = [...new Set(results.flatMap((r) => Object.keys(r.scores)))];
  const metrics: Record<string, number> = Object.fromEntries(keys.map((k) => [k, round(mean(results.filter((r) => k in r.scores).map((r) => r.scores[k]!)))]));
  Object.assign(metrics, Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, round(v)])));
  const passed = results.filter((r) => r.pass).length;
  metrics.passRate = round(results.length ? passed / results.length : 0);
  const lat = results.map((r) => r.latencyMs).filter((x): x is number => typeof x === "number");
  const gatePassed = Object.entries(thresholds).every(([k, v]) => (metrics[k] ?? 0) >= v);
  const ci = wilson(passed, results.length);
  return {
    suite, kind, cases: results.length, passed, passRate: metrics.passRate, passRateCI95: { low: round(ci.low), high: round(ci.high) }, metrics,
    latencyMs: lat.length ? { p50: Math.round(percentile(lat, 50)), p95: Math.round(percentile(lat, 95)) } : undefined,
    thresholds, gatePassed,
  };
}

export const round = (x: number) => Math.round(x * 1000) / 1000;

export function toMarkdown(r: EvalReport): string {
  const lines = [
    `# Evaluation report`,
    ``,
    `Generated ${r.generatedAt} · gateway mode **${r.gateway.mode}** · runtime ${r.gateway.runtime}${r.judge ? ` · LLM judge ${r.judge.model}` : " · no LLM judge (deterministic metrics only)"}`,
    ``,
    `| suite | kind | cases | pass rate (95% CI) | gate | key metrics |`,
    `|---|---|---|---|---|---|`,
  ];
  for (const s of r.suites) {
    if (s.skipped) {
      lines.push(`| ${s.suite} | ${s.kind} | 0 | – | skipped | ${s.skipped} |`);
      continue;
    }
    const key = Object.entries(s.metrics).filter(([k]) => k !== "passRate").slice(0, 8).map(([k, v]) => `${k} ${v}`).join(" · ");
    lines.push(`| ${s.suite} | ${s.kind} | ${s.cases} | ${(s.passRate * 100).toFixed(0)}% (${(s.passRateCI95.low * 100).toFixed(0)}–${(s.passRateCI95.high * 100).toFixed(0)}%) | ${s.gatePassed ? "✅" : "❌"} | ${key} |`);
  }
  const failed = r.cases.filter((c) => !c.pass);
  lines.push("", `## Failed cases (${failed.length})`, "");
  if (!failed.length) lines.push("None.");
  for (const c of failed.slice(0, 50)) lines.push(`- **${c.suite} / ${c.id}**: ${c.error ?? ""} ${Object.entries(c.scores).map(([k, v]) => `${k}=${round(v)}`).join(" ")} ${(c.notes ?? []).join("; ")}`.trim());
  lines.push("", "Thresholds per suite are in the JSON report. Deterministic suites run in CI; `llm` suites need ANTHROPIC_API_KEY.");
  return lines.join("\n") + "\n";
}
