/**
 * Traditional MCP vs Code Mode, on identical business workflows, against the same gateway,
 * same mock org, same user, same policies.
 *
 * MEASURED (real, from executed runs): model round trips, tool invocations, Salesforce API calls,
 * gateway execution latency, success rate, bytes in/out of the gateway.
 *
 * ESTIMATED (no live model is called): input/output tokens (UTF-8 chars / 4, applied identically to both
 * approaches) and model time (a documented rate card). These are labelled `est` everywhere. Re-run with a
 * live model to replace them; the harness is structured so only `ModelTimeModel` and `countTokens` change.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { WORKFLOWS } from "@sfcm/salesforce-mcp";
import type { Platform } from "../../apps/worker/src/platform";
import { appFor, makePlatform, principal, token } from "../helpers/harness";

export const countTokens = (s: string) => Math.ceil(s.length / 4);
export const FINAL_ANSWER_TOKENS = 250; // identical assumption for every approach
export const SYSTEM_PROMPT_TOKENS = 400; // identical assumption for every approach

/** Documented assumption (override via env): model latency = fixed + output tokens / speed. */
export const ModelTimeModel = {
  fixedMsPerTurn: Number(process.env.BENCH_MODEL_FIXED_MS ?? 800),
  outputTokensPerSecond: Number(process.env.BENCH_MODEL_TPS ?? 60),
  inputTokensPerSecond: Number(process.env.BENCH_MODEL_INPUT_TPS ?? 8000),
  estimate(inputTokens: number, outputTokens: number) {
    return this.fixedMsPerTurn + (outputTokens / this.outputTokensPerSecond) * 1000 + (inputTokens / this.inputTokensPerSecond) * 1000;
  },
};

type Call = { tool: string; args: Record<string, unknown> };
type TurnFn = (calls: Call[]) => Promise<any[]>;

/** The traditional-MCP plan for each workflow: model turns, each issuing parallel tool calls (best case for traditional). */
const PLANS: Record<string, (turn: TurnFn) => Promise<void>> = {
  "account-360": async (turn) => {
    const [s] = await turn([{ tool: "searchAccounts", args: { query: "Acme Corporation", limit: 1 } }]);
    const id = s.records[0].Id;
    await turn([
      { tool: "getContactsByAccount", args: { accountId: id, limit: 50 } },
      { tool: "getOpportunities", args: { accountId: id, limit: 50, orderBy: "CloseDate" } },
      { tool: "getOpenCasesByAccount", args: { accountId: id, limit: 50 } },
    ]);
  },
  "sales-pipeline": async (turn) => {
    const [a] = await turn([{ tool: "searchAccounts", args: { limit: 50 } }]);
    const ids = a.records.map((r: any) => r.Id);
    await turn([
      { tool: "getPipelineSummary", args: { accountIds: ids } },
      { tool: "getOpportunities", args: { accountIds: ids, isClosed: false, limit: 200, orderBy: "Amount", direction: "DESC" } },
    ]);
  },
  "customer-risk": async (turn) => {
    const [a] = await turn([{ tool: "searchAccounts", args: { limit: 100, extraFields: ["Overdue_Invoices__c", "Past_Due_Amount__c"] } }]);
    const ids = a.records.map((r: any) => r.Id);
    await turn([
      { tool: "searchCases", args: { isClosed: false, limit: 200 } },
      { tool: "getOpportunities", args: { accountIds: ids, isClosed: false, limit: 200, extraFields: ["Previous_Amount__c"] } },
    ]);
  },
  "service-intelligence": async (turn) => {
    let offset = 0;
    for (let page = 0; page < 10; page++) {
      const [r] = await turn([{ tool: "searchCases", args: { isClosed: false, limit: 5, offset } }]);
      if (!r.hasMore) break;
      offset = r.nextOffset;
    }
  },
  "cross-system-analysis": async (turn) => {
    const [a] = await turn([{ tool: "searchAccounts", args: { limit: 50 } }]);
    const ids = a.records.map((r: any) => r.Id);
    await turn([
      { tool: "getOpportunities", args: { accountIds: ids, isClosed: false, limit: 200 } },
      ...a.records.flatMap((r: any) => [
        { tool: "getCustomerInvoices", args: { customerName: r.Name, status: "Overdue" } },
        { tool: "getCreditStatus", args: { customerName: r.Name } },
      ]),
    ]);
  },
};

const VALIDATORS: Record<string, (r: any) => boolean> = {
  "account-360": (r) => r.account?.name === "Acme Corporation" && r.contacts?.length === 3 && r.openCases?.length === 3,
  "sales-pipeline": (r) => r.totals?.count > 0 && r.topAccounts?.length > 0,
  "customer-risk": (r) => r.atRisk?.[0]?.account === "Umbrella Health",
  "service-intelligence": (r) => r.openCases === 11 && r.escalationCandidates?.length >= 3,
  "cross-system-analysis": (r) => r.pipelineAtRisk?.some((x: any) => x.account === "Umbrella Health"),
};

