import { jwtVerify, SignJWT, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { ALL_ROLES, type Principal, type Role } from "@sfcm/shared-types";
import { GatewayError } from "./errors";

export interface AuthConfig {
  /** HS256 shared secret (>= 32 chars). Use for simple deployments / dev. */
  jwtSecret?: string;
  /** JWKS URL for RS256/ES256 tokens issued by your IdP (Okta, Entra ID, Auth0). */
  jwksUrl?: string;
  issuer?: string;
  audience?: string;
}

const encoder = new TextEncoder();

function parseRoles(raw: unknown): Role[] {
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[ ,]+/) : [];
  const roles = arr.filter((r): r is Role => typeof r === "string" && (ALL_ROLES as readonly string[]).includes(r));
  return [...new Set(roles)];
}

/** Verify a bearer token and map claims to a Principal. Throws GatewayError('unauthenticated'). */
export async function authenticateBearer(authorization: string | null | undefined, config: AuthConfig): Promise<Principal> {
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
    throw new GatewayError("unauthenticated", "Missing or malformed Authorization header (expected 'Bearer <token>').", 401);
  }
  const token = authorization.replace(/^Bearer\s+/i, "");
  let getKey: JWTVerifyGetKey | Uint8Array;
  let algorithms: string[];
  if (config.jwksUrl) {
    getKey = createRemoteJWKSet(new URL(config.jwksUrl));
    algorithms = ["RS256", "ES256", "PS256"];
  } else if (config.jwtSecret) {
    if (config.jwtSecret.length < 32) throw new GatewayError("internal_error", "Gateway JWT secret is too short.", 500);
    getKey = encoder.encode(config.jwtSecret);
    algorithms = ["HS256"];
  } else {
    throw new GatewayError("internal_error", "Gateway authentication is not configured.", 500);
  }
  try {
    const { payload } = await jwtVerify(token, getKey as never, {
      algorithms,
      issuer: config.issuer,
      audience: config.audience,
    });
    const userId = typeof payload.sub === "string" ? payload.sub : undefined;
    if (!userId) throw new Error("no sub");
    const roles = parseRoles(payload.roles ?? payload.role);
    return {
      userId,
      email: typeof payload.email === "string" ? payload.email : undefined,
      displayName: typeof payload.name === "string" ? payload.name : undefined,
      roles: roles.length ? roles : ["viewer"],
      salesforceUserId: typeof payload.sf_user_id === "string" ? payload.sf_user_id : undefined,
    };
  } catch {
    // Never reveal why verification failed.
    throw new GatewayError("unauthenticated", "Invalid or expired token.", 401);
  }
}

/** Issue an HS256 token. Used for the dev/mock token endpoint and tests only. */
export async function signToken(
  claims: { sub: string; roles: Role[]; email?: string; name?: string; sf_user_id?: string },
  secret: string,
  opts: { expiresInSeconds?: number; issuer?: string; audience?: string } = {},
): Promise<string> {
  const jwt = new SignJWT({ roles: claims.roles, email: claims.email, name: claims.name, sf_user_id: claims.sf_user_id })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${opts.expiresInSeconds ?? 3600}s`);
  if (opts.issuer) jwt.setIssuer(opts.issuer);
  if (opts.audience) jwt.setAudience(opts.audience);
  return jwt.sign(encoder.encode(secret));
}
