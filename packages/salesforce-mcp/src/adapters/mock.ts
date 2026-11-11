import type { Dataset } from "@sfcm/salesforce-client";
import type { AgentforceAdapter, DataCloudAdapter, NetSuiteAdapter, NetSuiteInvoice, SalesforceAdapters, UnifiedProfile } from "./types";

function buildProfiles(data: Dataset): UnifiedProfile[] {
  const accounts = data.Account ?? [];
  return (data.Contact ?? []).map((c, i) => {
    const acct = accounts.find((a) => a.Id === c.AccountId);
    const overdue = Number(acct?.Overdue_Invoices__c ?? 0);
    const openCases = (data.Case ?? []).filter((k) => k.AccountId === c.AccountId && !k.IsClosed).length;
    return {
      unifiedId: `UP-${String(c.Id).slice(3, 15)}`,
      accountId: String(c.AccountId),
      fullName: String(c.Name),
      email: String(c.Email),
      lifetimeValue: Math.round(Number(acct?.AnnualRevenue ?? 1_000_000) / 400 + i * 1_300),
      churnRisk: Math.min(0.95, Number((0.1 + overdue * 0.12 + openCases * 0.07).toFixed(2))),
      engagementScore: Math.max(5, 90 - overdue * 11 - openCases * 6 - (i % 5) * 3),
      preferredChannel: ["email", "phone", "portal"][i % 3]!,
      segments: [overdue > 1 ? "At-Risk Billing" : "Healthy", openCases > 1 ? "High-Touch Support" : "Self-Serve"],
      lastPurchaseDate: new Date(Date.now() - (30 + i * 17) * 86_400_000).toISOString().slice(0, 10),
      openSupportTickets: openCases,
    };
  });
}

export class MockDataCloud implements DataCloudAdapter {
  readonly kind = "mock" as const;
  private readonly profiles: UnifiedProfile[];
  constructor(data: Dataset) {
    this.profiles = buildProfiles(data);
  }
  async searchProfiles(query: string, limit: number) {
    const q = query.toLowerCase();
    return this.profiles.filter((p) => p.fullName.toLowerCase().includes(q) || (p.email ?? "").includes(q)).slice(0, limit);
  }
  async getProfile(sel: { unifiedId?: string; accountId?: string; email?: string }) {
    return this.profiles.find((p) => (sel.unifiedId && p.unifiedId === sel.unifiedId) || (sel.email && p.email === sel.email.toLowerCase()) || (sel.accountId && p.accountId === sel.accountId)) ?? null;
  }
  approvedSources() {
    return ["UnifiedIndividual", "EngagementEvents", "ChurnScores"];
  }
  async querySource(source: string, filters: Record<string, string | number | boolean>, limit: number) {
    let rows: Array<Record<string, unknown>> = this.profiles.map((p) => ({ ...p }));
    if (source === "ChurnScores") rows = this.profiles.map((p) => ({ unifiedId: p.unifiedId, accountId: p.accountId, churnRisk: p.churnRisk }));
    if (source === "EngagementEvents") rows = this.profiles.map((p) => ({ unifiedId: p.unifiedId, accountId: p.accountId, engagementScore: p.engagementScore, channel: p.preferredChannel }));
    for (const [k, v] of Object.entries(filters)) rows = rows.filter((r) => r[k] === v);
    return rows.slice(0, limit);
  }
}

export class MockAgentforce implements AgentforceAdapter {
  readonly kind = "mock" as const;
  async invoke(agentName: string, prompt: string, sessionId?: string) {
    const sid = sessionId ?? `sess-${Math.abs([...prompt].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(16)}`;
    const response =
      agentName === "Sales_Coach_Agent"
        ? `Coaching note: focus on the highest-probability open opportunities first and confirm next steps with the economic buyer. (Re: "${prompt.slice(0, 80)}")`
        : `Triage: classify as P1 if production is impacted, otherwise P2. Recommended next action: gather logs and link the relevant Knowledge article. (Re: "${prompt.slice(0, 80)}")`;
    return { sessionId: sid, response, citations: ["Knowledge:api-latency-spikes", "Knowledge:nightly-sync-data-loss"] };
  }
  actions(agentName: string) {
    return agentName === "Service_Triage_Agent" ? ["SummarizeCase", "SuggestKnowledge"] : ["DraftFollowUp"];
  }
  async invokeAction(agentName: string, actionName: string, parameters: Record<string, unknown>) {
    return { result: { agentName, actionName, accepted: true, echo: parameters } };
  }
}

const INVOICES: Array<[string, number, number, number, NetSuiteInvoice["status"]]> = [
  // customer, amount, remaining, daysOverdue (negative = due in future), status
  ["Acme Corporation", 30_000, 30_000, 75, "Overdue"], ["Acme Corporation", 28_000, 28_000, 45, "Overdue"], ["Acme Corporation", 26_000, 26_000, 20, "Overdue"], ["Acme Corporation", 90_000, 0, 0, "Paid"],
  ["Initech", 12_500, 12_500, 33, "Overdue"], ["Initech", 40_000, 40_000, -12, "Open"],
  ["Umbrella Health", 50_000, 50_000, 90, "Overdue"], ["Umbrella Health", 40_000, 40_000, 60, "Overdue"], ["Umbrella Health", 36_000, 36_000, 40, "Overdue"], ["Umbrella Health", 30_000, 30_000, 15, "Overdue"],
  ["Hooli Media", 18_000, 18_000, 52, "Overdue"], ["Hooli Media", 13_000, 13_000, 21, "Overdue"],
  ["Globex Industries", 120_000, 120_000, -20, "Open"], ["Wayne Financial", 75_000, 0, 0, "Paid"],
];

export class MockNetSuite implements NetSuiteAdapter {
  readonly kind = "mock" as const;
  private invoices(): NetSuiteInvoice[] {
    return INVOICES.map(([customerName, amount, rem, d, status], i) => ({
      invoiceNumber: `INV-${10_000 + i}`,
      customerName,
      amount,
      amountRemaining: rem,
      dueDate: new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10),
      status,
      daysOverdue: Math.max(0, d),
    }));
  }
  async getCustomerInvoices(customerName: string, status?: NetSuiteInvoice["status"]) {
    return this.invoices().filter((i) => i.customerName.toLowerCase() === customerName.toLowerCase() && (!status || i.status === status));
  }
  async getCreditStatus(customerName: string) {
    const open = this.invoices().filter((i) => i.customerName.toLowerCase() === customerName.toLowerCase());
    const balance = open.reduce((s, i) => s + i.amountRemaining, 0);
    return { customerName, creditLimit: 150_000, balance, onCreditHold: open.some((i) => i.daysOverdue > 60) };
  }
}

export function createMockAdapters(data: Dataset): SalesforceAdapters {
  return { dataCloud: new MockDataCloud(data), agentforce: new MockAgentforce(), netsuite: new MockNetSuite() };
}