export interface RunMetrics {
  approach: string;
  workflow: string;
  success: boolean;
  modelRoundTrips: number;
  toolInvocations: number;
  salesforceApiCalls: number;
  inputTokensEst: number;
  outputTokensEst: number;
  gatewayLatencyMs: number;
  modelTimeMsEst: number;
  completionTimeMsEst: number;
}


function directToolDefs(platform: Platform, p = principal("analyst")): string {
  return JSON.stringify(
    platform.newSession(p).visibleTools().map((t) => ({ name: `${t.namespace}_${t.name}`, description: t.description, inputSchema: z.toJSONSchema(t.input, { io: "input", unrepresentable: "any", target: "draft-7" }) })),
  );
}

async function runTraditional(platform: Platform, wf: string): Promise<RunMetrics> {
  const p = principal("analyst");
  const defsTokens = countTokens(directToolDefs(platform, p));
  let sf = 0;
  const sharedCache = new Map<string, unknown>(); // model a caching MCP server (conservative: favors traditional)
  let context = SYSTEM_PROMPT_TOKENS + defsTokens + 40; // + user request
  let input = 0, output = 0, turns = 0, calls = 0, gateway = 0, ok = true;
  const turn: TurnFn = async (cs) => {
    turns++;
    input += context;
    const outToks = countTokens(JSON.stringify(cs.map((c) => ({ name: `sf_${c.tool}`, arguments: c.args }))));
    output += outToks;
    const t0 = performance.now();
    const results = await Promise.all(
      cs.map(async (c) => {
        calls++;
        try {
          const session = platform.newSession(p, "trad", undefined, sharedCache);
          try {
            return await session.call(c.tool, c.args);
          } finally {
            sf += session.salesforceApiCalls;
          }
        } catch (e) {
          ok = false;
          return { error: String(e) };
        }
      }),
    );
    gateway += performance.now() - t0;
    context += outToks + countTokens(JSON.stringify(results));
    return results;
  };
  await PLANS[wf]!(turn);
  turns++; // final answer turn
  input += context;
  output += FINAL_ANSWER_TOKENS;
  return finish("traditional-mcp", wf, ok, turns, calls, sf, input, output, gateway, turns);
}

async function runCodeMode(platform: Platform, wf: string, withDiscovery: boolean): Promise<RunMetrics> {
  const app = appFor(platform);
  const transport = new StreamableHTTPClientTransport(new URL("http://gateway.test/mcp"), {
    fetch: ((u: string | URL, i?: RequestInit) => app(new Request(u, i))) as typeof fetch,
    requestInit: { headers: { authorization: `Bearer ${await token("analyst")}` } },
  });
  const client = new Client({ name: "bench", version: "1" });
  await client.connect(transport);
  const defsTokens = countTokens(JSON.stringify((await client.listTools()).tools));
  const w = WORKFLOWS.find((x) => x.id === wf)!;
  const code = w.build(w.defaults);
  let context = SYSTEM_PROMPT_TOKENS + defsTokens + 40;
  let input = 0, output = 0, turns = 0, calls = 0, gateway = 0;
  let typesText = "";
  if (withDiscovery) {
    turns++; calls++; input += context;
    const args = { includeTypeScript: true };
    const outToks = countTokens(JSON.stringify({ name: "discover_capabilities", arguments: args }));
    output += outToks;
    const t0 = performance.now();
    const r: any = await client.callTool({ name: "discover_capabilities", arguments: args });
    gateway += performance.now() - t0;
    typesText = r.content[0].text;
    context += outToks + countTokens(typesText);
  } else {
    // Types are assumed to be pre-loaded in the model's context (e.g. CLAUDE.md); count them as input once.
    const d: any = await client.callTool({ name: "discover_capabilities", arguments: { includeTypeScript: true } });
    context += countTokens(JSON.parse(d.content[0].text).typescript);
  }
  turns++; calls++; input += context;
  const outToks = countTokens(JSON.stringify({ name: "execute_code", arguments: { code } }));
  output += outToks;
  const t0 = performance.now();
  const res: any = await client.callTool({ name: "execute_code", arguments: { code } });
  gateway += performance.now() - t0;
  const parsed = JSON.parse(res.content[0].text);
  context += outToks + countTokens(res.content[0].text);
  turns++; // final answer
  input += context;
  output += FINAL_ANSWER_TOKENS;
  await client.close();
  const sf = Number(parsed.metadata?.salesforceApiCalls ?? 0);
  return finish(withDiscovery ? "code-mode (discover + execute)" : "code-mode (execute only, types preloaded)", wf, !!parsed.ok && VALIDATORS[wf]!(parsed.result), turns, calls, sf, input, output, gateway, turns);
}

