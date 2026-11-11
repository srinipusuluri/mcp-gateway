# MCP Gateway: Salesforce Code Mode for Claude

**Claude writes one TypeScript program instead of making dozens of tool calls.** The program runs in an isolated sandbox with no network and no secrets, and every Salesforce call passes through one governed checkpoint before it reaches your org as the signed-in user.

```
Claude ─▶ Code Mode MCP gateway ─▶ TypeScript sandbox ─▶ governed tool registry ─▶ Salesforce (user-scoped OAuth)
          discover_capabilities       (no network,          RBAC · Zod · approvals     CRUD · FLS · sharing
          execute_code                 no secrets)          redaction · audit
```

Inspired by Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode/) and built on `@cloudflare/codemode` 0.5.6, the MCP TypeScript SDK 1.32.2, Zod 4, Cloudflare Workers + Dynamic Worker Loader.

**Author:** Srinivasa Pusuluri · [LinkedIn](https://www.linkedin.com/in/pusulurisrinivasa/)

## Results at a glance

450 benchmark runs (5 workflows × 3 approaches × 30 runs) plus live runs on a Salesforce Developer Edition org.

| | Code Mode vs traditional tool calls | Basis |
|---|---|---|
| Model round trips | **−33% to −50%** | measured |
| Tool invocations | **−67% to −94%** (18 → 1 on fan-out) | measured |
| Salesforce API calls | no change (same work done) | measured |
| Success | 100% in both modes | measured |
| Input tokens, types preloaded | −7.5% to −35% | estimated |
| Input tokens, discovery every time | +11% to +57% | estimated |
| End-to-end time | slower on 4 of 5 small tasks; 18% faster on fan-out | estimated |

Fewer turns and tool calls are proven. Token and time savings depend on fan-out and on how the API types reach Claude. Full write-up: [paper (PDF)](docs/paper/main.pdf) · [slides (PPTX)](docs/presentation/code-mode-salesforce.pptx) · [raw data](tests/evaluations/results/benchmark.json).

## Status (read this first)

| | |
|---|---|
| ✅ Verified | typecheck, lint, **180 tests** (unit, integration, MCP protocol, security, eval gates), benchmark harness, dashboard production build, and the Account 360 + cross-system workflows executing in the **real Cloudflare Dynamic Worker (workerd)** through the real MCP endpoint |
| ✅ Live org | Per-user OAuth (PKCE) and read workflows ran against a real Salesforce Developer Edition org; live security probes passed. Live **writes** were only tested up to the approval gate |
| ✅ Guardrails & evals | Prompt-injection guardrail policies enforced at the checkpoint (detect → sanitize/quarantine/block → taint-blocks writes); deterministic eval gates for tools, agent trajectories, RAG and guardrails run in `npm test` |
| ⚠️ Not verified | **CPU-loop termination on Cloudflare production:** a synchronous infinite loop hung local `wrangler dev` even with `limits.cpuMs`; run `npm run verify:deployment` against a deployed Worker before exposing to untrusted code |
| 🧪 Mock-only | Data Cloud, Agentforce, NetSuite, `getSubscriptions`: mock adapters implement the contract; live adapters are **not** included (see [docs/tool-registry.md](docs/tool-registry.md)) |

Details and the full limitation list: [docs/security.md](docs/security.md).

## 1. What is Code Mode?

Normally an agent is given N tools and issues calls one at a time; every call's raw output flows back through the model's context. **Code Mode** gives the model *typed APIs* and asks it to **write code** that calls them. The code runs in a sandbox next to the data, so loops, joins, parallel calls, pagination and aggregation happen outside the model, and only the program's compact return value comes back. Models have seen far more real code than tool-call transcripts, so they tend to write good programs.

## 2. Why it helps multi-tool orchestration (and when it does not)

Measured on five identical workflows against this gateway (`npm run bench -- 30`, mock org, full table in [tests/evaluations/results/benchmark.md](tests/evaluations/results/benchmark.md)). **Measured** = counted from executed runs. **Estimated** = no live model was called (see caveats).

| workflow | model round trips<br/>trad → code* | tool invocations<br/>trad → code | input tokens (est)<br/>trad → code* | est. completion (s)<br/>trad → code* |
|---|---|---|---|---|
| account-360 | 3 → 2 | 4 → 1 | 14.9k → 13.8k | 10.0 → 14.1 |
| sales-pipeline | 3 → 2 | 3 → 1 | 16.8k → 13.8k | 11.1 → 12.8 |
| customer-risk | 3 → 2 | 3 → 1 | 17.9k → 13.6k | 10.8 → 13.7 |
| service-intelligence (3 pages) | 4 → 2 | 3 → 1 | 20.9k → 13.6k | 11.0 → 12.2 |
| cross-system (8 accounts × NetSuite) | 3 → 2 | **18 → 1** | 17.6k → 14.5k | **15.9 → 13.0** |

\*code = "execute only" with the TypeScript declarations preloaded (e.g. via CLAUDE.md). Salesforce API calls were **identical** in both approaches (e.g. 8 for account-360), as expected, since the same work is performed.

**Honest reading:**
- Measured: Code Mode needs **fewer model round trips** and **far fewer tool invocations**; the gap grows with fan-out (18 → 1).
- Estimated: input tokens drop 7–35% when types are preloaded. With a fresh `discover_capabilities` call each time the payload is larger (≈23k tokens): **more** input tokens than the traditional baseline in these small examples.
- Estimated: end-to-end time was **worse** for the small workflows, because writing a ~600-token program costs more output time than emitting a short tool call; Code Mode only won on the 18-call fan-out. This baseline is deliberately generous to traditional MCP (parallel calls in one turn, shared describe cache) on a *tiny* dataset. Raw payload size, the number of dependent steps, and loops are where Code Mode is expected to pull ahead; that is a hypothesis this benchmark does not prove.
- Not measured: answer quality (no live model), real network latency, large result sets.

Re-run with your own numbers: `BENCH_MODEL_TPS=80 npm run bench -- 30`.

## 3. How Salesforce connects to Claude

Claude → gateway (`Authorization: Bearer <JWT>`) → per-user Salesforce OAuth token held encrypted in the gateway → Salesforce REST. Each Claude user acts **as their own Salesforce user**, so Salesforce enforces that user's CRUD, field-level security and sharing; the gateway adds RBAC, validation, approvals, redaction and audit on top. Diagrams: [docs/architecture.md](docs/architecture.md).

## Quick start (mock mode, 2 minutes)

```bash
npm install
cp .env.example .dev.vars          # set GATEWAY_JWT_SECRET to a 32+ char random string
npm test                           # 180 tests
npm run example -- account-360     # run the first workflow locally
npm run dev:worker                 # real workerd + Dynamic Worker on http://127.0.0.1:8787 (dashboard at /)
```

## 4. Configure Salesforce OAuth

Create an External Client App / Connected App with the callback URL, scopes `api` + `refresh_token`, PKCE on; set `SF_*` variables and secrets; create per-role permission sets. Step by step: [docs/salesforce-setup.md](docs/salesforce-setup.md) and [docs/oauth-setup.md](docs/oauth-setup.md). Then set `SF_MODE=live`.

## 5. Deploy to Cloudflare Workers

```bash
npx wrangler login
openssl rand -base64 48 | npx wrangler secret put GATEWAY_JWT_SECRET
npm run deploy
GATEWAY_URL=https://<your-worker>.workers.dev GATEWAY_TOKEN=<jwt> npm run verify:deployment
```

Requires Workers + Durable Objects and access to the Worker Loader binding. Full guide: [docs/deployment.md](docs/deployment.md).

## 6. Connect Claude Code

```bash
export SFCM_URL=http://127.0.0.1:8787            # or your deployed URL
export SFCM_TOKEN=$(npm run --silent token -- analyst)
claude                                           # from this directory; .mcp.json is picked up
> /mcp                                           # salesforce-codemode: 2 tools
```

Claude Desktop and the Claude API: [docs/claude-integration.md](docs/claude-integration.md). Claude is told how to behave by [CLAUDE.md](CLAUDE.md).

## 7. Run the first Account 360 workflow

In Claude Code: *"Give me an Account 360 for Acme Corporation."* It discovers capabilities, then sends one program ([examples/account-360/program.ts](examples/account-360/program.ts)) that performs 4 tool calls (search, then contacts / opportunities / open cases in parallel) and returns a compact summary labelled `mode: "mock"`.

Without Claude: `npm run example -- account-360`, or the dashboard → **Code Mode Playground** → pick *Account 360* → **Execute**, or:

```bash
curl -s $SFCM_URL/mcp -H "authorization: Bearer $SFCM_TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute_code","arguments":{"code":"async () => (await sf.searchAccounts({ query: \"Acme\", limit: 1 })).records"}}}'
```

All ten demonstrations (Account 360, Sales Pipeline, Customer Risk, Service Intelligence, Opportunity Intelligence, CPQ Analysis, Customer 360, Knowledge Assistant, Agentforce Integration, Enterprise Cross-System) live in [packages/salesforce-mcp/src/workflows.ts](packages/salesforce-mcp/src/workflows.ts); generated, type-checked copies are in [examples/](examples/). Seven of the ten work against a live org's standard objects; Customer 360, Agentforce and Cross-System use mock-only adapters.

## 8. Extend the tool registry

Define a tool with `defineTool` (Zod input/output, permission, kind, handler using `listRecords`/`buildSoql`) and register it. The sandbox binding, RBAC, TypeScript declarations, dashboard entry and audit come for free. Guide: [docs/tool-registry.md](docs/tool-registry.md).

## 9. Enable approved write operations

Writes (`createCase`, `updateCase`, `invokeApprovedAgentAction`) are approval-gated. A `service_agent` runs a program → `approval_required` + id → a *different* user with `approver`/`admin` approves in **Security Center → Approval queue** (exact arguments shown) → the requester re-runs → executes exactly once. Switches: `writesEnabled`, `writesRequireApproval`, `allowSelfApproval`, `approvalTtlMs`. See [docs/tool-registry.md](docs/tool-registry.md#enabling-approved-write-operations).

## 10. Prompt-injection guardrails

Salesforce text is untrusted: anyone who can file a case or edit an article can plant instructions. Every string returned by a tool, and the final result, passes configurable policies at the checkpoint:

- **Detect** 10 categories: instruction override, role hijack, fake system turns, tool coercion, secret seeking, exfiltration links, hidden Unicode, active HTML, untrusted links, encoded payloads.
- **Act** per category: `allow`, `flag`, `sanitize`, `quarantine` or `block`.
- **Taint:** once an execution reads injected text, its writes are refused before an approval is created.
- **Write inputs** carrying injection text are refused.
- **Report** every hit in `metadata.guardrails`, the audit log, traces and dashboard metrics.

Policies are set with `GUARDRAIL_POLICY_JSON`; there is a monitor mode for rollout and a strict preset. Details: [docs/prompt-injection-guardrails.md](docs/prompt-injection-guardrails.md).

## 11. Observability (OpenTelemetry, open source)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and each execution becomes a trace: an `execute_code` CHAIN span with one TOOL span per Salesforce call. Spans use the OpenTelemetry GenAI and OpenInference conventions, so **Phoenix, Langfuse, Jaeger, Tempo and SigNoz** render them natively. A W3C `traceparent` from the agent links its trace to the gateway's. Spans carry metadata only unless `OTEL_CAPTURE_CONTENT=true`, which live mode refuses.

```bash
docker compose -f observability/docker-compose.yml up -d   # Collector → Phoenix :6006 + Jaeger :16686
```

Guide: [docs/observability.md](docs/observability.md).

## 12. Evals (LLM, RAG, agents, tools, guardrails)

```bash
npm run evals                          # deterministic suites → tests/evals/results/evals.{json,md}
ANTHROPIC_API_KEY=... npm run evals    # + Claude writes the programs, + LLM-as-judge
```

| Suite | Result (mock org) |
|---|---|
| tools: golden cases, error contract, output-schema conformance | 19/19 |
| agent: tool recall/precision, order, budget, no writes, task checks | 12/12 · 4.5 tool calls / task |
| rag: hit@3, MRR, nDCG, groundedness, abstention, poisoned article | hit@3 0.90 (single raw tool call: 0.0) · groundedness 1.0 · 2 known misses |
| guardrails: labelled corpus + 9 attack scenarios + workflow false positives | precision 1.0 · recall 0.925 · FPR 0 · **held-out recall 0.5** |

Results are identical across 10 repeated runs, and guardrails add 0.2–2.1 ms per execution (`npm run evals:repeat`). The misses are kept on purpose; [docs/evals.md](docs/evals.md) explains each one. The paper now has a section on these results. Results can be exported as OTel spans next to production traces.

## 13. Tests and benchmarks

```bash
npm run typecheck        # root + dashboard
npm run lint
npm test                 # all suites
npm run test:unit | test:integration | test:security
npm run evals            # quality evals → tests/evals/results/evals.{json,md}
npm run bench -- 30      # writes tests/evaluations/results/benchmark.{json,md}
npm run verify:deployment   # against a running/deployed gateway
```

Suites: **unit** (REST client, OAuth, SOQL, schemas, registry, authz, redaction, governance incl. concurrency, code prep, mock org, workflows), **integration** (MCP initialize/discovery/execution over Streamable HTTP, orchestration, approvals, REST API, auth failures), **security** (CRUD/FLS/sharing, SOQL injection, credential leakage, network/filesystem/process access, lint bypasses, infinite loops, memory, oversized results, unauthorized writes, rate limits, audit), **evaluations** (benchmark harness).

## Dashboard

React + TypeScript console served by the Worker: **Overview** (connection, gateway, sandbox, tool counts, executions, failures, latency), **Tool Explorer** (schemas, TypeScript, examples, live tester), **Code Mode Playground** (task → TypeScript → review → execute → result/trace/logs, mock/live badge), **Security Center** (users, permissions matrix, approval queue, audit log with chain verification, policies), **Monitoring** (latency, per-tool usage, errors, API consumption, history with traces). Dark/light/system themes, responsive, keyboard-accessible tabs and tables. In mock mode, sign in with a demo persona.

## Documentation

[architecture](docs/architecture.md) (10 Mermaid diagrams) · [security](docs/security.md) · [prompt-injection guardrails](docs/prompt-injection-guardrails.md) · [observability](docs/observability.md) · [evals](docs/evals.md) · [salesforce-setup](docs/salesforce-setup.md) · [oauth-setup](docs/oauth-setup.md) · [claude-integration](docs/claude-integration.md) · [tool-registry](docs/tool-registry.md) · [deployment](docs/deployment.md) · [troubleshooting](docs/troubleshooting.md) · [implementation-guide](docs/implementation-guide.md)

## Manual configuration required

Cloudflare account (+ Worker Loader access), Cloudflare API token for CI, all secrets in `.env.example`, a Salesforce External Client App/Connected App and permission sets, live adapters for Data Cloud / Agentforce / NetSuite (if wanted), an IdP for production gateway tokens.

## License

Not specified. Add one before publishing.
