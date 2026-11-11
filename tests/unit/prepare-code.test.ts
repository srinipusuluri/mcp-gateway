import { describe, expect, it } from "vitest";
import { prepareCode } from "@sfcm/codemode-runtime";

const prep = (c: string, maxBytes = 20_000) => prepareCode(c, { maxBytes }).code;

describe("code preparation", () => {
  it("strips TypeScript types and accepts fenced code", () => {
    const out = prep("```ts\nasync (): Promise<number> => { const x: number = 1; return x as number; }\n```");
    expect(out).not.toMatch(/: number|Promise</);
    expect(out).toMatch(/async/);
  });
  it("wraps bare statements and trailing expressions", () => {
    expect(prep("const a = await sf.getAccount({accountId:'x'}); return a;")).toMatch(/^async \(\) => \{/);
    expect(prep("1 + 1")).toContain("return (1 + 1)");
  });
  it("enforces the maximum code size", () => {
    expect(() => prep("x".repeat(100), 50)).toThrow(/maximum is 50/);
  });
  it.each([
    ["eval('1')", /eval/],
    ["new Function('return 1')()", /Function/],
    ["(async () => { await fetch('https://evil.example') })", /fetch/],
    ["import fs from 'fs'", /import/],
    ["const p = await import('x')", /import/],
    ["process.env.SECRET", /process/],
    ["require('child_process')", /require/],
    ["globalThis.fetch", /globalThis/],
    ["({}).constructor.constructor('return this')()", /constructor/],
    ["x['__proto__']", /__proto__/],
    ["new WebSocket('wss://x')", /WebSocket/],
    ["WebAssembly.instantiate", /WebAssembly/],
  ])("rejects %s", (code, re) => {
    expect(() => prep(code)).toThrowError(re);
  });
  it("does not flag harmless property names", () => {
    expect(() => prep("async () => ({ process: 1, fetch: 2, env: 3, self: 4 }).process")).not.toThrow();
  });
  it("reports syntax errors as code_rejected", () => {
    expect(() => prep("async () => {")).toThrowError(/yntax/);
    expect(() => prep("   ")).toThrow(/empty/);
  });
});
