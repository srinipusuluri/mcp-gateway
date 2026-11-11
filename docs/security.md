# Security

> **Sandbox isolation alone does not make this system secure, and this project does not claim that it does.** The isolate is one layer. The controls that matter most are host-side: user-scoped Salesforce tokens, RBAC, validation, approvals, redaction and audit. Salesforce's own CRUD / field-level security / sharing enforcement is the final authority.

## Threat model

| Threat | Example | Primary controls |
|---|---|---|
| Malicious or confused generated code | exfiltrate data, call `fetch`, spin forever, read secrets | isolate with no network/env, host-only credentials, CPU + wall + memory limits, static lint (defense in depth) |
| Over-privileged access | analyst reads Quotes; agent edits Opportunities | per-user OAuth token, RBAC deny-by-default, FLS intersection, Salesforce sharing |
| Injection | SOQL injection via search text; malicious record content steering the model | no raw SOQL path, escaped literals, validated identifiers; record text is treated as data (see Limitations) |
| Unapproved writes | an agent edits cases unprompted | writes disabled/approval-gated, four-eyes, single-use fingerprinted approvals |
| Data leakage | SSNs/cards/tokens in free text flow into a model | host-side redaction on every tool result and the final result |
| Abuse / DoS | loops, huge results, API-limit exhaustion | rate limits, call budgets, result caps, Salesforce API budget |
| Repudiation | "I never ran that" | hash-chained audit log with user, action, outcome |

## Requirement → implementation → test

| # | Requirement | Where | Tested in |
|---|---|---|---|
| 1 | Gateway authentication | `authenticateBearer` ([auth.ts](../packages/security/src/auth.ts)): HS256 secret or JWKS; rejects `alg=none`, expired, wrong secret; unknown roles never elevate | `unit/security-primitives`, `integration/mcp-protocol` |
| 2 | Per-user authorization | `ROLE_PERMISSIONS` + `PolicyEngine.authorizeTool` | `unit/governance`, `security/*` |
| 3 | Salesforce CRUD/FLS | Salesforce enforces on the user's token; the gateway additionally intersects fields with the user's own `describe` (`accessibleFields`) and refuses filters on hidden fields | `security › unauthorized field access`, `unit/mock-salesforce` |
| 4 | Record sharing | user token ⇒ Salesforce sharing; Data Cloud/adapter rows are filtered by Account visibility | `security › record-level sharing` |
| 5 | SOQL injection prevention | `buildSoql`, `escapeSoqlString`, `SoqlLiteral`, `assertReadOnlySoql`; no raw-SOQL tool exists | `unit/soql`, `security › SOQL injection` |
| 6 | Zod validation | every tool input is a Zod schema parsed on the host | `unit/registry-and-schemas`, `security › re-validated on the host` |
| 7 | Tool allowlisting | `toolAllowlist` policy + per-principal binding (unauthorized tools do not exist in the sandbox) | `security › global tool allowlist` |
| 8 | Restricted execution | fresh isolate per run; frozen proxies; empty realm | `security › sandbox isolation` |
| 9 | Egress restriction | `globalOutbound: null` on Dynamic Workers; no network primitive in QuickJS | `security › arbitrary network access`, real-workerd probes (below) |
| 10 | Timeouts | wall timeout + `limits.cpuMs` (see Limitations) | `security › resource limits` |
| 11 | Max records | `maxRecordsPerQuery` clamp, pagination fields | `security › max records per call` |
| 12 | Max code size | `maxCodeBytes` | `security › maximum code size` |
| 13 | Redaction | `redactValue` (keys, SSN, EIN, Luhn cards, bearer tokens, SF session ids) twice: per tool result, and on the final result | `unit/security-primitives`, `security › redacted` |
| 14 | Audit trail | `AuditLog` hash chain; args are **not** copied into audit detail | `unit/governance`, `security › audit trail` |
| 15 | Human approval for writes | `ApprovalService` | `integration/orchestration › approval workflow` |
| 16 | Idempotency | approvals are single-use; result stored under `write:<approvalId>`; keyed mutex | `unit/governance › race-free` |
| 17 | Rate limits | per-user fixed window (executions and tool calls) | `security › rate limits` |
| 18 | Secure errors | `toSafeError`: unknown errors become `internal_error` with no detail | `unit/security-primitives` |

## What was verified, and how

