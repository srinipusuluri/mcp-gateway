import { z } from "zod";
import type { AnyTool } from "./types";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  maximum?: number;
  minimum?: number;
  prefixItems?: JsonSchema[];
};

const safeKey = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
const doc = (d: string | undefined, indent: string) => (d ? `${indent}/** ${d.replace(/\*\//g, "* /").replace(/\n/g, " ")} */\n` : "");

export function jsonSchemaToTs(s: JsonSchema, indent = ""): string {
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ") || "never";
  const union = s.anyOf ?? s.oneOf;
  if (union) return [...new Set(union.map((x) => jsonSchemaToTs(x, indent)))].join(" | ");
  if (s.allOf) return s.allOf.map((x) => jsonSchemaToTs(x, indent)).join(" & ");
  const t = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (t.length > 1) return t.map((x) => jsonSchemaToTs({ ...s, type: x }, indent)).join(" | ");
  switch (t[0]) {
    case "string": return "string";
    case "number":
    case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": {
      if (s.prefixItems) return `[${s.prefixItems.map((x) => jsonSchemaToTs(x, indent)).join(", ")}]`;
      const inner = jsonSchemaToTs(s.items ?? {}, indent);
      return /[|&]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
    }
    case "object": {
      const props = s.properties ?? {};
      const req = new Set(s.required ?? []);
      const next = indent + "  ";
      const lines = Object.entries(props).map(([k, v]) => `${doc(v.description, next)}${next}${safeKey(k)}${req.has(k) ? "" : "?"}: ${jsonSchemaToTs(v, next)};`);
      if (s.additionalProperties && typeof s.additionalProperties === "object") lines.push(`${next}[key: string]: ${jsonSchemaToTs(s.additionalProperties, next)};`);
      else if (s.additionalProperties === true) lines.push(`${next}[key: string]: unknown;`);
      return lines.length ? `{\n${lines.join("\n")}\n${indent}}` : "Record<string, unknown>";
    }
    default:
      return "unknown";
  }
}

/** Convert a Zod schema to a TypeScript type expression using Zod's own JSON Schema export. */
export function zodToTs(schema: z.ZodType, io: "input" | "output", indent = ""): string {
  const js = z.toJSONSchema(schema, { io, unrepresentable: "any", target: "draft-7" }) as JsonSchema;
  return jsonSchemaToTs(js, indent);
}

export function toolSignature(tool: AnyTool, indent = "  "): string {
  const kindTag = tool.kind === "write" ? "WRITE (requires human approval)" : "read";
  const header = `${indent}/**\n${indent} * ${tool.description.replace(/\n/g, " ")}\n${indent} * [${kindTag}] permission: ${tool.permission}${tool.availability === "mock-only" ? " | availability: mock-only" : ""}\n${indent} */\n`;
  return `${header}${indent}${tool.name}(input: ${zodToTs(tool.input, "input", indent)}): Promise<${zodToTs(tool.output, "output", indent)}>;`;
}

/** Full ambient declaration block the model sees: `declare const sf: { ... }`. */
export function generateTypeScriptApi(tools: AnyTool[]): string {
  const byNs = new Map<string, AnyTool[]>();
  for (const t of tools) byNs.set(t.namespace, [...(byNs.get(t.namespace) ?? []), t]);
  return [...byNs.entries()].map(([ns, ts]) => `declare const ${ns}: {\n${ts.map((t) => toolSignature(t)).join("\n\n")}\n};`).join("\n\n");
}
