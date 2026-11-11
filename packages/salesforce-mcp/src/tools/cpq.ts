import { z } from "zod";
import { defineTool } from "@sfcm/tool-registry";
import { customFields, isoDate, listOut, listRecords, paging, rec, sfId } from "../helpers";

void isoDate;
void customFields;
const Quote = rec({ Id: z.string(), Name: z.string(), QuoteNumber: z.string(), OpportunityId: z.string().nullable(), AccountId: z.string().nullable(), Status: z.string(), Subtotal: z.number().nullable(), Discount: z.number().nullable(), GrandTotal: z.number().nullable(), ExpirationDate: z.string().nullable() });
const Line = rec({ Id: z.string(), QuoteId: z.string(), Product2Id: z.string(), Quantity: z.number(), ListPrice: z.number().nullable(), UnitPrice: z.number(), Discount: z.number().nullable(), TotalPrice: z.number().nullable() });
const text = z.string().trim().min(1).max(100);

export const cpqTools = [
  defineTool({
    name: "getQuotes", title: "Quotes", domain: "cpq", namespace: "sf", kind: "read", permission: "sf.read.cpq", availability: "live",
    notes: "Uses the standard Quote object. For Salesforce CPQ (SBQQ__Quote__c) or Revenue Cloud, add an adapter mapping.",
    description: "List quotes by account, opportunity or status.",
    input: z.object({ accountId: sfId.optional(), opportunityId: sfId.optional(), status: text.optional(), ...paging }),
    output: listOut(Quote),
    examples: ["await sf.getQuotes({ accountId })"],
    handler: (ctx, i) => listRecords(ctx, {
      object: "Quote", defaultFields: ["Id", "Name", "QuoteNumber", "OpportunityId", "AccountId", "Status", "Subtotal", "Discount", "GrandTotal", "ExpirationDate", "CreatedDate"],
      where: [...(i.accountId ? [{ field: "AccountId", op: "=" as const, value: i.accountId }] : []), ...(i.opportunityId ? [{ field: "OpportunityId", op: "=" as const, value: i.opportunityId }] : []), ...(i.status ? [{ field: "Status", op: "=" as const, value: i.status }] : [])],
      orderBy: [{ field: "CreatedDate", direction: "DESC" }], limit: i.limit, offset: i.offset,
    }),
  }),
  defineTool({
    name: "getQuoteLines", title: "Quote line items", domain: "cpq", namespace: "sf", kind: "read", permission: "sf.read.cpq", availability: "live",
    description: "List line items for one or more quotes (up to 20 quote ids).",
    input: z.object({ quoteIds: z.array(sfId).min(1).max(20), ...paging }),
    output: listOut(Line),
    examples: ["await sf.getQuoteLines({ quoteIds: quotes.records.map(q => q.Id) })"],
    handler: (ctx, i) => listRecords(ctx, { object: "QuoteLineItem", defaultFields: ["Id", "QuoteId", "Product2Id", "Quantity", "ListPrice", "UnitPrice", "Discount", "TotalPrice", "Description"], where: [{ field: "QuoteId", op: "IN", value: i.quoteIds }], orderBy: [{ field: "QuoteId" }], limit: i.limit, offset: i.offset }),
  }),
  defineTool({
    name: "getOrders", title: "Orders", domain: "cpq", namespace: "sf", kind: "read", permission: "sf.read.cpq", availability: "live",
    description: "List orders by account and status.",
    input: z.object({ accountId: sfId.optional(), status: text.optional(), ...paging }),
    output: listOut(rec({ Id: z.string(), OrderNumber: z.string(), AccountId: z.string(), Status: z.string(), TotalAmount: z.number().nullable(), EffectiveDate: z.string() })),
    examples: ["await sf.getOrders({ accountId })"],
    handler: (ctx, i) => listRecords(ctx, { object: "Order", defaultFields: ["Id", "OrderNumber", "AccountId", "Status", "TotalAmount", "EffectiveDate"], where: [...(i.accountId ? [{ field: "AccountId", op: "=" as const, value: i.accountId }] : []), ...(i.status ? [{ field: "Status", op: "=" as const, value: i.status }] : [])], orderBy: [{ field: "EffectiveDate", direction: "DESC" }], limit: i.limit, offset: i.offset }),
  }),
  defineTool({
    name: "getSubscriptions", title: "Subscriptions", domain: "cpq", namespace: "sf", kind: "read", permission: "sf.read.cpq", availability: "mock-only",
    notes: "Maps to SBQQ__Subscription__c (Salesforce CPQ). Field names are unverified against a live org; validate before enabling.",
    description: "List recurring subscriptions for an account.",
    input: z.object({ accountId: sfId.optional(), ...paging }),
    output: listOut(rec({ Id: z.string(), SBQQ__Account__c: z.string(), SBQQ__ProductName__c: z.string(), SBQQ__Quantity__c: z.number(), SBQQ__NetPrice__c: z.number(), SBQQ__StartDate__c: z.string(), SBQQ__EndDate__c: z.string() })),
    examples: ["await sf.getSubscriptions({ accountId })"],
    handler: (ctx, i) => listRecords(ctx, { object: "SBQQ__Subscription__c", defaultFields: ["Id", "SBQQ__Account__c", "SBQQ__ProductName__c", "SBQQ__Quantity__c", "SBQQ__NetPrice__c", "SBQQ__StartDate__c", "SBQQ__EndDate__c"], where: i.accountId ? [{ field: "SBQQ__Account__c", op: "=", value: i.accountId }] : [], orderBy: [{ field: "SBQQ__EndDate__c" }], limit: i.limit, offset: i.offset }),
  }),
  defineTool({
    name: "getAssets", title: "Assets", domain: "cpq", namespace: "sf", kind: "read", permission: "sf.read.cpq", availability: "live",
    description: "List installed assets for an account.",
    input: z.object({ accountId: sfId.optional(), ...paging }),
    output: listOut(rec({ Id: z.string(), Name: z.string(), AccountId: z.string(), SerialNumber: z.string().nullable(), Status: z.string().nullable(), InstallDate: z.string().nullable(), Quantity: z.number().nullable(), Price: z.number().nullable() })),
    examples: ["await sf.getAssets({ accountId })"],
    handler: (ctx, i) => listRecords(ctx, { object: "Asset", defaultFields: ["Id", "Name", "AccountId", "SerialNumber", "Status", "InstallDate", "Quantity", "Price"], where: i.accountId ? [{ field: "AccountId", op: "=", value: i.accountId }] : [], orderBy: [{ field: "Name" }], limit: i.limit, offset: i.offset }),
  }),
];
