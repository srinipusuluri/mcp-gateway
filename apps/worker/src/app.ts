import { z } from "zod";
import { can, permissionsOf, requirePermission, ROLE_PERMISSIONS } from "@sfcm/governance";
import { GatewayError, authenticateBearer, randomId, sha256Base64Url, signToken, toSafeError } from "@sfcm/security";
import { ALL_ROLES, type Principal, type Role } from "@sfcm/shared-types";
import { SalesforceAuthError } from "@sfcm/salesforce-client";
import { WORKFLOWS, findWorkflow } from "@sfcm/salesforce-mcp";
import { generateTypeScriptApi } from "@sfcm/tool-registry";
import { validateConfig } from "./config";
import { generateCode } from "./generator";
import { handleMcpRequest } from "./mcp";
import type { Platform } from "./platform";

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...extra } });
}

function errorResponse(e: unknown): Response {
  const s = toSafeError(e);
  return json({ error: { code: s.code, message: s.message } }, s.status, s.status === 401 ? { "www-authenticate": 'Bearer realm="salesforce-codemode"' } : {});
}

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.output<T>> {
  const raw = await req.text();
  if (raw.length > 200_000) throw new GatewayError("invalid_input", "Request body too large.", 413);
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    throw new GatewayError("invalid_input", "Body must be JSON.", 400);
  }
  const r = schema.safeParse(parsed);
  if (!r.success) throw new GatewayError("invalid_input", r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), 400);
  return r.data;
}

export type FetchHandler = (request: Request) => Promise<Response>;