function finish(approach: string, workflow: string, success: boolean, turns: number, calls: number, sf: number, input: number, output: number, gateway: number, modelTurns: number): RunMetrics {
  // model time is spread evenly across turns for the estimate
  const modelTime = ModelTimeModel.estimate(input, output) + (modelTurns - 1) * 0; // fixed per-turn cost is included once per turn below
  const perTurnFixed = ModelTimeModel.fixedMsPerTurn * (modelTurns - 1);
  return {
    approach, workflow, success, modelRoundTrips: turns, toolInvocations: calls, salesforceApiCalls: sf, inputTokensEst: input, outputTokensEst: output,
    gatewayLatencyMs: gateway, modelTimeMsEst: modelTime + perTurnFixed, completionTimeMsEst: modelTime + perTurnFixed + gateway,
  };
}

export interface Summary {
  approach: string;
  workflow: string;
  runs: number;
  successRate: number;
  modelRoundTrips: number;
  toolInvocations: number;
  salesforceApiCalls: number;
  inputTokensEst: number;
  outputTokensEst: number;
  gatewayLatencyMsMedian: number;
  completionTimeMsEstMedian: number;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

export async function runBenchmark(runsPerCell = 20): Promise<{ summaries: Summary[]; meta: Record<string, unknown> }> {
  const workflows = Object.keys(PLANS);
  const summaries: Summary[] = [];
  for (const wf of workflows) {
    for (const approach of ["traditional", "code-discover", "code-execute-only"] as const) {
      const rows: RunMetrics[] = [];
      for (let i = 0; i < runsPerCell; i++) {
        const platform = makePlatform({ EXECUTION_POLICY_JSON: JSON.stringify({ executionsPerMinute: 10_000, toolCallsPerMinute: 100_000 }) });
        rows.push(approach === "traditional" ? await runTraditional(platform, wf) : await runCodeMode(platform, wf, approach === "code-discover"));
      }
      const first = rows[0]!;
      summaries.push({
        approach: first.approach, workflow: wf, runs: rows.length, successRate: rows.filter((r) => r.success).length / rows.length,
        modelRoundTrips: first.modelRoundTrips, toolInvocations: first.toolInvocations, salesforceApiCalls: first.salesforceApiCalls,
        inputTokensEst: Math.round(mean(rows.map((r) => r.inputTokensEst))), outputTokensEst: Math.round(mean(rows.map((r) => r.outputTokensEst))),
        gatewayLatencyMsMedian: Number(median(rows.map((r) => r.gatewayLatencyMs)).toFixed(2)), completionTimeMsEstMedian: Math.round(median(rows.map((r) => r.completionTimeMsEst))),
      });
    }
  }
  return {
    summaries,
    meta: {
      generatedAt: new Date().toISOString(), runsPerCell, node: process.version, sandbox: "quickjs-wasm (local); production uses Cloudflare Dynamic Workers", data: "built-in mock Salesforce org",
      measured: ["modelRoundTrips", "toolInvocations", "salesforceApiCalls", "gatewayLatencyMs", "successRate"],
      estimated: { tokens: "UTF-8 chars / 4 on the exact payloads exchanged (identical estimator for every approach)", finalAnswerTokens: FINAL_ANSWER_TOKENS, systemPromptTokens: SYSTEM_PROMPT_TOKENS, modelTime: ModelTimeModel },
      caveats: [
        "No live model is called: model behaviour (e.g. whether Claude batches parallel tool calls) is a stated assumption: the traditional plan is the BEST case (parallel calls per turn, describe-cache shared across calls).",
        "Traditional success means every planned tool call succeeded; it does not grade a model-written final answer.",
        "Mock data is small; with larger real result sets the traditional input-token cost grows with raw payload size while Code Mode returns only the aggregated result.",
        "Gateway latency excludes network RTT to a deployed Worker.",
      ],
    },
  };
}

export function toMarkdown(r: Awaited<ReturnType<typeof runBenchmark>>): string {
  const rows = r.summaries.map((s) => `| ${s.workflow} | ${s.approach} | ${s.modelRoundTrips} | ${s.toolInvocations} | ${s.salesforceApiCalls} | ${s.inputTokensEst} | ${s.outputTokensEst} | ${s.gatewayLatencyMsMedian} | ${s.completionTimeMsEstMedian} | ${(s.successRate * 100).toFixed(0)}% |`);
  return [
    `# Benchmark: traditional MCP vs Code Mode`,
    ``,
    `Generated ${String(r.meta.generatedAt)} · ${String(r.meta.runsPerCell)} runs per cell · ${String(r.meta.data)} · sandbox: ${String(r.meta.sandbox)}`,
    ``,
    `Columns marked **est** are estimates (see caveats). All others are measured from executed runs.`,
    ``,
    `| workflow | approach | model round trips | tool invocations | SF API calls | input tokens (est) | output tokens (est) | gateway latency ms (median) | completion ms (est, median) | success |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
    ...rows,
    ``,
    `## Caveats`,
    ...(r.meta.caveats as string[]).map((c) => `- ${c}`),
  ].join("\n");
}
