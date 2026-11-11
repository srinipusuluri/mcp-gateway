/** A deliberately small SOQL evaluator for the mock org: SELECT/FROM/WHERE/ORDER BY/LIMIT/OFFSET. */
import { SalesforceApiError, type SfRecord } from "../types";

type Tok = { k: "id" | "str" | "num" | "date" | "op" | "punc"; v: string };

const TOKEN =
  /\s*(?:('(?:\\.|[^'\\])*')|(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?)|((?:LAST|NEXT)_N_DAYS:\d+)|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|!=|<>|=|<|>)|([(),*]))/y;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(pos))) break;
      throw new SalesforceApiError(400, "MALFORMED_QUERY", `Unexpected token near '${src.slice(pos, pos + 12).trim()}'`);
    }
    pos = TOKEN.lastIndex;
    if (m[1] !== undefined) out.push({ k: "str", v: m[1].slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "%" || c === "_" ? `\\${c}` : ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[c] ?? c)) });
    else if (m[2] !== undefined) out.push({ k: "date", v: m[2] });
    else if (m[3] !== undefined) out.push({ k: "date", v: m[3] });
    else if (m[4] !== undefined) out.push({ k: "num", v: m[4] });
    else if (m[5] !== undefined) out.push({ k: "id", v: m[5] });
    else if (m[6] !== undefined) out.push({ k: "op", v: m[6] === "<>" ? "!=" : m[6] });
    else if (m[7] !== undefined) out.push({ k: "punc", v: m[7] });
  }
  return out;
}

export type Expr =
  | { t: "or" | "and"; l: Expr; r: Expr }
  | { t: "not"; e: Expr }
  | { t: "cmp"; field: string; op: string; value: unknown };

export interface ParsedQuery {
  fields: string[];
  object: string;
  where?: Expr;
  orderBy: Array<{ field: string; desc: boolean }>;
  limit?: number;
  offset?: number;
}

const isKw = (t: Tok | undefined, kw: string) => t?.k === "id" && t.v.toUpperCase() === kw;

export function parseSoql(src: string): ParsedQuery {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  const fail = (m: string): never => {
    throw new SalesforceApiError(400, "MALFORMED_QUERY", m);
  };
  const expectKw = (kw: string) => {
    if (!isKw(peek(), kw)) fail(`Expected ${kw}`);
    i++;
  };

  expectKw("SELECT");
  const fields: string[] = [];
  do {
    const t = take();
    if (t?.k !== "id") fail("Expected field name");
    fields.push(t!.v);
  } while (peek()?.v === "," && (i++, true));
  expectKw("FROM");
  const objTok = take();
  if (objTok?.k !== "id") fail("Expected object name");
  const q: ParsedQuery = { fields, object: objTok!.v, orderBy: [] };

  const value = (): unknown => {
    const t = take();
    if (!t) return fail("Expected value");
    if (t.k === "str") return t.v;
    if (t.k === "num") return Number(t.v);
    if (t.k === "date") return { date: t.v };
    if (t.k === "id") {
      const u = t.v.toUpperCase();
      if (u === "TRUE") return true;
      if (u === "FALSE") return false;
      if (u === "NULL") return null;
      return { date: t.v.toUpperCase() };
    }
    return fail("Bad value");
  };
  const cmp = (): Expr => {
    if (peek()?.v === "(") {
      i++;
      const e = or();
      if (take()?.v !== ")") fail("Expected )");
      return e;
    }
    if (isKw(peek(), "NOT")) {
      i++;
      return { t: "not", e: cmp() };
    }
    const f = take();
    if (f?.k !== "id") return fail("Expected field in WHERE");
    const opTok = take();
    let op = opTok?.v ?? "";
    if (opTok?.k === "id") {
      op = opTok.v.toUpperCase();
      if (op === "NOT") {
        expectKw("IN");
        op = "NOT IN";
      }
    }
    if (op === "IN" || op === "NOT IN") {
      if (take()?.v !== "(") fail("Expected (");
      const vals: unknown[] = [];
      do vals.push(value());
      while (peek()?.v === "," && (i++, true));
      if (take()?.v !== ")") fail("Expected )");
      return { t: "cmp", field: f!.v, op, value: vals };
    }
    if (!["=", "!=", "<", "<=", ">", ">=", "LIKE"].includes(op)) fail(`Unsupported operator ${op}`);
    return { t: "cmp", field: f!.v, op, value: value() };
  };
  const and = (): Expr => {
    let l = cmp();
    while (isKw(peek(), "AND")) {
      i++;
      l = { t: "and", l, r: cmp() };
    }
    return l;
  };
  const or = (): Expr => {
    let l = and();
    while (isKw(peek(), "OR")) {
      i++;
      l = { t: "or", l, r: and() };
    }
    return l;
  };

  if (isKw(peek(), "WHERE")) {
    i++;
    q.where = or();
  }
  if (isKw(peek(), "ORDER")) {
    i++;
    expectKw("BY");
    do {
      const f = take();
      if (f?.k !== "id") fail("Expected ORDER BY field");
      let desc = false;
      if (isKw(peek(), "ASC")) i++;
      else if (isKw(peek(), "DESC")) {
        i++;
        desc = true;
      }
      q.orderBy.push({ field: f!.v, desc });
    } while (peek()?.v === "," && (i++, true));
  }
  if (isKw(peek(), "LIMIT")) {
    i++;
    q.limit = Number(take()?.v);
  }
  if (isKw(peek(), "OFFSET")) {
    i++;
    q.offset = Number(take()?.v);
  }
  if (i < toks.length) fail(`Unexpected token '${peek()?.v}'`);
  return q;
}

