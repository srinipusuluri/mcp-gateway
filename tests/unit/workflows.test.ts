import { describe, expect, it } from "vitest";
import { WORKFLOWS, extractAccountName, matchWorkflow } from "@sfcm/salesforce-mcp";
import { makePlatform, principal, run } from "../helpers/harness";

describe("the 10 demonstration workflows (mock Salesforce)", () => {
  it("there are exactly ten, with unique ids", () => {
    expect(WORKFLOWS.length).toBe(10);
    expect(new Set(WORKFLOWS.map((w) => w.id)).size).toBe(10);
  });
  const p = makePlatform();
  for (const w of WORKFLOWS) {
    it(`${w.id} runs successfully in ONE execution`, async () => {
      const out = await run(p, principal("admin"), w.build(w.defaults));
      expect(out.error, JSON.stringify(out.error)).toBeUndefined();
      expect(out.ok).toBe(true);
      expect(out.metadata.mode).toBe("mock");
      expect(out.metadata.toolCalls).toBeGreaterThan(1);
      expect((out.result as any)?.error).toBeUndefined();
    });
  }
  it("customer-risk flags the accounts with overdue invoices + cases + declining deals", async () => {
    const out = await run(p, principal("analyst"), WORKFLOWS.find((w) => w.id === "customer-risk")!.build({}));
    const names = (out.result as any).atRisk.map((a: any) => a.account);
    expect(names[0]).toBe("Umbrella Health");
    expect(names).toContain("Acme Corporation");
    expect(names).not.toContain("Wayne Financial");
  });
  it("service-intelligence paginates and finds escalations", async () => {
    const out = await run(p, principal("analyst"), WORKFLOWS.find((w) => w.id === "service-intelligence")!.build({}));
    const r = out.result as any;
    expect(r.openCases).toBe(11);
    expect(out.metadata.toolCalls).toBe(3); // 5 + 5 + 1 rows across three pages
    expect(r.escalationCandidates.length).toBeGreaterThanOrEqual(3);
    expect(r.escalationCandidates[0].ageDays).toBeGreaterThanOrEqual(r.escalationCandidates.at(-1).ageDays);
  });
  it("knowledge-assistant answers only from articles and cites sources", async () => {
    const out = await run(p, principal("analyst"), WORKFLOWS.find((w) => w.id === "knowledge-assistant")!.build({ question: "How do I fix API latency spikes?" }));
    const r = out.result as any;
    expect(r.grounded).toBe(true);
    expect(r.sources[0].urlName).toBe("api-latency-spikes");
    expect(r.answer).toContain("connection pooling");
    const none = await run(p, principal("analyst"), WORKFLOWS.find((w) => w.id === "knowledge-assistant")!.build({ question: "What is the airspeed of a swallow?" }));
    expect((none.result as any).grounded).toBe(false);
  });
  it("cross-system analysis joins NetSuite receivables with Salesforce pipeline", async () => {
    const out = await run(p, principal("analyst"), WORKFLOWS.find((w) => w.id === "cross-system-analysis")!.build({}));
    const r = out.result as any;
    expect(r.pipelineAtRisk.map((x: any) => x.account)).toContain("Umbrella Health");
    expect(r.totalOverdue).toBeGreaterThan(100_000);
  });
  it("template matcher + account extraction", () => {
    expect(matchWorkflow("Give me an account 360 for Globex Industries")?.id).toBe("account-360");
    expect(matchWorkflow("which customers are at risk of churn")?.id).toBe("customer-risk");
    expect(matchWorkflow("zzz")).toBeUndefined();
    expect(extractAccountName("account 360 for Globex Industries")).toBe("Globex Industries");
    expect(extractAccountName("show 'Umbrella Health' overview")).toBe("Umbrella Health");
  });
});
