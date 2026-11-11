import { describe, expect, it } from "vitest";
import { makePlatform, principal, run } from "../helpers/harness";

describe("Code Mode orchestration capabilities", () => {
  const p = makePlatform();
  const analyst = principal("analyst");

  it("supports Promise.all with parallel tool calls", async () => {
    const out = await run(p, analyst, `async () => {
      const [a, c, o] = await Promise.all([sf.searchAccounts({limit: 3}), sf.searchCases({limit: 3}), sf.getOpportunities({limit: 3})]);
      return [a.count, c.count, o.count];
    }`);
    expect(out.result).toEqual([3, 3, 3]);
    expect(out.metadata.toolCalls).toBe(3);
  });
  it("supports loops, conditionals and aggregation", async () => {
    const out = await run(p, analyst, `async () => {
      const accounts = (await sf.searchAccounts({ limit: 50 })).records;
      const totals: Record<string, number> = {};
      for (const a of accounts) {
        if (a.Industry === "Technology") continue;
        const opps = await sf.getOpportunities({ accountId: a.Id as string, isClosed: false });
        totals[a.Name as string] = opps.records.reduce((s, o) => s + (o.Amount ?? 0), 0);
      }
      return { n: Object.keys(totals).length, top: Object.entries(totals).sort((x, y) => y[1] - x[1])[0] };
    }`);
    expect(out.ok).toBe(true);
    expect((out.result as any).n).toBe(6);
    expect((out.result as any).top[0]).toBe("Wayne Financial");
  });
  it("supports pagination via hasMore/nextOffset", async () => {
    const out = await run(p, analyst, `async () => {
      const ids: string[] = []; let offset = 0;
      for (let page = 0; page < 20; page++) { // bounded: always cap pagination loops
        const r = await sf.getOpportunities({ limit: 4, offset });
        ids.push(...r.records.map(x => x.Id as string));
        if (!r.hasMore) break;
        offset = r.nextOffset as number;
      }
      return { total: ids.length, unique: new Set(ids).size };
    }`);
    expect(out.result).toEqual({ total: 16, unique: 16 });
    expect(out.metadata.toolCalls).toBe(4);
  });
  it("captures console output as logs and reports Salesforce API consumption", async () => {
    const out = await run(p, analyst, `async () => { console.log("hello", { a: 1 }); await sf.getAccount({ accountId: "001000000000001AAA" }); return "ok"; }`);
    expect(out.logs).toEqual(['hello {"a":1}']);
    expect(out.metadata.salesforceApiCalls).toBe(2); // describe (FLS) + query; describe is cached across calls
  });
  it("shares describe cache across calls in one execution", async () => {
    const out = await run(p, analyst, `async () => { await sf.getAccount({ accountId: "001000000000001AAA" }); await sf.getAccount({ accountId: "001000000000002AAA" }); return 1; }`);
    expect(out.metadata.salesforceApiCalls).toBe(3);
  });
  it("propagates tool errors into the program so it can handle them", async () => {
    const out = await run(p, analyst, `async () => { try { await sf.getAccount({ accountId: "bad" }); return "no" } catch (e) { return (e as Error).message } }`);
    expect(String(out.result)).toMatch(/^\[invalid_input\]/);
  });
  it("applies least-privilege capability references", async () => {
    const out = await run(p, analyst, `async () => { await sf.searchCases({}); return 1 }`, { capabilities: ["searchAccounts"] });
    expect(out.ok).toBe(false);
    expect(out.error?.message).toMatch(/not a function/); // binding does not exist in the sandbox at all
  });
  it("runs TypeScript with types and interfaces", async () => {
    const out = await run(p, analyst, `
      interface Row { name: string; amount: number }
      async function main(): Promise<Row[]> {
        const r = await sf.getOpportunities({ limit: 2, orderBy: "Amount", direction: "DESC" });
        return r.records.map((o): Row => ({ name: o.Name as string, amount: o.Amount as number }));
      }
    `);
    expect(out.ok).toBe(true);
    expect((out.result as any[]).length).toBe(2);
  });
  it("records executions in metrics", async () => {
    const s = await p.metrics.snapshot();
    expect(s.totalExecutions).toBeGreaterThan(5);
    expect(s.perTool.find((t) => t.tool === "getOpportunities")!.calls).toBeGreaterThan(3);
    expect(s.totalSalesforceApiCalls).toBeGreaterThan(0);
  });
});

