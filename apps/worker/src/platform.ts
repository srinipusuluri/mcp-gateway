import { ApprovalService, AuditLog, IdempotencyStore, PolicyEngine, RateLimiter, type StateStore } from "@sfcm/governance";
import { MetricsCollector, OtlpTraceExporter } from "@sfcm/observability";
import { Guardrails } from "@sfcm/security";
import { MockOrg, MockSalesforceClient, SalesforceClient, SalesforceOAuth, TokenVault, VaultTokenProvider, MOCK_USERS, type SalesforceApi } from "@sfcm/salesforce-client";
import { createMockAdapters, createSalesforceRegistry, type SalesforceAdapters } from "@sfcm/salesforce-mcp";
import { CodeModeEngine, type Executor } from "@sfcm/codemode-runtime";
import { ExecutionSession, type ToolRegistry } from "@sfcm/tool-registry";
import type { Principal, Role } from "@sfcm/shared-types";
import type { AppConfig } from "./config";

export interface Platform {
  config: AppConfig;
  store: StateStore;
  registry: ToolRegistry;
  governance: { policy: PolicyEngine; approvals: ApprovalService; audit: AuditLog; rateLimiter: RateLimiter; idempotency: IdempotencyStore };
  metrics: MetricsCollector;
  guardrails: Guardrails;
  telemetry?: OtlpTraceExporter;
  engine: CodeModeEngine;
  runtimeName: string;
  oauth?: SalesforceOAuth;
  vault?: TokenVault;
  org: MockOrg;
  /** User-scoped Salesforce API + adapters for this principal. Credentials stay in the host. */
  salesforceFor(principal: Principal): { sf: SalesforceApi; adapters: SalesforceAdapters; profile?: string };
  newSession(principal: Principal, id?: string, allowedTools?: string[], sharedCache?: Map<string, unknown>): ExecutionSession;
}

/** Mock-mode mapping from gateway roles to a simulated Salesforce profile (permissions + sharing). */
export function mockProfileFor(p: Principal): string {
  if (p.salesforceUserId && MOCK_USERS[p.salesforceUserId]) return p.salesforceUserId;
  const order: Array<[Role, string]> = [["admin", "sf_admin"], ["service_agent", "sf_service"], ["sales_rep", "sf_rep_east"], ["analyst", "sf_analyst"]];
  return order.find(([r]) => p.roles.includes(r))?.[1] ?? "sf_analyst";
}

export function createPlatform(o: { config: AppConfig; store: StateStore; executor: Executor; runtimeName: string; org?: MockOrg; fetchImpl?: typeof fetch }): Platform {
  const { config, store } = o;
  const policy = new PolicyEngine(config.policy);
  const governance = {
    policy,
    approvals: new ApprovalService(store, { ttlMs: config.policy.approvalTtlMs, allowSelfApproval: config.policy.allowSelfApproval }),
    audit: new AuditLog(store),
    rateLimiter: new RateLimiter(store),
    idempotency: new IdempotencyStore(store),
  };
  const registry = createSalesforceRegistry();
  const metrics = new MetricsCollector(store);
  const guardrails = new Guardrails(config.guardrails);
  const telemetry = config.otel ? new OtlpTraceExporter(config.otel, o.fetchImpl) : undefined;
  const engine = new CodeModeEngine({ registry, executor: o.executor, governance, metrics, guardrails, telemetry, runtimeName: o.runtimeName });
  const org = o.org ?? new MockOrg();
  const mockAdapters = createMockAdapters(org.data);

  const live = config.mode === "live";
  const oauth = live && config.sf.clientId && config.sf.redirectUri
    ? new SalesforceOAuth({ loginUrl: config.sf.loginUrl, clientId: config.sf.clientId, clientSecret: config.sf.clientSecret, redirectUri: config.sf.redirectUri })
    : undefined;
  const vault = live && config.tokenEncryptionKey ? new TokenVault(store, config.tokenEncryptionKey) : undefined;

  const salesforceFor: Platform["salesforceFor"] = (principal) => {
    if (!live) {
      const profile = mockProfileFor(principal);
      return { sf: new MockSalesforceClient(org, MOCK_USERS[profile]!), adapters: mockAdapters, profile };
    }
    if (!oauth || !vault) throw new Error("Live mode is not fully configured.");
    // User-scoped: this user's own OAuth tokens, so Salesforce enforces THEIR CRUD/FLS/sharing.
    const tokens = new VaultTokenProvider(principal.userId, vault, oauth);
    return { sf: new SalesforceClient({ tokens, apiVersion: config.sf.apiVersion }), adapters: {} };
  };

  const platform: Platform = {
    config, store, registry, governance, metrics, guardrails, telemetry, engine, runtimeName: o.runtimeName, oauth, vault, org, salesforceFor,
    newSession(principal, id = "api", allowedTools, sharedCache) {
      const { sf, adapters } = salesforceFor(principal);
      return new ExecutionSession({ executionId: id, principal, sf, registry, governance, adapters, allowedTools, sharedCache, guardrails });
    },
  };
  return platform;
}
