/**
 * npm run evals:repeat [-- --runs 10 --overhead 30]
 *
 * 1. Runs the deterministic suites N times: checks metric stability and collects per-run latency.
 * 2. Guardrail overhead: every workflow K times with guardrails on vs off (interleaved, same process).
 * 3. Detector throughput on synthetic CRM text.
 * Writes tests/evals/results/evals-repeated.{json,md}.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WORKFLOWS } from "@sfcm/salesforce-mcp";
import { Guardrails } from "@sfcm/security";
import { mean, percentile } from "@sfcm/evals";
import { makePlatform, principal } from "../helpers/harness";
import { runAgentSuite, runGuardrailSuite, runRagSuite, runToolSuite } from "./suites";

const num = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const RUNS = num("runs", 10);
const K = num("overhead", 30);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ---- 1. repeated suites --------------------------------------------------------------------
type Row = { run: number; suite: string; passed: number; cases: number; gate: boolean; wallMs: number; metrics: Record<string, number> };
const rows: Row[] = [];
for (let run = 1; run <= RUNS; run++) {
  for (const [name, fn] of [["tools", runToolSuite], ["agent", runAgentSuite], ["rag", () => runRagSuite()], ["guardrails", runGuardrailSuite]] as const) {
    const t = performance.now();
    const r = await fn();
    rows.push({ run, suite: name, passed: r.summary.passed, cases: r.summary.cases, gate: r.summary.gatePassed, wallMs: performance.now() - t, metrics: r.summary.metrics });
  }
  process.stdout.write(`run ${run}/${RUNS}\r`);
}
const suites = [...new Set(rows.map((r) => r.suite))].map((suite) => {
  const rs = rows.filter((r) => r.suite === suite);
  const keys = Object.keys(rs[0]!.metrics);
  const unstable = keys.filter((k) => new Set(rs.map((r) => r.metrics[k])).size > 1);
  const wall = rs.map((r) => r.wallMs);
  return {
    suite, runs: rs.length, cases: rs[0]!.cases, passedPerRun: [...new Set(rs.map((r) => r.passed))], gatePassedAllRuns: rs.every((r) => r.gate),
    unstableMetrics: unstable, metrics: rs[0]!.metrics,
    wallMs: { mean: r1(mean(wall)), p50: r1(percentile(wall, 50)), p95: r1(percentile(wall, 95)), min: r1(Math.min(...wall)), max: r1(Math.max(...wall)) },
  };
});

// ---- 2. guardrail overhead -----------------------------------------------------------------
// Rate limits are raised so the benchmark measures execution, not the limiter.
const BENCH_POLICY = JSON.stringify({ executionsPerMinute: 100_000, toolCallsPerMinute: 1_000_000 });
const on = makePlatform({ EXECUTION_POLICY_JSON: BENCH_POLICY });
const off = makePlatform({ EXECUTION_POLICY_JSON: BENCH_POLICY, GUARDRAIL_POLICY_JSON: JSON.stringify({ enabled: false }) });
const who = principal("admin");
const overhead = [];
for (const w of WORKFLOWS) {
  const code = w.build(w.defaults);
  const times: Record<"on" | "off", number[]> = { on: [], off: [] };
  let bytes = 0;
  for (const p of [on, off]) {
    const { sf, adapters } = p.salesforceFor(who);
    await p.engine.execute({ code, principal: who, sf, adapters }); // warm-up
  }
  for (let i = 0; i < K; i++) {
    for (const [label, p] of (i % 2 ? [["off", off], ["on", on]] : [["on", on], ["off", off]]) as Array<["on" | "off", typeof on]>) {
      const { sf, adapters } = p.salesforceFor(who);
      const t = performance.now();
      const o = await p.engine.execute({ code, principal: who, sf, adapters });
      times[label].push(performance.now() - t);
      if (!o.ok) throw new Error(`${w.id} (${label}) failed: ${o.error?.code} ${o.error?.message}`);
      if (label === "on") bytes = o.metadata.resultBytes;
    }
  }
  const mOn = percentile(times.on, 50);
  const mOff = percentile(times.off, 50);
  overhead.push({ workflow: w.id, p50OnMs: r1(mOn), p50OffMs: r1(mOff), deltaMs: r1(mOn - mOff), deltaPct: r1(((mOn - mOff) / mOff) * 100), p95OnMs: r1(percentile(times.on, 95)), p95OffMs: r1(percentile(times.off, 95)), resultBytes: bytes });
}

// ---- 3. detector throughput ----------------------------------------------------------------
const g = new Guardrails();
const sample = "Customer reports intermittent latency on the EU cluster; please check Retry-After headers and connection pooling. ";
const throughput = [1_000, 10_000, 50_000].map((n) => {
  const text = sample.repeat(Math.ceil(n / sample.length)).slice(0, n);
  const reps = 50;
  const t = performance.now();
  for (let i = 0; i < reps; i++) g.scanText(text, { source: "tool_output" });
  const ms = (performance.now() - t) / reps;
  return { chars: n, msPerScan: r3(ms), mbPerSec: r1(n / 1e6 / (ms / 1000)) };
});

const out = { generatedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, runs: RUNS, overheadIterations: K, suites, overhead, throughput };
const dir = fileURLToPath(new URL("./results/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}evals-repeated.json`, JSON.stringify(out, null, 2));

const md = [
  `# Repeated eval runs (${RUNS} runs, ${out.platform}, Node ${process.version})`, "",
  "| suite | cases | passed per run | gate all runs | unstable metrics | wall ms p50 / p95 |", "|---|---|---|---|---|---|",
  ...suites.map((s) => `| ${s.suite} | ${s.cases} | ${s.passedPerRun.join(", ")} | ${s.gatePassedAllRuns ? "yes" : "no"} | ${s.unstableMetrics.join(", ") || "none"} | ${s.wallMs.p50} / ${s.wallMs.p95} |`),
  "", `## Guardrail overhead (${K} interleaved executions per workflow, median)`, "",
  "| workflow | off ms | on ms | Δ ms | Δ % | result bytes |", "|---|---|---|---|---|---|",
  ...overhead.map((o) => `| ${o.workflow} | ${o.p50OffMs} | ${o.p50OnMs} | ${o.deltaMs} | ${o.deltaPct} | ${o.resultBytes} |`),
  "", "## Detector throughput", "", "| chars | ms / scan | MB/s |", "|---|---|---|",
  ...throughput.map((t) => `| ${t.chars} | ${t.msPerScan} | ${t.mbPerSec} |`), "",
].join("\n");
writeFileSync(`${dir}evals-repeated.md`, md);
console.log(md);
