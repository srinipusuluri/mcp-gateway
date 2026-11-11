import { DurableObject } from "cloudflare:workers";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { MemoryStore, type StateStore } from "@sfcm/governance";
import { MockOrg } from "@sfcm/salesforce-client";
import type { Executor } from "@sfcm/codemode-runtime";
import { createApp, type FetchHandler } from "./app";
import { configFromEnv, validateConfig } from "./config";
import { withLimits } from "./limited-loader";
import { createPlatform } from "./platform";

export interface Env {
  LOADER: WorkerLoader;
  GATEWAY: DurableObjectNamespace;
  ASSETS: Fetcher;
  [key: string]: unknown;
}

/** StateStore over Durable Object storage (strongly consistent, single-writer). */
class DoStore implements StateStore {
  constructor(private readonly storage: DurableObjectStorage) {}
  async get<T>(key: string) {
    return (await this.storage.get<T>(key)) ?? undefined;
  }
  async put<T>(key: string, value: T) {
    await this.storage.put(key, value);
  }
  async delete(key: string) {
    await this.storage.delete(key);
  }
  async list<T>(prefix: string, opts: { limit?: number; reverse?: boolean } = {}) {
    const m = await this.storage.list<T>({ prefix, limit: opts.limit, reverse: opts.reverse });
    return [...m.entries()].map(([key, value]) => ({ key, value }));
  }
}

/**
 * The whole gateway runs inside one Durable Object so audit chain, approvals, rate limits and
 * metrics are consistent without extra coordination. Shard by tenant id (idFromName(tenant)) for scale.
 */
export class GatewayDO extends DurableObject<Env> {
  private handler?: FetchHandler;

  private build(): FetchHandler {
    const config = configFromEnv(this.env as Record<string, unknown>);
    const problems = validateConfig(config);
    if (problems.length) {
      return async () => new Response(JSON.stringify({ error: { code: "internal_error", message: "Gateway misconfigured.", problems } }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const executor: Executor = new DynamicWorkerExecutor({
      loader: withLimits(this.env.LOADER, { cpuMs: config.policy.maxCpuMs }),
      timeout: config.policy.timeoutMs,
      globalOutbound: null, // sandbox has NO network: fetch()/connect() throw at the runtime level
    });
    const platform = createPlatform({ config, store: new DoStore(this.ctx.storage), executor, runtimeName: "cloudflare-dynamic-worker", org: new MockOrg() });
    return createApp(platform);
  }

  override async fetch(request: Request): Promise<Response> {
    this.handler ??= this.build();
    return this.handler(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.GATEWAY.get(env.GATEWAY.idFromName("global"));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

void MemoryStore;
