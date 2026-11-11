import { describe, expect, it } from "vitest";
import { GatewayError, REDACTED, authenticateBearer, capResult, decryptJson, encryptJson, redactValue, signToken, toSafeError } from "@sfcm/security";

const SECRET = "unit-secret-unit-secret-unit-secret-00";

describe("result filtering (redaction)", () => {
  it("redacts sensitive keys, SSNs, Luhn-valid cards, bearer tokens and session ids", () => {
    const { value, redactions } = redactValue({
      Name: "Acme", Password__c: "hunter2", Tax_ID__c: "12-3", access_token: "abc",
      note: "ssn 123-45-6789 card 4111 1111 1111 1111 order 1234 5678 9012 3456 bearer Bearer abcdefghijklmnopqrstuvwxyz012345",
      nested: [{ client_secret: "x", ok: 1 }],
      sid: "00D5g000000XXXXAAA!AQEAQ1234567890abcdefghijkl",
    });
    expect(JSON.stringify(value)).not.toMatch(/hunter2|123-45-6789|4111 1111|abcdefghijklmnopqrstuvwxyz012345|AQEAQ1234/);
    expect((value as any).Name).toBe("Acme");
    expect((value as any).Password__c).toBe(REDACTED);
    expect((value as any).note).toContain("1234 5678 9012 3456"); // not Luhn-valid: left alone
    expect((value as any).nested[0].ok).toBe(1);
    expect(redactions).toBeGreaterThanOrEqual(7);
  });
  it("honours extra sensitive fields and does not mutate input", () => {
    const input = { Secret_Sauce__c: "x", keep: "y" };
    const { value } = redactValue(input, { extraSensitiveFields: ["keep"] });
    expect((value as any).keep).toBe(REDACTED);
    expect(input.keep).toBe("y");
  });
});

describe("result size limits", () => {
  it("passes small values through", () => expect(capResult({ a: 1 }, 1000)).toMatchObject({ truncated: false }));
  it("truncates arrays and reports counts", () => {
    const r = capResult(Array.from({ length: 5000 }, (_, i) => ({ i, pad: "x".repeat(50) })), 10_000);
    expect(r.truncated).toBe(true);
    const v = r.value as any;
    expect(v._truncated).toBe(true);
    expect(v.originalCount).toBe(5000);
    expect(JSON.stringify(r.value).length).toBeLessThanOrEqual(10_000);
  });
  it("shrinks big arrays inside objects", () => {
    const r = capResult({ keep: 1, rows: Array.from({ length: 2000 }, () => "y".repeat(40)) }, 5000);
    expect(r.truncated).toBe(true);
    expect(JSON.stringify(r.value).length).toBeLessThanOrEqual(5000);
  });
  it("rejects values that cannot be truncated safely", () => {
    expect(() => capResult("x".repeat(100_000), 1000)).toThrow(GatewayError);
  });
});

describe("gateway authentication", () => {
  it("accepts a valid token and maps roles", async () => {
    const t = await signToken({ sub: "u1", roles: ["analyst", "approver"], email: "a@b.c" }, SECRET);
    const p = await authenticateBearer(`Bearer ${t}`, { jwtSecret: SECRET });
    expect(p).toMatchObject({ userId: "u1", roles: ["analyst", "approver"], email: "a@b.c" });
  });
  it("rejects missing, malformed, wrong-secret, expired and unknown-role tokens", async () => {
    await expect(authenticateBearer(null, { jwtSecret: SECRET })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(authenticateBearer("Basic abc", { jwtSecret: SECRET })).rejects.toMatchObject({ code: "unauthenticated" });
    const wrong = await signToken({ sub: "u", roles: ["admin"] }, "another-secret-another-secret-another-1");
    await expect(authenticateBearer(`Bearer ${wrong}`, { jwtSecret: SECRET })).rejects.toMatchObject({ code: "unauthenticated" });
    const expired = await signToken({ sub: "u", roles: ["admin"] }, SECRET, { expiresInSeconds: -10 });
    await expect(authenticateBearer(`Bearer ${expired}`, { jwtSecret: SECRET })).rejects.toMatchObject({ code: "unauthenticated" });
    const bogus = await signToken({ sub: "u", roles: ["superuser" as never] }, SECRET);
    expect((await authenticateBearer(`Bearer ${bogus}`, { jwtSecret: SECRET })).roles).toEqual(["viewer"]); // unknown roles never elevate
  });
  it("rejects alg=none tokens", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const t = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "x", roles: ["admin"] })}.`;
    await expect(authenticateBearer(`Bearer ${t}`, { jwtSecret: SECRET })).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("crypto + safe errors", () => {
  it("AES-GCM round trip and tamper detection", async () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    const blob = await encryptJson({ a: 1 }, key);
    expect(await decryptJson(blob, key)).toEqual({ a: 1 });
    await expect(decryptJson(blob.slice(0, -2) + "AA", key)).rejects.toThrow();
  });
  it("toSafeError hides internals", () => {
    const s = toSafeError(new Error("ECONNREFUSED 10.0.0.5 token=abc"));
    expect(s.code).toBe("internal_error");
    expect(s.message).not.toMatch(/10\.0|token/);
  });
});
