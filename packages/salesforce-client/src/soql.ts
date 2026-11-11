/**
 * SOQL construction and validation. All queries issued by the platform are built by
 * buildSoql() from validated identifiers and escaped literals; there is no path that
 * concatenates caller-controlled text into a query.
 */

export class SoqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoqlError";
  }
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const PATH = /^[A-Za-z][A-Za-z0-9_]{0,79}(\.[A-Za-z][A-Za-z0-9_]{0,79}){0,4}$/;
const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

export function assertIdentifier(name: string, what = "identifier"): string {
  if (!IDENT.test(name)) throw new SoqlError(`Invalid ${what}: ${JSON.stringify(name).slice(0, 60)}`);
  return name;
}

export function assertFieldPath(name: string): string {
  if (!PATH.test(name)) throw new SoqlError(`Invalid field path: ${JSON.stringify(name).slice(0, 60)}`);
  return name;
}

export function assertSalesforceId(id: string): string {
  if (!SF_ID.test(id)) throw new SoqlError(`Invalid Salesforce id: ${JSON.stringify(id).slice(0, 40)}`);
  return id;
}

/** Escape a string for use inside a single-quoted SOQL literal. */
export function escapeSoqlString(value: string): string {
  return value.replace(/[\\'"\n\r\t\b\f]/g, (c) => {
    switch (c) {
      case "\n": return "\\n";
      case "\r": return "\\r";
      case "\t": return "\\t";
      case "\b": return "\\b";
      case "\f": return "\\f";
      default: return "\\" + c;
    }
  });
}

/** Escape LIKE wildcards in user text, so '%' and '_' match literally. */
export function escapeLike(value: string): string {
  return escapeSoqlString(value).replace(/[%_]/g, (c) => "\\" + c);
}

/** A pre-validated, unquoted SOQL literal (dates, date-literals). Only constructible via helpers. */
export class SoqlLiteral {
  private constructor(readonly text: string) {}
  static date(iso: string): SoqlLiteral {
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.test(iso)) throw new SoqlError("Invalid date literal");
    return new SoqlLiteral(iso);
  }
  /** A LIKE pattern: user text is escaped so %, _ and quotes match literally, then wrapped. */
  static like(text: string, mode: "contains" | "startsWith" = "contains"): SoqlLiteral {
    const e = escapeLike(text);
    return new SoqlLiteral(`'${mode === "contains" ? "%" : ""}${e}%'`);
  }
  /** TODAY, THIS_QUARTER, LAST_N_DAYS:30, NEXT_N_DAYS:90 ... */
  static dateKeyword(kw: string): SoqlLiteral {
    if (!/^(TODAY|YESTERDAY|TOMORROW|THIS_WEEK|THIS_MONTH|THIS_QUARTER|THIS_YEAR|LAST_QUARTER|NEXT_QUARTER|(LAST|NEXT)_N_DAYS:\d{1,4})$/.test(kw)) {
      throw new SoqlError("Invalid date keyword");
    }
    return new SoqlLiteral(kw);
  }
}

export type SoqlValue = string | number | boolean | null | SoqlLiteral | Array<string | number>;

export type SoqlOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "LIKE" | "IN" | "NOT IN";
const OPS = new Set<string>(["=", "!=", "<", "<=", ">", ">=", "LIKE", "IN", "NOT IN"]);

export interface SoqlCondition {
  field: string;
  op: SoqlOp;
  value: SoqlValue;
}

export interface SoqlSelect {
  object: string;
  fields: string[];
  /** AND-ed conditions. */
  where?: SoqlCondition[];
  orderBy?: Array<{ field: string; direction?: "ASC" | "DESC" }>;
  limit?: number;
  offset?: number;
}

function formatValue(op: SoqlOp, v: SoqlValue): string {
  if (op === "IN" || op === "NOT IN") {
    if (!Array.isArray(v) || v.length === 0) throw new SoqlError(`${op} requires a non-empty array`);
    if (v.length > 200) throw new SoqlError(`${op} list too large (max 200)`);
    return `(${v.map((x) => formatValue("=", x)).join(", ")})`;
  }
  if (v === null) return "null";
  if (v instanceof SoqlLiteral) return v.text;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new SoqlError("Non-finite number");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return `'${op === "LIKE" ? escapeLike(v) : escapeSoqlString(v)}'`;
  throw new SoqlError("Unsupported literal");
}

export function buildSoql(q: SoqlSelect): string {
  assertIdentifier(q.object, "object name");
  if (!q.fields.length) throw new SoqlError("At least one field is required");
  const fields = [...new Set(q.fields.map(assertFieldPath))];
  let out = `SELECT ${fields.join(", ")} FROM ${q.object}`;
  if (q.where?.length) {
    const parts = q.where.map((c) => {
      assertFieldPath(c.field);
      if (!OPS.has(c.op)) throw new SoqlError(`Unsupported operator ${String(c.op)}`);
      return `${c.field} ${c.op} ${formatValue(c.op, c.value)}`;
    });
    out += ` WHERE ${parts.join(" AND ")}`;
  }
  if (q.orderBy?.length) {
    out += ` ORDER BY ${q.orderBy.map((o) => `${assertFieldPath(o.field)} ${o.direction === "DESC" ? "DESC" : "ASC"}`).join(", ")}`;
  }
  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 2000) throw new SoqlError("limit must be an integer in 1..2000");
    out += ` LIMIT ${q.limit}`;
  }
  if (q.offset !== undefined) {
    if (!Number.isInteger(q.offset) || q.offset < 0 || q.offset > 2000) throw new SoqlError("offset must be an integer in 0..2000");
    out += ` OFFSET ${q.offset}`;
  }
  return out;
}

/**
 * Defense-in-depth gate applied by every SalesforceApi.query(): exactly one read-only SELECT,
 * no statement separators, no comments, no DML-ish keywords outside string literals.
 */
export function assertReadOnlySoql(soql: string): void {
  if (soql.length > 20_000) throw new SoqlError("SOQL too long");
  // Strip string literals before scanning for structure.
  const stripped = soql.replace(/'(?:\\.|[^'\\])*'/g, "''");
  if (!/^\s*SELECT\s/i.test(stripped)) throw new SoqlError("Only SELECT statements are allowed");
  if (/;|--|\/\*|\*\//.test(stripped)) throw new SoqlError("Statement separators and comments are not allowed");
  if (/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|UNDELETE)\b/i.test(stripped)) throw new SoqlError("DML keywords are not allowed");
  if ((stripped.match(/\bSELECT\b/gi) ?? []).length > 1) throw new SoqlError("Subqueries are not allowed");
  // Unbalanced quotes would indicate injection that survived stripping.
  if ((stripped.match(/'/g) ?? []).length % 2 !== 0) throw new SoqlError("Unbalanced quotes");
}
