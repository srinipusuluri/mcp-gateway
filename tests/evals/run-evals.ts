/**
 * npm run evals [-- --suite tools,agent,rag,guardrails,llm] [--no-export]
 *
 * Writes tests/evals/results/evals.{json,md}. Exits 1 when a deterministic gate fails.
 * With OTEL_EXPORTER_OTLP_ENDPOINT set, the run is also exported as spans (Phoenix / Langfuse / Jaeger).
 * With ANTHROPIC_API_KEY set, the LLM suites run (live code generation + LLM judge); they cost money.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ClaudeJudge, exportEvalReport, toMarkdown, type EvalCaseResult, type EvalReport, type SuiteSummary } from "@sfcm/evals";
import { OtlpTraceExporter, otelConfigFromEnv } from "@sfcm/observability";
import { runAgentSuite, runGuardrailSuite, runLlmSuite, runRagSuite, runToolSuite } from "./suites";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const wanted = new Set((arg("suite") ?? "tools,agent,rag,guardrails,llm").split(","));
const started = Date.now();
const judge = wanted.has("llm") ? ClaudeJudge.fromEnv() : undefined;

const suites: SuiteSummary[] = [];
const cases: EvalCaseResult[] = [];
const add = (r: { summary: SuiteSummary; cases: EvalCaseResult[] }) => {
  suites.push(r.summary);
  cases.push(...r.cases);
  const s = r.summary;
  console.log(`${s.skipped ? "⏭ " : s.gatePassed ? "✅" : "❌"} ${s.suite.padEnd(14)} ${s.skipped ?? `${s.passed}/${s.cases} passed  ${Object.entries(s.metrics).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(" ")}`}`);
};

if (wanted.has("tools")) add(await runToolSuite());
if (wanted.has("agent")) add(await runAgentSuite());
if (wanted.has("rag")) {
  const r = await runRagSuite(judge);
  add(r);
  if (judge && r.judged?.length) {
    const { summarize } = await import("@sfcm/evals");
    add({ summary: summarize("llm-judge-rag", "llm", r.judged, { judgeFaithfulness: 0.8 }), cases: r.judged });
  }
}
if (wanted.has("guardrails")) add(await runGuardrailSuite());
if (wanted.has("llm")) add(await runLlmSuite({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.EVAL_AGENT_MODEL ?? "claude-opus-5-5", judge }));

const report: EvalReport = {
  generatedAt: new Date().toISOString(),
  gateway: { mode: "mock", runtime: "quickjs-wasm" },
  judge: judge ? { model: judge.model } : undefined,
  suites,
  cases,
};

const dir = fileURLToPath(new URL("./results/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}evals.json`, JSON.stringify(report, null, 2));
writeFileSync(`${dir}evals.md`, toMarkdown(report));
console.log(`\nWrote ${dir}evals.json and evals.md${judge ? ` (judge usage: ${JSON.stringify(judge.usage)})` : ""}`);

const otel = otelConfigFromEnv(process.env);
if (otel && !process.argv.includes("--no-export")) {
  const exporter = new OtlpTraceExporter({ ...otel, serviceName: `${otel.serviceName}-evals` });
  await exportEvalReport(exporter, report, started, Date.now());
  console.log(`Exported eval spans to ${new URL(otel.endpoint).host}: ${JSON.stringify(exporter.exported)}`);
}

const failed = suites.filter((s) => s.kind === "deterministic" && !s.skipped && !s.gatePassed);
if (failed.length) {
  console.error(`\nGate failed: ${failed.map((s) => s.suite).join(", ")}`);
  process.exit(1);
}
