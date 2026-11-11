import { describe, expect, it, vi } from "vitest";
import { SalesforceApiError, SalesforceAuthError, SalesforceClient, type TokenProvider } from "@sfcm/salesforce-client";

function tokens(overrides: Partial<TokenProvider> = {}): TokenProvider {
  let t = "tok1";
  return { getAccessToken: async () => t, refresh: async () => (t = "tok2"), instanceUrl: async () => "https://acme.my.salesforce.com", ...overrides };
}
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

describe("SalesforceClient (REST)", () => {
  it("queries with bearer token, strips attributes, tracks API usage header", async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => res(200, { totalSize: 1, done: true, records: [{ attributes: { type: "Account" }, Id: "1", Name: "A" }] }, { "Sforce-Limit-Info": "api-usage=25/15000" }));
    const c = new SalesforceClient({ tokens: tokens(), fetch: f as never, apiVersion: "66.0" });
    const r = await c.query("SELECT Id, Name FROM Account");
    expect(r.records).toEqual([{ Id: "1", Name: "A" }]);
    expect(f.mock.calls[0]![0]).toContain("https://acme.my.salesforce.com/services/data/v66.0/query?q=");
    expect((f.mock.calls[0]![1].headers as Record<string, string>).Authorization).toBe("Bearer tok1");
    expect(c.apiUsage()).toEqual({ used: 25, limit: 15000 });
    expect(c.apiCalls).toBe(1);
  });
  it("follows nextRecordsUrl until maxRecords", async () => {
    const pages = [
      res(200, { totalSize: 5, done: false, nextRecordsUrl: "/services/data/v66.0/query/01g-2000", records: [{ Id: "1" }, { Id: "2" }] }),
      res(200, { totalSize: 5, done: true, records: [{ Id: "3" }, { Id: "4" }, { Id: "5" }] }),
    ];
    const c = new SalesforceClient({ tokens: tokens(), fetch: (async () => pages.shift()!) as never });
    const r = await c.query("SELECT Id FROM Account", { maxRecords: 4 });
    expect(r.records.map((x) => (x as { Id: string }).Id)).toEqual(["1", "2", "3", "4"]);
    expect(r.done).toBe(false);
  });
  it("refreshes once on 401 and retries with the new token", async () => {
    const seen: string[] = [];
    const f = vi.fn(async (_u: string, i: RequestInit) => {
      seen.push((i.headers as Record<string, string>).Authorization!);
      return seen.length === 1 ? res(401, [{ errorCode: "INVALID_SESSION_ID", message: "expired" }]) : res(200, { totalSize: 0, done: true, records: [] });
    });
    const c = new SalesforceClient({ tokens: tokens(), fetch: f as never });
    await c.query("SELECT Id FROM Account");
    expect(seen).toEqual(["Bearer tok1", "Bearer tok2"]);
  });
  it("surfaces session expiry when refresh fails", async () => {
    const c = new SalesforceClient({ tokens: tokens({ refresh: async () => { throw new SalesforceAuthError("expired"); } }), fetch: (async () => res(401, [{ errorCode: "INVALID_SESSION_ID", message: "x" }])) as never });
    await expect(c.query("SELECT Id FROM Account")).rejects.toBeInstanceOf(SalesforceAuthError);
  });
  it("retries 503 with backoff then succeeds; gives up after maxRetries", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const ok = new SalesforceClient({ tokens: tokens(), sleep: async (ms) => void sleeps.push(ms), fetch: (async () => (++n < 3 ? res(503, [{ errorCode: "SERVER_UNAVAILABLE", message: "busy" }]) : res(200, { totalSize: 0, done: true, records: [] }))) as never });
    await ok.query("SELECT Id FROM Account");
    expect(sleeps).toEqual([250, 500]);
    const bad = new SalesforceClient({ tokens: tokens(), sleep: async () => undefined, maxRetries: 1, fetch: (async () => res(503, [{ errorCode: "SERVER_UNAVAILABLE", message: "busy" }])) as never });
    await expect(bad.query("SELECT Id FROM Account")).rejects.toMatchObject({ status: 503, errorCode: "SERVER_UNAVAILABLE" });
  });
  it("maps API errors without leaking tokens", async () => {
    const c = new SalesforceClient({ tokens: tokens(), fetch: (async () => res(400, [{ errorCode: "INVALID_FIELD", message: "No such column 'X'" }])) as never });
    const e = (await c.query("SELECT X FROM Account").catch((x: unknown) => x)) as SalesforceApiError;
    expect(e).toBeInstanceOf(SalesforceApiError);
    expect(e.errorCode).toBe("INVALID_FIELD");
    expect(JSON.stringify(e)).not.toContain("tok1");
  });
  it("refuses non-read-only SOQL before any network call", async () => {
    const f = vi.fn();
    const c = new SalesforceClient({ tokens: tokens(), fetch: f as never });
    await expect(c.query("SELECT Id FROM Account; DELETE FROM Account")).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
  it("create/update use REST verbs and validate ids", async () => {
    const calls: Array<[string, string]> = [];
    const c = new SalesforceClient({ tokens: tokens(), fetch: (async (u: string, i: RequestInit) => (calls.push([i.method!, u]), i.method === "PATCH" ? res(204, undefined) : res(201, { id: "500000000000001AAA", success: true }))) as never });
    expect(await c.createRecord("Case", { Subject: "x" })).toEqual({ id: "500000000000001AAA", success: true });
    expect(await c.updateRecord("Case", "500000000000001AAA", { Status: "Closed" })).toEqual({ id: "500000000000001AAA", success: true });
    expect(calls.map((x) => x[0])).toEqual(["POST", "PATCH"]);
    await expect(c.updateRecord("Case", "bad id!", {})).rejects.toThrow();
  });
});
