import { z } from "zod";
import { SoqlLiteral, buildSoql, type SoqlCondition } from "@sfcm/salesforce-client";
import { defineTool } from "@sfcm/tool-registry";
import { accessibleFields, customFields, getById, isoDate, listOut, listRecords, paging, rec, sfId } from "../helpers";

const ACCOUNT_FIELDS = ["Id", "Name", "Industry", "Type", "Rating", "AnnualRevenue", "NumberOfEmployees", "BillingCity", "BillingCountry", "Website", "Phone", "OwnerId", "CreatedDate"];
const CONTACT_FIELDS = ["Id", "FirstName", "LastName", "Name", "Email", "Phone", "Title", "Department", "AccountId"];
const OPP_FIELDS = ["Id", "Name", "AccountId", "StageName", "Amount", "CloseDate", "Probability", "IsClosed", "IsWon", "Type", "ForecastCategoryName", "NextStep", "OwnerId", "LastModifiedDate", "CreatedDate"];

const Account = rec({ Id: z.string(), Name: z.string(), Industry: z.string().nullable(), Type: z.string().nullable(), Rating: z.string().nullable(), AnnualRevenue: z.number().nullable(), NumberOfEmployees: z.number().nullable(), BillingCity: z.string().nullable(), OwnerId: z.string() });
const Contact = rec({ Id: z.string(), Name: z.string(), Email: z.string().nullable(), Phone: z.string().nullable(), Title: z.string().nullable(), AccountId: z.string().nullable() });
const Opportunity = rec({ Id: z.string(), Name: z.string(), AccountId: z.string().nullable(), StageName: z.string(), Amount: z.number().nullable(), CloseDate: z.string(), Probability: z.number().nullable(), IsClosed: z.boolean(), IsWon: z.boolean() });

const text = z.string().trim().min(1).max(100);

