import { describe, expect, it } from "vitest";
import { WORKFLOWS } from "@sfcm/salesforce-mcp";
import { makePlatform, principal, run } from "../helpers/harness";

describe("Account 360 end to end (mock Salesforce, QuickJS sandbox)", () => {
  it("returns account, contacts, opportunities and open cases from one execution", async () => {
    const p = makePlatform();
    const w = WORKFLOWS.find((x) => x.id === "account-360")!;
    const out = await run(p, principal("analyst"), w.build(w.defaults));
    expect(out.error).toBeUndefined();
    expect(out.ok).toBe(true);
    const r = out.result as any;
    expect(r.account.name).toBe("Acme Corporation");
    expect(r.contacts.length).toBe(3);
    expect(r.opportunities.open).toBe(2);
    expect(r.openCases.length).toBe(3);
    expect(out.metadata.mode).toBe("mock");
    expect(out.metadata.toolCalls).toBe(4);
    expect(out.trace.map((t) => t.tool)).toContain("getOpenCasesByAccount");
  });
});