- **Node test suite (QuickJS-WASM sandbox):** unit, integration, MCP protocol and security tests, run with `npm test`.
- **Real Cloudflare runtime (`wrangler dev`/workerd):** Account 360 and the cross-system workflow executed through the real MCP endpoint in a Dynamic Worker; `fetch` is rejected; dynamic code generation (`Function` via a computed `constructor` lookup) fails with *"Code generation from strings disallowed for this context"*; `import("cloudflare:sockets")` rejected; the sandbox's global is not reachable via `this` (modules are strict). Reproduce with `scripts/verify-deployment.sh`.
- **Concurrency:** the benchmark exposed lost audit events under parallel tool calls (read-modify-write race). Fixed with a keyed mutex and covered by a regression test.

## Known limitations and open items (read these)

1. **CPU-bound infinite loops: not verified as stopped.** In local `wrangler dev`, a synchronous `while (go) {}` **hung the gateway** (including `/health`) even with `limits.cpuMs` injected via `withLimits` ([limited-loader.ts](../apps/worker/src/limited-loader.ts)). `@cloudflare/codemode`'s `DynamicWorkerExecutor` only enforces a wall-clock `Promise.race`, which cannot fire while the isolate spins. `cpuMs` is the documented Cloudflare control and is expected to be enforced on Cloudflare's infrastructure, but **we could not verify that locally**. Because the gateway runs in one Durable Object, an unstopped loop would stall all users. **Before exposing this to untrusted code, run `scripts/verify-deployment.sh` against a deployed Worker** (it includes the loop probe with a client-side timeout) and, if it fails, move sandbox execution out of the shared DO (e.g. execute from the stateless Worker, keeping the DO for state only). The static check that rejects `while(true)` / `for(;;)` is a speed bump, not a defence.
2. **Prompt injection through Salesforce data.** Case descriptions, account names, Knowledge bodies and Agentforce replies are attacker-influenceable text. The gateway redacts sensitive patterns but cannot stop a model from being *persuaded* by such text. Mitigations: write approval (a human sees exact arguments), least-privilege roles, `capabilities` allowlists per execution, and instructions in [CLAUDE.md](../CLAUDE.md) to treat record text as data.
3. **Live Salesforce was not exercised.** There were no org credentials. The REST client and OAuth service are tested against fake `fetch` implementations only; the mock org simulates CRUD/FLS/sharing but is *our model* of Salesforce. Validate field/object assumptions (notably Knowledge body field names, Quote vs CPQ objects, `SBQQ__Subscription__c`) in a sandbox org first.
4. **Mock-only adapters.** Data Cloud, Agentforce and NetSuite have mock adapters only. They are labelled `availability: "mock-only"` in discovery and the UI, and in live mode they return `not_available` rather than pretending to work.
5. **Audit log is tamper-*evident*, not tamper-*proof.** Someone with write access to Durable Object storage could rewrite the entire chain. Periodically export the head hash (`GET /api/audit/verify`) to an external system of record.
6. **Redaction is heuristic.** It covers common key names and patterns (SSN, NN-NNNNNNN tax ids, Luhn-valid cards, bearer tokens). It will miss other identifiers and can over-redact. Add `extraSensitiveFields` / patterns for your data.
7. **Single Durable Object.** Simple and consistent, but a throughput ceiling and a shared-fate component. Shard by tenant for scale.
8. **Fixed-window rate limiting** permits a 2× burst at window edges.
9. **Dev tokens** (`ALLOW_DEV_TOKENS`) mint tokens for any role without authentication. Config validation forbids them in live mode, but never enable them on an internet-facing deployment.

## Hardening checklist before production

- [ ] `scripts/verify-deployment.sh` passes against the deployed Worker (especially the loop probe).
- [ ] `ALLOW_DEV_TOKENS=false`; tokens come from your IdP via `GATEWAY_JWKS_URL`.
- [ ] `TOKEN_ENCRYPTION_KEY` set via `wrangler secret put`; rotation plan documented.
- [ ] Salesforce permission sets per gateway role created (see [salesforce-setup.md](salesforce-setup.md)); no integration-user shortcut.
- [ ] `EXECUTION_POLICY_JSON` reviewed: `writesEnabled`, `approvedAgents`, `maxRecordsPerQuery`.
- [ ] Audit head hash exported on a schedule; alerts on `auth.failure`, `tool.denied`, `ratelimit.exceeded`.
- [ ] Pen-test the deployed endpoint (prompt-injection scenarios included).
