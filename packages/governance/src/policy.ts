import { z } from "zod";
import type { Principal, ToolKind } from "@sfcm/shared-types";
import { GatewayError } from "@sfcm/security";
import { can, type Permission } from "./rbac";

export const ExecutionPolicySchema = z.object({
  maxCodeBytes: z.number().int().positive().default(20_000),
  timeoutMs: z.number().int().positive().max(120_000).default(15_000),
  maxResultBytes: z.number().int().positive().default(100_000),
  maxRecordsPerQuery: z.number().int().positive().default(200),
  maxToolCallsPerExecution: z.number().int().positive().default(100),
  maxSalesforceApiCallsPerExecution: z.number().int().positive().default(50),
  maxMemoryBytes: z.number().int().positive().default(64 * 1024 * 1024),
  /** CPU-time cap per sandbox (Dynamic Worker `limits.cpuMs`). This, not the wall-clock timeout, stops synchronous infinite loops. */
  maxCpuMs: z.number().int().positive().max(30_000).default(1000),
  writesRequireApproval: z.boolean().default(true),
  /** Four-eyes: the requester may not approve their own request. */
  allowSelfApproval: z.boolean().default(false),
  approvalTtlMs: z.number().int().positive().default(60 * 60 * 1000),
  executionsPerMinute: z.number().int().positive().default(30),
  toolCallsPerMinute: z.number().int().positive().default(600),
  /** If set, only these tools can ever run (global allowlist). */
  toolAllowlist: z.array(z.string()).optional(),
  /** Writes are disabled entirely unless this is true (defense in depth for first rollout). */
  writesEnabled: z.boolean().default(true),
  approvedAgents: z.array(z.string()).default(["Service_Triage_Agent", "Sales_Coach_Agent"]),
});
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

export function defaultPolicy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return ExecutionPolicySchema.parse(overrides);
}

export interface ToolPolicyInput {
  name: string;
  kind: ToolKind;
  permission: Permission;
}

export class PolicyEngine {
  constructor(readonly policy: ExecutionPolicy) {}

  /** Throws unless this principal may invoke this tool at all. */
  authorizeTool(principal: Principal, tool: ToolPolicyInput): void {
    if (this.policy.toolAllowlist && !this.policy.toolAllowlist.includes(tool.name)) {
      throw new GatewayError("tool_not_allowed", `Tool '${tool.name}' is not on the gateway allowlist.`, 403);
    }
    if (tool.kind === "write" && !this.policy.writesEnabled) {
      throw new GatewayError("policy_violation", "Write operations are disabled by execution policy.", 403);
    }
    if (!can(principal, tool.permission)) {
      throw new GatewayError("tool_not_allowed", `Role(s) [${principal.roles.join(", ")}] may not use '${tool.name}' (needs '${tool.permission}').`, 403);
    }
  }

  requiresApproval(tool: ToolPolicyInput): boolean {
    return tool.kind === "write" && this.policy.writesRequireApproval;
  }

  clampLimit(requested: number | undefined): number {
    const max = this.policy.maxRecordsPerQuery;
    return Math.min(Math.max(requested ?? 50, 1), max);
  }
}
