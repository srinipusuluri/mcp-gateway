import { z } from "zod";
import { generateTypeScriptApi, toolSignature, zodToTs, type AnyTool } from "@sfcm/tool-registry";
import type { ExecutionPolicy } from "@sfcm/governance";
import type { ExecutionMode, Principal } from "@sfcm/shared-types";

export interface DiscoveryOptions {
  domain?: string;
  search?: string;
  tool?: string;
  includeTypeScript?: boolean;
  /** summary (default): compact list + one combined TypeScript block. full: also per-tool JSON Schema, signature and examples. */
  detail?: "summary" | "full";
}

export interface CapabilityDescriptor {
  name: string;
  call: string;
  namespace: string;
  title: string;
  description: string;
  domain: string;
  kind: "read" | "write";
  requiresApproval: boolean;
  permission: string;
  availability: "live" | "mock-only";
  availableNow: boolean;
  notes?: string;
  inputSchema?: unknown;
  typescript?: string;
  examples?: string[];
  example?: string;
}

export function describeCapabilities(tools: AnyTool[], opts: DiscoveryOptions, ctx: { mode: ExecutionMode; policy: ExecutionPolicy; principal: Principal }) {
  const q = opts.search?.toLowerCase();
  const selected = tools.filter(
    (t) => (!opts.domain || t.domain === opts.domain) && (!opts.tool || t.name === opts.tool) && (!q || `${t.name} ${t.title} ${t.description}`.toLowerCase().includes(q)),
  );
  const full = opts.detail === "full" || !!opts.tool;
  const capabilities: CapabilityDescriptor[] = selected.map((t) => ({
    name: t.name,
    call: `${t.namespace}.${t.name}`,
    namespace: t.namespace,
    title: t.title,
    description: t.description,
    domain: t.domain,
    kind: t.kind,
    requiresApproval: t.kind === "write" && ctx.policy.writesRequireApproval,
    permission: t.permission,
    availability: t.availability,
    // mock-only tools work only while a mock adapter is configured (mode === "mock") unless a live adapter was supplied.
    availableNow: t.availability === "live" || ctx.mode === "mock",
    notes: t.notes,
    ...(full
      ? { inputSchema: z.toJSONSchema(t.input, { io: "input", unrepresentable: "any", target: "draft-7" }), typescript: toolSignature(t), examples: t.examples }
      : { example: t.examples[0] }),
  }));
  return {
    mode: ctx.mode,
    modeNote: ctx.mode === "mock" ? "MOCK: data comes from the built-in mock Salesforce org, not a live org." : "LIVE: data comes from the connected Salesforce org with your user-scoped permissions.",
    user: { userId: ctx.principal.userId, roles: ctx.principal.roles },
    capabilityCount: capabilities.length,
    capabilities,
    ...(opts.includeTypeScript === false ? {} : { typescript: generateTypeScriptApi(selected) }),
    executionLimits: {
      maxCodeBytes: ctx.policy.maxCodeBytes,
      timeoutMs: ctx.policy.timeoutMs,
      maxResultBytes: ctx.policy.maxResultBytes,
      maxRecordsPerCall: ctx.policy.maxRecordsPerQuery,
      maxToolCallsPerExecution: ctx.policy.maxToolCallsPerExecution,
      maxSalesforceApiCallsPerExecution: ctx.policy.maxSalesforceApiCallsPerExecution,
      writesRequireApproval: ctx.policy.writesRequireApproval,
    },
    usage: [
      "Write ONE async arrow function: `async () => { ... return result; }`. TypeScript syntax is accepted.",
      "Call APIs as `await sf.<tool>({...})` (and `netsuite.<tool>` for NetSuite). Use Promise.all for independent calls.",
      "Paginate with `limit`/`offset` while `hasMore` is true. Aggregate inside the code and return a compact JSON result.",
      "There is no fetch, no filesystem, no process, no imports. Only the listed APIs exist.",
      "Writes (createCase/updateCase/...) return an approval_required error with an approvalId; a human approves it, then re-run the same code.",
    ],
  };
}

export { zodToTs };
