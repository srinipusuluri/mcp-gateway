#!/usr/bin/env bash
# Post-deploy verification of a running gateway (local `wrangler dev` or a deployed Worker).
#   GATEWAY_URL=https://salesforce-codemode-gateway.<acct>.workers.dev GATEWAY_TOKEN=<jwt> ./scripts/verify-deployment.sh
# Every probe has a client-side timeout so a hung gateway is reported instead of hanging the script.
set -u
URL="${GATEWAY_URL:-http://127.0.0.1:8787}"
TOKEN="${GATEWAY_TOKEN:?set GATEWAY_TOKEN to a gateway JWT with the execute permission}"
pass=0; fail=0
check() { if [ "$2" = "0" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }
exec_code() { python3 -c 'import json,sys;print(json.dumps({"code":sys.argv[1]}))' "$1" | curl -s -m "${2:-30}" "$URL/api/execute" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @-; }

curl -sf -m 10 "$URL/health" >/dev/null; check "health endpoint" $?
curl -s -m 10 -o /dev/null -w '%{http_code}' "$URL/mcp" | grep -q 401; check "MCP rejects unauthenticated requests (401)" $?
exec_code 'async () => (await sf.searchAccounts({ limit: 1 })).count' | grep -q '"ok":true'; check "execute_code runs a Salesforce call in the sandbox" $?
exec_code 'async () => fetch("https://example.com")' | grep -q 'code_rejected'; check "fetch() is rejected" $?
exec_code 'async () => { const k = "constr"+"uctor"; return [][k][k]("return 1")() }' | grep -Eq 'execution_error|code_rejected'; check "dynamic code generation is blocked" $?
exec_code 'async () => { await new Promise(() => {}); }' 40 | grep -q '"timeout"'; check "unresolved promise hits the wall-clock timeout" $?
echo "--- CPU-bound loop (the runtime's cpuMs limit must stop this; a hang here means the limit is NOT enforced) ---"
exec_code 'async () => { let go = 1; while (go) {} }' 45 | grep -Eq 'execution_error|timeout|"ok":false'; check "synchronous infinite loop is terminated" $?
curl -sf -m 10 "$URL/health" >/dev/null; check "gateway still responsive after the loop" $?
echo "passed=$pass failed=$fail"; [ "$fail" = "0" ]
