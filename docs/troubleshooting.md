# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `503 Gateway misconfigured` with `problems[]` | missing `GATEWAY_JWT_SECRET`/JWKS, or live mode without client id / redirect / `TOKEN_ENCRYPTION_KEY` | set the listed variables/secrets and redeploy |
| `401 Invalid or expired token` | wrong secret, expired JWT, wrong `iss`/`aud` | mint a fresh token (`npm run token -- analyst`); check `GATEWAY_JWT_ISSUER/AUDIENCE` |
| Claude shows no tools / MCP not connected | not started in the repo dir (no `.mcp.json`), `SFCM_TOKEN` unset, gateway down | `claude` from `salesforce-claude-codemode/`; `echo $SFCM_TOKEN`; `curl $SFCM_URL/health` |
| `[forbidden] Missing permission 'execute'` | `viewer`/`approver` role | use `analyst`, `sales_rep`, `service_agent` or `admin` |
| `… is not a function` inside code | the tool is not bound for your role (e.g. `sf.createCase` as analyst), is disabled by policy, or `capabilities` excluded it | run `discover_capabilities`; it lists exactly what you may call |
| `code_rejected: Disallowed identifier 'fetch'` etc. | static lint | remove network/process/import usage; use `sf.*` |
| `code_rejected: Unbounded loop` | `while(true)` / `for(;;)` | bound loops, e.g. `for (let page = 0; page < 20; page++)` |
| `execution_error` | exception thrown by your program | read `error.message` and `logs` |
| `timeout` | wall-clock limit (`timeoutMs`) or CPU cap | do less per execution; paginate; raise `timeoutMs` within reason |
| `result_too_large` | one un-truncatable value above `maxResultBytes` | aggregate/project inside the program |
| `approval_required` | a write needs a human | approver approves in Security Center; re-run the same program |
| `forbidden … not createable by this user (FLS)` | Salesforce FLS/CRUD blocks the write even after approval | fix the user's permission set |
| `rate_limited` | per-user rate limit | wait (`Retry-After` in the message) or raise limits |
| `[salesforce_error] [INVALID_FIELD] No such column` | field missing in the org (custom fields in demos) | create the field or omit it; see [salesforce-setup.md](salesforce-setup.md) |
| `[unauthenticated] Salesforce session expired` | refresh token expired/revoked | dashboard → Connect my Salesforce user |
| `not_available … needs a dataCloud adapter` | mock-only tool used in live mode | supply a live adapter ([tool-registry.md](tool-registry.md)) |
| Dashboard shows "Demo tokens … ALLOW_DEV_TOKENS" | dev tokens disabled | paste a real token, or enable only for local mock demos |
| `wrangler dev` hangs after a sync loop | CPU limit not enforced locally | restart; run `scripts/verify-deployment.sh` against a deployed Worker, see [security.md](security.md) |
| `Cannot find module 'cloudflare:workers'` in Node | importing the Worker entry in Node | tests import `@sfcm/worker` (`app.ts`) only; `index.ts` is Workers-only |

## Useful commands

```bash
npm run typecheck && npm run lint && npm test     # full local verification
npm run bench -- 20                                # regenerate tests/evaluations/results/
npm run example -- customer-risk                   # run a workflow against the mock org
npx wrangler tail                                  # live logs from a deployed Worker
```
