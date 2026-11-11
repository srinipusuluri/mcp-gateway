/**
 * Export eval results as OTLP spans so they appear next to production traces in Phoenix / Langfuse /
 * Jaeger. One root span per run ("eval.run"), one child span per suite, one grandchild per case with
 * the scores as attributes (eval.<metric>), plus OpenInference "EVALUATOR" span kind.
 */
import { attrs, newSpanId, newTraceId, type OtlpSpan, type OtlpTraceExporter } from "@sfcm/observability";
import type { EvalReport } from "./report";

const ns = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

export function evalSpans(report: EvalReport, runStartedMs: number, runEndedMs: number): OtlpSpan[] {
  const traceId = newTraceId();
  const rootId = newSpanId();
  const spans: OtlpSpan[] = [
    {
      traceId, spanId: rootId, name: "eval.run", kind: 1, startTimeUnixNano: ns(runStartedMs), endTimeUnixNano: ns(runEndedMs),
      attributes: attrs({ "openinference.span.kind": "EVALUATOR", "eval.suites": report.suites.length, "eval.cases": report.cases.length, "eval.gate_passed": report.suites.every((s) => s.gatePassed || s.skipped), "eval.judge_model": report.judge?.model, "codemode.mode": report.gateway.mode }),
      status: { code: report.suites.every((s) => s.gatePassed || s.skipped) ? 1 : 2 },
    },
  ];
  for (const s of report.suites) {
    const sid = newSpanId();
    spans.push({
      traceId, spanId: sid, parentSpanId: rootId, name: `eval.suite ${s.suite}`, kind: 1, startTimeUnixNano: ns(runStartedMs), endTimeUnixNano: ns(runEndedMs),
      attributes: attrs({ "openinference.span.kind": "EVALUATOR", "eval.suite": s.suite, "eval.kind": s.kind, "eval.cases": s.cases, "eval.pass_rate": s.passRate, "eval.gate_passed": s.gatePassed, "eval.skipped": s.skipped, ...Object.fromEntries(Object.entries(s.metrics).map(([k, v]) => [`eval.metric.${k}`, v])) }),
      status: { code: s.skipped ? 0 : s.gatePassed ? 1 : 2 },
    });
    for (const c of report.cases.filter((x) => x.suite === s.suite)) {
      spans.push({
        traceId, spanId: newSpanId(), parentSpanId: sid, name: `eval.case ${c.id}`, kind: 1, startTimeUnixNano: ns(runStartedMs), endTimeUnixNano: ns(runStartedMs + (c.latencyMs ?? 0)),
        attributes: attrs({ "openinference.span.kind": "EVALUATOR", "eval.suite": c.suite, "eval.case_id": c.id, "eval.pass": c.pass, "error.type": c.error, ...Object.fromEntries(Object.entries(c.scores).map(([k, v]) => [`eval.score.${k}`, v])) }),
        status: { code: c.pass ? 1 : 2 },
      });
    }
  }
  return spans;
}

export async function exportEvalReport(exporter: OtlpTraceExporter, report: EvalReport, startedMs: number, endedMs: number): Promise<void> {
  exporter.send(evalSpans(report, startedMs, endedMs), "sfcm.evals");
  await exporter.flush();
}
