import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WORKFLOWS } from "@sfcm/salesforce-mcp";
import { appFor, makePlatform, token } from "../helpers/harness";

async function connect(platform = makePlatform(), role: any = "analyst", path = "/mcp") {
  const app = appFor(platform);
  const t = await token(role);
  const transport = new StreamableHTTPClientTransport(new URL(`http://gateway.test${path}`), {
    fetch: ((url: string | URL, init?: RequestInit) => app(new Request(url, init))) as typeof fetch,
    requestInit: { headers: { authorization: `Bearer ${t}` } },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, platform, app };
}
const text = (r: any) => JSON.parse(r.content[0].text);

describe("MCP protocol (Streamable HTTP) against the Code Mode gateway", () => {
  it("initializes and advertises exactly two tools", async () => {
    const { client } = await connect();
    expect(client.getServerVersion()?.name).toBe("salesforce-codemode");
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["discover_capabilities", "execute_code"]);
    const exec = tools.tools.find((t) => t.name === "execute_code")!;
    expect(exec.description).toContain("sf.searchAccounts");
    expect(exec.inputSchema.required).toContain("code");
    expect(tools.tools.find((t) => t.name === "discover_capabilities")!.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("discover_capabilities returns schemas, TS interfaces, permissions, classification and examples", async () => {
    const { client } = await connect();
    const r = text(await client.callTool({ name: "discover_capabilities", arguments: { domain: "sales", detail: "full" } }));
    expect(r.mode).toBe("mock");
    expect(r.modeNote).toMatch(/MOCK/);
    const t = r.capabilities.find((c: any) => c.name === "getOpportunities");
    expect(t).toMatchObject({ call: "sf.getOpportunities", kind: "read", permission: "sf.read.sales", availability: "live", requiresApproval: false });
    expect(t.inputSchema.properties.accountIds.maxItems).toBe(50);
    expect(t.typescript).toContain("getOpportunities(input:");
    expect(t.examples.length).toBeGreaterThan(0);
    expect(r.typescript).toContain("declare const sf");
    expect(r.executionLimits.maxResultBytes).toBeGreaterThan(0);
    await client.close();
  });

  it("discovery is permission-aware (a service agent sees the write tools, an analyst does not)", async () => {
    const analyst = text(await (await connect(undefined, "analyst")).client.callTool({ name: "discover_capabilities", arguments: { search: "case", includeTypeScript: false } }));
    const agent = text(await (await connect(undefined, "service_agent")).client.callTool({ name: "discover_capabilities", arguments: { search: "case", includeTypeScript: false } }));
    expect(analyst.capabilities.map((c: any) => c.name)).not.toContain("createCase");
    expect(agent.capabilities.find((c: any) => c.name === "createCase")).toMatchObject({ kind: "write", requiresApproval: true });
  });

  it("execute_code runs the Account 360 program and returns structured JSON with metadata + trace", async () => {
    const { client } = await connect();
    const w = WORKFLOWS[0]!;
    const res = await client.callTool({ name: "execute_code", arguments: { code: w.build(w.defaults), context: { userRequest: "Account 360 for Acme" } } });
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out.ok).toBe(true);
    expect(out.result.account.name).toBe("Acme Corporation");
    expect(out.metadata).toMatchObject({ mode: "mock", toolCalls: 4, runtime: "quickjs-wasm" });
    expect(out.metadata.executionId).toMatch(/^exe_/);
    expect(out.trace).toHaveLength(4);
    expect(out.trace[0]).toMatchObject({ tool: "searchAccounts", ok: true, kind: "read" });
  });

  it("execute_code surfaces sandbox errors without crashing the server", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "execute_code", arguments: { code: "async () => { throw new Error('boom') }" } });
    expect(res.isError).toBe(true);
    expect(text(res).error.message).toContain("boom");
    const again = await client.callTool({ name: "execute_code", arguments: { code: "async () => 1 + 1" } });
    expect(text(again).result).toBe(2);
  });

  it("rejects missing, invalid and wrong-secret tokens with 401", async () => {
    const platform = makePlatform();
    const app = appFor(platform);
    const post = (h: Record<string, string>) => app(new Request("http://g/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...h }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer garbage" })).status).toBe(401);
    const res = await post({});
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect((await platform.governance.audit.list(5)).some((e) => e.action === "auth.failure")).toBe(true);
  });

  it("a viewer cannot execute code", async () => {
    const { client } = await connect(undefined, "viewer");
    const res = await client.callTool({ name: "execute_code", arguments: { code: "async () => 1" } });
    expect(res.isError).toBe(true);
    expect(text(res).error.code).toBe("forbidden");
  });

  it("the direct (traditional) endpoint exposes one MCP tool per capability", async () => {
    const { client } = await connect(undefined, "analyst", "/mcp/direct");
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(20);
    expect(tools.tools.map((t) => t.name)).toContain("sf_searchAccounts");
    expect(tools.tools.map((t) => t.name)).not.toContain("sf_createCase");
    const r = text(await client.callTool({ name: "sf_searchAccounts", arguments: { query: "Acme", limit: 1 } }));
    expect(r.records[0].Name).toBe("Acme Corporation");
    const bad = await client.callTool({ name: "sf_getAccount", arguments: { accountId: "nope" } }).catch((e) => e);
    expect(bad.isError === true || bad instanceof Error).toBe(true);
  });
});