export const salesTools = [
  defineTool({
    name: "searchAccounts", title: "Search accounts", domain: "sales", namespace: "sf", kind: "read", permission: "sf.read.sales", availability: "live",
    description: "Search accounts by name (contains) and optional industry/type/rating/owner filters. Paginated.",
    input: z.object({ query: text.optional().describe("Substring of the account name"), industry: text.optional(), type: text.optional(), rating: text.optional(), ownerId: sfId.optional(), orderBy: z.enum(["Name", "AnnualRevenue", "CreatedDate"]).default("Name"), direction: z.enum(["ASC", "DESC"]).default("ASC"), extraFields: customFields, ...paging }),
    output: listOut(Account),
    examples: ['await sf.searchAccounts({ query: "Acme", limit: 5 })'],
    handler: (ctx, i) => {
      const where: SoqlCondition[] = [];
      if (i.query) where.push({ field: "Name", op: "LIKE", value: SoqlLiteral.like(i.query) as never });
      if (i.industry) where.push({ field: "Industry", op: "=", value: i.industry });
      if (i.type) where.push({ field: "Type", op: "=", value: i.type });
      if (i.rating) where.push({ field: "Rating", op: "=", value: i.rating });
      if (i.ownerId) where.push({ field: "OwnerId", op: "=", value: i.ownerId });
      return listRecords(ctx, { object: "Account", defaultFields: ACCOUNT_FIELDS, extraFields: i.extraFields, where, orderBy: [{ field: i.orderBy, direction: i.direction }], limit: i.limit, offset: i.offset });
    },
  }),
  defineTool({
    name: "getAccount", title: "Get account", domain: "sales", namespace: "sf", kind: "read", permission: "sf.read.sales", availability: "live",
    description: "Fetch one account by Salesforce id. Only fields the calling user may read are returned.",
    input: z.object({ accountId: sfId, extraFields: customFields }),
    output: z.object({ record: Account, omittedFields: z.array(z.string()) }),
    examples: ['await sf.getAccount({ accountId: "001000000000001AAA", extraFields: ["Overdue_Invoices__c"] })'],
    handler: (ctx, i) => getById(ctx, "Account", i.accountId, ACCOUNT_FIELDS, i.extraFields),
  }),
  defineTool({
    name: "searchContacts", title: "Search contacts", domain: "sales", namespace: "sf", kind: "read", permission: "sf.read.sales", availability: "live",
    description: "Search contacts by name, email or account. Paginated.",
    input: z.object({ query: text.optional().describe("Substring of the contact name"), email: z.string().email().max(120).optional(), accountId: sfId.optional(), extraFields: customFields, ...paging }),
    output: listOut(Contact),
    examples: ['await sf.searchContacts({ query: "Dana" })'],
    handler: (ctx, i) => {
      const where: SoqlCondition[] = [];
      if (i.query) where.push({ field: "Name", op: "LIKE", value: SoqlLiteral.like(i.query) as never });
      if (i.email) where.push({ field: "Email", op: "=", value: i.email });
      if (i.accountId) where.push({ field: "AccountId", op: "=", value: i.accountId });
      return listRecords(ctx, { object: "Contact", defaultFields: CONTACT_FIELDS, extraFields: i.extraFields, where, orderBy: [{ field: "Name" }], limit: i.limit, offset: i.offset });
    },
  }),
  defineTool({
    name: "getContactsByAccount", title: "Contacts for account", domain: "sales", namespace: "sf", kind: "read", permission: "sf.read.sales", availability: "live",
    description: "List contacts that belong to an account.",
    input: z.object({ accountId: sfId, ...paging }),
    output: listOut(Contact),
    examples: ["await sf.getContactsByAccount({ accountId })"],
    handler: (ctx, i) => listRecords(ctx, { object: "Contact", defaultFields: CONTACT_FIELDS, where: [{ field: "AccountId", op: "=", value: i.accountId }], orderBy: [{ field: "Name" }], limit: i.limit, offset: i.offset }),
  }),
  defineTool({
    name: "getOpportunities", title: "List opportunities", domain: "sales", namespace: "sf", kind: "read", permission: "sf.read.sales", availability: "live",
    description: "List opportunities, filterable by account(s), stage, open/closed, close-date window and minimum amount. Paginated.",
    input: z.object({
      accountId: sfId.optional(), accountIds: z.array(sfId).min(1).max(50).optional().describe("Up to 50 account ids (IN filter)"),
      stage: text.optional(), isClosed: z.boolean().optional(), closeDateFrom: isoDate.optional(), closeDateTo: isoDate.optional(), minAmount: z.number().nonnegative().optional(),
      orderBy: z.enum(["CloseDate", "Amount", "StageName", "LastModifiedDate"]).default("CloseDate"), direction: z.enum(["ASC", "DESC"]).default("ASC"), extraFields: customFields, ...paging,
    }),
    output: listOut(Opportunity),
    examples: ["await sf.getOpportunities({ accountIds, isClosed: false, orderBy: 'Amount', direction: 'DESC' })"],
    handler: (ctx, i) => {
      const where: SoqlCondition[] = [];
      if (i.accountId) where.push({ field: "AccountId", op: "=", value: i.accountId });
      if (i.accountIds) where.push({ field: "AccountId", op: "IN", value: i.accountIds });
      if (i.stage) where.push({ field: "StageName", op: "=", value: i.stage });
      if (i.isClosed !== undefined) where.push({ field: "IsClosed", op: "=", value: i.isClosed });
      if (i.closeDateFrom) where.push({ field: "CloseDate", op: ">=", value: SoqlLiteral.date(i.closeDateFrom) });
      if (i.closeDateTo) where.push({ field: "CloseDate", op: "<=", value: SoqlLiteral.date(i.closeDateTo) });
      if (i.minAmount !== undefined) where.push({ field: "Amount", op: ">=", value: i.minAmount });
      return listRecords(ctx, { object: "Opportunity", defaultFields: OPP_FIELDS, extraFields: i.extraFields, where, orderBy: [{ field: i.orderBy, direction: i.direction }], limit: i.limit, offset: i.offset });
    },
  }),
  defineTool({
    name: "getOpportunityDetails", title: "Opportunity details", domain: "sales", namespace: "sf", kind: "read", permission: "sf.read.sales", availability: "live",
    description: "Fetch one opportunity by id.",
    input: z.object({ opportunityId: sfId, extraFields: customFields }),
    output: z.object({ record: Opportunity, omittedFields: z.array(z.string()) }),
    examples: ["await sf.getOpportunityDetails({ opportunityId })"],
    handler: (ctx, i) => getById(ctx, "Opportunity", i.opportunityId, OPP_FIELDS, i.extraFields),
  }),
  defineTool({
    name: "getPipelineSummary", title: "Pipeline summary", domain: "sales", namespace: "sf", kind: "read", permission: "sf.read.sales", availability: "live",
    description: "Server-side aggregation of the pipeline by stage and close month (scans up to 2000 opportunities, returns only aggregates). Amounts are omitted if the user lacks field access to Amount.",
    input: z.object({ accountIds: z.array(sfId).min(1).max(50).optional(), includeClosed: z.boolean().default(false), closeDateFrom: isoDate.optional(), closeDateTo: isoDate.optional() }),
    output: z.object({
      amountAvailable: z.boolean(), scanned: z.number(), scanTruncated: z.boolean(),
      totals: z.object({ count: z.number(), amount: z.number(), weightedAmount: z.number() }),
      byStage: z.array(z.object({ stage: z.string(), count: z.number(), amount: z.number(), weightedAmount: z.number() })),
      byCloseMonth: z.array(z.object({ month: z.string(), count: z.number(), amount: z.number() })),
    }),
    examples: ["await sf.getPipelineSummary({ includeClosed: false })"],
    handler: async (ctx, i) => {
      const { fields, all } = await accessibleFields(ctx, "Opportunity", ["StageName", "Amount", "Probability", "CloseDate", "IsClosed"]);
      const amountAvailable = all.has("Amount");
      const where: SoqlCondition[] = [];
      if (i.accountIds) where.push({ field: "AccountId", op: "IN", value: i.accountIds });
      if (!i.includeClosed) where.push({ field: "IsClosed", op: "=", value: false });
      if (i.closeDateFrom) where.push({ field: "CloseDate", op: ">=", value: SoqlLiteral.date(i.closeDateFrom) });
      if (i.closeDateTo) where.push({ field: "CloseDate", op: "<=", value: SoqlLiteral.date(i.closeDateTo) });
      const res = await ctx.sf.query<Record<string, unknown>>(buildSoql({ object: "Opportunity", fields, where, limit: 2000 }), { maxRecords: 2000 });
      const stage = new Map<string, { count: number; amount: number; weighted: number }>();
      const month = new Map<string, { count: number; amount: number }>();
      let amount = 0, weighted = 0;
      for (const r of res.records) {
        const a = Number(r.Amount ?? 0), p = Number(r.Probability ?? 0) / 100;
        amount += a; weighted += a * p;
        const s = stage.get(String(r.StageName)) ?? { count: 0, amount: 0, weighted: 0 };
        s.count++; s.amount += a; s.weighted += a * p; stage.set(String(r.StageName), s);
        const m = String(r.CloseDate ?? "").slice(0, 7);
        const mm = month.get(m) ?? { count: 0, amount: 0 };
        mm.count++; mm.amount += a; month.set(m, mm);
      }
      return {
        amountAvailable, scanned: res.records.length, scanTruncated: !res.done,
        totals: { count: res.records.length, amount, weightedAmount: Math.round(weighted) },
        byStage: [...stage.entries()].map(([s, v]) => ({ stage: s, count: v.count, amount: v.amount, weightedAmount: Math.round(v.weighted) })),
        byCloseMonth: [...month.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => ({ month: m, count: v.count, amount: v.amount })),
      };
    },
  }),
];