export function resolveDateLiteral(raw: string, now: Date): string {
  const day = 86_400_000;
  const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const t0 = startOfDay(now);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const m = raw.match(/^(LAST|NEXT)_N_DAYS:(\d+)$/);
  if (m) return iso(new Date(t0.getTime() + (m[1] === "LAST" ? -1 : 1) * Number(m[2]) * day));
  switch (raw) {
    case "TODAY": return iso(t0);
    case "YESTERDAY": return iso(new Date(t0.getTime() - day));
    case "TOMORROW": return iso(new Date(t0.getTime() + day));
    default: return raw;
  }
}

export interface EvalEnv {
  now: Date;
  getField: (rec: SfRecord, path: string) => unknown;
}

function norm(v: unknown): unknown {
  return typeof v === "string" ? v.toLowerCase() : v;
}

function likeToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is");
}

export function evalExpr(e: Expr, rec: SfRecord, env: EvalEnv): boolean {
  switch (e.t) {
    case "and": return evalExpr(e.l, rec, env) && evalExpr(e.r, rec, env);
    case "or": return evalExpr(e.l, rec, env) || evalExpr(e.r, rec, env);
    case "not": return !evalExpr(e.e, rec, env);
    case "cmp": {
      const lhs = env.getField(rec, e.field);
      const resolve = (v: unknown) => (v && typeof v === "object" && "date" in v ? resolveDateLiteral((v as { date: string }).date, env.now) : v);
      if (e.op === "IN" || e.op === "NOT IN") {
        const set = (e.value as unknown[]).map((v) => norm(resolve(v)));
        const hit = set.includes(norm(lhs));
        return e.op === "IN" ? hit : !hit;
      }
      const rhs = resolve(e.value);
      if (e.op === "LIKE") return typeof lhs === "string" && likeToRegex(String(rhs)).test(lhs);
      if (rhs === null) return e.op === "=" ? lhs == null : e.op === "!=" ? lhs != null : false;
      if (lhs == null) return e.op === "!=";
      let a = norm(lhs) as string | number | boolean;
      const b = norm(rhs) as string | number | boolean;
      // Date-only literal vs datetime field: compare on the date portion.
      if (typeof a === "string" && typeof b === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b) && a.length > 10) a = a.slice(0, 10);
      switch (e.op) {
        case "=": return a === b;
        case "!=": return a !== b;
        case "<": return a < b;
        case "<=": return a <= b;
        case ">": return a > b;
        case ">=": return a >= b;
      }
      return false;
    }
  }
}
