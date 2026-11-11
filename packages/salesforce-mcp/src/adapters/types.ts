import { GatewayError } from "@sfcm/security";
import type { ToolContext } from "@sfcm/tool-registry";

export interface UnifiedProfile {
  unifiedId: string;
  accountId?: string;
  fullName: string;
  email?: string;
  lifetimeValue: number;
  churnRisk: number;
  engagementScore: number;
  preferredChannel: string;
  segments: string[];
  lastPurchaseDate?: string;
  openSupportTickets: number;
}

export interface DataCloudAdapter {
  readonly kind: "mock" | "live";
  searchProfiles(query: string, limit: number): Promise<UnifiedProfile[]>;
  getProfile(sel: { unifiedId?: string; accountId?: string; email?: string }): Promise<UnifiedProfile | null>;
  approvedSources(): string[];
  querySource(source: string, filters: Record<string, string | number | boolean>, limit: number): Promise<Array<Record<string, unknown>>>;
}

export interface AgentforceAdapter {
  readonly kind: "mock" | "live";
  invoke(agentName: string, prompt: string, sessionId?: string): Promise<{ sessionId: string; response: string; citations: string[] }>;
  invokeAction(agentName: string, actionName: string, parameters: Record<string, unknown>): Promise<{ result: unknown }>;
  actions(agentName: string): string[];
}

export interface NetSuiteInvoice {
  invoiceNumber: string;
  customerName: string;
  amount: number;
  amountRemaining: number;
  dueDate: string;
  status: "Paid" | "Open" | "Overdue";
  daysOverdue: number;
}

export interface NetSuiteAdapter {
  readonly kind: "mock" | "live";
  getCustomerInvoices(customerName: string, status?: NetSuiteInvoice["status"]): Promise<NetSuiteInvoice[]>;
  getCreditStatus(customerName: string): Promise<{ customerName: string; creditLimit: number; balance: number; onCreditHold: boolean }>;
}

export interface SalesforceAdapters {
  [name: string]: unknown;
  dataCloud?: DataCloudAdapter;
  agentforce?: AgentforceAdapter;
  netsuite?: NetSuiteAdapter;
}

export function needAdapter<K extends keyof SalesforceAdapters>(ctx: ToolContext, key: K, what: string): NonNullable<SalesforceAdapters[K]> {
  const a = ctx.adapters[key];
  if (!a) {
    throw new GatewayError("not_available", `${what} is not configured. This capability needs a ${key} adapter (see docs/tool-registry.md to enable a live adapter).`, 501);
  }
  return a as NonNullable<SalesforceAdapters[K]>;
}
