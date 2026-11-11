/** Errors that are safe to show to callers. Anything else is masked by toSafeError. */
export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_input"
  | "tool_not_found"
  | "tool_not_allowed"
  | "approval_required"
  | "rate_limited"
  | "policy_violation"
  | "code_rejected"
  | "execution_error"
  | "timeout"
  | "result_too_large"
  | "salesforce_error"
  | "not_available"
  | "internal_error";

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface SafeError {
  code: ErrorCode;
  message: string;
  approvalId?: string;
}

/** Convert any thrown value to something that cannot leak stack traces, tokens or internals. */
export function toSafeError(err: unknown): SafeError & { status: number } {
  if (err instanceof GatewayError) {
    const approvalId = typeof err.details?.approvalId === "string" ? err.details.approvalId : undefined;
    return { code: err.code, message: err.message, status: err.status, ...(approvalId ? { approvalId } : {}) };
  }
  return { code: "internal_error", message: "Internal error. See gateway logs with the execution id.", status: 500 };
}
