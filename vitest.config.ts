import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@sfcm/shared-types": p("./packages/shared-types/src/index.ts"),
      "@sfcm/security": p("./packages/security/src/index.ts"),
      "@sfcm/governance": p("./packages/governance/src/index.ts"),
      "@sfcm/observability": p("./packages/observability/src/index.ts"),
      "@sfcm/salesforce-client": p("./packages/salesforce-client/src/index.ts"),
      "@sfcm/tool-registry": p("./packages/tool-registry/src/index.ts"),
      "@sfcm/salesforce-mcp": p("./packages/salesforce-mcp/src/index.ts"),
      "@sfcm/codemode-runtime": p("./packages/codemode-runtime/src/index.ts"),
      "@sfcm/worker": p("./apps/worker/src/app.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
