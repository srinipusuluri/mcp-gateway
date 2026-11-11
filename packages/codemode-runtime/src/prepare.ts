import { parse, type Node } from "acorn";
import { transform } from "sucrase";
import { GatewayError } from "@sfcm/security";

const BANNED_IDENTIFIERS = new Map<string, string>([
  ["eval", "eval() is not allowed"],
  ["Function", "the Function constructor is not allowed"],
  ["AsyncFunction", "dynamic function construction is not allowed"],
  ["require", "require() is not available in the sandbox"],
  ["process", "process is not available in the sandbox"],
  ["Deno", "Deno is not available in the sandbox"],
  ["Bun", "Bun is not available in the sandbox"],
  ["fetch", "network access is blocked; use the provided sf.* / netsuite.* APIs"],
  ["XMLHttpRequest", "network access is blocked"],
  ["WebSocket", "network access is blocked"],
  ["WebAssembly", "WebAssembly is not allowed"],
  ["importScripts", "importScripts is not allowed"],
  ["__proto__", "prototype manipulation is not allowed"],
  ["globalThis", "globalThis access is not allowed"],
  ["self", "self access is not allowed"],
  ["window", "window access is not allowed"],
  ["env", "env bindings are not accessible"],
]);
const BANNED_MEMBERS = new Map<string, string>([
  ["constructor", "constructor access is not allowed"],
  ["__proto__", "prototype manipulation is not allowed"],
  ["prototype", "prototype manipulation is not allowed"],
  ["__defineGetter__", "not allowed"],
  ["__lookupGetter__", "not allowed"],
]);

type AnyNode = Node & Record<string, unknown>;

function walk(node: unknown, visit: (n: AnyNode, parent: AnyNode | null) => void, parent: AnyNode | null = null): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, parent);
    return;
  }
  const n = node as AnyNode;
  if (typeof n.type === "string") {
    visit(n, parent);
    for (const [k, v] of Object.entries(n)) if (k !== "type" && k !== "loc" && v && typeof v === "object") walk(v, visit, n);
  }
}

function stripFences(code: string): string {
  const m = code.trim().match(/^```(?:ts|typescript|js|javascript|tsx)?\s*\n([\s\S]*?)\n```$/);
  return m ? m[1]! : code.trim();
}

export interface PreparedCode {
  /** An async arrow function expression source, ready for any Executor. */
  code: string;
  bytes: number;
}

/**
 * Validate + transpile + normalise generated code. This is a usability and defense-in-depth layer
 * (clear early errors, cheap rejection of obviously hostile code). The security BOUNDARY is the
 * isolate plus host-side authorization, never this lint.
 */
export function prepareCode(source: string, opts: { maxBytes: number }): PreparedCode {
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > opts.maxBytes) throw new GatewayError("code_rejected", `Code is ${bytes} bytes; the maximum is ${opts.maxBytes}.`, 413);
  const stripped = stripFences(source);
  if (!stripped) throw new GatewayError("code_rejected", "Code is empty.", 400);

  let js: string;
  try {
    js = transform(stripped, { transforms: ["typescript"], disableESTransforms: true, keepUnusedImports: true }).code;
  } catch (e) {
    throw new GatewayError("code_rejected", `TypeScript syntax error: ${(e as Error).message.split("\n")[0]}`, 400);
  }

  let ast: Node;
  try {
    ast = parse(js, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch (e) {
    throw new GatewayError("code_rejected", `Syntax error: ${(e as Error).message}`, 400);
  }

  walk(ast, (n, parent) => {
    if (n.type === "ImportDeclaration" || n.type === "ImportExpression" || n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") {
      throw new GatewayError("code_rejected", "import/export is not allowed; only the provided API globals are available.", 400);
    }
    if (n.type === "Identifier") {
      const name = n.name as string;
      const isMemberProp = parent?.type === "MemberExpression" && parent.property === n && !parent.computed;
      const isPropKey = (parent?.type === "Property" || parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition") && parent.key === n && !parent.computed;
      if (isMemberProp) {
        const why = BANNED_MEMBERS.get(name);
        if (why) throw new GatewayError("code_rejected", `Disallowed member '.${name}': ${why}.`, 400);
      } else if (!isPropKey) {
        const why = BANNED_IDENTIFIERS.get(name);
        if (why) throw new GatewayError("code_rejected", `Disallowed identifier '${name}': ${why}.`, 400);
      }
    }
    // Blatantly unbounded loops. Not a boundary (while(x) is undecidable); the runtime CPU limit is.
    const truthyLiteral = (t: unknown) => !!t && typeof t === "object" && (t as AnyNode).type === "Literal" && !!(t as AnyNode).value;
    if ((n.type === "WhileStatement" || n.type === "DoWhileStatement") && truthyLiteral(n.test)) {
      throw new GatewayError("code_rejected", "Unbounded loop (while(true)) is not allowed; iterate over data or use a bounded counter.", 400);
    }
    if (n.type === "ForStatement" && (n.test === null || truthyLiteral(n.test))) {
      throw new GatewayError("code_rejected", "Unbounded loop (for(;;)) is not allowed; iterate over data or use a bounded counter.", 400);
    }
    // Computed access with string literals: obj["constructor"], obj["__proto__"]
    if (n.type === "MemberExpression" && n.computed && (n.property as AnyNode).type === "Literal") {
      const v = String((n.property as AnyNode).value);
      const why = BANNED_MEMBERS.get(v);
      if (why) throw new GatewayError("code_rejected", `Disallowed member ["${v}"]: ${why}.`, 400);
    }
  });

  return { code: normalize(js), bytes };
}

/** Mirrors @cloudflare/codemode normalizeCode so both executors see an async arrow function. */
function normalize(js: string): string {
  const src = js.trim();
  try {
    const ast = parse(src, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }) as unknown as { body: AnyNode[] };
    const first = ast.body[0];
    if (ast.body.length === 1 && first?.type === "ExpressionStatement") {
      const expr = first.expression as AnyNode;
      if (expr.type === "ArrowFunctionExpression" || expr.type === "FunctionExpression") return `(${src.replace(/;$/, "")})`;
    }
    if (ast.body.length === 1 && first?.type === "FunctionDeclaration") {
      return `async () => {\n${src}\nreturn ${(first.id as AnyNode).name as string}();\n}`;
    }
    const last = ast.body[ast.body.length - 1];
    if (last?.type === "ExpressionStatement") {
      const e = last.expression as AnyNode;
      return `async () => {\n${src.slice(0, last.start)}return (${src.slice(e.start, e.end)})\n}`;
    }
  } catch {
    /* fall through: body with top-level return/await */
  }
  return `async () => {\n${src}\n}`;
}
