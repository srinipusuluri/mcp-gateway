import { GatewayError, randomId, sha256Hex } from "@sfcm/security";
import { nowIso, type ApprovalRequest } from "@sfcm/shared-types";
import { KeyedMutex, type StateStore } from "./store";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function fingerprint(tool: string, args: unknown, requestedBy: string): Promise<string> {
  return sha256Hex(`${tool}\n${requestedBy}\n${canonicalJson(args)}`);
}

export interface ApprovalOptions {
  ttlMs: number;
  allowSelfApproval: boolean;
}

/**
 * Human-in-the-loop gate for writes. An approval authorizes exactly one execution of
 * one (tool, args, requester) tuple. It is consumed on use and expires.
 */
export class ApprovalService {
  private readonly lock = new KeyedMutex();
  constructor(
    private readonly store: StateStore,
    private readonly options: ApprovalOptions,
  ) {}

  private key(id: string) {
    return `approval:${id}`;
  }

  /** Return an existing live request for the same call, or create one. */
  requestOrGet(tool: string, args: unknown, requestedBy: string): Promise<ApprovalRequest> {
    return this.lock.run("approvals", () => this.requestOrGetUnlocked(tool, args, requestedBy));
  }

  private async requestOrGetUnlocked(tool: string, args: unknown, requestedBy: string): Promise<ApprovalRequest> {
    const fp = await fingerprint(tool, args, requestedBy);
    const existing = (await this.list()).find((a) => a.fingerprint === fp && (a.status === "pending" || a.status === "approved"));
    if (existing) return existing;
    const req: ApprovalRequest = {
      id: randomId("apr"),
      fingerprint: fp,
      tool,
      args,
      requestedBy,
      requestedAt: nowIso(),
      status: "pending",
      expiresAt: new Date(Date.now() + this.options.ttlMs).toISOString(),
    };
    await this.store.put(this.key(req.id), req);
    return req;
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    const a = await this.store.get<ApprovalRequest>(this.key(id));
    if (a && (a.status === "pending" || a.status === "approved") && Date.parse(a.expiresAt) < Date.now()) {
      a.status = "expired";
      await this.store.put(this.key(id), a);
    }
    return a;
  }

  async list(): Promise<ApprovalRequest[]> {
    const rows = await this.store.list<ApprovalRequest>("approval:");
    const out: ApprovalRequest[] = [];
    for (const { value } of rows) out.push((await this.get(value.id)) ?? value);
    return out.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  decide(id: string, approverId: string, approve: boolean, reason?: string): Promise<ApprovalRequest> {
    return this.lock.run("approvals", () => this.decideUnlocked(id, approverId, approve, reason));
  }

  private async decideUnlocked(id: string, approverId: string, approve: boolean, reason?: string): Promise<ApprovalRequest> {
    const a = await this.get(id);
    if (!a) throw new GatewayError("invalid_input", "Unknown approval id.", 404);
    if (a.status !== "pending") throw new GatewayError("invalid_input", `Approval is already ${a.status}.`, 409);
    if (approve && !this.options.allowSelfApproval && a.requestedBy === approverId) {
      throw new GatewayError("forbidden", "Requesters cannot approve their own write requests.", 403);
    }
    a.status = approve ? "approved" : "rejected";
    a.decidedBy = approverId;
    a.decidedAt = nowIso();
    a.reason = reason;
    await this.store.put(this.key(id), a);
    return a;
  }

  /** If an approved request matches this exact call, atomically mark it consumed. */
  consumeIfApproved(tool: string, args: unknown, requestedBy: string): Promise<ApprovalRequest | undefined> {
    return this.lock.run("approvals", () => this.consumeUnlocked(tool, args, requestedBy));
  }

  private async consumeUnlocked(tool: string, args: unknown, requestedBy: string): Promise<ApprovalRequest | undefined> {
    const fp = await fingerprint(tool, args, requestedBy);
    const match = (await this.list()).find((a) => a.fingerprint === fp && a.status === "approved");
    if (!match) return undefined;
    match.status = "consumed";
    await this.store.put(this.key(match.id), match);
    return match;
  }
}
