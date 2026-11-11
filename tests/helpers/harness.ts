import { MemoryStore } from "@sfcm/governance";
import { MockOrg } from "@sfcm/salesforce-client";
import { QuickJsExecutor } from "@sfcm/codemode-runtime";
import { signToken } from "@sfcm/security";
import type { Principal, Role } from "@sfcm/shared-types";
import { createApp } from "@sfcm/worker";
import { configFromEnv } from "../../apps/worker/src/config";
import { createPlatform, type Platform } from "../../apps/worker/src/platform";

export const JWT_SECRET = "test-secret-test-secret-test-secret-1234";

export function makePlatform(env: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Platform {
  const config = configFromEnv({ GATEWAY_JWT_SECRET: JWT_SECRET, ALLOW_DEV_TOKENS: "true", ...env });
  const executor = new QuickJsExecutor({ timeoutMs: opts.timeoutMs ?? config.policy.timeoutMs });
  return createPlatform({ config, store: new MemoryStore(), executor, runtimeName: "quickjs-wasm", org: new MockOrg(new Date()) });
}

export function principal(role: Role, extra: Partial<Principal> = {}): Principal {
  return { userId: `u-${role}`, roles: [role], ...extra };
}

export async function token(role: Role, userId = `u-${role}`, profile?: string): Promise<string> {
  return signToken({ sub: userId, roles: [role], sf_user_id: profile }, JWT_SECRET);
}

export async function run(platform: Platform, p: Principal, code: string, extra: { capabilities?: string[] } = {}) {
  const { sf, adapters } = platform.salesforceFor(p);
  return platform.engine.execute({ code, principal: p, sf, adapters, ...extra });
}

export function appFor(platform: Platform) {
  return createApp(platform);
}
