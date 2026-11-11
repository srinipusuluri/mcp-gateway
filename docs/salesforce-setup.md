# Salesforce setup

> This guide describes what to configure; it was **not** executed against a live org by the authors (no credentials were available). Verify each step in a sandbox. Salesforce UI labels and defaults change between releases; check the current release notes for External Client Apps vs Connected Apps.

## 1. Choose an org

Use a **sandbox** or Developer Edition first (`SF_LOGIN_URL=https://test.salesforce.com` for sandboxes, `https://login.salesforce.com` for production/Developer Edition, or your **My Domain** URL).

## 2. Create the OAuth app

Salesforce is steering new integrations to **External Client Apps**; classic **Connected Apps** continue to work where your org allows creating them. Either way, set:

| Setting | Value |
|---|---|
| Callback URL | exactly your `SF_REDIRECT_URI`, e.g. `https://salesforce-codemode-gateway.<sub>.workers.dev/oauth/callback` (and `http://127.0.0.1:8787/oauth/callback` for local dev) |
| OAuth scopes | `api` (Manage user data via APIs) and `refresh_token` (Perform requests at any time) |
| PKCE | **Require Proof Key for Code Exchange (PKCE)** enabled |
| Client secret | Optional with PKCE; if the app issues one, set `SF_CLIENT_SECRET` as a Worker secret |
| Flows | Authorization Code (web server) only. Do **not** enable the client-credentials or username-password flows for this app |
| Access policy | "Admin approved users are pre-authorized" + assign the permission sets below; IP relaxation per your policy |
| Refresh token policy | e.g. "Expire refresh token after 90 days of inactivity" |

Copy the **Consumer Key** to `SF_CLIENT_ID`.

## 3. Permission sets (map one per gateway role)

The gateway restricts *which tools* a role can call; **Salesforce restricts which data the user can see.** Both must agree. Never use a shared integration user to stand in for Claude users: that would give every Claude user that user's access.

| Gateway role | Salesforce permission set (suggested name) | Grants |
|---|---|---|
| `analyst` | `SFCM_Analyst_ReadOnly` | System permission **API Enabled**; Read on Account, Contact, Opportunity, Case, Quote, QuoteLineItem, Order, Asset, Product2, Knowledge; field access per your data policy |
| `sales_rep` | `SFCM_Sales_Rep` | as above for sales objects; sharing via role hierarchy / territories |
| `service_agent` | `SFCM_Service_Agent` | Read Account/Contact/Opportunity/Case/Knowledge; **Create/Edit Case**; hide revenue fields (e.g. `AnnualRevenue`, `Amount`) via FLS |
| `approver` | none required for data; needs **API Enabled** only if they use live metadata tools | |
| `admin` | your normal admin permission set | |

Tips: use **Permission Set Groups** (+ muting) to keep these maintainable; keep FLS *least privilege* on sensitive fields (SSN-like, tax id, revenue). The gateway will report FLS-hidden fields in `omittedFields` instead of failing.

## 4. Fields and objects the demos assume

| Used by | Needs |
|---|---|
| Customer Risk | custom Account fields `Overdue_Invoices__c` (number), `Past_Due_Amount__c` (currency); custom Opportunity field `Previous_Amount__c` (currency). Without them, those inputs are reported in `omittedFields` and the workflow degrades |
| Knowledge | Lightning Knowledge enabled (`Knowledge__kav`); pass `bodyField` with your rich-text field's API name (the mock uses `Body__c`) |
| CPQ analysis | standard `Quote` / `QuoteLineItem` (Salesforce CPQ uses `SBQQ__Quote__c`: add an adapter or tool variant) |
| Subscriptions | `SBQQ__Subscription__c` (unverified mapping, **mock-only**) |

## 5. API limits

Each tool call costs 1 REST call plus (once per object per execution) 1 describe call. Execution budgets cap this (`maxSalesforceApiCallsPerExecution`, default 50). The client reads `Sforce-Limit-Info` and the dashboard shows consumption; watch the org's daily API limit.

## 6. Verify

1. Complete [oauth-setup.md](oauth-setup.md).
2. In the dashboard, Overview → **Connect my Salesforce user**, then Tool Explorer → `getAvailableObjects` → Run. You should see only objects *that user* can read.
3. Run the Account 360 program against a real account name.
