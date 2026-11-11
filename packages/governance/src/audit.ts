import { randomId, sha256Hex } from "@sfcm/security";
import { nowIso, type AuditAction, type AuditEvent } from "@sfcm/shared-types";
import { KeyedMutex, type StateStore } from "./store";

const GENESIS = "0".repeat(64);

/** Append-only, hash-chained audit log: any edit or deletion breaks verify(). */
export class AuditLog {
  private readonly lock = new KeyedMutex();
  constructor(private readonly store: StateStore) {}

  append(input: {
    action: AuditAction;
    userId: string;
    outcome: AuditEvent["outcome"];
    resource?: string;
    detail?: Record<string, unknown>;
  }): Promise<AuditEvent> {
    return this.lock.run("audit-chain", () => this.appendUnlocked(input));
  }

  private async appendUnlocked(input: {
    action: AuditAction;
    userId: string;
    outcome: AuditEvent["outcome"];
    resource?: string;
    detail?: Record<string, unknown>;
  }): Promise<AuditEvent> {
    const head = (await this.store.get<{ seq: number; hash: string }>("audit:head")) ?? { seq: 0, hash: GENESIS };
    const seq = head.seq + 1;
    const base = {
      id: randomId("aud"),
      ts: nowIso(),
      action: input.action,
      userId: input.userId,
      outcome: input.outcome,
      resource: input.resource,
      detail: input.detail,
      prevHash: head.hash,
    };
    const hash = await sha256Hex(JSON.stringify(base));
    const event: AuditEvent = { ...base, hash };
    await this.store.put(`audit:e:${String(seq).padStart(12, "0")}`, event);
    await this.store.put("audit:head", { seq, hash });
    return event;
  }

  async list(limit = 100): Promise<AuditEvent[]> {
    const rows = await this.store.list<AuditEvent>("audit:e:", { limit, reverse: true });
    return rows.map((r) => r.value);
  }

  /** Recompute the whole chain; returns the first broken sequence number, if any. */
  async verify(): Promise<{ valid: boolean; checked: number; brokenAt?: number }> {
    const rows = await this.store.list<AuditEvent>("audit:e:");
    let prev = GENESIS;
    let i = 0;
    for (const { value } of rows) {
      i++;
      const { hash, ...rest } = value;
      if (rest.prevHash !== prev || (await sha256Hex(JSON.stringify(rest))) !== hash) return { valid: false, checked: i, brokenAt: i };
      prev = hash;
    }
    return { valid: true, checked: i };
  }
}
