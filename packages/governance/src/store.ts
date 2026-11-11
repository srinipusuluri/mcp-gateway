/** Minimal async JSON key-value contract. Memory for tests/dev; a Durable Object in production. */
export interface StateStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys are returned in lexicographic order; `reverse` returns newest-first for time-prefixed keys. */
  list<T>(prefix: string, opts?: { limit?: number; reverse?: boolean }): Promise<Array<{ key: string; value: T }>>;
}

export class MemoryStore implements StateStore {
  private readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list<T>(prefix: string, opts: { limit?: number; reverse?: boolean } = {}): Promise<Array<{ key: string; value: T }>> {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (opts.reverse) keys.reverse();
    return keys.slice(0, opts.limit ?? keys.length).map((key) => ({ key, value: structuredClone(this.data.get(key)) as T }));
  }
}

/**
 * In-process keyed mutex. Governance read-modify-write sequences (audit head, rate-limit counters,
 * approval de-duplication, idempotency) interleave at every `await`, so parallel tool calls would
 * otherwise lose updates. In production the whole gateway runs in ONE Durable Object, which makes an
 * in-process lock sufficient; if you shard state across instances, use a store with transactions instead.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
