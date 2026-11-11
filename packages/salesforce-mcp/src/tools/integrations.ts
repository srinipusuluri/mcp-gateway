import { z } from "zod";
import { GatewayError } from "@sfcm/security";
import { defineTool } from "@sfcm/tool-registry";
import { needAdapter } from "../adapters/types";
import { listRecords, rec, sfId } from "../helpers";

const Profile = z.object({
  unifiedId: z.string(), accountId: z.string().optional(), fullName: z.string(), email: z.string().optional(), lifetimeValue: z.number(), churnRisk: z.number().describe("0..1"),
  engagementScore: z.number().describe("0..100"), preferredChannel: z.string(), segments: z.array(z.string()), lastPurchaseDate: z.string().optional(), openSupportTickets: z.number(),
});
const agentName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/);

/** Sharing enforcement for adapter data: keep only profiles whose Account the user can see in Salesforce. */
async function visibleAccountIds(ctx: Parameters<typeof listRecords>[0], ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const r = await listRecords(ctx, { object: "Account", defaultFields: ["Id"], where: [{ field: "Id", op: "IN", value: [...new Set(ids)].slice(0, 200) }], limit: 200, offset: 0 });
  return new Set(r.records.map((x) => String(x.Id)));
}

export const dataCloudTools = [
  defineTool({
    name: "searchCustomerProfiles", title: "Search customer profiles", domain: "datacloud", namespace: "sf", kind: "read", permission: "sf.read.datacloud", availability: "mock-only",
    notes: "Requires a Data Cloud adapter (Data Cloud Query/Profile APIs). Results are filtered to Accounts the user can see in Salesforce.",
    description: "Search Data Cloud unified individual profiles by name or email.",
    input: z.object({ query: z.string().trim().min(2).max(100), limit: z.number().int().min(1).max(50).default(10) }),
    output: z.object({ profiles: z.array(Profile), count: z.number(), source: z.enum(["mock", "live"]) }),
    examples: ["await sf.searchCustomerProfiles({ query: 'Dana' })"],
    handler: async (ctx, i) => {
      const dc = needAdapter(ctx, "dataCloud", "Data Cloud");
      const found = await dc.searchProfiles(i.query, i.limit * 3);
      const ok = await visibleAccountIds(ctx, found.flatMap((p) => (p.accountId ? [p.accountId] : [])));
      const profiles = found.filter((p) => !p.accountId || ok.has(p.accountId)).slice(0, i.limit);
      return { profiles, count: profiles.length, source: dc.kind };
    },
  }),
  defineTool({
    name: "retrieveUnifiedProfile", title: "Unified profile", domain: "datacloud", namespace: "sf", kind: "read", permission: "sf.read.datacloud", availability: "mock-only",
    notes: "Requires a Data Cloud adapter.",
    description: "Retrieve one unified profile by unifiedId, email or accountId (first match).",
    input: z.object({ unifiedId: z.string().max(60).optional(), email: z.string().email().optional(), accountId: sfId.optional() }).refine((v) => v.unifiedId || v.email || v.accountId, "provide unifiedId, email or accountId"),
    output: z.object({ profile: Profile.nullable(), source: z.enum(["mock", "live"]) }),
    examples: ["await sf.retrieveUnifiedProfile({ accountId })"],
    handler: async (ctx, i) => {
      const dc = needAdapter(ctx, "dataCloud", "Data Cloud");
      const p = await dc.getProfile(i);
      if (p?.accountId && !(await visibleAccountIds(ctx, [p.accountId])).has(p.accountId)) return { profile: null, source: dc.kind };
      return { profile: p, source: dc.kind };
    },
  }),
  defineTool({
    name: "queryApprovedDataCloudSources", title: "Query approved Data Cloud sources", domain: "datacloud", namespace: "sf", kind: "read", permission: "sf.read.datacloud", availability: "mock-only",
    notes: "Only sources on the approved list can be queried; filters are equality-only.",
    description: "Query an approved Data Cloud data source with equality filters. Arbitrary SQL is intentionally not supported.",
    input: z.object({ source: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,60}$/), filters: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,60}$/), z.union([z.string().max(200), z.number(), z.boolean()])).default({}), limit: z.number().int().min(1).max(200).default(25) }),
    output: z.object({ rows: z.array(z.record(z.string(), z.unknown())), count: z.number(), approvedSources: z.array(z.string()) }),
    examples: ["await sf.queryApprovedDataCloudSources({ source: 'ChurnScores', filters: { accountId } })"],
    handler: async (ctx, i) => {
      const dc = needAdapter(ctx, "dataCloud", "Data Cloud");
      if (!dc.approvedSources().includes(i.source)) throw new GatewayError("tool_not_allowed", `Source '${i.source}' is not approved. Approved: ${dc.approvedSources().join(", ")}`, 403);
      const rows = await dc.querySource(i.source, i.filters, i.limit * 3);
      const ok = await visibleAccountIds(ctx, rows.flatMap((r) => (typeof r.accountId === "string" ? [r.accountId] : [])));
      const out = rows.filter((r) => typeof r.accountId !== "string" || ok.has(r.accountId)).slice(0, i.limit);
      return { rows: out, count: out.length, approvedSources: dc.approvedSources() };
    },
  }),
];

