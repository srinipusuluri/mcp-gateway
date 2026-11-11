import { z } from "zod";
import { SalesforceApiError, SalesforceAuthError, SoqlError, withMeter, type SalesforceApi } from "@sfcm/salesforce-client";
import { GatewayError, GuardrailState, redactValue, type Guardrails } from "@sfcm/security";
import type { ApprovalService, AuditLog, IdempotencyStore, PolicyEngine, RateLimiter } from "@sfcm/governance";
import { nowIso, type Principal, type ToolCallRecord } from "@sfcm/shared-types";
import type { ToolRegistry } from "./registry";
import type { Adapters, AnyTool } from "./types";

export interface GovernanceServices {
  policy: PolicyEngine;
  approvals: ApprovalService;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  idempotency: IdempotencyStore;
}

export interface SessionOptions {
  executionId: string;
  principal: Principal;
  sf: SalesforceApi;
  registry: ToolRegistry;
  governance: GovernanceServices;
  adapters?: Adapters;
  /** If set, only these tools may be called (least-privilege capability references). */
  allowedTools?: string[];
  /** Optional describe-cache shared across sessions (used by the evaluation baseline to model a caching MCP server). */
  sharedCache?: Map<string, unknown>;
  /** Prompt-injection guardrails applied to tool outputs and write inputs. */
  guardrails?: Guardrails;
}

function countRecords(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.records)) return o.records.length;
    if (Array.isArray(o.items)) return o.items.length;
  }
  return 0;
}

