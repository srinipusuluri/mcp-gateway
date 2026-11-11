import { describe, expect, it } from "vitest";
import { ApprovalService, AuditLog, IdempotencyStore, MemoryStore, PolicyEngine, RateLimiter, can, defaultPolicy, fingerprint, canonicalJson } from "@sfcm/governance";
import type { Principal } from "@sfcm/shared-types";

const P = (roles: Principal["roles"], userId = "u"): Principal => ({ userId, roles });

describe("RBAC + policy", () => {
  it("deny by default; roles grant only their permissions", () => {
    expect(can(P(["viewer"]), "sf.read.sales")).toBe(false);
    expect(can(P(["viewer"]), "sf.read.metadata")).toBe(true);
    expect(can(P(["analyst"]), "sf.write.case")).toBe(false);
    expect(can(P(["service_agent"]), "sf.write.case")).toBe(true);
    expect(can(P(["approver"]), "execute")).toBe(false);
    expect(can(P(["admin"]), "sf.write.case")).toBe(true);
  });
  it("authorizeTool enforces allowlist, write switch and permission", () => {
    const tool = { name: "createCase", kind: "write" as const, permission: "sf.write.case" as const };
    expect(() => new PolicyEngine(defaultPolicy()).authorizeTool(P(["service_agent"]), tool)).not.toThrow();
    expect(() => new PolicyEngine(defaultPolicy()).authorizeTool(P(["analyst"]), tool)).toThrow(/may not use/);
    expect(() => new PolicyEngine(defaultPolicy({ writesEnabled: false })).authorizeTool(P(["admin"]), tool)).toThrow(/disabled/);
    expect(() => new PolicyEngine(defaultPolicy({ toolAllowlist: ["getAccount"] })).authorizeTool(P(["admin"]), tool)).toThrow(/allowlist/);
  });
  it("clamps limits to policy", () => {
    const e = new PolicyEngine(defaultPolicy({ maxRecordsPerQuery: 50 }));
    expect(e.clampLimit(9999)).toBe(50);
    expect(e.clampLimit(undefined)).toBe(50);
    expect(e.clampLimit(0)).toBe(1);
  });
});

describe("approvals", () => {
  const mk = (o: Partial<{ ttlMs: number; allowSelfApproval: boolean }> = {}) => new ApprovalService(new MemoryStore(), { ttlMs: 60_000, allowSelfApproval: false, ...o });
  it("canonicalJson/fingerprint ignore key order but not content or requester", async () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(await fingerprint("t", { a: 1, b: 2 }, "u")).toBe(await fingerprint("t", { b: 2, a: 1 }, "u"));
    expect(await fingerprint("t", { a: 1 }, "u")).not.toBe(await fingerprint("t", { a: 2 }, "u"));
    expect(await fingerprint("t", { a: 1 }, "u")).not.toBe(await fingerprint("t", { a: 1 }, "v"));
  });
  it("request -> approve -> consume once, bound to exact args and requester", async () => {
    const s = mk();
    const r = await s.requestOrGet("createCase", { subject: "x" }, "alice");
    expect((await s.requestOrGet("createCase", { subject: "x" }, "alice")).id).toBe(r.id);
    expect(await s.consumeIfApproved("createCase", { subject: "x" }, "alice")).toBeUndefined();
    await s.decide(r.id, "bob", true);
    expect(await s.consumeIfApproved("createCase", { subject: "DIFFERENT" }, "alice")).toBeUndefined();
    expect(await s.consumeIfApproved("createCase", { subject: "x" }, "mallory")).toBeUndefined();
    expect((await s.consumeIfApproved("createCase", { subject: "x" }, "alice"))?.status).toBe("consumed");
    expect(await s.consumeIfApproved("createCase", { subject: "x" }, "alice")).toBeUndefined();
  });
  it("four-eyes: requester cannot self-approve; rejected/expired cannot be used", async () => {
    const s = mk();
    const r = await s.requestOrGet("t", {}, "alice");
    await expect(s.decide(r.id, "alice", true)).rejects.toThrow(/own/);
    await s.decide(r.id, "bob", false);
    await expect(s.decide(r.id, "bob", true)).rejects.toThrow(/already rejected/);
    expect(await s.consumeIfApproved("t", {}, "alice")).toBeUndefined();
    const e = mk({ ttlMs: 1 });
    const x = await e.requestOrGet("t", {}, "alice");
    await new Promise((r) => setTimeout(r, 5));
    expect((await e.get(x.id))?.status).toBe("expired");
    await expect(e.decide(x.id, "bob", true)).rejects.toThrow(/expired/);
  });
});

