import { decryptJson, encryptJson, randomId, sha256Base64Url, toBase64Url } from "@sfcm/security";
import type { StateStore } from "@sfcm/governance";
import { SalesforceAuthError } from "./types";
import type { TokenProvider } from "./client";

export interface OAuthConfig {
  /** https://login.salesforce.com (prod) or https://test.salesforce.com (sandbox) or a My Domain URL. */
  loginUrl: string;
  clientId: string;
  /** Optional for External Client Apps / public PKCE clients; required for classic Connected Apps with secret. */
  clientSecret?: string;
  redirectUri: string;
  scopes?: string[];
  fetch?: typeof fetch;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  instanceUrl: string;
  /** Identity URL (https://login.salesforce.com/id/00D.../005...). */
  id?: string;
  scope?: string;
  issuedAt: number;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
}

export class SalesforceOAuth {
  private readonly doFetch: typeof fetch;
  constructor(private readonly cfg: OAuthConfig) {
    this.doFetch = cfg.fetch ?? ((...a) => fetch(...a));
  }

  private base(): string {
    return this.cfg.loginUrl.replace(/\/+$/, "");
  }

  /** Authorization-code flow with PKCE (S256). Persist {state, codeVerifier} server-side until the callback. */
  async createAuthorization(): Promise<AuthorizationRequest> {
    const verifierBytes = crypto.getRandomValues(new Uint8Array(48));
    const codeVerifier = toBase64Url(verifierBytes);
    const challenge = await sha256Base64Url(codeVerifier);
    const state = randomId("st", 18);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      scope: (this.cfg.scopes ?? ["api", "refresh_token"]).join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return { url: `${this.base()}/services/oauth2/authorize?${params}`, state, codeVerifier };
  }

  private async tokenRequest(params: Record<string, string>): Promise<Record<string, string>> {
    const body = new URLSearchParams({ client_id: this.cfg.clientId, ...params });
    if (this.cfg.clientSecret) body.set("client_secret", this.cfg.clientSecret);
    const res = await this.doFetch(`${this.base()}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, string>;
    if (!res.ok) {
      // error_description may be echoed to operators but never contains our secrets.
      throw new SalesforceAuthError(`Salesforce token endpoint error: ${json.error ?? res.status}`);
    }
    return json;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
    const j = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri, code_verifier: codeVerifier });
    return this.toTokenSet(j);
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const j = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    // Salesforce does not return a new refresh token on refresh; keep the old one.
    return { ...this.toTokenSet(j), refreshToken };
  }

  /** Revoke a refresh or access token (logout). */
  async revoke(token: string): Promise<void> {
    const res = await this.doFetch(`${this.base()}/services/oauth2/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    if (!res.ok && res.status !== 400) throw new SalesforceAuthError(`Token revocation failed (${res.status}).`);
  }

  private toTokenSet(j: Record<string, string>): TokenSet {
    if (!j.access_token || !j.instance_url) throw new SalesforceAuthError("Malformed token response from Salesforce.");
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      instanceUrl: j.instance_url,
      id: j.id,
      scope: j.scope,
      issuedAt: Number(j.issued_at) || Date.now(),
    };
  }
}

/** Tokens are AES-256-GCM encrypted at rest; the key lives only in Worker secrets. */
export class TokenVault {
  constructor(
    private readonly store: StateStore,
    private readonly encryptionKey: string,
  ) {}
  async save(userId: string, tokens: TokenSet): Promise<void> {
    await this.store.put(`sftoken:${userId}`, await encryptJson(tokens, this.encryptionKey));
  }
  async get(userId: string): Promise<TokenSet | undefined> {
    const blob = await this.store.get<string>(`sftoken:${userId}`);
    return blob ? decryptJson<TokenSet>(blob, this.encryptionKey) : undefined;
  }
  async delete(userId: string): Promise<void> {
    await this.store.delete(`sftoken:${userId}`);
  }
}

/** Per-user TokenProvider: refreshes on 401 and clears the vault when the session cannot be renewed. */
export class VaultTokenProvider implements TokenProvider {
  private cached?: TokenSet;
  constructor(
    private readonly userId: string,
    private readonly vault: TokenVault,
    private readonly oauth: SalesforceOAuth,
  ) {}

  private async load(): Promise<TokenSet> {
    this.cached ??= await this.vault.get(this.userId);
    if (!this.cached) throw new SalesforceAuthError("No Salesforce session for this user. Reconnect from the dashboard (Overview → Connect my Salesforce user).");
    return this.cached;
  }
  async getAccessToken() {
    return (await this.load()).accessToken;
  }
  async instanceUrl() {
    return (await this.load()).instanceUrl;
  }
  async refresh() {
    const cur = await this.load();
    if (!cur.refreshToken) {
      await this.vault.delete(this.userId);
      throw new SalesforceAuthError("Salesforce session expired and no refresh token is available. Reconnect from the dashboard (Overview → Connect my Salesforce user).");
    }
    try {
      const next = await this.oauth.refresh(cur.refreshToken);
      this.cached = next;
      await this.vault.save(this.userId, next);
      return next.accessToken;
    } catch {
      await this.vault.delete(this.userId);
      this.cached = undefined;
      throw new SalesforceAuthError("Salesforce session expired. Reconnect from the dashboard (Overview → Connect my Salesforce user).");
    }
  }
}
