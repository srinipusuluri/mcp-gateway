import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSalesforceRegistry, WORKFLOWS } from "@sfcm/salesforce-mcp";
import { generateTypeScriptApi } from "@sfcm/tool-registry";

const DIRS = new Set(["account-360", "sales-pipeline", "customer-risk", "service-intelligence", "cross-system-analysis"]);

describe("examples stay in sync with the single source of truth", () => {
  it("every workflow has a generated program file (run `npm run examples:generate` if this fails)", () => {
    for (const w of WORKFLOWS) {
      const file = DIRS.has(w.id) ? `examples/${w.id}/program.ts` : `examples/more/${w.id}.ts`;
      expect(readFileSync(file, "utf8"), file).toContain(w.build(w.defaults));
    }
  });
  it("ambient type declarations match the registry", () => {
    expect(readFileSync("examples/sf-api.d.ts", "utf8")).toContain(generateTypeScriptApi(createSalesforceRegistry().list()));
  });
});
