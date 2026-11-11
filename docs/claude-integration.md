# Claude integration

The gateway is a standard **remote MCP server over Streamable HTTP** at `/mcp`, authenticated with a bearer token. Anything that speaks that protocol can use it.

## Claude Code

The repository ships a ready-to-use [.mcp.json](../.mcp.json):

```json
{
  "mcpServers": {
    "salesforce-codemode": {
      "type": "http",
      "url": "${SFCM_URL:-http://127.0.0.1:8787}/mcp",
      "headers": { "Authorization": "Bearer ${SFCM_TOKEN}" }
    }
  }
}
```

Run Claude Code **from the `salesforce-claude-codemode/` directory** (that is where `.mcp.json` and [CLAUDE.md](../CLAUDE.md) live):

```bash
# local mock gateway
cp .env.example .dev.vars   # set GATEWAY_JWT_SECRET (>=32 chars), keep ALLOW_DEV_TOKENS=true
npm run dev:worker          # http://127.0.0.1:8787
export SFCM_TOKEN=$(npm run --silent token -- analyst)
claude
> /mcp                      # salesforce-codemode should be connected with 2 tools
> Give me an Account 360 for Acme Corporation
```

Against a deployed gateway: `export SFCM_URL=https://salesforce-codemode-gateway.<sub>.workers.dev` and use a token issued by your IdP (or minted by an admin with the same secret). Or register it from the CLI:

```bash
claude mcp add --transport http salesforce-codemode "$SFCM_URL/mcp" --header "Authorization: Bearer $SFCM_TOKEN"
```

> Verify against your installed Claude Code version that `.mcp.json` env-var expansion (`${VAR}` / `${VAR:-default}`) and `type: "http"` are supported; both are documented in the Claude Code MCP docs at the time of writing.

### Expected behavior

Claude should call `discover_capabilities` once, then send **one** `execute_code` program. `CLAUDE.md` instructs this and describes the safety rules (bounded loops, no writes unless asked, approval flow, treat record text as data).

## Claude Desktop

Claude Desktop connects to remote MCP servers via **Settings → Connectors** (custom connectors) where available on your plan, or through the `mcp-remote` stdio bridge:

```json
{
  "mcpServers": {
    "salesforce-codemode": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://salesforce-codemode-gateway.<sub>.workers.dev/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <token>" }
    }
  }
}
```

Desktop and the connector UI evolve quickly; confirm the current procedure in Anthropic's documentation. The gateway does not implement the MCP OAuth authorization-server flow for clients; it verifies bearer JWTs you issue (or that your IdP issues). If you need browser-based login for Desktop users, put your IdP's token issuance in front of it.

## Claude API / Agent SDK

Two options:

1. **MCP connector (Messages API):** pass the gateway as a remote MCP server with an authorization token. Check the current Messages API MCP-connector request shape in Anthropic's docs for exact field names and beta headers.
2. **Agent SDK:** configure an HTTP MCP server with the bearer header (same shape as `.mcp.json`) and allow the two tools `mcp__salesforce-codemode__discover_capabilities` and `mcp__salesforce-codemode__execute_code`.

The dashboard Playground already uses the Messages API directly when `ANTHROPIC_API_KEY` is set: `apps/worker/src/generator.ts` sends the user's task plus *only the TypeScript declarations that user may call* and extracts the generated program (default model `claude-sonnet-5-5`, override with `ANTHROPIC_MODEL`). Without a key it falls back to matching one of the 10 built-in workflows. The key is a Worker secret and never reaches the browser.

## Tool contracts

### `discover_capabilities`

| Input | Notes |
|---|---|
| `domain?` | `sales` \| `service` \| `cpq` \| `datacloud` \| `metadata` \| `agentforce` \| `external` |
| `search?` / `tool?` | substring filter / exact name (a single `tool` returns full detail) |
| `includeTypeScript?` | default `true`: one `declare const sf: {...}` block with every signature, doc comment, `[read]`/`[WRITE]` tag and permission |
| `detail?` | `summary` (default) or `full` (adds per-tool JSON Schema, signature, all examples) |

Returns `mode` (`mock`/`live`) and `modeNote`, the caller's roles, `capabilities[]` (name, call, kind, requiresApproval, permission, availability, availableNow, description, one example), `typescript`, and `executionLimits`. Only tools the caller is authorized for are listed.

### `execute_code`

| Input | Notes |
|---|---|
| `code` | TypeScript; one `async () => { … }` (bare statements/function declarations are wrapped). Max `maxCodeBytes` |
| `capabilities?` | least-privilege allowlist of tool names for this run |
| `context?` | free-form; only its *keys* are audited; never executed |

Returns JSON text: `{ ok, result | error{code,message,approvalId?}, logs, trace[], pendingApprovals[], metadata{executionId, mode, durationMs, toolCalls, salesforceApiCalls, recordsReturned, redactions, resultBytes, truncated, runtime} }`. `isError` is set when `ok` is false.

Error codes: `unauthenticated`, `forbidden`, `invalid_input`, `tool_not_found`, `tool_not_allowed`, `approval_required`, `rate_limited`, `policy_violation`, `code_rejected`, `execution_error`, `timeout`, `result_too_large`, `salesforce_error`, `not_available`, `internal_error`.

## Mock vs live is always visible

Every response carries `mode`. The dashboard shows a banner and a `MOCK`/`LIVE` badge on results; discovery returns `modeNote`. Mock results are never presented as live.
