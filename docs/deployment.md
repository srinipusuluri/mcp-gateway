# Deployment

## Prerequisites

- Node.js ≥ 20 (CI uses 22), npm
- A Cloudflare account with **Workers + Durable Objects**. **Dynamic Workers / Worker Loader** availability depends on your plan and may require enrollment: check Cloudflare's current documentation for the Worker Loader binding (`worker_loaders`) *before* relying on it.
- `wrangler` 4.x (installed as a dev dependency)

## Local development

```bash
npm install
cp .env.example .dev.vars        # set GATEWAY_JWT_SECRET (>=32 chars); keep SF_MODE=mock ALLOW_DEV_TOKENS=true
npm run dev:worker               # builds the dashboard, starts wrangler dev on :8787 (real workerd + Worker Loader)
# in another terminal, optional hot reload of the dashboard:
npm run dev:dashboard            # http://localhost:5173 (proxies /api, /mcp to :8787)
```

Local `wrangler dev` runs your code in the real `workerd` runtime, including the Worker Loader. See [security.md](security.md) for the one thing local dev cannot prove (CPU-limit enforcement).

## Deploy

```bash
npx wrangler login
npm run build:dashboard

# secrets (never in git)
openssl rand -base64 48 | npx wrangler secret put GATEWAY_JWT_SECRET     # or set GATEWAY_JWKS_URL as a var
# live Salesforce only:
npx wrangler secret put SF_CLIENT_SECRET
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY
# optional Playground generation:
npx wrangler secret put ANTHROPIC_API_KEY

# non-secret vars: edit "vars" in wrangler.jsonc (SF_MODE, SF_LOGIN_URL, SF_CLIENT_ID, SF_REDIRECT_URI, SF_API_VERSION)
npm run deploy
GATEWAY_URL=https://salesforce-codemode-gateway.<sub>.workers.dev GATEWAY_TOKEN=<jwt> npm run verify:deployment
```

First deploy applies the Durable Object migration `v1` (`new_sqlite_classes: ["GatewayDO"]`).

`npx wrangler deploy --dry-run --outdir=.wrangler/dryrun` validates bundling without credentials (CI runs it).

## Going live (mock → Salesforce)

1. Complete [salesforce-setup.md](salesforce-setup.md) and [oauth-setup.md](oauth-setup.md).
2. Set `SF_MODE=live`, `ALLOW_DEV_TOKENS=false`, and the secrets above. Redeploy.
3. Each user opens the dashboard → Overview → **Connect my Salesforce user**.
4. Re-run `npm run verify:deployment`.

## CI/CD

[.github/workflows/ci.yml](../.github/workflows/ci.yml): typecheck → lint → tests → benchmark smoke (artifact) → dashboard build → `wrangler deploy --dry-run`. The `deploy` job runs only on `main` when the repository variable `DEPLOY_ENABLED=true`, using the secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `GATEWAY_SMOKE_TOKEN` and the variable `GATEWAY_URL`; it finishes with `verify-deployment.sh`. These secrets are **manual configuration** and are not present in the repo.

## Configuration reference

See [.env.example](../.env.example). `EXECUTION_POLICY_JSON` accepts any field of `ExecutionPolicySchema` ([policy.ts](../packages/governance/src/policy.ts)): `maxCodeBytes`, `timeoutMs`, `maxCpuMs`, `maxResultBytes`, `maxRecordsPerQuery`, `maxToolCallsPerExecution`, `maxSalesforceApiCallsPerExecution`, `writesEnabled`, `writesRequireApproval`, `allowSelfApproval`, `approvalTtlMs`, `executionsPerMinute`, `toolCallsPerMinute`, `toolAllowlist`, `approvedAgents`.

## Operations

- **State:** all governance/metrics state is in the Durable Object. Metrics keep the latest 500 executions.
- **Mock org state** is per-isolate memory and resets when the Durable Object restarts.
- **Observability:** `observability.enabled` in `wrangler.jsonc` turns on Workers Logs; audit events are in-app (Security Center) and exportable via `/api/audit`.
