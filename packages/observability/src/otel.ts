/**
 * Dependency-free OpenTelemetry trace export (OTLP/HTTP JSON) for the gateway.
 *
 * Why not the OTel JS SDK: the gateway runs inside a Cloudflare Durable Object and in Node tests; the SDK's
 * Node exporters and async-context machinery don't fit the Workers runtime. Executions already carry a
 * precise trace (per tool call start + duration), so spans are built after the fact and POSTed once.
 *
 * Span attributes follow two open conventions so any open-source backend can read them:
 *   - OpenTelemetry GenAI semantic conventions  (gen_ai.operation.name, gen_ai.tool.name, ...)
 *   - OpenInference (Arize Phoenix)             (openinference.span.kind, tool.name, input.value, ...)
 * Langfuse, Phoenix, Jaeger, Grafana Tempo, SigNoz, Zipkin (via collector) all ingest OTLP.
 *
 * Privacy: by default spans carry only metadata (counts, durations, tool names, error codes, guardrail
 * categories). Generated code and (redacted) results are attached ONLY when OTEL_CAPTURE_CONTENT=true.
 */
import type { ExecutionOutcome } from "@sfcm/shared-types";

export interface OtelConfig {
  /** Full traces URL, e.g. http://localhost:4318/v1/traces */
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
  environment?: string;
  /** Attach code and results to spans (redacted by the gateway first). Default false. */
  captureContent: boolean;
  /** 0..1 head sampling for successful executions; failures and guardrail hits are always kept. */
  sampleRatio: number;
  timeoutMs: number;
}

type Env = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Standard OTEL_* environment variables. Returns undefined when tracing is not configured. */
export function otelConfigFromEnv(env: Env): OtelConfig | undefined {
  const explicit = str(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const base = str(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const endpoint = explicit ?? (base ? `${base.replace(/\/+$/, "")}/v1/traces` : undefined);
  if (!endpoint || str(env.OTEL_SDK_DISABLED) === "true") return undefined;
  const headers: Record<string, string> = {};
  for (const part of (str(env.OTEL_EXPORTER_OTLP_HEADERS) ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) headers[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim());
  }
  const ratio = Number(str(env.OTEL_TRACES_SAMPLER_ARG) ?? "1");
  return {
    endpoint,
    headers,
    serviceName: str(env.OTEL_SERVICE_NAME) ?? "salesforce-codemode-gateway",
    environment: str(env.OTEL_DEPLOYMENT_ENVIRONMENT),
    captureContent: str(env.OTEL_CAPTURE_CONTENT) === "true",
    sampleRatio: Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 1,
    timeoutMs: 3000,
  };
}

// ---- OTLP JSON shapes -------------------------------------------------------------------------
type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: AnyValue[] } };
export interface KeyValue { key: string; value: AnyValue }
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number; // 1 INTERNAL, 2 SERVER, 3 CLIENT
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  events?: Array<{ name: string; timeUnixNano: string; attributes: KeyValue[] }>;
  status: { code: number; message?: string }; // 0 unset, 1 ok, 2 error
}

function toValue(v: unknown): AnyValue | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue).filter((x): x is AnyValue => !!x) } };
  return { stringValue: JSON.stringify(v) };
}

export function attrs(o: Record<string, unknown>): KeyValue[] {
  return Object.entries(o).flatMap(([key, v]) => {
    const value = toValue(v);
    return value ? [{ key, value }] : [];
  });
}

const hex = (bytes: number) => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};
export const newTraceId = () => hex(16);
export const newSpanId = () => hex(8);
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

/** W3C traceparent: 00-<32 hex trace>-<16 hex span>-<flags> */
export function parseTraceparent(h: string | null | undefined): { traceId: string; spanId: string; sampled: boolean } | undefined {
  const m = h?.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/);
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return undefined;
  return { traceId: m[1]!, spanId: m[2]!, sampled: (parseInt(m[3]!, 16) & 1) === 1 };
}

export interface ExecutionSpanInput {
  outcome: ExecutionOutcome;
  code?: string;
  codeBytes: number;
  capabilities?: string[];
  /** Incoming W3C trace context (MCP client / agent span), so gateway spans nest under the agent's trace. */
  traceparent?: string;
}

