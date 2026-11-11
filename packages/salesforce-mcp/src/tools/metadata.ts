import { z } from "zod";
import { GatewayError } from "@sfcm/security";
import { defineTool } from "@sfcm/tool-registry";
import { assertIdentifier } from "@sfcm/salesforce-client";
import { describeCached } from "../helpers";

const objectName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/, "valid object API name");
const FieldOut = z.object({ name: z.string(), label: z.string(), type: z.string(), createable: z.boolean(), updateable: z.boolean(), referenceTo: z.array(z.string()).optional() });

export const metadataTools = [
  defineTool({
    name: "getAvailableObjects", title: "Available objects", domain: "metadata", namespace: "sf", kind: "read", permission: "sf.read.metadata", availability: "live",
    description: "List sObjects visible to the calling user (CRUD-filtered by Salesforce).",
    input: z.object({ search: z.string().max(60).optional(), customOnly: z.boolean().optional(), queryableOnly: z.boolean().default(true) }),
    output: z.object({ objects: z.array(z.object({ name: z.string(), label: z.string(), custom: z.boolean(), createable: z.boolean(), updateable: z.boolean() })), count: z.number() }),
    examples: ["await sf.getAvailableObjects({ search: 'case' })"],
    handler: async (ctx, i) => {
      const all = await ctx.sf.describeGlobal();
      const q = i.search?.toLowerCase();
      const objects = all
        .filter((o) => (!i.queryableOnly || o.queryable) && (!i.customOnly || o.custom) && (!q || o.name.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)))
        .map((o) => ({ name: o.name, label: o.label, custom: o.custom, createable: o.createable, updateable: o.updateable }))
        .slice(0, 300);
      return { objects, count: objects.length };
    },
  }),
  defineTool({
    name: "describeObject", title: "Describe object", domain: "metadata", namespace: "sf", kind: "read", permission: "sf.read.metadata", availability: "live",
    description: "Object-level metadata plus the fields the calling user may read.",
    input: z.object({ objectName }),
    output: z.object({ name: z.string(), label: z.string(), custom: z.boolean(), createable: z.boolean(), updateable: z.boolean(), fieldCount: z.number(), fields: z.array(FieldOut) }),
    examples: ["await sf.describeObject({ objectName: 'Opportunity' })"],
    handler: async (ctx, i) => {
      const d = await describeCached(ctx, assertIdentifier(i.objectName, "object name")).catch(() => {
        throw new GatewayError("forbidden", `Object '${i.objectName}' does not exist or is not accessible.`, 403);
      });
      return { name: d.name, label: d.label, custom: d.custom, createable: d.createable, updateable: d.updateable, fieldCount: d.fields.length, fields: d.fields.map((f) => ({ name: f.name, label: f.label, type: f.type, createable: f.createable, updateable: f.updateable, referenceTo: f.referenceTo })) };
    },
  }),
  defineTool({
    name: "describeFields", title: "Describe fields", domain: "metadata", namespace: "sf", kind: "read", permission: "sf.read.metadata", availability: "live",
    description: "List an object's readable fields, optionally filtered by type or name substring.",
    input: z.object({ objectName, type: z.string().max(30).optional(), search: z.string().max(60).optional() }),
    output: z.object({ fields: z.array(FieldOut), count: z.number() }),
    examples: ["await sf.describeFields({ objectName: 'Account', type: 'currency' })"],
    handler: async (ctx, i) => {
      const d = await describeCached(ctx, i.objectName).catch(() => {
        throw new GatewayError("forbidden", `Object '${i.objectName}' does not exist or is not accessible.`, 403);
      });
      const q = i.search?.toLowerCase();
      const fields = d.fields.filter((f) => (!i.type || f.type === i.type) && (!q || f.name.toLowerCase().includes(q) || f.label.toLowerCase().includes(q))).map((f) => ({ name: f.name, label: f.label, type: f.type, createable: f.createable, updateable: f.updateable, referenceTo: f.referenceTo }));
      return { fields, count: fields.length };
    },
  }),
  defineTool({
    name: "getPicklistValues", title: "Picklist values", domain: "metadata", namespace: "sf", kind: "read", permission: "sf.read.metadata", availability: "live",
    description: "Active picklist values for a field.",
    input: z.object({ objectName, fieldName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/) }),
    output: z.object({ field: z.string(), values: z.array(z.object({ value: z.string(), label: z.string() })) }),
    examples: ["await sf.getPicklistValues({ objectName: 'Opportunity', fieldName: 'StageName' })"],
    handler: async (ctx, i) => {
      const d = await describeCached(ctx, i.objectName).catch(() => {
        throw new GatewayError("forbidden", `Object '${i.objectName}' does not exist or is not accessible.`, 403);
      });
      const f = d.fields.find((x) => x.name === i.fieldName);
      if (!f) throw new GatewayError("invalid_input", `Field '${i.fieldName}' not found or not accessible.`, 404);
      return { field: f.name, values: (f.picklistValues ?? []).filter((p) => p.active).map((p) => ({ value: p.value, label: p.label })) };
    },
  }),
];
