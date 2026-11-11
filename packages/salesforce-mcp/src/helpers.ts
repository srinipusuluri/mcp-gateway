import { z } from "zod";
import { buildSoql, type ObjectDescribe, type SoqlCondition } from "@sfcm/salesforce-client";
import { GatewayError } from "@sfcm/security";
import type { ToolContext } from "@sfcm/tool-registry";

export const sfId = z.string().regex(/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/, "must be a 15/18 character Salesforce id");
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
export const customFields = z
  .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*__c$/, "custom field API name ending in __c"))
  .max(20)
  .optional()
  .describe("Extra custom fields (API names ending in __c). Fields the user cannot access are omitted and reported in omittedFields.");

export const paging = {
  limit: z.number().int().min(1).max(200).default(25).describe("Page size (max 200, also capped by gateway policy)"),
  offset: z.number().int().min(0).max(2000).default(0).describe("Row offset for pagination; use nextOffset from the previous page"),
};

/** All Salesforce records are dynamic (FLS decides which fields exist), so every field is optional. */
export const rec = <T extends z.ZodRawShape>(shape: T) => z.object(shape).partial().catchall(z.unknown());

export const listOut = <T extends z.ZodType>(item: T) =>
  z.object({
    records: z.array(item),
    count: z.number(),
    hasMore: z.boolean().describe("True if more rows exist beyond this page"),
    nextOffset: z.number().nullable().describe("Pass as offset to fetch the next page"),
    omittedFields: z.array(z.string()).describe("Requested fields the user may not read (field-level security)"),
  });

/** Describe, cached per execution (promise cached so parallel calls share one request). */
export function describeCached(ctx: ToolContext, object: string): Promise<ObjectDescribe> {
  const key = `describe:${object}`;
  let p = ctx.cache.get(key) as Promise<ObjectDescribe> | undefined;
  if (!p) {
    p = ctx.sf.describeObject(object);
    ctx.cache.set(key, p);
    p.catch(() => ctx.cache.delete(key));
  }
  return p;
}

/** Intersect desired fields with what this user may read (CRUD/FLS enforced via the user's own describe). */
export async function accessibleFields(ctx: ToolContext, object: string, desired: string[]) {
  const d = await describeCached(ctx, object).catch(() => {
    throw new GatewayError("forbidden", `Object '${object}' is not accessible to this user.`, 403);
  });
  if (!d.queryable) throw new GatewayError("forbidden", `Object '${object}' is not queryable.`, 403);
  const all = new Set(d.fields.map((f) => f.name));
  const fields = [...new Set(desired)].filter((f) => all.has(f));
  const omitted = [...new Set(desired)].filter((f) => !all.has(f));
  return { fields, omitted, all, describe: d };
}

export interface ListArgs {
  object: string;
  defaultFields: string[];
  extraFields?: string[];
  where?: SoqlCondition[];
  orderBy?: Array<{ field: string; direction?: "ASC" | "DESC" }>;
  limit: number;
  offset: number;
}

export async function listRecords(ctx: ToolContext, a: ListArgs) {
  const { fields, omitted, all } = await accessibleFields(ctx, a.object, [...a.defaultFields, ...(a.extraFields ?? [])]);
  if (!fields.length) throw new GatewayError("forbidden", `No readable fields on '${a.object}'.`, 403);
  for (const c of a.where ?? []) {
    if (!c.field.includes(".") && !all.has(c.field)) throw new GatewayError("forbidden", `Field '${a.object}.${c.field}' is not accessible to this user.`, 403);
  }
  const orderBy = (a.orderBy ?? []).filter((o) => all.has(o.field));
  const limit = Math.min(a.limit, ctx.policy.maxRecordsPerQuery);
  const soql = buildSoql({ object: a.object, fields, where: a.where, orderBy, limit: limit + 1, offset: a.offset });
  const res = await ctx.sf.query<Record<string, unknown>>(soql, { maxRecords: limit + 1 });
  const hasMore = res.records.length > limit;
  const records = hasMore ? res.records.slice(0, limit) : res.records;
  return { records, count: records.length, hasMore, nextOffset: hasMore ? a.offset + limit : null, omittedFields: omitted };
}

export async function getById(ctx: ToolContext, object: string, id: string, defaultFields: string[], extra: string[] = []) {
  const r = await listRecords(ctx, { object, defaultFields, extraFields: extra, where: [{ field: "Id", op: "=", value: id }], limit: 1, offset: 0 });
  const record = r.records[0];
  if (!record) throw new GatewayError("invalid_input", `${object} ${id} not found or not visible to this user.`, 404);
  return { record, omittedFields: r.omittedFields };
}
