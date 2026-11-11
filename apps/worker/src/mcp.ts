import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createDirectMcpServer } from "@sfcm/salesforce-mcp";
import { toSafeError } from "@sfcm/security";
import { requirePermission } from "@sfcm/governance";
import type { Principal } from "@sfcm/shared-types";
import type { Platform } from "./platform";

function capabilitySummary(platform: Platform): string {
  const byDomain = new Map<string, string[]>();
  for (const t of platform.registry.list()) byDomain.set(t.domain, [...(byDomain.get(t.domain) ?? []), `${t.namespace}.${t.name}${t.kind === "write" ? "*" : ""}`]);
  return [...byDomain.entries()].map(([d, names]) => `${d}: ${names.join(", ")}`).join("\n");
}

/** The Code Mode MCP server: exactly two tools, regardless of how many Salesforce APIs exist. */
export function createCodeModeServer(platform: Platform, principal: Principal, traceparent?: string): McpServer {
  const server = new McpServer(
    { name: "salesforce-codemode", version: "0.1.0" },
    { instructions: "Salesforce Code Mode gateway. Call discover_capabilities once, then write ONE TypeScript program for execute_code that orchestrates all needed Salesforce calls and returns a compact result. Prefer this over many separate calls." },
  );

  server.registerTool(
    "discover_capabilities",
    {
      title: "Discover Salesforce capabilities",
      description:
        "Lists the Salesforce APIs YOU are authorized to call inside execute_code, with TypeScript declarations, input schemas, read/write classification, required permissions and usage examples. Call this first. Filter with domain/search/tool to keep output small.",
      inputSchema: {
        domain: z.enum(["sales", "service", "cpq", "datacloud", "metadata", "agentforce", "external"]).optional().describe("Restrict to one cloud/domain"),
        search: z.string().max(100).optional().describe("Substring match on name/title/description"),
        tool: z.string().max(80).optional().describe("Return one tool by exact name"),
        includeTypeScript: z.boolean().default(true).describe("Include the combined `declare const sf: {...}` block (contains every input/output type, description, read/write tag and permission)"),
        detail: z.enum(["summary", "full"]).default("summary").describe("summary (default, compact) or full (adds per-tool JSON Schema, signature and all examples)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        requirePermission(principal, "discover");
        const { sf, adapters } = platform.salesforceFor(principal);
        const out = await platform.engine.discover({ principal, sf, adapters }, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        const s = toSafeError(e);
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: s.code, message: s.message }) }] };
      }
    },
  );

  server.registerTool(
    "execute_code",
    {
      title: "Execute Salesforce orchestration code",
      description:
        `Run ONE TypeScript async arrow function in an isolated sandbox. The sandbox has only these globals (no fetch, fs, process, imports):\n${capabilitySummary(platform)}\n(* = write, needs human approval)\n` +
        "Call `await sf.searchAccounts({...})` etc.; use Promise.all for independent calls, loops for pagination (limit/offset/hasMore), and return a compact JSON-serialisable result. Call discover_capabilities first for exact input/output types. Results are redacted, size-capped and include an execution trace.",
      inputSchema: {
        code: z.string().min(1).describe("TypeScript: `async () => { ... return result; }`"),
        capabilities: z.array(z.string().max(80)).max(60).optional().describe("Optional least-privilege list of tool names this program may use"),
        context: z.record(z.string(), z.unknown()).optional().describe("Free-form context (e.g. user's request) recorded in the audit log. Not executed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        requirePermission(principal, "execute");
        const { sf, adapters } = platform.salesforceFor(principal);
        const outcome = await platform.engine.execute({ code: args.code, principal, sf, adapters, capabilities: args.capabilities, context: args.context, traceparent });
        return { isError: !outcome.ok, content: [{ type: "text" as const, text: JSON.stringify(outcome, null, 2) }] };
      } catch (e) {
        const s = toSafeError(e);
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: { code: s.code, message: s.message } }) }] };
      }
    },
  );
  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request, principal bound by closure. */
export async function handleMcpRequest(request: Request, platform: Platform, principal: Principal, kind: "codemode" | "direct"): Promise<Response> {
  const server =
    kind === "codemode"
      ? createCodeModeServer(platform, principal, request.headers.get("traceparent") ?? undefined)
      : createDirectMcpServer({ registry: platform.registry, sessionFactory: () => platform.newSession(principal, "direct") });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
