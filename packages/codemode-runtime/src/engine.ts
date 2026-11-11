import type { ApprovalService, AuditLog, IdempotencyStore, PolicyEngine, RateLimiter } from "@sfcm/governance";
import { GatewayError, type Guardrails, capResult, jsonByteLength, randomId, redactValue, toSafeError, type ErrorCode } from "@sfcm/security";
import type { MetricsCollector, OtlpTraceExporter } from "@sfcm/observability";
import { nowIso, type ExecutionOutcome, type Principal } from "@sfcm/shared-types";
import type { SalesforceApi } from "@sfcm/salesforce-client";
import { ExecutionSession, type Adapters, type ToolRegistry } from "@sfcm/tool-registry";
import { describeCapabilities, type DiscoveryOptions } from "./discovery";
import type { Executor, ResolvedProvider } from "./executor-types";
import { prepareCode } from "./prepare";

export interface EngineDeps {
  registry: ToolRegistry;
  executor: Executor;
  governance: { policy: PolicyEngine; approvals: ApprovalService; audit: AuditLog; rateLimiter: RateLimiter; idempotency: IdempotencyStore };
  metrics?: MetricsCollector;
  /** Prompt-injection guardrails applied at the tool checkpoint and to the final result. */
  guardrails?: Guardrails;
  /** Optional OpenTelemetry (OTLP) exporter. */
  telemetry?: OtlpTraceExporter;
  /** Free-form label of the sandbox technology, shown in execution metadata. */
  runtimeName: string;
}

export interface ExecuteRequest {
  code: string;
  principal: Principal;
  sf: SalesforceApi;
  adapters?: Adapters;
  /** Capability references (tool names) this execution may use. Omit for "everything I am authorized for". */
  capabilities?: string[];
  /** Free-form execution context from the caller; recorded in audit, never executed. */
  context?: Record<string, unknown>;
  /** Incoming W3C traceparent, so gateway spans join the caller's (agent's) trace. */
  traceparent?: string;
}

const CODE_RE = /^\[([a-z_]+)\]\s*/;

export class CodeModeEngine {
  constructor(private readonly d: EngineDeps) {}

  private newSession(req: Pick<ExecuteRequest, "principal" | "sf" | "adapters" | "capabilities">, executionId: string) {
    return new ExecutionSession({
      executionId,
      principal: req.principal,
      sf: req.sf,
      registry: this.d.registry,
      governance: this.d.governance,
      adapters: req.adapters,
      allowedTools: req.capabilities,
      guardrails: this.d.guardrails,
    });
  }

  /** discover_capabilities: only tools this principal may call, with schemas, TS types and examples. */
  async discover(req: Pick<ExecuteRequest, "principal" | "sf" | "adapters">, opts: DiscoveryOptions = {}) {
    const session = this.newSession(req, "discover");
    const out = describeCapabilities(session.visibleTools(), opts, { mode: req.sf.mode, policy: this.d.governance.policy.policy, principal: req.principal });
    await this.d.governance.audit.append({ action: "discover", userId: req.principal.userId, outcome: "success", detail: { returned: out.capabilityCount, filter: opts } });
    return out;
  }

