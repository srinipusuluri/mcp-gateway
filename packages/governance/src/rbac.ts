import type { Principal, Role } from "@sfcm/shared-types";
import { GatewayError } from "@sfcm/security";

export type Permission =
  | "discover"
  | "execute"
  | "sf.read.sales"
  | "sf.read.service"
  | "sf.read.cpq"
  | "sf.read.datacloud"
  | "sf.read.metadata"
  | "sf.read.knowledge"
  | "sf.agentforce.invoke"
  | "external.read"
  | "sf.write.case"
  | "approvals.decide"
  | "audit.read"
  | "admin";

const READ_ALL: Permission[] = [
  "sf.read.sales",
  "sf.read.service",
  "sf.read.cpq",
  "sf.read.datacloud",
  "sf.read.metadata",
  "sf.read.knowledge",
  "external.read",
];

/** Role -> permissions. Deny by default: a role with no entry has no access. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ["discover", "sf.read.metadata"],
  analyst: ["discover", "execute", ...READ_ALL, "sf.agentforce.invoke"],
  sales_rep: ["discover", "execute", "sf.read.sales", "sf.read.metadata", "sf.read.cpq", "sf.read.knowledge"],
  service_agent: ["discover", "execute", "sf.read.sales", "sf.read.service", "sf.read.metadata", "sf.read.knowledge", "sf.write.case"],
  approver: ["discover", "approvals.decide", "audit.read", "sf.read.metadata"],
  admin: ["discover", "execute", ...READ_ALL, "sf.agentforce.invoke", "sf.write.case", "approvals.decide", "audit.read", "admin"],
};

export function permissionsOf(principal: Principal): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of principal.roles) for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
  return out;
}

export function can(principal: Principal, permission: Permission): boolean {
  const perms = permissionsOf(principal);
  return perms.has(permission) || perms.has("admin");
}

export function requirePermission(principal: Principal, permission: Permission): void {
  if (!can(principal, permission)) {
    throw new GatewayError("forbidden", `Missing permission '${permission}'.`, 403);
  }
}
