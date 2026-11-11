import { describe, expect, it } from "vitest";
import { appFor, makePlatform, token } from "../helpers/harness";

const call = async (app: ReturnType<typeof appFor>, role: any, path: string, method = "GET", body?: unknown): Promise<{ status: number; json(): Promise<any> }> =>
  app(new Request(`http://g${path}`, { method, headers: { authorization: `Bearer ${await token(role)}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));

describe("dashboard REST API", () => {
  const platform = makePlatform();
  const app = appFor(platform);

  it("health is public; everything else under /api requires auth", async () => {
    expect((await app(new Request("http://g/health"))).status).toBe(200);
    expect((await app(new Request("http://g/api/status"))).status).toBe(401);
    expect((await app(new Request("http://g/api/nope"))).status).toBe(401);
  });
  it("status reports registry, sandbox and Salesforce connection (mock)", async () => {
    const s = await (await call(app, "analyst", "/api/status")).json();
    expect(s.mode).toBe("mock");
    expect(s.registry.total).toBeGreaterThanOrEqual(29);
    expect(s.registry.writeTools).toBe(3);
    expect(s.sandbox.runtime).toBe("quickjs-wasm");
    expect(s.salesforce.connected).toBe(true);
    expect(s.mcp.tools).toEqual(["discover_capabilities", "execute_code"]);
  });
  it("tool explorer: lists permitted tools, lets you test one, enforces RBAC", async () => {
    const t = await (await call(app, "analyst", "/api/tools")).json();
    expect(t.capabilities.length).toBeGreaterThan(20);
    expect(t.denied.map((x: any) => x.name)).toContain("createCase");
    const ok = await (await call(app, "analyst", "/api/tools/searchAccounts/invoke", "POST", { input: { query: "Acme" } })).json();
    expect(ok.ok).toBe(true);
    expect(ok.result.records[0].Name).toBe("Acme Corporation");
    const bad = await (await call(app, "analyst", "/api/tools/createCase/invoke", "POST", { input: { subject: "abc" } })).json();
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("tool_not_allowed");
    const invalid = await (await call(app, "analyst", "/api/tools/getAccount/invoke", "POST", { input: { accountId: "x" } })).json();
    expect(invalid.error.code).toBe("invalid_input");
  });
  it("playground: generate from template, execute, and read monitoring", async () => {
    const g = await (await call(app, "analyst", "/api/playground/generate", "POST", { task: "Give me an account 360 for Globex Industries" })).json();
    expect(g.generator).toBe("template");
    expect(g.code).toContain("Globex Industries");
    const e = await (await call(app, "analyst", "/api/execute", "POST", { code: g.code })).json();
    expect(e.ok).toBe(true);
    expect(e.result.account.name).toBe("Globex Industries");
    const none = await (await call(app, "analyst", "/api/playground/generate", "POST", { task: "zzzzzz qqqq" })).json();
    expect(none.code).toBeNull();
    const m = await (await call(app, "admin", "/api/metrics")).json();
    expect(m.totalExecutions).toBeGreaterThanOrEqual(1);
    const ex = await (await call(app, "admin", "/api/executions")).json();
    expect(ex.executions[0].trace.length).toBeGreaterThan(0);
  });
  it("security center: only auditors see users/audit; chain verifies; policy visible", async () => {
    expect((await call(app, "analyst", "/api/audit")).status).toBe(403);
    expect((await call(app, "analyst", "/api/security/users")).status).toBe(403);
    const a = await (await call(app, "admin", "/api/audit")).json();
    expect(a.events.length).toBeGreaterThan(0);
    expect((await (await call(app, "admin", "/api/audit/verify")).json()).valid).toBe(true);
    const users = await (await call(app, "admin", "/api/security/users")).json();
    expect(users.users.length).toBeGreaterThan(1);
    const sec = await (await call(app, "analyst", "/api/security/overview")).json();
    expect(sec.policy.writesRequireApproval).toBe(true);
    expect(sec.toolPermissions.find((t: any) => t.tool === "createCase")).toMatchObject({ requiresApproval: true, allowedForYou: false });
  });
  it("dev tokens are issued only when enabled", async () => {
    const r = await app(new Request("http://g/api/dev/token", { method: "POST", body: JSON.stringify({ role: "analyst" }) }));
    expect(r.status).toBe(200);
    const off = appFor(makePlatform({ ALLOW_DEV_TOKENS: "false" }));
    expect((await off(new Request("http://g/api/dev/token", { method: "POST", body: JSON.stringify({ role: "admin" }) }))).status).toBe(403);
  });
  it("oauth endpoints are unavailable in mock mode", async () => {
    expect((await call(app, "analyst", "/api/oauth/start", "POST")).status).toBe(501);
  });
  it("rejects oversized and malformed bodies", async () => {
    const r = await app(new Request("http://g/api/execute", { method: "POST", headers: { authorization: `Bearer ${await token("analyst")}` }, body: "{not json" }));
    expect(r.status).toBe(400);
    expect((await call(app, "analyst", "/api/execute", "POST", { code: "" })).status).toBe(400);
  });
});
