# Architecture

This document describes the system as implemented in this repository. Each diagram is followed by an explanation that points at the code.

**Contents:** [1 Overall](#1-overall-architecture) · [2 MCP lifecycle](#2-mcp-request-lifecycle) · [3 Code Mode execution](#3-code-mode-execution-lifecycle) · [4 OAuth](#4-salesforce-oauth-flow) · [5 Security boundaries](#5-security-boundaries) · [6 Account 360](#6-account-360-sequence) · [7 Multi-agent](#7-multi-agent-integration) · [8 Deployment](#8-deployment-architecture) · [9 Errors & retries](#9-error-handling-and-retries) · [10 Approvals](#10-human-approval-workflow)

## 1. Overall architecture

```mermaid
flowchart LR
  subgraph Clients["Claude client layer"]
    CC["Claude Code<br/>(.mcp.json)"]
    CD["Claude Desktop<br/>(remote MCP / mcp-remote)"]
    API["Claude API / Agent SDK<br/>(MCP connector)"]
    DASH["React dashboard"]
  end

  subgraph CF["Cloudflare"]
    W["Worker entry"]
    subgraph DO["GatewayDO (Durable Object)"]
      MCP["MCP server<br/>discover_capabilities · execute_code"]
      ENG["CodeModeEngine"]
      GOV["Governance<br/>RBAC · policy · approvals<br/>audit chain · rate limit · idempotency"]
      REG["Tool registry<br/>29 typed tools"]
      OBS["Observability<br/>metrics · traces"]
      STORE[("DO storage")]
    end
    SBX["Dynamic Worker sandbox<br/>(fresh isolate per run,<br/>no network, no secrets)"]
  end

  subgraph SF["Salesforce"]
    REST["REST API v66<br/>user-scoped token"]
    ORG[("Org data<br/>CRUD · FLS · sharing")]
  end
  EXT["Other MCP systems<br/>(NetSuite adapter)"]
  DC["Data Cloud / Agentforce<br/>(adapters, mock-only today)"]

  CC & CD & API -->|"HTTPS + Bearer JWT"| W
  DASH -->|"/api/*"| W
  W --> MCP
  MCP --> ENG
  ENG -->|"generated TypeScript"| SBX
  SBX -->|"RPC: sf.tool(args)"| ENG
  ENG --> REG
  REG --> GOV
  GOV --- STORE
  ENG --> OBS --- STORE
  REG -->|"host-side only"| REST --> ORG
  REG --> EXT
  REG --> DC
```

**Reading it.** Claude never talks to Salesforce. It talks to the gateway's *two* MCP tools. `execute_code` hands a TypeScript program to the sandbox; every `sf.*` call in that program is an RPC back to the host, where `ExecutionSession.call` ([session.ts](../packages/tool-registry/src/session.ts)) applies authorization, validation, approvals, limits, redaction and auditing before touching Salesforce with the *user's own* OAuth token. The sandbox holds no credentials and has no network.

## 2. MCP request lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant C as Claude (MCP client)
  participant W as Worker → GatewayDO
  participant A as authenticateBearer
  participant S as McpServer (per request)
  participant E as CodeModeEngine

  C->>W: POST /mcp  initialize  (Authorization: Bearer JWT)
  W->>A: verify signature, exp, iss/aud
  alt invalid / missing
    A-->>C: 401 + WWW-Authenticate (audit: auth.failure)
  else valid
    A-->>W: Principal {userId, roles}
    W->>S: new McpServer + stateless Streamable-HTTP transport
    S-->>C: serverInfo, capabilities.tools, instructions
  end
  C->>W: tools/list
  S-->>C: discover_capabilities, execute_code
  C->>W: tools/call discover_capabilities {domain}
  S->>E: discover(principal)
  E-->>C: only the tools this user may call + TS types
  C->>W: tools/call execute_code {code}
  S->>E: execute(principal, code)
  E-->>C: {ok, result, trace, metadata}
```

**Notes.** The transport is stateless (`sessionIdGenerator: undefined`, JSON responses): a fresh `McpServer` is built per HTTP request with the authenticated principal bound by closure ([mcp.ts](../apps/worker/src/mcp.ts)). There is no server-side session to hijack; every request is authenticated independently. `/mcp/direct` serves the *traditional* one-tool-per-capability surface through the same governance path and is used as the evaluation baseline.

## 3. Code Mode execution lifecycle

```mermaid
flowchart TD
  A["execute_code {code, capabilities?}"] --> B{"permission 'execute'?"}
  B -- no --> X1["forbidden"]
  B -- yes --> C{"rate limit<br/>executions/min/user"}
  C -- exceeded --> X2["rate_limited"]
  C -- ok --> D["prepareCode<br/>size ≤ maxCodeBytes<br/>strip TS (sucrase)<br/>parse (acorn)<br/>lint: eval/Function/import/fetch/process…<br/>unbounded loops<br/>normalize to async arrow fn"]
  D -- rejected --> X3["code_rejected"]
  D --> E["Build sandbox bindings:<br/>only tools this principal may call<br/>(∩ requested capabilities)"]
  E --> F["Executor.execute(code, providers)<br/>Dynamic Worker / QuickJS"]
  F -->|"sf.tool(args) RPC"| G["ExecutionSession.call<br/>(see diagram 5)"]
  G -->|"redacted JSON"| F
  F --> H{"result"}
  H -- error --> X4["execution_error / timeout /<br/>approval_required / tool error code"]
  H -- value --> I["JSON-normalize → redact again → cap to maxResultBytes"]
  I --> J["ExecutionOutcome {result, logs, trace, metadata}"]
  X1 & X2 & X3 & X4 & J --> K["audit.append(execute) · metrics.record"]
```

**Notes.** Generated code is plain TypeScript; types are stripped, never executed through `eval`/`Function`. Static checks give fast, clear errors but are explicitly **not** the security boundary (see [security.md](security.md)). Two interchangeable executors implement the same `Executor` contract as `@cloudflare/codemode`: `DynamicWorkerExecutor` (production, wrapped by `withLimits` for CPU caps) and `QuickJsExecutor` (WASM, used for Node tests and local scripts).

## 4. Salesforce OAuth flow

```mermaid
sequenceDiagram
  autonumber
  participant U as User (dashboard)
  participant G as Gateway (GatewayDO)
  participant SF as Salesforce login
  participant V as TokenVault (AES-256-GCM)

  U->>G: POST /api/oauth/start (Bearer JWT)
  G->>G: PKCE: verifier, S256 challenge, random state
  G->>G: store sha256(state) → {userId, verifier, exp 10 min}
  G-->>U: authorizeUrl (state + challenge only)
  U->>SF: GET /services/oauth2/authorize
  SF-->>U: user logs in and consents
  SF-->>G: GET /oauth/callback?code&state
  G->>G: look up + delete state (single use), check expiry
  G->>SF: POST /services/oauth2/token (code, code_verifier, client_id[, secret])
  SF-->>G: access_token, refresh_token, instance_url
  G->>V: encrypt + save under userId
  G-->>U: 302 /?salesforce=connected
  Note over G,SF: later calls use the user's token. On 401: refresh once;<br/>if refresh fails the vault entry is deleted and the user must re-authorize.
  U->>G: POST /api/oauth/logout
  G->>SF: POST /services/oauth2/revoke
  G->>V: delete
```

**Notes.** Tokens are per Claude user, so Salesforce itself enforces *that user's* CRUD, field-level security and sharing. The integration is **not** a shared admin identity. The code verifier never reaches the browser; `state` is stored hashed and consumed on first use. See [oauth-setup.md](oauth-setup.md).

## 5. Security boundaries

```mermaid
flowchart TB
  subgraph UNTRUSTED["UNTRUSTED: model-generated code"]
    CODE["TypeScript program"]
  end
  subgraph SANDBOX["Isolation boundary: Dynamic Worker isolate<br/>no network (globalOutbound=null) · no env/secrets · CPU cap · wall timeout"]
    RT["Empty JS realm +<br/>frozen sf.* / netsuite.* proxies"]
  end
  subgraph HOST["TRUSTED HOST: GatewayDO"]
    direction TB
    S1["1 tool exists for this principal? (RBAC + allowlist)"]
    S2["2 per-user rate limit + per-execution call budgets"]
    S3["3 Zod validation (ids, enums, bounds, identifiers)"]
    S4["4 write? → human approval gate + idempotency"]
    S5["5 FLS: intersect requested fields with user's describe"]
    S6["6 SOQL built from validated identifiers + escaped literals"]
    S7["7 redact result (PII, secrets) · count rows"]
    S8["8 audit (hash chain)"]
    S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7 --> S8
  end
  subgraph SFB["Salesforce: final authority"]
    SFA["User-scoped OAuth token<br/>CRUD · FLS · sharing rules"]
  end
  CODE --> RT
  RT -- "RPC (JSON only)" --> S1
  S6 --> SFA
  SECRETS[("Secrets: JWT secret, SF client secret,<br/>token-encryption key, API keys")] -.->|"never cross"| SANDBOX
```

**Notes.** Defense in depth, with an explicit hierarchy: *Salesforce's own enforcement is the final authority*; the host re-checks everything; the sandbox is only one layer and is **not claimed to be sufficient alone**. The numbered host checks live in `ExecutionSession.call`.

## 6. Account 360 sequence

```mermaid
sequenceDiagram
  autonumber
  participant C as Claude
  participant G as Gateway
  participant X as Sandbox
  participant SF as Salesforce (user token)

  C->>G: discover_capabilities {domain:"sales"}
  G-->>C: TS types for sf.*
  C->>G: execute_code (one program)
  G->>X: run program
  X->>G: sf.searchAccounts({query:"Acme"})
  G->>SF: describe Account (cached) + SELECT … FROM Account WHERE Name LIKE …
  SF-->>G: rows (FLS/sharing applied)
  G-->>X: redacted records
  par Promise.all
    X->>G: sf.getContactsByAccount
    G->>SF: SELECT … FROM Contact
  and
    X->>G: sf.getOpportunities
    G->>SF: SELECT … FROM Opportunity
  and
    X->>G: sf.getOpenCasesByAccount
    G->>SF: SELECT … FROM Case
  end
  G-->>X: three results
  X-->>G: compact {account, contacts, pipeline, openCases}
  G-->>C: result + trace (4 tool calls, 8 SF API calls)
```

**Notes.** One model round trip for the work instead of one per call. Raw rows never enter the model's context; only the program's aggregated return value does. The `describe` calls power field-level security filtering and are cached per execution.

## 7. Multi-agent integration

```mermaid
flowchart LR
  subgraph Agents
    ORCH["Orchestrator agent<br/>(Claude Agent SDK)"]
    SALES["Sales analyst agent"]
    SUPPORT["Support triage agent"]
  end
  subgraph GW["Code Mode gateway"]
    P1["Principal: orchestrator<br/>roles: analyst"]
    P2["Principal: support-bot<br/>roles: service_agent"]
    GOV2["Same governance path:<br/>RBAC · approvals · audit · limits"]
  end
  APPR["Human approver<br/>(dashboard)"]
  AF["Agentforce agent<br/>invokeApprovedAgent<br/>(allowlist)"]
  SFO[("Salesforce")]

  ORCH -->|"delegates"| SALES & SUPPORT
  SALES -->|"own JWT"| P1
  SUPPORT -->|"own JWT"| P2
  P1 & P2 --> GOV2 --> SFO
  GOV2 -->|"pending writes"| APPR
  GOV2 --> AF
```

**Notes.** Each agent authenticates with its **own** token and gets its own role, rate limits, audit identity and Salesforce profile; agents do not share credentials or inherit the orchestrator's permissions. Writes from any agent pause for a human. Agentforce is called as a governed, allowlisted tool (currently via the mock adapter; see [tool-registry.md](tool-registry.md)).

## 8. Deployment architecture

```mermaid
flowchart TB
  DEV["Developer / GitHub Actions"] -->|"wrangler deploy"| WK
  subgraph Cloudflare["Cloudflare account"]
    WK["Worker: salesforce-codemode-gateway"]
    AS["Static assets<br/>(dashboard build)"]
    DOO["Durable Object GatewayDO<br/>(SQLite-backed storage)"]
    LDR["Worker Loader binding LOADER"]
    SEC["Secrets & vars"]
    WK --> AS
    WK --> DOO
    DOO --> LDR --> ISO["Per-execution isolates"]
    SEC -.-> DOO
  end
  CL["Claude Code / Desktop / API"] -->|"HTTPS"| WK
  DOO -->|"HTTPS, user token"| SFDC["Salesforce org / sandbox"]
  IDP["IdP (JWKS) or HS256 secret"] -.->|"token verification"| DOO
```

**Notes.** One Worker, one Durable Object, one Worker Loader binding, static assets for the dashboard ([wrangler.jsonc](../wrangler.jsonc)). The single global DO gives a consistent audit chain, approval queue and rate limiter with no extra infrastructure; to scale out, shard by tenant (`idFromName(tenantId)`). Details in [deployment.md](deployment.md).

## 9. Error handling and retries

```mermaid
flowchart TD
  REQ["Salesforce REST request"] --> R{"response"}
  R -- "2xx" --> OK["return (attributes stripped)"]
  R -- "401" --> RF{"already refreshed?"}
  RF -- no --> REF["refresh token → retry once"]
  REF --> R
  RF -- yes --> AUTHERR["SalesforceAuthError → unauthenticated (401)<br/>vault cleared if refresh failed"]
  R -- "429 / 502 / 503" --> RT{"retries left? (default 2)"}
  RT -- yes --> BO["backoff: Retry-After (≤5 s) or 250 ms · 2^n"] --> REQ
  RT -- no --> APIERR
  R -- "network error" --> RT
  R -- "other 4xx/5xx" --> APIERR["SalesforceApiError → tool error<br/>[salesforce_error] CODE message"]
  APIERR --> MAP["ExecutionSession maps to GatewayError<br/>(no stack traces / tokens)"]
  AUTHERR --> MAP
  MAP --> SBX["thrown into the sandbox as Error('[code] message')<br/>program can try/catch and continue"]
  SBX --> FIN{"uncaught?"}
  FIN -- yes --> OUT["ExecutionOutcome.error {code, message}"]
```

**Notes.** Writes are **not** automatically retried (non-idempotent at the Salesforce layer). Idempotency for approved writes is enforced at the gateway: an approval is single-use and its result is stored under `write:<approvalId>`. Unknown exceptions become `internal_error` with no detail, by design ([errors.ts](../packages/security/src/errors.ts)).

## 10. Human approval workflow

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent (service_agent)
  participant G as Gateway
  participant AP as ApprovalService
  participant H as Human approver (dashboard)
  participant SF as Salesforce

  A->>G: execute_code → sf.createCase({...})
  G->>AP: consumeIfApproved(tool, args, user)?
  AP-->>G: none
  G->>AP: requestOrGet → apr_123 (pending, fingerprint = hash(tool, args, user))
  G-->>A: error approval_required {approvalId: apr_123}  (nothing written)
  H->>G: GET /api/approvals → sees tool + exact args
  H->>G: POST /api/approvals/apr_123/approve
  Note over G,AP: requester ≠ approver (four-eyes); must hold approvals.decide
  A->>G: re-run the same program
  G->>AP: consumeIfApproved → status consumed (atomic, single use)
  G->>SF: create Case with the USER's token (CRUD/FLS still enforced by Salesforce)
  SF-->>G: {id, success}
  G-->>A: result  (audit: approval.consumed, tool.invoke)
  A->>G: run again
  G-->>A: approval_required (a fresh approval is needed)
```

**Notes.** An approval authorizes **exactly one execution of exactly these arguments by exactly this requester**, and expires after `approvalTtlMs` (1 h default). Changing any argument changes the fingerprint, so a tampered re-run needs a new approval. All state transitions are serialized by a keyed mutex (a race in the first implementation was found by the benchmark and fixed; see the concurrency test in `tests/unit/governance.test.ts`).
