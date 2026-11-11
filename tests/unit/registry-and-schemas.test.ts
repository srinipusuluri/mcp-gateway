import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSalesforceRegistry } from "@sfcm/salesforce-mcp";
import { ToolRegistry, defineTool, generateTypeScriptApi, zodToTs } from "@sfcm/tool-registry";

describe("tool registry", () => {
  const reg = createSalesforceRegistry();
  it("registers every required capability exactly once", () => {
    const names = reg.list().map((t) => t.name);
    for (const n of [
      "searchAccounts", "getAccount", "searchContacts", "getContactsByAccount", "getOpportunities", "getOpportunityDetails", "getPipelineSummary",
      "searchCases", "getCaseDetails", "getOpenCasesByAccount", "createCase", "updateCase", "getKnowledgeArticles",
      "getQuotes", "getQuoteLines", "getOrders", "getSubscriptions", "getAssets",
      "searchCustomerProfiles", "retrieveUnifiedProfile", "queryApprovedDataCloudSources",
      "describeObject", "describeFields", "getAvailableObjects", "getPicklistValues", "invokeApprovedAgent", "invokeApprovedAgentAction",
    ]) expect(names, n).toContain(n);
    expect(new Set(names).size).toBe(names.length);
  });
  it("classifies writes and flags non-live adapters honestly", () => {
    const writes = reg.list((t) => t.kind === "write").map((t) => t.name).sort();
    expect(writes).toEqual(["createCase", "invokeApprovedAgentAction", "updateCase"]);
    for (const n of ["searchCustomerProfiles", "retrieveUnifiedProfile", "queryApprovedDataCloudSources", "invokeApprovedAgent", "invokeApprovedAgentAction", "getSubscriptions"]) {
      expect(reg.get(n)!.availability, n).toBe("mock-only");
    }
    for (const n of ["searchAccounts", "getOpportunities", "searchCases", "describeObject", "getKnowledgeArticles", "getQuotes"]) expect(reg.get(n)!.availability, n).toBe("live");
  });
  it("rejects duplicates and non-identifier names", () => {
    const t = defineTool({ name: "x", title: "", description: "", domain: "sales", namespace: "sf", kind: "read", permission: "sf.read.sales", availability: "live", input: z.object({}), output: z.object({}), examples: [], handler: async () => ({}) });
    expect(() => new ToolRegistry().register(t, t)).toThrow(/Duplicate/);
    expect(() => new ToolRegistry().register({ ...t, name: "bad-name" })).toThrow(/identifier/);
  });
  it("every tool has examples and a description", () => {
    for (const t of reg.list()) {
      expect(t.examples.length, t.name).toBeGreaterThan(0);
      expect(t.description.length, t.name).toBeGreaterThan(10);
    }
  });
});

describe("TypeScript interface generation", () => {
  it("emits typed declarations per namespace with optional markers, enums, docs and arrays", () => {
    const ts = generateTypeScriptApi(createSalesforceRegistry().list());
    expect(ts).toContain("declare const sf: {");
    expect(ts).toContain("declare const netsuite: {");
    expect(ts).toMatch(/searchAccounts\(input: \{/);
    expect(ts).toMatch(/orderBy\?: "Name" \| "AnnualRevenue" \| "CreatedDate"/);
    expect(ts).toMatch(/createCase\(/);
    expect(ts).toContain("WRITE (requires human approval)");
    expect(ts).toContain("availability: mock-only");
    expect(ts).toMatch(/hasMore: boolean/);
  });
  it("converts nullable/union/record shapes", () => {
    expect(zodToTs(z.object({ a: z.string().nullable(), b: z.array(z.number()).optional(), c: z.record(z.string(), z.unknown()) }), "output")).toMatch(/a: string \| null;[\s\S]*b\?: number\[\];[\s\S]*c: \{\s*\[key: string\]: unknown;/);
  });
});

describe("input validation (Zod)", () => {
  const reg = createSalesforceRegistry();
  const parse = (tool: string, input: unknown) => reg.get(tool)!.input.safeParse(input);
  it("rejects malformed ids, oversize pages and unknown enum values", () => {
    expect(parse("getAccount", { accountId: "not an id!" }).success).toBe(false);
    expect(parse("getAccount", { accountId: "001000000000001AAA" }).success).toBe(true);
    expect(parse("searchAccounts", { limit: 5000 }).success).toBe(false);
    expect(parse("searchAccounts", { orderBy: "Id; DROP" }).success).toBe(false);
    expect(parse("searchCases", { priority: "Urgent" }).success).toBe(false);
    expect(parse("getOpportunities", { closeDateFrom: "yesterday" }).success).toBe(false);
    expect(parse("searchAccounts", { extraFields: ["Name FROM User--"] }).success).toBe(false);
    expect(parse("searchAccounts", { extraFields: ["Region__c"] }).success).toBe(true);
    expect(parse("getOpportunities", { accountIds: [] }).success).toBe(false);
  });
  it("applies defaults and enforces write constraints", () => {
    expect(parse("searchAccounts", {}).data).toMatchObject({ limit: 25, offset: 0, orderBy: "Name" });
    expect(parse("createCase", { subject: "x" }).success).toBe(false);
    expect(parse("updateCase", { caseId: "500000000000001AAA", changes: {} }).success).toBe(false);
    expect(parse("retrieveUnifiedProfile", {}).success).toBe(false);
  });
});