describe("human approval workflow for writes", () => {
  const code = `async () => sf.createCase({ subject: "Follow up on SSO outage", priority: "High", accountId: "001000000000001AAA" })`;
  it("blocks the first attempt, then executes exactly once after a different user approves", async () => {
    const platform = makePlatform();
    const agent = principal("service_agent", { userId: "agent-1" });
    const before = platform.org.data.Case!.length;

    const first = await run(platform, agent, code);
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("approval_required");
    const approvalId = first.error!.approvalId!;
    expect(approvalId).toMatch(/^apr_/);
    expect(first.pendingApprovals).toEqual([approvalId]);
    expect(platform.org.data.Case!.length).toBe(before); // nothing written

    // requester cannot self-approve
    await expect(platform.governance.approvals.decide(approvalId, "agent-1", true)).rejects.toThrow(/own/);
    await platform.governance.approvals.decide(approvalId, "approver-1", true);

    const second = await run(platform, agent, code);
    expect(second.ok).toBe(true);
    expect((second.result as any).success).toBe(true);
    expect(platform.org.data.Case!.length).toBe(before + 1);

    // approval is single-use: running again needs a fresh approval
    const third = await run(platform, agent, code);
    expect(third.error?.code).toBe("approval_required");
    expect(third.error?.approvalId).not.toBe(approvalId);
    expect(platform.org.data.Case!.length).toBe(before + 1);

    const actions = (await platform.governance.audit.list(50)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["approval.requested", "approval.consumed"]));
  });
  it("a rejected approval never executes", async () => {
    const platform = makePlatform();
    const agent = principal("service_agent", { userId: "agent-1" });
    const first = await run(platform, agent, code);
    await platform.governance.approvals.decide(first.error!.approvalId!, "approver-1", false, "not now");
    const again = await run(platform, agent, code);
    expect(again.error?.code).toBe("approval_required");
    expect(platform.org.data.Case!.length).toBe(14);
  });
  it("approval for one set of arguments does not authorize different arguments", async () => {
    const platform = makePlatform();
    const agent = principal("service_agent", { userId: "agent-1" });
    const first = await run(platform, agent, code);
    await platform.governance.approvals.decide(first.error!.approvalId!, "approver-1", true);
    const tampered = await run(platform, agent, code.replace("High", "Low"));
    expect(tampered.error?.code).toBe("approval_required");
    expect(platform.org.data.Case!.length).toBe(14);
  });
  it("another user cannot use someone else's approval", async () => {
    const platform = makePlatform();
    const first = await run(platform, principal("service_agent", { userId: "agent-1" }), code);
    await platform.governance.approvals.decide(first.error!.approvalId!, "approver-1", true);
    const other = await run(platform, principal("service_agent", { userId: "agent-2" }), code);
    expect(other.error?.code).toBe("approval_required");
  });
  it("approval can be completed through the REST API (approver role) and updateCase works end to end", async () => {
    const platform = makePlatform();
    const { appFor, token } = await import("../helpers/harness");
    const app = appFor(platform);
    const agent = principal("service_agent", { userId: "u-service_agent" });
    const upd = `async () => sf.updateCase({ caseId: "500000000000001AAA", changes: { isEscalated: true, priority: "High" } })`;
    const first = await run(platform, agent, upd);
    const id = first.error!.approvalId!;
    const call = async (role: any, path: string, method = "GET", body?: unknown) =>
      app(new Request(`http://g${path}`, { method, headers: { authorization: `Bearer ${await token(role)}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
    expect((await call("service_agent", `/api/approvals/${id}/approve`, "POST", {})).status).toBe(403);
    expect((await call("admin", `/api/approvals/${id}/approve`, "POST", { reason: "ok" })).status).toBe(200);
    const done = await run(platform, agent, upd);
    expect(done.ok).toBe(true);
    expect(platform.org.data.Case!.find((c) => c.Id === "500000000000001AAA")!.IsEscalated).toBe(true);
  });
});
