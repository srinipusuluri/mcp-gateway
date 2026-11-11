import { GatewayError } from "@sfcm/security";
import { KeyedMutex, type StateStore } from "./store";

/** Fixed-window limiter. Backed by the StateStore (a single Durable Object in production). */
export class RateLimiter {
  private readonly lock = new KeyedMutex();
  constructor(private readonly store: StateStore) {}

  check(bucket: string, limit: number, windowMs = 60_000, cost = 1): Promise<{ remaining: number }> {
    return this.lock.run(`rl:${bucket}`, () => this.checkUnlocked(bucket, limit, windowMs, cost));
  }

  private async checkUnlocked(bucket: string, limit: number, windowMs: number, cost: number): Promise<{ remaining: number }> {
    const windowId = Math.floor(Date.now() / windowMs);
    const key = `rl:${bucket}:${windowId}`;
    const used = (await this.store.get<number>(key)) ?? 0;
    if (used + cost > limit) {
      const retryAfter = Math.ceil(((windowId + 1) * windowMs - Date.now()) / 1000);
      throw new GatewayError("rate_limited", `Rate limit exceeded for '${bucket}'. Retry in ${retryAfter}s.`, 429, { retryAfter });
    }
    await this.store.put(key, used + cost);
    return { remaining: limit - used - cost };
  }
}
