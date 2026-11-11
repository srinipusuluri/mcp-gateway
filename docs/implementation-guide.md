# Implementation guide

How the build was staged, what exists in each package, and where to extend it.

## Repository map

```
apps/worker/          Cloudflare Worker + GatewayDO: HTTP app, MCP server, platform wiring, config, loader limits
apps/dashboard/       React + Vite console (Overview, Tool Explorer, Playground, Security Center, Monitoring)
packages/shared-types   Principal, Role, ExecutionOutcome, AuditEvent … (no logic)
packages/security       auth (JWT), redaction, result caps, AES-GCM, safe errors
packages/governance     RBAC, policy engine, approvals, hash-chained audit, rate limit, idempotency, keyed mutex, StateStore
packages/observability  MetricsCollector (executions, per-tool, errors, API use, estimated cost)
packages/salesforce-client  REST client, SOQL builder/validator, OAuth+PKCE, TokenVault, MockOrg/MockSalesforceClient
packages/tool-registry  ToolDefinition, registry, Zod→TypeScript generator, ExecutionSession (the choke point)
packages/salesforce-mcp 29 tool definitions, adapters (mock), 10 workflows, direct (one-tool-per-capability) MCP server
packages/codemode-runtime  prepareCode, QuickJsExecutor, discovery, CodeModeEngine
tests/                unit · integration · security · evaluations
examples/             generated programs (type-checked against the registry)
scripts/              mint-token, run-example, generate-examples, verify-deployment
```

## Phases as executed

| Phase | Delivered | Verified by |
|---|---|---|
| 1 Inspect & architecture | Existing repo was an SFDX project: left untouched; platform built in `salesforce-claude-codemode/`. Verified current packages (`@cloudflare/codemode` 0.5.6, MCP SDK 1.32.2, zod 4.6, wrangler 4.160) and read the installed `.d.ts` / source rather than assuming APIs | – |
| 2 Salesforce client & OAuth | REST client (pagination, 401-refresh, 429/503 backoff, limit header), SOQL builder/validator, PKCE OAuth, encrypted vault | `unit/salesforce-client`, `unit/oauth`, `unit/soql` |
| 3 Salesforce MCP server | 29 tools via registry; direct MCP server | `unit/registry-and-schemas`, `integration/mcp-protocol` |
| 4 Code Mode gateway | `discover_capabilities` + `execute_code` on Streamable HTTP, per-request auth | `integration/mcp-protocol` |
| 5 Isolated execution | `Executor` contract shared with `@cloudflare/codemode`; Dynamic Worker (prod) + QuickJS (tests) | `security/*`, real-workerd smoke |
| 6 Security & governance | RBAC, approvals, audit chain, limits, redaction | `unit/governance`, `security/*` |
| 7 Claude integration | `.mcp.json`, `CLAUDE.md`, token script | manual connection steps in [claude-integration.md](claude-integration.md) |
| 8 Dashboard | 5 pages, dark/light, accessible tabs/tables, SVG charts | `npm run build:dashboard` (typecheck + production build) |
| 9 Tests & evaluation | 150+ tests, benchmark harness | `npm test`, `npm run bench` |
| 10 Docs & deployment | this docs set, CI, wrangler config, deployment verification script | `wrangler deploy --dry-run` in CI |

## Design decisions worth knowing

- **Two executors, one contract.** `@cloudflare/codemode`'s package entry imports `cloudflare:workers`, so it cannot load in Node. The runtime depends only on a structural `Executor` interface; `index.ts` (Workers-only) wires `DynamicWorkerExecutor`, tests/scripts wire `QuickJsExecutor`. We use the library's executor rather than re-implementing the isolate; we add `withLimits` because the library omits CPU limits.
- **Approval by fingerprint, not by pausing.** `@cloudflare/codemode` ships an abort-and-replay runtime for approvals; we deliberately use a simpler stateless pattern (fingerprint = hash(tool, args, requester); re-run the program) so approvals work identically in both executors and the human sees the exact arguments.
- **One choke point.** All paths (sandbox, REST tester, direct MCP) call `ExecutionSession.call`. Add controls there and they apply everywhere.
- **FLS by describe-intersection.** Hidden fields are omitted and reported (`omittedFields`) rather than failing whole queries, which is what a model-driven workflow needs. Filters/sorts on hidden fields are refused.
- **No raw SOQL tool.** Expressiveness comes from typed filters + code, not query strings.
- **Honest availability.** `availability: "mock-only"` is first-class and surfaced everywhere.

## Extending

- New tool → [tool-registry.md](tool-registry.md). New role/permission → `rbac.ts`. New policy knob → `ExecutionPolicySchema` (+ README table + test).
- New executor (container, VM) → implement `Executor`; keep the host-side `ExecutionSession` unchanged.
- Persisted mock state / multi-tenant → give each tenant its own `GatewayDO` (`idFromName(tenantId)`), derived from the JWT `tenant` claim.
- Sandbox types for Salesforce *custom* objects → add tools with typed schemas; the generator picks them up automatically.
