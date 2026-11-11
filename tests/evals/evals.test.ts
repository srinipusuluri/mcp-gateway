import { describe, expect, it } from "vitest";
import { hitAtK, ndcgAtK, prf, recallAtK, reciprocalRank, scoreTrajectory, tokenSupport, wilson } from "@sfcm/evals";
import { runAgentSuite, runGuardrailSuite, runRagSuite, runToolSuite } from "./suites";

describe("eval metrics", () => {
  it("retrieval metrics match hand-computed values", () => {
    const rel = new Set(["b"]);
    expect(hitAtK(["a", "b"], rel, 2)).toBe(1);
    expect(reciprocalRank(["a", "b"], rel)).toBe(0.5);
    expect(recallAtK(["a"], rel, 1)).toBe(0);
    expect(ndcgAtK(["b", "a"], rel, 2)).toBe(1);
    expect(hitAtK([], new Set(), 3)).toBe(1); // unanswerable + nothing retrieved = correct
  });
  it("trajectory, grounding, P/R and Wilson interval", () => {
    const t = scoreTrajectory(["searchAccounts", "createCase"], { expected: ["searchAccounts"], forbidden: ["createCase"], maxCalls: 1 });
    expect(t.forbiddenCalls).toEqual(["createCase"]);
    expect(t.withinBudget).toBe(0);
    expect(tokenSupport("enable connection pooling", "Enable connection pooling and keep-alive")).toBe(1);
    expect(prf({ tp: 9, fp: 1, tn: 9, fn: 1 }).f1).toBeCloseTo(0.9);
    const ci = wilson(10, 10);
    expect(ci.high).toBe(1);
    expect(ci.low).toBeGreaterThan(0.65);
  });
});

// Deterministic suites are CI gates: a regression in tools, agent trajectories, RAG or guardrails fails the build.
describe("eval gates (deterministic, mock org)", () => {
  it("tools suite", async () => {
    const r = await runToolSuite();
    expect(r.cases.filter((c) => !c.pass).map((c) => `${c.id}: ${c.error ?? ""}`)).toEqual([]);
    expect(r.summary.gatePassed).toBe(true);
  });
  it("agent suite", async () => {
    const r = await runAgentSuite();
    expect(r.cases.filter((c) => !c.pass).map((c) => `${c.id}: ${c.error ?? ""}`)).toEqual([]);
  });
  it("rag suite", async () => {
    const r = await runRagSuite();
    expect(r.summary.gatePassed, JSON.stringify(r.summary.metrics)).toBe(true);
    expect(r.cases.find((c) => c.id === "poisoned-article")?.pass).toBe(true);
  });
  it("guardrails suite", async () => {
    const r = await runGuardrailSuite();
    expect(r.cases.filter((c) => c.id.startsWith("e2e.") && !c.pass).map((c) => `${c.id} ${c.error ?? ""} ${(c.notes ?? []).join(" ")}`)).toEqual([]);
    expect(r.summary.metrics.falsePositiveRate).toBe(0);
    expect(r.summary.gatePassed, JSON.stringify(r.summary.metrics)).toBe(true);
  });
});