export const agentforceTools = [
  defineTool({
    name: "invokeApprovedAgent", title: "Invoke approved Agentforce agent", domain: "agentforce", namespace: "sf", kind: "read", permission: "sf.agentforce.invoke", availability: "mock-only",
    notes: "Requires an Agentforce adapter (Agent API with a service-agent connected app). Only agents in the policy allowlist can be invoked.",
    description: "Send a prompt to an allowlisted Agentforce agent and return its text response. Does not execute agent actions.",
    input: z.object({ agentName, prompt: z.string().trim().min(1).max(2000), sessionId: z.string().max(100).optional() }),
    output: z.object({ agentName: z.string(), sessionId: z.string(), response: z.string(), citations: z.array(z.string()), source: z.enum(["mock", "live"]) }),
    examples: ["await sf.invokeApprovedAgent({ agentName: 'Service_Triage_Agent', prompt: 'Summarize SSO outage' })"],
    handler: async (ctx, i) => {
      if (!ctx.policy.approvedAgents.includes(i.agentName)) throw new GatewayError("tool_not_allowed", `Agent '${i.agentName}' is not on the approved agent list.`, 403);
      const ag = needAdapter(ctx, "agentforce", "Agentforce");
      const r = await ag.invoke(i.agentName, i.prompt, i.sessionId);
      return { agentName: i.agentName, ...r, source: ag.kind };
    },
  }),
  defineTool({
    name: "invokeApprovedAgentAction", title: "Invoke approved Agentforce action", domain: "agentforce", namespace: "sf", kind: "write", permission: "sf.agentforce.invoke", availability: "mock-only",
    notes: "WRITE: agent actions can change data, so every call needs human approval.",
    description: "Run a named action on an allowlisted agent. WRITE: requires human approval.",
    input: z.object({ agentName, actionName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/), parameters: z.record(z.string(), z.unknown()).default({}) }),
    output: z.object({ agentName: z.string(), actionName: z.string(), result: z.unknown(), source: z.enum(["mock", "live"]) }),
    examples: ["await sf.invokeApprovedAgentAction({ agentName: 'Service_Triage_Agent', actionName: 'SummarizeCase', parameters: { caseId } })"],
    handler: async (ctx, i) => {
      if (!ctx.policy.approvedAgents.includes(i.agentName)) throw new GatewayError("tool_not_allowed", `Agent '${i.agentName}' is not on the approved agent list.`, 403);
      const ag = needAdapter(ctx, "agentforce", "Agentforce");
      if (!ag.actions(i.agentName).includes(i.actionName)) throw new GatewayError("tool_not_allowed", `Action '${i.actionName}' is not exposed by agent '${i.agentName}'.`, 403);
      const r = await ag.invokeAction(i.agentName, i.actionName, i.parameters);
      return { agentName: i.agentName, actionName: i.actionName, result: r.result, source: ag.kind };
    },
  }),
];

const Invoice = z.object({ invoiceNumber: z.string(), customerName: z.string(), amount: z.number(), amountRemaining: z.number(), dueDate: z.string(), status: z.enum(["Paid", "Open", "Overdue"]), daysOverdue: z.number() });

/** A second MCP-connected system (NetSuite) exposed under its own sandbox namespace. */
export const externalTools = [
  defineTool({
    name: "getCustomerInvoices", title: "NetSuite invoices", domain: "external", namespace: "netsuite", kind: "read", permission: "external.read", availability: "mock-only",
    notes: "Backed by a NetSuite adapter. In production wire it to a NetSuite MCP server (see docs/tool-registry.md).",
    description: "List NetSuite invoices for a customer (matched by exact customer name).",
    input: z.object({ customerName: z.string().trim().min(1).max(120), status: z.enum(["Paid", "Open", "Overdue"]).optional() }),
    output: z.object({ invoices: z.array(Invoice), count: z.number(), source: z.enum(["mock", "live"]) }),
    examples: ["await netsuite.getCustomerInvoices({ customerName: 'Acme Corporation', status: 'Overdue' })"],
    handler: async (ctx, i) => {
      const ns = needAdapter(ctx, "netsuite", "NetSuite");
      const invoices = await ns.getCustomerInvoices(i.customerName, i.status);
      return { invoices, count: invoices.length, source: ns.kind };
    },
  }),
  defineTool({
    name: "getCreditStatus", title: "NetSuite credit status", domain: "external", namespace: "netsuite", kind: "read", permission: "external.read", availability: "mock-only",
    description: "Credit limit, balance and credit-hold flag for a NetSuite customer.",
    input: z.object({ customerName: z.string().trim().min(1).max(120) }),
    output: z.object({ customerName: z.string(), creditLimit: z.number(), balance: z.number(), onCreditHold: z.boolean(), source: z.enum(["mock", "live"]) }),
    examples: ["await netsuite.getCreditStatus({ customerName: 'Umbrella Health' })"],
    handler: async (ctx, i) => {
      const ns = needAdapter(ctx, "netsuite", "NetSuite");
      return { ...(await ns.getCreditStatus(i.customerName)), source: ns.kind };
    },
  }),
];

void rec;
