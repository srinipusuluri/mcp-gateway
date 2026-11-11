/** Shared domain types used across every @sfcm package. */

export type Role = "viewer" | "analyst" | "sales_rep" | "service_agent" | "approver" | "admin";

export const ALL_ROLES: readonly Role[] = ["viewer", "analyst", "sales_rep", "service_agent", "approver", "admin"];

/** The authenticated caller. Produced by gateway authentication, never by sandbox code. */
export interface Principal {
  userId: string;
  email?: string;
  displayName?: string;
  roles: Role[];
  /** Salesforce user id this principal maps to (user-scoped OAuth). */
  salesforceUserId?: string;
}

export type ToolKind = "read" | "write";

export type CloudDomain = "sales" | "service" | "cpq" | "datacloud" | "metadata" | "agentforce" | "external";

/**
 * Honest availability flag:
 * - live:      implemented against real Salesforce APIs (also works against the mock)
 * - mock-only: implemented only against the mock adapter; a live adapter must be supplied
 */
export type Availability = "live" | "mock-only";

export type ExecutionMode = "mock" | "live";

export interface ToolCallRecord {
  seq: number;
  tool: string;
  kind: ToolKind;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  recordsReturned?: number;
  salesforceApiCalls: number;
  redactions: number;
}

export interface ExecutionMetadata {
  executionId: string;
  mode: ExecutionMode;
  userId: string;
  startedAt: string;
  durationMs: number;
  toolCalls: number;
  salesforceApiCalls: number;
  recordsReturned: number;
  redactions: number;
  resultBytes: number;
  truncated: boolean;
  runtime: string;
}

export interface ExecutionOutcome {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; approvalId?: string };
  logs: string[];
  trace: ToolCallRecord[];
  /** Approval ids created during this execution (writes awaiting a human decision). */
  pendingApprovals: string[];
  metadata: ExecutionMetadata;
}

export type AuditAction =
  | "auth.success"
  | "auth.failure"
  | "discover"
  | "execute"
  | "tool.invoke"
  | "tool.denied"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "approval.consumed"
  | "ratelimit.exceeded"
  | "policy.violation";

export interface AuditEvent {
  id: string;
  ts: string;
  action: AuditAction;
  userId: string;
  outcome: "success" | "failure" | "denied";
  resource?: string;
  detail?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed" | "expired";

export interface ApprovalRequest {
  id: string;
  /** Hash binding (tool, args, requester); an approval only authorizes this exact call. */
  fingerprint: string;
  tool: string;
  args: unknown;
  requestedBy: string;
  requestedAt: string;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  expiresAt: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}
