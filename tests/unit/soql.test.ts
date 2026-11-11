import { describe, expect, it } from "vitest";
import { SoqlLiteral, assertFieldPath, assertIdentifier, assertReadOnlySoql, assertSalesforceId, buildSoql, escapeSoqlString } from "@sfcm/salesforce-client";

describe("SOQL builder & validation", () => {
  it("escapes quotes and backslashes", () => {
    expect(escapeSoqlString("O'Reilly \\ \"x\"\n")).toBe("O\\'Reilly \\\\ \\\"x\\\"\\n");
  });
  it("builds a parameter-free but fully escaped query", () => {
    const q = buildSoql({ object: "Account", fields: ["Id", "Name"], where: [{ field: "Name", op: "=", value: "x' OR Name != '" }], orderBy: [{ field: "Name" }], limit: 5, offset: 10 });
    expect(q).toBe("SELECT Id, Name FROM Account WHERE Name = 'x\\' OR Name != \\'' ORDER BY Name ASC LIMIT 5 OFFSET 10");
    expect(() => assertReadOnlySoql(q)).not.toThrow();
  });
  it("LIKE patterns escape wildcards from user text", () => {
    const q = buildSoql({ object: "Account", fields: ["Id"], where: [{ field: "Name", op: "LIKE", value: SoqlLiteral.like("50%_off") as never }] });
    expect(q).toContain("LIKE '%50\\%\\_off%'");
  });
  it("rejects malicious identifiers", () => {
    for (const bad of ["Account; DELETE", "Name FROM User--", "A.B.C.D.E.F.G", "1abc", "", "Na me"]) {
      expect(() => assertFieldPath(bad)).toThrow();
    }
    expect(() => assertIdentifier("Account__c")).not.toThrow();
    expect(() => buildSoql({ object: "Account WHERE 1=1", fields: ["Id"] })).toThrow();
    expect(() => buildSoql({ object: "Account", fields: ["Id FROM Contact--"] })).toThrow();
  });
  it("validates salesforce ids and numeric/limit bounds", () => {
    expect(() => assertSalesforceId("001000000000001AAA")).not.toThrow();
    expect(() => assertSalesforceId("001' OR '1'='1")).toThrow();
    expect(() => buildSoql({ object: "Account", fields: ["Id"], limit: 0 })).toThrow();
    expect(() => buildSoql({ object: "Account", fields: ["Id"], limit: 99999 })).toThrow();
    expect(() => buildSoql({ object: "Account", fields: ["Id"], where: [{ field: "AnnualRevenue", op: ">", value: Number.NaN }] })).toThrow();
  });
  it("date literals are validated", () => {
    expect(() => SoqlLiteral.date("2026-01-01")).not.toThrow();
    expect(() => SoqlLiteral.date("2026-01-01' OR 1=1")).toThrow();
    expect(() => SoqlLiteral.dateKeyword("LAST_N_DAYS:30")).not.toThrow();
    expect(() => SoqlLiteral.dateKeyword("TODAY OR Id != null")).toThrow();
  });
  it("assertReadOnlySoql blocks stacking, comments, DML words and subqueries", () => {
    for (const bad of [
      "DELETE FROM Account",
      "SELECT Id FROM Account; SELECT Id FROM User",
      "SELECT Id FROM Account -- x",
      "SELECT Id FROM Account /* x */",
      "SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)",
      "SELECT Id FROM Account WHERE Name = 'unterminated",
    ]) {
      expect(() => assertReadOnlySoql(bad), bad).toThrow();
    }
    // keywords inside string literals are fine
    expect(() => assertReadOnlySoql("SELECT Id FROM Account WHERE Name = 'DELETE; -- /* x */'")).not.toThrow();
  });
});
