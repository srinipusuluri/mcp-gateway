import { describe, expect, it } from "vitest";
import { runBenchmark } from "./benchmark";

describe("evaluation harness (smoke: 2 runs per cell)", () => {
  it("runs every workflow in every approach and reports structurally sound metrics", async () => {
    const { summaries } = await runBenchmark(2);
    expect(summaries).toHaveLength(5 * 3);
    for (const s of summaries) {
      expect(s.successRate, `${s.workflow}/${s.approach}`).toBe(1);
      expect(s.salesforceApiCalls).toBeGreaterThan(0);
    }
    for (const wf of new Set(summaries.map((s) => s.workflow))) {
      const trad = summaries.find((s) => s.workflow === wf && s.approach === "traditional-mcp")!;
      const code = summaries.find((s) => s.workflow === wf && s.approach.startsWith("code-mode (execute only"))!;
      // Code Mode needs exactly: execute + final answer = 2 model turns, regardless of workflow size.
      expect(code.modelRoundTrips).toBe(2);
      expect(trad.modelRoundTrips).toBeGreaterThanOrEqual(2);
      expect(trad.toolInvocations).toBeGreaterThanOrEqual(code.toolInvocations);
    }
    const multi = summaries.filter((s) => s.workflow !== "account-360" || true).filter((s) => s.approach === "traditional-mcp" && s.modelRoundTrips > 2);
    expect(multi.length).toBeGreaterThan(0);
  }, 120_000);
});