export function createApp(platform: Platform): FetchHandler {
  const seen = new Map<string, number>();

  async function authenticate(req: Request): Promise<Principal> {
    try {
      const p = await authenticateBearer(req.headers.get("authorization"), platform.config.auth);
      const last = seen.get(p.userId) ?? 0;
      if (Date.now() - last > 30_000) {
        seen.set(p.userId, Date.now());
        await platform.store.put(`user:${p.userId}`, { userId: p.userId, email: p.email, displayName: p.displayName, roles: p.roles, lastSeen: new Date().toISOString() });
      }
      return p;
    } catch (e) {
      await platform.governance.audit.append({ action: "auth.failure", userId: "anonymous", outcome: "denied", detail: { path: new URL(req.url).pathname } }).catch(() => undefined);
      throw e;
    }
  }

  async function sfConnected(p: Principal): Promise<boolean> {
    if (platform.config.mode === "mock") return true;
    return !!(await platform.vault?.get(p.userId));
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === "/health") return json({ status: "ok", mode: platform.config.mode, runtime: platform.runtimeName });

    // ---------- MCP endpoints ----------
    if (path === "/mcp" || path === "/mcp/direct") {
      const principal = await authenticate(req);
      return handleMcpRequest(req, platform, principal, path === "/mcp" ? "codemode" : "direct");
    }

    // ---------- Salesforce OAuth (live mode) ----------
    if (path === "/api/oauth/start" && method === "POST") {
      const p = await authenticate(req);
      if (!platform.oauth) throw new GatewayError("not_available", "Salesforce OAuth is only available in live mode.", 501);
      const a = await platform.oauth.createAuthorization();
      // State is bound to the user server-side; the verifier never reaches the browser.
      await platform.store.put(`oauth:${await sha256Base64Url(a.state)}`, { userId: p.userId, verifier: a.codeVerifier, exp: Date.now() + 10 * 60_000 });
      return json({ authorizeUrl: a.url });
    }
    if (path === "/oauth/callback" && method === "GET") {
      if (!platform.oauth || !platform.vault) throw new GatewayError("not_available", "OAuth is not configured.", 501);
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      const key = `oauth:${await sha256Base64Url(state)}`;
      const pending = await platform.store.get<{ userId: string; verifier: string; exp: number }>(key);
      await platform.store.delete(key); // single use
      if (!pending || pending.exp < Date.now() || !code) throw new GatewayError("unauthenticated", "Invalid or expired OAuth state.", 400);
      const tokens = await platform.oauth.exchangeCode(code, pending.verifier);
      await platform.vault.save(pending.userId, tokens);
      await platform.governance.audit.append({ action: "auth.success", userId: pending.userId, outcome: "success", resource: "salesforce-oauth" });
      return new Response(null, { status: 302, headers: { location: "/?salesforce=connected", ...SECURITY_HEADERS } });
    }
    if (path === "/api/oauth/logout" && method === "POST") {
      const p = await authenticate(req);
      const t = await platform.vault?.get(p.userId);
      if (t && platform.oauth) await platform.oauth.revoke(t.refreshToken ?? t.accessToken).catch(() => undefined);
      await platform.vault?.delete(p.userId);
      return json({ ok: true });
    }

    // ---------- Dev tokens (mock/demo only) ----------
    if (path === "/api/dev/token" && method === "POST") {
      if (!platform.config.allowDevTokens || !platform.config.auth.jwtSecret) throw new GatewayError("forbidden", "Dev tokens are disabled.", 403);
      const { role, profile } = await body(req, z.object({ role: z.enum(ALL_ROLES as [Role, ...Role[]]), profile: z.string().max(40).optional() }));
      const token = await signToken({ sub: `demo-${role}`, roles: [role], email: `${role}@demo.local`, name: `Demo ${role}`, sf_user_id: profile }, platform.config.auth.jwtSecret, { expiresInSeconds: 8 * 3600 });
      return json({ token, userId: `demo-${role}`, role });
    }

    if (!path.startsWith("/api/")) return json({ error: { code: "tool_not_found", message: "Not found" } }, 404);

    // ---------- Authenticated dashboard API ----------
    const principal = await authenticate(req);
    const g = platform.governance;

    if (path === "/api/me" && method === "GET") {
      return json({ userId: principal.userId, email: principal.email, roles: principal.roles, permissions: [...permissionsOf(principal)], salesforceConnected: await sfConnected(principal), mode: platform.config.mode });
    }

    if (path === "/api/status" && method === "GET") {
      const snap = await platform.metrics.snapshot();
      const tools = platform.registry.list();
      return json({
        mode: platform.config.mode,
        mcp: { status: "ok", endpoints: { codemode: "/mcp", direct: "/mcp/direct" }, tools: ["discover_capabilities", "execute_code"] },
        sandbox: { status: "ok", runtime: platform.runtimeName, limits: { timeoutMs: g.policy.policy.timeoutMs, maxCodeBytes: g.policy.policy.maxCodeBytes, maxResultBytes: g.policy.policy.maxResultBytes } },
        salesforce: { mode: platform.config.mode, connected: await sfConnected(principal), apiVersion: platform.config.sf.apiVersion, loginHost: new URL(platform.config.sf.loginUrl).host },
        registry: { total: tools.length, readTools: tools.filter((t) => t.kind === "read").length, writeTools: tools.filter((t) => t.kind === "write").length, mockOnly: tools.filter((t) => t.availability === "mock-only").length },
        metrics: { totalExecutions: snap.totalExecutions, failedExecutions: snap.failedExecutions, avgLatencyMs: snap.avgLatencyMs },
        claudeApiConfigured: !!platform.config.anthropic.apiKey,
        configWarnings: can(principal, "admin") ? validateConfig(platform.config) : [],
      });
    }

    if (path === "/api/tools" && method === "GET") {
      const { sf, adapters } = platform.salesforceFor(principal);
      const all = await platform.engine.discover({ principal, sf, adapters }, { includeTypeScript: true, detail: "full" });
      const visible = new Set(all.capabilities.map((c) => c.name));
      const denied = platform.registry.list().filter((t) => !visible.has(t.name)).map((t) => ({ name: t.name, permission: t.permission, domain: t.domain }));
      return json({ ...all, denied });
    }

    const invoke = path.match(/^\/api\/tools\/([A-Za-z0-9_]+)\/invoke$/);
    if (invoke && method === "POST") {
      requirePermission(principal, "execute");
      const { input } = await body(req, z.object({ input: z.unknown().default({}) }));
      const session = platform.newSession(principal, randomId("tst", 6), [invoke[1]!]);
      try {
        const result = await session.call(invoke[1]!, input);
        return json({ ok: true, result, trace: session.trace, mode: platform.config.mode });
      } catch (e) {
        const s = toSafeError(e);
        return json({ ok: false, error: { code: s.code, message: s.message, approvalId: s.approvalId }, trace: session.trace, mode: platform.config.mode }, 200);
      }
    }

    if (path === "/api/workflows" && method === "GET") {
      return json({ workflows: WORKFLOWS.map((w) => ({ id: w.id, title: w.title, description: w.description, requires: w.requires, usesMockOnly: w.usesMockOnly, code: w.build(w.defaults) })) });
    }

    if (path === "/api/playground/generate" && method === "POST") {
      requirePermission(principal, "discover");
      const { task, workflowId } = await body(req, z.object({ task: z.string().trim().min(3).max(2000), workflowId: z.string().max(60).optional() }));
      if (workflowId) {
        const w = findWorkflow(workflowId);
        if (!w) throw new GatewayError("invalid_input", "Unknown workflow.", 404);
        return json({ code: w.build({ ...w.defaults }), generator: "template", workflowId: w.id });
      }
      const session = platform.newSession(principal, "generate");
      const ts = generateTypeScriptApi(session.visibleTools());
      return json(await generateCode({ task, typescriptApi: ts, apiKey: platform.config.anthropic.apiKey, model: platform.config.anthropic.model }));
    }

    if (path === "/api/execute" && method === "POST") {
      requirePermission(principal, "execute");
      const b = await body(req, z.object({ code: z.string().min(1).max(100_000), capabilities: z.array(z.string().max(80)).max(60).optional(), context: z.record(z.string(), z.unknown()).optional() }));
      const { sf, adapters } = platform.salesforceFor(principal);
      return json(await platform.engine.execute({ code: b.code, principal, sf, adapters, capabilities: b.capabilities, context: { ...b.context, via: "dashboard" } }));
    }

    // ----- Security center -----
    if (path === "/api/security/overview" && method === "GET") {
      return json({
        policy: g.policy.policy,
        rolePermissions: ROLE_PERMISSIONS,
        yourPermissions: [...permissionsOf(principal)],
        toolPermissions: platform.registry.list().map((t) => ({ tool: t.name, kind: t.kind, permission: t.permission, availability: t.availability, requiresApproval: g.policy.requiresApproval(t), allowedForYou: (() => { try { g.policy.authorizeTool(principal, t); return true; } catch { return false; } })() })),
      });
    }
    if (path === "/api/security/users" && method === "GET") {
      requirePermission(principal, "audit.read");
      const rows = await platform.store.list<Record<string, unknown>>("user:");
      return json({ users: rows.map((r) => r.value).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))) });
    }
    if (path === "/api/approvals" && method === "GET") {
      const all = await g.approvals.list();
      return json({ approvals: can(principal, "approvals.decide") ? all : all.filter((a) => a.requestedBy === principal.userId), canDecide: can(principal, "approvals.decide") });
    }
    const decide = path.match(/^\/api\/approvals\/([A-Za-z0-9_-]+)\/(approve|reject)$/);
    if (decide && method === "POST") {
      requirePermission(principal, "approvals.decide");
      const { reason } = await body(req, z.object({ reason: z.string().max(500).optional() }));
      const approve = decide[2] === "approve";
      const a = await g.approvals.decide(decide[1]!, principal.userId, approve, reason);
      await g.audit.append({ action: approve ? "approval.approved" : "approval.rejected", userId: principal.userId, outcome: "success", resource: a.tool, detail: { approvalId: a.id, requestedBy: a.requestedBy } });
      return json({ approval: a });
    }
    if (path === "/api/audit" && method === "GET") {
      requirePermission(principal, "audit.read");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
      return json({ events: await g.audit.list(limit) });
    }
    if (path === "/api/audit/verify" && method === "GET") {
      requirePermission(principal, "audit.read");
      return json(await g.audit.verify());
    }

    // ----- Monitoring -----
    if (path === "/api/metrics" && method === "GET") {
      requirePermission(principal, "audit.read");
      return json(await platform.metrics.snapshot());
    }
    if (path === "/api/executions" && method === "GET") {
      requirePermission(principal, "audit.read");
      return json({ executions: await platform.metrics.history(Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200)) });
    }

    return json({ error: { code: "tool_not_found", message: "Not found" } }, 404);
  }

  return async (req) => {
    try {
      return await handle(req);
    } catch (e) {
      if (e instanceof SalesforceAuthError) return errorResponse(new GatewayError("unauthenticated", e.message, 401));
      return errorResponse(e);
    }
  };
}