function mapError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  if (err instanceof z.ZodError) {
    return new GatewayError("invalid_input", `Invalid input: ${err.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, 400);
  }
  if (err instanceof SoqlError) return new GatewayError("invalid_input", err.message, 400);
  if (err instanceof SalesforceAuthError) return new GatewayError("unauthenticated", err.message, 401);
  if (err instanceof SalesforceApiError) return new GatewayError("salesforce_error", `[${err.errorCode}] ${err.message}`, err.status >= 500 ? 502 : 400);
  return new GatewayError("internal_error", "Tool failed with an internal error.", 500);
}

/**
 * One session per execution. Every sandbox -> host call goes through call(), the single
 * choke point where authorization, validation, approval, limits, redaction and audit happen.
 */
export class ExecutionSession {
  readonly trace: ToolCallRecord[] = [];
  readonly pendingApprovals: string[] = [];
  toolCalls = 0;
  salesforceApiCalls = 0;
  recordsReturned = 0;
  redactions = 0;
  /** Per-execution guardrail findings and taint (undefined when guardrails are not configured). */
  readonly guard?: GuardrailState;
  private readonly allowed?: Set<string>;
  /** Shared across all tool calls of this execution (e.g. describe results). Holds promises. */
  private readonly cache: Map<string, unknown>;

  constructor(private readonly o: SessionOptions) {
    this.allowed = o.allowedTools ? new Set(o.allowedTools) : undefined;
    this.cache = o.sharedCache ?? new Map<string, unknown>();
    if (o.guardrails?.enabled) this.guard = new GuardrailState(o.guardrails);
  }

  private async guardrailEvent(name: string, outcome: "denied" | "success", detail: Record<string, unknown>) {
    await this.o.governance.audit
      .append({ action: "guardrail.triggered", userId: this.o.principal.userId, outcome, resource: name, detail: { executionId: this.o.executionId, ...detail } })
      .catch(() => undefined);
  }

  /** Writes are refused once the execution is tainted, or when their own arguments carry injection text. */
  private async guardWrite(name: string, input: unknown): Promise<void> {
    const guard = this.guard;
    if (!guard || guard.guard.policy.mode !== "enforce") return;
    const p = guard.guard.policy;
    if (p.blockWritesAfterInjection && guard.tainted) {
      guard.blockedWrites++;
      await this.guardrailEvent(name, "denied", { reason: "tainted_execution", taintSource: guard.taintSource });
      throw new GatewayError("policy_violation", `Write '${name}' blocked: this execution read Salesforce text that matched prompt-injection policies (from '${guard.taintSource ?? "a tool"}'). Re-run the write in a separate execution after a human reviews the content.`, 403, { guardrail: "tainted_execution" });
    }
    if (p.scanWriteInputs) {
      const insp = guard.guard.inspect(input, { source: "tool_input", tool: name });
      guard.findings.push(...insp.findings);
      if (guard.guard.isTainting(insp.maxSeverity) || insp.blocked) {
        guard.blockedWrites++;
        await this.guardrailEvent(name, "denied", { reason: "injected_write_input", rules: [...new Set(insp.findings.map((f) => f.ruleId))] });
        throw new GatewayError("policy_violation", `Write '${name}' blocked: its arguments contain text that matches prompt-injection policies (${[...new Set(insp.findings.map((f) => f.category))].join(", ")}).`, 403, { guardrail: "injected_write_input" });
      }
    }
  }

  /** Tools this principal could call in this session (used to build sandbox bindings and discovery). */
  visibleTools(): AnyTool[] {
    return this.o.registry.list((t) => {
      if (this.allowed && !this.allowed.has(t.name)) return false;
      try {
        this.o.governance.policy.authorizeTool(this.o.principal, t);
        return true;
      } catch {
        return false;
      }
    });
  }

  async call(name: string, rawInput: unknown): Promise<unknown> {
    const { principal, registry, governance: g } = this.o;
    const started = Date.now();
    const seq = ++this.toolCalls;
    const tool = registry.get(name);
    const base = { seq, tool: name, kind: tool?.kind ?? ("read" as const), startedAt: nowIso() };
    let meter = { calls: 0 };
    const finish = (ok: boolean, extra: Partial<ToolCallRecord> = {}) => {
      this.trace.push({ ...base, durationMs: Date.now() - started, ok, salesforceApiCalls: meter.calls, redactions: 0, ...extra });
    };

    try {
      if (!tool || (this.allowed && !this.allowed.has(name))) throw new GatewayError("tool_not_found", `Unknown or unauthorized tool '${name}'.`, 404);
      if (seq > g.policy.policy.maxToolCallsPerExecution) throw new GatewayError("policy_violation", "Maximum tool calls per execution exceeded.", 429);
      if (this.salesforceApiCalls >= g.policy.policy.maxSalesforceApiCallsPerExecution) {
        throw new GatewayError("policy_violation", "Salesforce API call budget for this execution is exhausted.", 429);
      }
      try {
        g.policy.authorizeTool(principal, tool);
      } catch (e) {
        await g.audit.append({ action: "tool.denied", userId: principal.userId, outcome: "denied", resource: name, detail: { executionId: this.o.executionId } });
        throw e;
      }
      await g.rateLimiter.check(`tool:${principal.userId}`, g.policy.policy.toolCallsPerMinute);

      const input = tool.input.parse(rawInput ?? {}) as unknown;
      if (tool.kind === "write") await this.guardWrite(name, input);

      let approvalId: string | undefined;
      if (g.policy.requiresApproval(tool)) {
        const consumed = await g.approvals.consumeIfApproved(name, input, principal.userId);
        if (!consumed) {
          const req = await g.approvals.requestOrGet(name, input, principal.userId);
          if (req.status === "pending") {
            await g.audit.append({ action: "approval.requested", userId: principal.userId, outcome: "success", resource: name, detail: { approvalId: req.id } });
          }
          this.pendingApprovals.push(req.id);
          throw new GatewayError("approval_required", `Write '${name}' requires human approval. Approval id: ${req.id}. Re-run after an approver approves it.`, 202, { approvalId: req.id });
        }
        approvalId = consumed.id;
        await g.audit.append({ action: "approval.consumed", userId: principal.userId, outcome: "success", resource: name, detail: { approvalId } });
      }

      meter = { calls: 0 };
      const ctx = { principal, sf: withMeter(this.o.sf, meter), policy: g.policy.policy, adapters: this.o.adapters ?? {}, cache: this.cache };
      const run = () => tool.handler(ctx, input);
      const raw = approvalId ? (await g.idempotency.run(`write:${approvalId}`, run)).value : await run();

      const redacted = redactValue(raw);
      const redactions = redacted.redactions;
      let value = redacted.value;
      this.salesforceApiCalls += meter.calls;
      if (this.guard) {
        // Indirect prompt injection: every string returned by Salesforce is scanned before the sandbox (and model) sees it.
        const insp = this.guard.guard.inspect(value, { source: "tool_output", tool: name });
        this.guard.record(insp, name);
        if (insp.findings.length) {
          await this.guardrailEvent(name, insp.blocked ? "denied" : "success", { findings: insp.findings.length, maxSeverity: insp.maxSeverity, rules: [...new Set(insp.findings.map((f) => f.ruleId))].slice(0, 10) });
        }
        if (insp.blocked) throw new GatewayError("policy_violation", `Result of '${name}' was withheld: it contains content blocked by prompt-injection policy.`, 403, { guardrail: "blocked_output" });
        value = insp.value;
      }
      this.redactions += redactions;
      const n = countRecords(value);
      this.recordsReturned += n;
      finish(true, { recordsReturned: n, redactions });
      await g.audit.append({
        action: "tool.invoke", userId: principal.userId, outcome: "success", resource: name,
        detail: { executionId: this.o.executionId, kind: tool.kind, durationMs: Date.now() - started, records: n, sfApiCalls: meter.calls, redactions },
      });
      return value;
    } catch (e) {
      this.salesforceApiCalls += meter.calls;
      const ge = mapError(e);
      finish(false, { error: ge.code });
      if (ge.code !== "approval_required" && ge.code !== "tool_not_allowed") {
        await g.audit.append({ action: "tool.invoke", userId: principal.userId, outcome: "failure", resource: name, detail: { executionId: this.o.executionId, code: ge.code } }).catch(() => undefined);
      }
      throw ge;
    }
  }
}
