import { z } from "zod";
import { SoqlLiteral, buildSoql, type SoqlCondition } from "@sfcm/salesforce-client";
import { GatewayError } from "@sfcm/security";
import { defineTool } from "@sfcm/tool-registry";
import { accessibleFields, customFields, getById, isoDate, listOut, listRecords, paging, rec, sfId } from "../helpers";

const CASE_FIELDS = ["Id", "CaseNumber", "Subject", "Status", "Priority", "Origin", "Type", "AccountId", "ContactId", "OwnerId", "IsClosed", "IsEscalated", "CreatedDate", "ClosedDate"];
const Case = rec({ Id: z.string(), CaseNumber: z.string(), Subject: z.string(), Status: z.string(), Priority: z.string().nullable(), AccountId: z.string().nullable(), IsClosed: z.boolean(), IsEscalated: z.boolean(), CreatedDate: z.string() });
const text = z.string().trim().min(1).max(100);

export const serviceTools = [
  defineTool({
    name: "searchCases", title: "Search cases", domain: "service", namespace: "sf", kind: "read", permission: "sf.read.service", availability: "live",
    description: "Search cases by subject text, account, status, priority, open/closed, escalation and creation date. Paginated.",
    input: z.object({
      query: text.optional().describe("Substring of the subject"), accountId: sfId.optional(), status: text.optional(), priority: z.enum(["Low", "Medium", "High"]).optional(),
      isClosed: z.boolean().optional(), isEscalated: z.boolean().optional(), createdAfter: isoDate.optional(), extraFields: customFields, ...paging,
    }),
    output: listOut(Case),
    examples: ["await sf.searchCases({ isClosed: false, priority: 'High' })"],
    handler: (ctx, i) => {
      const where: SoqlCondition[] = [];
      if (i.query) where.push({ field: "Subject", op: "LIKE", value: SoqlLiteral.like(i.query) as never });
      if (i.accountId) where.push({ field: "AccountId", op: "=", value: i.accountId });
      if (i.status) where.push({ field: "Status", op: "=", value: i.status });
      if (i.priority) where.push({ field: "Priority", op: "=", value: i.priority });
      if (i.isClosed !== undefined) where.push({ field: "IsClosed", op: "=", value: i.isClosed });
      if (i.isEscalated !== undefined) where.push({ field: "IsEscalated", op: "=", value: i.isEscalated });
      if (i.createdAfter) where.push({ field: "CreatedDate", op: ">=", value: SoqlLiteral.date(i.createdAfter) });
      return listRecords(ctx, { object: "Case", defaultFields: CASE_FIELDS, extraFields: i.extraFields, where, orderBy: [{ field: "CreatedDate", direction: "DESC" }], limit: i.limit, offset: i.offset });
    },
  }),
  defineTool({
    name: "getCaseDetails", title: "Case details", domain: "service", namespace: "sf", kind: "read", permission: "sf.read.service", availability: "live",
    description: "Fetch one case including its description. Sensitive values inside free text are redacted by the gateway.",
    input: z.object({ caseId: sfId }),
    output: z.object({ record: Case, omittedFields: z.array(z.string()) }),
    examples: ["await sf.getCaseDetails({ caseId })"],
    handler: (ctx, i) => getById(ctx, "Case", i.caseId, [...CASE_FIELDS, "Description"]),
  }),
  defineTool({
    name: "getOpenCasesByAccount", title: "Open cases for account", domain: "service", namespace: "sf", kind: "read", permission: "sf.read.service", availability: "live",
    description: "List open (not closed) cases for one account, newest first.",
    input: z.object({ accountId: sfId, ...paging }),
    output: listOut(Case),
    examples: ["await sf.getOpenCasesByAccount({ accountId })"],
    handler: (ctx, i) => listRecords(ctx, { object: "Case", defaultFields: CASE_FIELDS, where: [{ field: "AccountId", op: "=", value: i.accountId }, { field: "IsClosed", op: "=", value: false }], orderBy: [{ field: "CreatedDate", direction: "DESC" }], limit: i.limit, offset: i.offset }),
  }),
  defineTool({
    name: "createCase", title: "Create case", domain: "service", namespace: "sf", kind: "write", permission: "sf.write.case", availability: "live",
    description: "Create a Case. WRITE: requires human approval; the first call returns an approval_required error with an approval id. Idempotent per approved request.",
    input: z.object({
      subject: z.string().trim().min(3).max(255), description: z.string().max(4000).optional(), accountId: sfId.optional(), contactId: sfId.optional(),
      priority: z.enum(["Low", "Medium", "High"]).default("Medium"), origin: z.enum(["Phone", "Email", "Web"]).default("Web"), type: z.enum(["Problem", "Question", "Feature Request"]).optional(),
    }),
    output: z.object({ id: z.string(), success: z.boolean() }),
    examples: ["await sf.createCase({ accountId, subject: 'Follow-up on SSO outage', priority: 'High' })"],
    handler: async (ctx, i) => {
      const { all, describe } = await accessibleFields(ctx, "Case", []);
      if (!describe.createable) throw new GatewayError("forbidden", "User cannot create Cases (CRUD).", 403);
      const fields: Record<string, unknown> = { Subject: i.subject, Priority: i.priority, Origin: i.origin };
      if (i.description) fields.Description = i.description;
      if (i.accountId) fields.AccountId = i.accountId;
      if (i.contactId) fields.ContactId = i.contactId;
      if (i.type) fields.Type = i.type;
      for (const k of Object.keys(fields)) {
        const f = describe.fields.find((x) => x.name === k);
        if (!all.has(k) || !f?.createable) throw new GatewayError("forbidden", `Field Case.${k} is not createable by this user (FLS).`, 403);
      }
      return ctx.sf.createRecord("Case", fields);
    },
  }),
  defineTool({
    name: "updateCase", title: "Update case", domain: "service", namespace: "sf", kind: "write", permission: "sf.write.case", availability: "live",
    description: "Update status/priority/subject/description/escalation of a Case. WRITE: requires human approval.",
    input: z.object({
      caseId: sfId,
      changes: z.object({
        status: z.enum(["New", "Working", "Escalated", "On Hold", "Closed"]).optional(), priority: z.enum(["Low", "Medium", "High"]).optional(),
        subject: z.string().trim().min(3).max(255).optional(), description: z.string().max(4000).optional(), isEscalated: z.boolean().optional(),
      }).refine((c) => Object.keys(c).length > 0, "at least one change is required"),
    }),
    output: z.object({ id: z.string(), success: z.boolean() }),
    examples: ["await sf.updateCase({ caseId, changes: { isEscalated: true, priority: 'High' } })"],
    handler: async (ctx, i) => {
      const map: Record<string, string> = { status: "Status", priority: "Priority", subject: "Subject", description: "Description", isEscalated: "IsEscalated" };
      const { describe } = await accessibleFields(ctx, "Case", []);
      if (!describe.updateable) throw new GatewayError("forbidden", "User cannot update Cases (CRUD).", 403);
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(i.changes)) {
        const api = map[k]!;
        const f = describe.fields.find((x) => x.name === api);
        if (!f?.updateable) throw new GatewayError("forbidden", `Field Case.${api} is not updateable by this user (FLS).`, 403);
        fields[api] = v;
      }
      return ctx.sf.updateRecord("Case", i.caseId, fields);
    },
  }),
  defineTool({
    name: "getKnowledgeArticles", title: "Knowledge articles", domain: "service", namespace: "sf", kind: "read", permission: "sf.read.knowledge", availability: "live",
    notes: "Queries Knowledge__kav (Lightning Knowledge). Body field API name differs per org: pass bodyField (e.g. 'Body__c') to include article text.",
    description: "Search published Knowledge articles by title/summary text. Optionally include the rich-text body field for grounding answers.",
    input: z.object({ query: text.describe("Search text matched against title and summary"), bodyField: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*__c$/).optional().describe("API name of the article body field, e.g. Body__c"), limit: z.number().int().min(1).max(25).default(5) }),
    output: z.object({ articles: z.array(rec({ Id: z.string(), Title: z.string(), UrlName: z.string(), Summary: z.string().nullable() })), count: z.number() }),
    examples: ["await sf.getKnowledgeArticles({ query: 'API latency', bodyField: 'Body__c' })"],
    handler: async (ctx, i) => {
      const { fields } = await accessibleFields(ctx, "Knowledge__kav", ["Id", "Title", "UrlName", "Summary", ...(i.bodyField ? [i.bodyField] : [])]);
      const base: SoqlCondition[] = [{ field: "PublishStatus", op: "=", value: "Online" }, { field: "Language", op: "=", value: "en_US" }];
      const run = (field: string) => ctx.sf.query<Record<string, unknown>>(buildSoql({ object: "Knowledge__kav", fields, where: [...base, { field, op: "LIKE", value: SoqlLiteral.like(i.query) as never }], limit: i.limit }), { maxRecords: i.limit });
      const [a, b] = await Promise.all([run("Title"), run("Summary")]);
      const seen = new Set<unknown>();
      const articles = [...a.records, ...b.records].filter((r) => (seen.has(r.Id) ? false : (seen.add(r.Id), true))).slice(0, i.limit);
      return { articles, count: articles.length };
    },
  }),
];
