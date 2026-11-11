# Tool registry

The registry ([packages/tool-registry](../packages/tool-registry/src)) is the single source of truth for every capability. One definition drives: the sandbox binding, Zod validation, RBAC, TypeScript declarations shown to the model, the dashboard Tool Explorer, the direct-MCP baseline, and documentation examples.

## Current capabilities (29)

| Domain | Tools | Kind | Availability |
|---|---|---|---|
| Sales | `searchAccounts` `getAccount` `searchContacts` `getContactsByAccount` `getOpportunities` `getOpportunityDetails` `getPipelineSummary` | read | live |
| Service | `searchCases` `getCaseDetails` `getOpenCasesByAccount` `getKnowledgeArticles` | read | live |
| Service | `createCase` `updateCase` | **write (approval)** | live |
| CPQ / Revenue | `getQuotes` `getQuoteLines` `getOrders` `getAssets` | read | live (standard objects) |
| CPQ / Revenue | `getSubscriptions` | read | **mock-only** (`SBQQ__Subscription__c`, unverified) |
| Data Cloud | `searchCustomerProfiles` `retrieveUnifiedProfile` `queryApprovedDataCloudSources` | read | **mock-only** |
| Metadata | `getAvailableObjects` `describeObject` `describeFields` `getPicklistValues` | read | live |
| Agentforce | `invokeApprovedAgent` | read (allowlisted) | **mock-only** |
| Agentforce | `invokeApprovedAgentAction` | **write (approval)** | **mock-only** |
| External (`netsuite.*`) | `getCustomerInvoices` `getCreditStatus` | read | **mock-only** |

*live* = implemented with real Salesforce REST calls (and also runs against the mock). *mock-only* = only a mock adapter exists; a live adapter must be supplied. In `live` mode, mock-only tools report `availableNow: false` in discovery and fail with `not_available`.

## Anatomy of a tool

```ts
import { z } from "zod";
import { defineTool } from "@sfcm/tool-registry";
import { listRecords, paging, listOut, rec } from "@sfcm/salesforce-mcp";

export const myTool = defineTool({
  name: "getContracts",             // valid JS identifier → sf.getContracts()
  title: "Contracts",
  description: "List contracts for an account.",
  domain: "sales",                  // sales | service | cpq | datacloud | metadata | agentforce | external
  namespace: "sf",                  // sandbox global ("netsuite", …)
  kind: "read",                     // "write" ⇒ approval gate automatically
  permission: "sf.read.sales",      // must exist in rbac.ts
  availability: "live",
  input: z.object({ accountId: sfId, ...paging }),
  output: listOut(rec({ Id: z.string(), Status: z.string() })),
  examples: ["await sf.getContracts({ accountId })"],
  handler: (ctx, i) => listRecords(ctx, {
    object: "Contract", defaultFields: ["Id", "Status", "AccountId"],
    where: [{ field: "AccountId", op: "=", value: i.accountId }],
    limit: i.limit, offset: i.offset,
  }),
});
```

Register it: `createSalesforceRegistry([myTool])`, or `registry.register(myTool)`.

**Rules the framework enforces for you:** authorization, input parsing, approval gate for writes, per-execution budgets, redaction, audit, error mapping, metering of Salesforce API calls. **Rules you must follow in `handler`:**

1. Build SOQL only with `buildSoql` / `listRecords`; never concatenate input into a query.
2. Select fields through `accessibleFields` / `listRecords` so field-level security is honoured.
3. Never return credentials; never call `fetch` with user-controlled URLs.
4. Keep outputs bounded (`limit`, pagination, aggregation).

## Adding a permission

Add it to the `Permission` union and `ROLE_PERMISSIONS` in [rbac.ts](../packages/governance/src/rbac.ts), then add tests in `tests/unit/governance.test.ts`.

## Enabling live adapters (Data Cloud, Agentforce, NetSuite)

Adapters are plain objects implementing the interfaces in [adapters/types.ts](../packages/salesforce-mcp/src/adapters/types.ts). In `platform.ts → salesforceFor`, return them in `adapters` for live mode:

```ts
return { sf: new SalesforceClient({ tokens, apiVersion }), adapters: { dataCloud: new LiveDataCloud(...), agentforce: new LiveAgentforce(...), netsuite: new McpNetSuite(...) } };
```

- **Data Cloud:** implement `DataCloudAdapter` with the Data Cloud Query / Profile APIs. Keep the approved-source allowlist; tools already filter rows by Salesforce Account visibility.
- **Agentforce:** implement `AgentforceAdapter` against the Agent API. Keep `approvedAgents` in policy; `invokeApprovedAgentAction` stays approval-gated.
- **NetSuite / other MCP systems:** implement `NetSuiteAdapter` by calling the remote MCP server with `@modelcontextprotocol/sdk`'s `Client` + `StreamableHTTPClientTransport`; credentials stay in Worker secrets, and the sandbox only ever sees the namespaced `netsuite.*` functions.

These live adapters are **not implemented in this repository**; the mocks demonstrate the contract.

## Enabling approved write operations

Writes are on by default **but gated**: the first call returns `approval_required`. To operate them:

1. Give users the role that carries the permission (`service_agent` → `sf.write.case`).
2. Give a *different* user `approver` (or `admin`).
3. Approver opens **Security Center → Approval queue**, reviews the exact arguments, approves.
4. The requester re-runs the same program; it executes once.

Policy switches (`EXECUTION_POLICY_JSON`): `"writesEnabled": false` disables all writes globally; `"allowSelfApproval": true` (not recommended) relaxes four-eyes; `"approvalTtlMs"` sets expiry.
