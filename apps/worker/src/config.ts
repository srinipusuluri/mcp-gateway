import { z } from "zod";
import { ExecutionPolicySchema, type ExecutionPolicy } from "@sfcm/governance";

export interface AppConfig {
  /** mock = built-in fake org (default); live = real Salesforce via user-scoped OAuth. */
  mode: "mock" | "live";
  auth: { jwtSecret?: string; jwksUrl?: string; issuer?: string; audience?: string };
  /** Lets the dashboard mint demo tokens. MUST be false in production. */
  allowDevTokens: boolean;
  sf: { loginUrl: string; clientId?: string; clientSecret?: string; redirectUri?: string; apiVersion: string };
  tokenEncryptionKey?: string;
  policy: ExecutionPolicy;
  anthropic: { apiKey?: string; model: string };
  publicUrl?: string;
}

type Env = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function configFromEnv(env: Env): AppConfig {
  const mode = str(env.SF_MODE) === "live" ? "live" : "mock";
  const policyOverrides = z.record(z.string(), z.unknown()).safeParse(str(env.EXECUTION_POLICY_JSON) ? JSON.parse(str(env.EXECUTION_POLICY_JSON)!) : {});
  const config: AppConfig = {
    mode,
    auth: { jwtSecret: str(env.GATEWAY_JWT_SECRET), jwksUrl: str(env.GATEWAY_JWKS_URL), issuer: str(env.GATEWAY_JWT_ISSUER), audience: str(env.GATEWAY_JWT_AUDIENCE) },
    allowDevTokens: str(env.ALLOW_DEV_TOKENS) === "true",
    sf: {
      loginUrl: str(env.SF_LOGIN_URL) ?? "https://login.salesforce.com",
      clientId: str(env.SF_CLIENT_ID),
      clientSecret: str(env.SF_CLIENT_SECRET),
      redirectUri: str(env.SF_REDIRECT_URI),
      apiVersion: str(env.SF_API_VERSION) ?? "v66.0",
    },
    tokenEncryptionKey: str(env.TOKEN_ENCRYPTION_KEY),
    policy: ExecutionPolicySchema.parse(policyOverrides.success ? policyOverrides.data : {}),
    anthropic: { apiKey: str(env.ANTHROPIC_API_KEY), model: str(env.ANTHROPIC_MODEL) ?? "claude-sonnet-5-5" },
    publicUrl: str(env.PUBLIC_URL),
  };
  return config;
}

/** Fail fast on unsafe or incomplete configuration. */
export function validateConfig(c: AppConfig): string[] {
  const problems: string[] = [];
  if (!c.auth.jwtSecret && !c.auth.jwksUrl) problems.push("Set GATEWAY_JWT_SECRET (>=32 chars) or GATEWAY_JWKS_URL.");
  if (c.auth.jwtSecret && c.auth.jwtSecret.length < 32) problems.push("GATEWAY_JWT_SECRET must be at least 32 characters.");
  if (c.mode === "live") {
    if (!c.sf.clientId) problems.push("SF_CLIENT_ID is required in live mode.");
    if (!c.sf.redirectUri) problems.push("SF_REDIRECT_URI is required in live mode.");
    if (!c.tokenEncryptionKey) problems.push("TOKEN_ENCRYPTION_KEY (32 bytes, base64) is required in live mode.");
    if (c.allowDevTokens) problems.push("ALLOW_DEV_TOKENS must be false in live mode.");
  }
  return problems;
}
