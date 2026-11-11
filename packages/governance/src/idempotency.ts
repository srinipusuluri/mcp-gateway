import { KeyedMutex, type StateStore } from "./store";

/** Replays the stored result for a repeated idempotency key instead of re-running a write. */
export class IdempotencyStore {
  private readonly lock = new KeyedMutex();
  constructor(private readonly store: StateStore) {}

  run<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; replayed: boolean }> {
    return this.lock.run(`idem:${key}`, () => this.runUnlocked(key, fn));
  }

  private async runUnlocked<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; replayed: boolean }> {
    const k = `idem:${key}`;
    const hit = await this.store.get<{ value: T }>(k);
    if (hit) return { value: hit.value, replayed: true };
    const value = await fn();
    await this.store.put(k, { value });
    return { value, replayed: false };
  }
}