  /** execute_code */
  async execute(req: ExecuteRequest): Promise<ExecutionOutcome> {
    const policy = this.d.governance.policy.policy;
    const executionId = randomId("exe", 9);
    const startedAt = nowIso();
    const t0 = Date.now();
    const session = this.newSession(req, executionId);
    const logs: string[] = [];
    let codeBytes = 0;

    const build = (partial: { ok: boolean; result?: unknown; error?: { code: ErrorCode | string; message: string }; truncated?: boolean; resultBytes?: number }): ExecutionOutcome => ({
      ok: partial.ok,
      ...(partial.ok ? { result: partial.result } : {}),
      ...(partial.error ? { error: { ...partial.error, ...(session.pendingApprovals[0] && partial.error.code === "approval_required" ? { approvalId: session.pendingApprovals[0] } : {}) } } : {}),
      logs,
      trace: session.trace,
      pendingApprovals: [...new Set(session.pendingApprovals)],
      metadata: {
        executionId, mode: req.sf.mode, userId: req.principal.userId, startedAt, durationMs: Date.now() - t0,
        toolCalls: session.toolCalls, salesforceApiCalls: session.salesforceApiCalls, recordsReturned: session.recordsReturned, redactions: session.redactions,
        resultBytes: partial.resultBytes ?? 0, truncated: partial.truncated ?? false, runtime: this.d.runtimeName,
        ...(session.guard?.summary() ? { guardrails: session.guard.summary() } : {}),
      },
    });

    const finalize = async (o: ExecutionOutcome): Promise<ExecutionOutcome> => {
      await this.d.governance.audit
        .append({
          action: "execute", userId: req.principal.userId, outcome: o.ok ? "success" : "failure", resource: executionId,
          detail: { mode: o.metadata.mode, durationMs: o.metadata.durationMs, toolCalls: o.metadata.toolCalls, code: o.error?.code, context: req.context ? Object.keys(req.context).slice(0, 10) : undefined },
        })
        .catch(() => undefined);
      await this.d.metrics?.record(o, codeBytes).catch(() => undefined);
      try {
        this.d.telemetry?.exportExecution({ outcome: o, code: req.code, codeBytes, capabilities: req.capabilities, traceparent: req.traceparent });
      } catch {
        /* telemetry must never affect execution */
      }
      return o;
    };

    try {
      await this.d.governance.rateLimiter.check(`exec:${req.principal.userId}`, policy.executionsPerMinute);
      const prepared = prepareCode(req.code, { maxBytes: policy.maxCodeBytes });
      codeBytes = prepared.bytes;

      const visible = session.visibleTools();
      const byNs = new Map<string, ResolvedProvider>();
      for (const t of visible) {
        const p = byNs.get(t.namespace) ?? { name: t.namespace, fns: {} };
        p.fns[t.name] = async (input: unknown) => {
          try {
            return await session.call(t.name, input);
          } catch (e) {
            const s = toSafeError(e);
            throw new Error(`[${s.code}] ${s.message}`);
          }
        };
        byNs.set(t.namespace, p);
      }

      const exec = await withTimeout(this.d.executor.execute(prepared.code, [...byNs.values()]), policy.timeoutMs + 1000);
      logs.push(...(exec.logs ?? []).slice(0, 200));

      if (exec.error !== undefined) {
        const m = CODE_RE.exec(exec.error);
        const code: ErrorCode = m ? (m[1] as ErrorCode) : /timed out/i.test(exec.error) ? "timeout" : "execution_error";
        return finalize(build({ ok: false, error: { code, message: exec.error.replace(CODE_RE, "") } }));
      }

      // Final result: JSON-normalise, redact again (code may have concatenated sensitive text), then cap.
      const json = JSON.parse(JSON.stringify(exec.result ?? null)) as unknown;
      const red = redactValue(json);
      session.redactions += red.redactions;
      let finalValue = red.value;
      if (session.guard) {
        // Outbound check: the program may have concatenated record text or built links (e.g. markdown-image exfiltration).
        const insp = session.guard.guard.inspect(finalValue, { source: "result" });
        session.guard.findings.push(...insp.findings);
        if (insp.blocked) return finalize(build({ ok: false, error: { code: "policy_violation", message: "Result withheld: it contains content blocked by prompt-injection policy." } }));
        finalValue = insp.value;
      }
      const capped = capResult(finalValue, policy.maxResultBytes);
      return finalize(build({ ok: true, result: capped.value, truncated: capped.truncated, resultBytes: jsonByteLength(capped.value) }));
    } catch (e) {
      const s = toSafeError(e);
      return finalize(build({ ok: false, error: { code: s.code, message: s.message } }));
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new GatewayError("timeout", `Execution exceeded ${ms}ms.`, 504)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}
