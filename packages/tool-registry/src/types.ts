import type { z } from "zod";
import type { Availability, CloudDomain, Principal, ToolKind } from "@sfcm/shared-types";
import type { SalesforceApi } from "@sfcm/salesforce-client";
import type { ExecutionPolicy, Permission } from "@sfcm/governance";

/** Host-side adapters for systems that are not plain Salesforce REST (mock-only unless a live adapter is supplied). */
export interface Adapters {
  [name: string]: unknown;
}

export interface ToolContext {
  principal: Principal;
  /** User-scoped, metered Salesforce API. Credentials never leave the host. */
  sf: SalesforceApi;
  policy: ExecutionPolicy;
  adapters: Adapters;
  /** Per-execution scratch cache (e.g. describe results). */
  cache: Map<string, unknown>;
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  domain: CloudDomain;
  /** Namespace exposed inside the sandbox, e.g. "sf" -> sf.searchAccounts(). */
  namespace: string;
  kind: ToolKind;
  permission: Permission;
  availability: Availability;
  /** Extra notes shown in discovery (e.g. which live adapter is required). */
  notes?: string;
  input: I;
  output: O;
  examples: string[];
  handler: (ctx: ToolContext, input: z.output<I>) => Promise<z.input<O>>;
}

export type AnyTool = ToolDefinition<any, any>;

export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return def;
}
