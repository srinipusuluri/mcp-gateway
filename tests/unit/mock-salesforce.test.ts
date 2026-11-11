import { describe, expect, it } from "vitest";
import { MOCK_USERS, MockOrg, MockSalesforceClient } from "@sfcm/salesforce-client";

const client = (profile: string, org = new MockOrg()) => new MockSalesforceClient(org, MOCK_USERS[profile]!);

describe("mock Salesforce org", () => {
  it("evaluates WHERE/ORDER/LIMIT/OFFSET and relationship fields", async () => {
    const c = client("sf_admin");
    const r = await c.query<any>("SELECT Name, Amount, Account.Name FROM Opportunity WHERE IsClosed = false AND Amount >= 300000 ORDER BY Amount DESC LIMIT 3 OFFSET 1");
    expect(r.records.length).toBe(3);
    expect(r.records[0].Amount).toBeGreaterThanOrEqual(r.records[1].Amount);
    expect(r.records[0].Account.Name).toBeTruthy();
    expect(r.totalSize).toBeGreaterThan(3);
  });
  it("supports IN, LIKE, OR/parentheses and date literals", async () => {
    const c = client("sf_admin");
    expect((await c.query("SELECT Id FROM Account WHERE Name LIKE '%corp%'")).records.length).toBe(1);
    expect((await c.query("SELECT Id FROM Account WHERE Industry IN ('Technology','Healthcare') AND (Rating = 'Hot' OR Rating = 'Cold')")).records.length).toBe(2);
    expect((await c.query("SELECT Id FROM Opportunity WHERE CloseDate >= LAST_N_DAYS:30 AND CloseDate <= NEXT_N_DAYS:30")).records.length).toBeGreaterThan(0);
  });
  it("sharing: private-OWD user only sees owned records", async () => {
    const all = (await client("sf_admin").query("SELECT Id FROM Account")).records.length;
    const mine = (await client("sf_rep_east").query<any>("SELECT Id, OwnerId FROM Account")).records;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThan(all);
    expect(new Set(mine.map((r) => r.OwnerId)).size).toBe(1);
  });
  it("FLS: hidden fields are absent from describe and fail in SOQL", async () => {
    const c = client("sf_service");
    const d = await c.describeObject("Opportunity");
    expect(d.fields.map((f) => f.name)).not.toContain("Amount");
    await expect(c.query("SELECT Amount FROM Opportunity")).rejects.toMatchObject({ errorCode: "INVALID_FIELD" });
    await expect(c.query("SELECT Id FROM Opportunity WHERE Amount > 5")).rejects.toMatchObject({ errorCode: "INVALID_FIELD" });
  });
  it("CRUD: no object access => not found; create denied without permission; create+update allowed with it", async () => {
    await expect(client("sf_service").describeObject("Quote")).rejects.toMatchObject({ status: 404 });
    await expect(client("sf_analyst").createRecord("Case", { Subject: "x" })).rejects.toMatchObject({ errorCode: "INSUFFICIENT_ACCESS_OR_READONLY" });
    const svc = client("sf_service");
    const { id } = await svc.createRecord("Case", { Subject: "New one", Priority: "High" });
    expect((await svc.query<any>(`SELECT Subject, Status FROM Case WHERE Id = '${id}'`)).records[0]).toMatchObject({ Subject: "New one", Status: "New" });
    await svc.updateRecord("Case", id, { Status: "Closed" });
    expect((await svc.query<any>(`SELECT IsClosed FROM Case WHERE Id = '${id}'`)).records[0].IsClosed).toBe(true);
    await expect(svc.updateRecord("Case", id, { CaseNumber: "hack" })).rejects.toMatchObject({ errorCode: "INVALID_FIELD_FOR_INSERT_UPDATE" });
    await expect(svc.updateRecord("Case", id, { Priority: "Nope" })).rejects.toMatchObject({ errorCode: "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST" });
  });
  it("the mock itself refuses non-SELECT SOQL and counts API calls", async () => {
    const c = client("sf_admin");
    await expect(c.query("SELECT Id FROM Account; SELECT Id FROM User")).rejects.toThrow();
    await c.query("SELECT Id FROM Account");
    expect(c.apiCalls).toBe(1); // the rejected statement never reached the 'server'
  });
});
