import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSafeError } from "@sfcm/security";
import type { ExecutionSession, ToolRegistry } from "@sfcm/tool-registry";

/**
 * "Traditional" MCP surface: every registry tool is exposed as its own MCP tool. It is used as the
 * baseline in the evaluation harness and can be served at /mcp/direct. It goes through the exact same
 * ExecutionSession choke point (RBAC, validation, approvals, redaction, audit) as Code Mode.
 */
export function createDirectMcpServer(opts: { registry: ToolRegistry; sessionFactory: () => ExecutionSession; name?: string }): McpServer {
  const server = new McpServer({ name: opts.name ?? "salesforce-direct", version: "0.1.0" });
  const probe = opts.sessionFactory();
  for (const tool of probe.visibleTools()) {
    server.registerTool(
      `${tool.namespace}_${tool.name}`,
      {
        title: tool.title,
        description: `${tool.description}${tool.kind === "write" ? " [WRITE: needs human approval]" : ""}${tool.availability === "mock-only" ? " [mock-only]" : ""}`,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.kind === "read", destructiveHint: false, openWorldHint: false },
      },
      async (args: unknown) => {
        try {
          const result = await opts.sessionFactory().call(tool.name, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (e) {
          const s = toSafeError(e);
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: s.code, message: s.message, approvalId: s.approvalId }) }] };
        }
      },
    );
  }
  return server;
}
