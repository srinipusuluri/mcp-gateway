/** Run a demonstration workflow against the mock org in the local QuickJS sandbox: `npm run example -- account-360` */
import { MemoryStore } from "../packages/governance/src";
import { QuickJsExecutor } from "../packages/codemode-runtime/src";
import { WORKFLOWS } from "../packages/salesforce-mcp/src";
import { createPlatform } from "../apps/worker/src/platform";
import { configFromEnv } from "../apps/worker/src/config";

const id = process.argv[2] ?? "account-360";
const w = WORKFLOWS.find((x) => x.id === id);
if (!w) {
  console.error(`Unknown workflow '${id}'. Available: ${WORKFLOWS.map((x) => x.id).join(", ")}`);
  process.exit(1);
}
const config = configFromEnv({ GATEWAY_JWT_SECRET: "x".repeat(40) });
const platform = createPlatform({ config, store: new MemoryStore(), executor: new QuickJsExecutor({ timeoutMs: config.policy.timeoutMs }), runtimeName: "quickjs-wasm" });
const principal = { userId: "example-user", roles: ["admin" as const] };
const { sf, adapters } = platform.salesforceFor(principal);
const out = await platform.engine.execute({ code: w.build(w.defaults), principal, sf, adapters });
console.log(`# ${w.title}  [mode: ${out.metadata.mode.toUpperCase()} · ${out.metadata.toolCalls} tool calls · ${out.metadata.salesforceApiCalls} Salesforce API calls · ${out.metadata.durationMs} ms]`);
console.log(JSON.stringify(out.ok ? out.result : out.error, null, 2));