describe("audit, rate limit, idempotency", () => {
  it("audit chain verifies and detects tampering", async () => {
    const store = new MemoryStore();
    const log = new AuditLog(store);
    for (let i = 0; i < 4; i++) await log.append({ action: "execute", userId: "u", outcome: "success", resource: `r${i}` });
    expect(await log.verify()).toMatchObject({ valid: true, checked: 4 });
    const key = "audit:e:000000000002";
    const ev = (await store.get<any>(key))!;
    await store.put(key, { ...ev, outcome: "denied" });
    expect(await log.verify()).toMatchObject({ valid: false, brokenAt: 2 });
    expect((await log.list(2)).length).toBe(2);
  });
  it("audit detects deletion", async () => {
    const store = new MemoryStore();
    const log = new AuditLog(store);
    for (let i = 0; i < 3; i++) await log.append({ action: "execute", userId: "u", outcome: "success" });
    await store.delete("audit:e:000000000002");
    expect((await log.verify()).valid).toBe(false);
  });
  it("rate limiter enforces windows per bucket", async () => {
    const rl = new RateLimiter(new MemoryStore());
    await rl.check("a", 2);
    await rl.check("a", 2);
    await expect(rl.check("a", 2)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    await expect(rl.check("b", 2)).resolves.toBeTruthy();
  });
  it("idempotency replays instead of re-running", async () => {
    const i = new IdempotencyStore(new MemoryStore());
    let n = 0;
    const a = await i.run("k", async () => ++n);
    const b = await i.run("k", async () => ++n);
    expect([a.value, a.replayed, b.value, b.replayed, n]).toEqual([1, false, 1, true, 1]);
  });
  it("is race-free under parallel callers (no lost audit events, exact rate limit, single approval, single execution)", async () => {
    const store = new MemoryStore();
    const log = new AuditLog(store);
    await Promise.all(Array.from({ length: 60 }, (_, i) => log.append({ action: "tool.invoke", userId: "u", outcome: "success", resource: `r${i}` })));
    expect((await log.list(1000)).length).toBe(60);
    expect(await log.verify()).toMatchObject({ valid: true, checked: 60 });

    const rl = new RateLimiter(new MemoryStore());
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => rl.check("x", 5)));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(5);

    const approvals = new ApprovalService(new MemoryStore(), { ttlMs: 60_000, allowSelfApproval: false });
    const reqs = await Promise.all(Array.from({ length: 10 }, () => approvals.requestOrGet("createCase", { s: 1 }, "alice")));
    expect(new Set(reqs.map((r) => r.id)).size).toBe(1);
    await approvals.decide(reqs[0]!.id, "bob", true);
    const consumed = await Promise.all(Array.from({ length: 10 }, () => approvals.consumeIfApproved("createCase", { s: 1 }, "alice")));
    expect(consumed.filter(Boolean).length).toBe(1);

    const idem = new IdempotencyStore(new MemoryStore());
    let runs = 0;
    await Promise.all(Array.from({ length: 10 }, () => idem.run("k", async () => { await new Promise((r) => setTimeout(r, 2)); return ++runs; })));
    expect(runs).toBe(1);
  });
});
