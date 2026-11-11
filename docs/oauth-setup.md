# OAuth setup

## Configuration

| Variable | Purpose | Where |
|---|---|---|
| `SF_MODE` | `live` to use Salesforce (default `mock`) | `wrangler.jsonc` vars |
| `SF_LOGIN_URL` | `https://login.salesforce.com`, `https://test.salesforce.com`, or My Domain | vars |
| `SF_CLIENT_ID` | Consumer key | vars or secret |
| `SF_CLIENT_SECRET` | Consumer secret (if the app has one) | **secret** |
| `SF_REDIRECT_URI` | Callback URL registered on the app (`…/oauth/callback`) | vars |
| `SF_API_VERSION` | default `v66.0` (verify the current version for your org) | vars |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64; encrypts tokens at rest | **secret** |
| `GATEWAY_JWT_SECRET` / `GATEWAY_JWKS_URL` | how users authenticate to the gateway | secret / vars |

```bash
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put SF_CLIENT_SECRET
npx wrangler secret put GATEWAY_JWT_SECRET      # or set GATEWAY_JWKS_URL as a var
```

Config validation (`validateConfig`) makes the gateway answer `503 Gateway misconfigured` with a list of problems if required values are missing in live mode, and refuses `ALLOW_DEV_TOKENS=true` in live mode.

## Flow summary

Authorization code + **PKCE (S256)**, per user (diagram 4 in [architecture.md](architecture.md)).

1. A signed-in user clicks **Connect my Salesforce user** (`POST /api/oauth/start`).
2. The gateway generates verifier + challenge + state, stores `sha256(state) → {userId, verifier, expires}` (10 minutes, single use) and returns the authorize URL.
3. Salesforce redirects to `/oauth/callback?code&state`; the gateway exchanges the code with the verifier (and secret if configured) and stores the tokens **AES-256-GCM encrypted** under the user id.
4. Tool calls use that user's access token. On `401` the client refreshes once and retries.
5. If the refresh token is invalid/expired/revoked, the stored tokens are **deleted** and the user must reconnect: no silent fallback to another identity.
6. **Logout** (`POST /api/oauth/logout`) revokes the token at Salesforce and deletes the vault entry.

## Session expiration

Salesforce access tokens expire per the org's session settings; the token response does not carry a reliable expiry, so the client is *reactive*: refresh on `401`. Refresh tokens expire per the app's refresh-token policy. Both cases surface to Claude as `[unauthenticated] Salesforce session expired. Reconnect from the dashboard (Overview → Connect my Salesforce user).`

## Local testing

OAuth needs a real org and an HTTPS-reachable (or localhost) callback registered on the app. Without credentials, run in mock mode; the OAuth service is covered by `tests/unit/oauth.test.ts` using fake endpoints.