/** Build the span tree for one execute_code call: CHAIN root + one TOOL span per sandbox->host call. */
export function executionSpans(input: ExecutionSpanInput, cfg: Pick<OtelConfig, "captureContent">): OtlpSpan[] {
  const { outcome: o } = input;
  const m = o.metadata;
  const parent = parseTraceparent(input.traceparent);
  const traceId = parent?.traceId ?? newTraceId();
  const rootId = newSpanId();
  const start = Date.parse(m.startedAt);
  const g = m.guardrails;

  const root: OtlpSpan = {
    traceId,
    spanId: rootId,
    parentSpanId: parent?.spanId,
    name: "execute_code",
    kind: 2,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(start + m.durationMs),
    attributes: attrs({
      "openinference.span.kind": "CHAIN",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "execute_code",
      "gen_ai.tool.type": "function",
      "mcp.method.name": "tools/call",
      "codemode.execution_id": m.executionId,
      "codemode.mode": m.mode,
      "codemode.runtime": m.runtime,
      "codemode.tool_calls": m.toolCalls,
      "codemode.salesforce_api_calls": m.salesforceApiCalls,
      "codemode.records_returned": m.recordsReturned,
      "codemode.redactions": m.redactions,
      "codemode.result_bytes": m.resultBytes,
      "codemode.code_bytes": input.codeBytes,
      "codemode.truncated": m.truncated,
      "codemode.capabilities": input.capabilities,
      "codemode.pending_approvals": o.pendingApprovals.length,
      "enduser.id": m.userId,
      "error.type": o.error?.code,
      "guardrail.findings": g?.findings ?? 0,
      "guardrail.categories": g ? Object.keys(g.byCategory) : undefined,
      "guardrail.max_severity": g?.maxSeverity,
      "guardrail.tainted": g?.tainted,
      "guardrail.blocked_writes": g?.blockedWrites,
      "guardrail.sanitized_fields": g?.sanitizedFields,
      ...(cfg.captureContent
        ? { "input.value": input.code, "input.mime_type": "text/plain", "output.value": JSON.stringify(o.ok ? o.result : o.error)?.slice(0, 32_000), "output.mime_type": "application/json" }
        : {}),
    }),
    events: g?.details.slice(0, 20).map((f) => ({
      name: "guardrail.finding",
      timeUnixNano: nanos(start + m.durationMs),
      attributes: attrs({ "guardrail.rule_id": f.ruleId, "guardrail.category": f.category, "guardrail.severity": f.severity, "guardrail.action": f.action, "guardrail.source": f.source, "gen_ai.tool.name": f.tool, "guardrail.path": f.path }),
    })),
    status: o.ok ? { code: 1 } : o.error?.code === "approval_required" ? { code: 0, message: "approval_required" } : { code: 2, message: o.error?.code },
  };

  const tools: OtlpSpan[] = o.trace.map((t) => {
    const s = Date.parse(t.startedAt);
    return {
      traceId,
      spanId: newSpanId(),
      parentSpanId: rootId,
      name: `${t.kind === "write" ? "write" : "read"} ${t.tool}`,
      kind: 3,
      startTimeUnixNano: nanos(s),
      endTimeUnixNano: nanos(s + t.durationMs),
      attributes: attrs({
        "openinference.span.kind": "TOOL",
        "tool.name": t.tool,
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": t.tool,
        "gen_ai.tool.type": "function",
        "gen_ai.tool.call.id": `${m.executionId}:${t.seq}`,
        "codemode.tool.kind": t.kind,
        "codemode.tool.seq": t.seq,
        "codemode.salesforce_api_calls": t.salesforceApiCalls,
        "codemode.records_returned": t.recordsReturned,
        "codemode.redactions": t.redactions,
        "error.type": t.error,
      }),
      status: t.ok ? { code: 1 } : t.error === "approval_required" ? { code: 0, message: "approval_required" } : { code: 2, message: t.error },
    };
  });
  return [root, ...tools];
}

export function otlpPayload(spans: OtlpSpan[], cfg: Pick<OtelConfig, "serviceName" | "environment">, scope = "sfcm.gateway") {
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs({ "service.name": cfg.serviceName, "service.version": "0.1.0", "deployment.environment.name": cfg.environment, "telemetry.sdk.name": "sfcm-otlp-lite", "telemetry.sdk.language": "webjs" }) },
        scopeSpans: [{ scope: { name: scope, version: "0.1.0" }, spans }],
      },
    ],
  };
}

/** Sends spans to an OTLP/HTTP endpoint. Export never throws and never blocks an execution result for long. */
export class OtlpTraceExporter {
  readonly exported: { batches: number; spans: number; failures: number } = { batches: 0, spans: 0, failures: 0 };
  private readonly pending = new Set<Promise<void>>();

  constructor(readonly cfg: OtelConfig, private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  shouldSample(o: ExecutionOutcome): boolean {
    if (!o.ok || o.metadata.guardrails) return true;
    return Math.random() < this.cfg.sampleRatio;
  }

  exportExecution(input: ExecutionSpanInput): void {
    if (!this.shouldSample(input.outcome)) return;
    this.send(executionSpans(input, this.cfg));
  }

  /** Fire-and-forget; call flush() to await (tests, scripts, waitUntil). */
  send(spans: OtlpSpan[], scope?: string): void {
    const p = this.post(otlpPayload(spans, this.cfg, scope), spans.length).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private async post(body: unknown, n: number): Promise<void> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(this.cfg.endpoint, { method: "POST", headers: { "content-type": "application/json", ...this.cfg.headers }, body: JSON.stringify(body), signal: ctl.signal });
      if (!res.ok) throw new Error(`OTLP ${res.status}`);
      this.exported.batches++;
      this.exported.spans += n;
    } catch {
      this.exported.failures++;
    } finally {
      clearTimeout(t);
    }
  }
}
