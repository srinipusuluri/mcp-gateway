/**
 * Mint a gateway JWT for local development / smoke tests.
 *   npm run token -- analyst            # prints a token valid for 8 hours
 * Reads GATEWAY_JWT_SECRET from the environment or .dev.vars. Production tokens come from your IdP.
 */
import { readFileSync } from "node:fs";
import { signToken } from "../packages/security/src/auth";
import { ALL_ROLES, type Role } from "../packages/shared-types/src";

function secret(): string {
  if (process.env.GATEWAY_JWT_SECRET) return process.env.GATEWAY_JWT_SECRET;
  try {
    const m = readFileSync(".dev.vars", "utf8").match(/^GATEWAY_JWT_SECRET=(.+)$/m);
    if (m?.[1]) return m[1].trim();
  } catch {
    /* fall through */
  }
  throw new Error("Set GATEWAY_JWT_SECRET (env or .dev.vars)");
}

const role = (process.argv[2] ?? "analyst") as Role;
if (!ALL_ROLES.includes(role)) throw new Error(`role must be one of: ${ALL_ROLES.join(", ")}`);
const profile = process.argv[3]; // optional mock Salesforce profile: sf_admin | sf_analyst | sf_service | sf_rep_east
console.log(await signToken({ sub: `local-${role}`, roles: [role], email: `${role}@local.test`, sf_user_id: profile }, secret(), { expiresInSeconds: 8 * 3600 }));
