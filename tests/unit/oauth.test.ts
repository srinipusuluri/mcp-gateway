import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@sfcm/governance";
import { SalesforceAuthError, SalesforceOAuth, TokenVault, VaultTokenProvider, type TokenSet } from "@sfcm/salesforce-client";
import { sha256Base64Url } from "@sfcm/security";

const KEY = Buffer.alloc(32, 7).toString("base64");
const cfg = { loginUrl: "https://test.salesforce.com/", clientId: "CID", clientSecret: "SEC", redirectUri: "https://gw.example.com/oauth/callback" };
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });

describe("Salesforce OAuth", () => {
  it("builds an authorization URL with PKCE S256 for sandbox login hosts", async () => {
    const o = new SalesforceOAuth(cfg);
    const a = await o.createAuthorization();
    const u = new URL(a.url);
    expect(u.origin).toBe("https://test.salesforce.com");
    expect(u.pathname).toBe("/services/oauth2/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(await sha256Base64Url(a.codeVerifier));
    expect(u.searchParams.get("state")).toBe(a.state);
    expect(u.searchParams.get("scope")).toBe("api refresh_token");
    expect(a.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(a.url).not.toContain(a.codeVerifier);
  });
  it("exchanges code with verifier and secret", async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => json(200, { access_token: "AT", refresh_token: "RT", instance_url: "https://x.my.salesforce.com", id: "https://login/id/1/2", scope: "api", issued_at: "123" }));
    const t = await new SalesforceOAuth({ ...cfg, fetch: f as never }).exchangeCode("CODE", "VERIFIER");
    expect(t).toMatchObject({ accessToken: "AT", refreshToken: "RT", instanceUrl: "https://x.my.salesforce.com" });
    const body = new URLSearchParams(String(f.mock.calls[0]![1].body));
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: "authorization_code", code: "CODE", code_verifier: "VERIFIER", client_id: "CID", client_secret: "SEC" });
  });
  it("refresh keeps the original refresh token; errors do not leak secrets", async () => {
    const ok = new SalesforceOAuth({ ...cfg, fetch: (async () => json(200, { access_token: "AT2", instance_url: "https://x.my.salesforce.com" })) as never });
    expect((await ok.refresh("RT")).refreshToken).toBe("RT");
    const bad = new SalesforceOAuth({ ...cfg, fetch: (async () => json(400, { error: "invalid_grant", error_description: "expired access/refresh token" })) as never });
    const e = (await bad.refresh("RT").catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(SalesforceAuthError);
    expect(e.message).not.toContain("SEC");
  });
  it("revokes tokens", async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => new Response(null, { status: 200 }));
    await new SalesforceOAuth({ ...cfg, fetch: f as never }).revoke("RT");
    expect(f.mock.calls[0]![0]).toBe("https://test.salesforce.com/services/oauth2/revoke");
  });
  it("vault stores tokens encrypted at rest", async () => {
    const store = new MemoryStore();
    const vault = new TokenVault(store, KEY);
    const t: TokenSet = { accessToken: "SECRET-ACCESS", refreshToken: "SECRET-REFRESH", instanceUrl: "https://x", issuedAt: 1 };
    await vault.save("u1", t);
    const raw = await store.get<string>("sftoken:u1");
    expect(raw).toBeTypeOf("string");
    expect(raw).not.toContain("SECRET");
    expect(await vault.get("u1")).toEqual(t);
    await vault.delete("u1");
    expect(await vault.get("u1")).toBeUndefined();
    await expect(new TokenVault(store, Buffer.alloc(32, 9).toString("base64")).get("u1")).resolves.toBeUndefined();
  });
  it("token provider refreshes, persists, and clears the vault when the session cannot be renewed", async () => {
    const store = new MemoryStore();
    const vault = new TokenVault(store, KEY);
    await vault.save("u1", { accessToken: "old", refreshToken: "RT", instanceUrl: "https://x", issuedAt: 1 });
    const goodOauth = new SalesforceOAuth({ ...cfg, fetch: (async () => json(200, { access_token: "new", instance_url: "https://x" })) as never });
    const p = new VaultTokenProvider("u1", vault, goodOauth);
    expect(await p.getAccessToken()).toBe("old");
    expect(await p.refresh()).toBe("new");
    expect((await vault.get("u1"))!.accessToken).toBe("new");
    const badOauth = new SalesforceOAuth({ ...cfg, fetch: (async () => json(400, { error: "invalid_grant" })) as never });
    const p2 = new VaultTokenProvider("u1", vault, badOauth);
    await expect(p2.refresh()).rejects.toThrow(/expired/i);
    expect(await vault.get("u1")).toBeUndefined();
    await expect(new VaultTokenProvider("nobody", vault, badOauth).getAccessToken()).rejects.toBeInstanceOf(SalesforceAuthError);
  });
});
