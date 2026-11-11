export * from "./otel";
import type { ExecutionOutcome, ToolCallRecord } from "@sfcm/shared-types";
import type { StateStore } from "@sfcm/governance";

export interface ExecutionRecord {
  executionId: string;
  ts: string;
  userId: string;
  mode: "mock" | "live";
  ok: boolean;
  errorCode?: string;
  durationMs: number;
  toolCalls: number;
  salesforceApiCalls: number;
  recordsReturned: number;
  resultBytes: number;
  truncated: boolean;
  codeBytes: number;
  runtime: string;
  trace: ToolCallRecord[];
  guardrailFindings?: number;
  guardrailCategories?: string[];
  guardrailTainted?: boolean;
  guardrailBlockedWrites?: number;
}

export interface MetricsSnapshot {
  totalExecutions: number;
  failedExecutions: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalToolCalls: number;
  totalSalesforceApiCalls: number;
  totalRecordsReturned: number;
  perTool: Array<{ tool: string; calls: number; errors: number; avgMs: number; maxMs: number; sfApiCalls: number }>;
  errorsByCode: Record<string, number>;
  /** Estimated: code + result bytes / 4. Real token usage is only available from the model provider. */
  estimatedTokens: { inputBytesProxy: number; outputBytesProxy: number; note: string };
  /** Salesforce API call count is measured; cost is an illustrative rate card, configurable. */
  estimatedCostUsd: number;
  series: Array<{ ts: string; durationMs: number; ok: boolean; toolCalls: number }>;
  /** Prompt-injection guardrails: executions with findings, tainted executions, blocked writes, findings per category. */
  guardrails: { executionsWithFindings: number; taintedExecutions: number; blockedWrites: number; byCategory: Record<string, number> };
}

const SF_API_CALL_USD = 0; // Salesforce API calls are entitlement-based, not metered per call.
const COMPUTE_USD_PER_MS = 0.00000002; // illustrative Workers CPU price proxy

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(idx, 0)] ?? 0;
}

export class MetricsCollector {
  constructor(private readonly store: StateStore, private readonly maxRecords = 500) {}

  async record(outcome: ExecutionOutcome, codeBytes: number): Promise<void> {
    const m = outcome.metadata;
    const rec: ExecutionRecord = {
      executionId: m.executionId,
      ts: m.startedAt,
      userId: m.userId,
      mode: m.mode,
      ok: outcome.ok,
      errorCode: outcome.error?.code,
      durationMs: m.durationMs,
      toolCalls: m.toolCalls,
      salesforceApiCalls: m.salesforceApiCalls,
      recordsReturned: m.recordsReturned,
      resultBytes: m.resultBytes,
      truncated: m.truncated,
      codeBytes,
      runtime: m.runtime,
      trace: outcome.trace,
      guardrailFindings: m.guardrails?.findings,
      guardrailCategories: m.guardrails ? Object.keys(m.guardrails.byCategory) : undefined,
      guardrailTainted: m.guardrails?.tainted,
      guardrailBlockedWrites: m.guardrails?.blockedWrites,
    };
    await this.store.put(`metrics:x:${m.startedAt}:${m.executionId}`, rec);
    // Retention: drop oldest beyond maxRecords.
    const all = await this.store.list<ExecutionRecord>("metrics:x:");
    for (const row of all.slice(0, Math.max(0, all.length - this.maxRecords))) await this.store.delete(row.key);
  }

  async history(limit = 50): Promise<ExecutionRecord[]> {
    return (await this.store.list<ExecutionRecord>("metrics:x:", { limit, reverse: true })).map((r) => r.value);
  }

  async getExecution(id: string): Promise<ExecutionRecord | undefined> {
    return (await this.history(this.maxRecords)).find((r) => r.executionId === id);
  }

  async snapshot(): Promise<MetricsSnapshot> {
    const recs = (await this.store.list<ExecutionRecord>("metrics:x:")).map((r) => r.value);
    const lat = recs.map((r) => r.durationMs).sort((a, b) => a - b);
    const per = new Map<string, { calls: number; errors: number; total: number; max: number; sf: number }>();
    const errorsByCode: Record<string, number> = {};
    let toolCalls = 0, sf = 0, rows = 0, bytesIn = 0, bytesOut = 0, compute = 0;
    for (const r of recs) {
      toolCalls += r.toolCalls;
      sf += r.salesforceApiCalls;
      rows += r.recordsReturned;
      bytesIn += r.codeBytes;
      bytesOut += r.resultBytes;
      compute += r.durationMs;
      if (!r.ok) errorsByCode[r.errorCode ?? "unknown"] = (errorsByCode[r.errorCode ?? "unknown"] ?? 0) + 1;
      for (const t of r.trace) {
        const e = per.get(t.tool) ?? { calls: 0, errors: 0, total: 0, max: 0, sf: 0 };
        e.calls++;
        if (!t.ok) e.errors++;
        e.total += t.durationMs;
        e.max = Math.max(e.max, t.durationMs);
        e.sf += t.salesforceApiCalls;
        per.set(t.tool, e);
      }
    }
    const guardrails = { executionsWithFindings: 0, taintedExecutions: 0, blockedWrites: 0, byCategory: {} as Record<string, number> };
    for (const r of recs) {
      if (r.guardrailFindings) guardrails.executionsWithFindings++;
      if (r.guardrailTainted) guardrails.taintedExecutions++;
      guardrails.blockedWrites += r.guardrailBlockedWrites ?? 0;
      for (const c of r.guardrailCategories ?? []) guardrails.byCategory[c] = (guardrails.byCategory[c] ?? 0) + 1;
    }
    return {
      guardrails,
      totalExecutions: recs.length,
      failedExecutions: recs.filter((r) => !r.ok).length,
      avgLatencyMs: recs.length ? Math.round(lat.reduce((a, b) => a + b, 0) / recs.length) : 0,
      p95LatencyMs: percentile(lat, 95),
      totalToolCalls: toolCalls,
      totalSalesforceApiCalls: sf,
      totalRecordsReturned: rows,
      perTool: [...per.entries()]
        .map(([tool, e]) => ({ tool, calls: e.calls, errors: e.errors, avgMs: Math.round(e.total / e.calls), maxMs: e.max, sfApiCalls: e.sf }))
        .sort((a, b) => b.calls - a.calls),
      errorsByCode,
      estimatedTokens: {
        inputBytesProxy: bytesIn,
        outputBytesProxy: bytesOut,
        note: "Byte totals of generated code (model output) and results (model input). Divide by ~4 for a rough token estimate; exact usage comes from the model provider.",
      },
      estimatedCostUsd: Number((compute * COMPUTE_USD_PER_MS + sf * SF_API_CALL_USD).toFixed(6)),
      series: recs.slice(-60).map((r) => ({ ts: r.ts, durationMs: r.durationMs, ok: r.ok, toolCalls: r.toolCalls })),
    };
  }
}
