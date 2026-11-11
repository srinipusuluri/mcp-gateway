# Observability: OpenTelemetry traces for LLM agents, tools and Code Mode

The gateway emits **OpenTelemetry traces** over OTLP/HTTP (JSON). Any open-source backend that speaks OTLP can receive them: **Arize Phoenix**, **Langfuse**, **Jaeger**, **Grafana Tempo**, **SigNoz**, or an **OpenTelemetry Collector** in front of any of these.

Nothing is sent unless you set an endpoint. By default spans carry **metadata only** (no code, no Salesforce data).

## What a trace looks like

```
[agent / MCP client span]                ← your agent, if it sends a W3C `traceparent` header
 └─ execute_code            CHAIN        execution id, mode, tool calls, SF API calls, records, bytes,
     │                                   redactions, guardrail findings / taint / blocked writes
     ├─ read searchAccounts      TOOL    duration, SF API calls, records, redactions, error.type
     ├─ read getContactsByAccount TOOL
     └─ write createCase         TOOL    status UNSET + "approval_required" when waiting for a human
```

Attributes follow two open conventions, so the backends render them natively:

| Convention | Attributes used | Read by |
|---|---|---|
| OpenTelemetry GenAI semantic conventions | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`, `error.type` | Langfuse, Tempo, SigNoz, Jaeger |
| OpenInference (Arize) | `openinference.span.kind` = `CHAIN` / `TOOL` / `EVALUATOR`, `tool.name`, `input.value`, `output.value` | Phoenix, Arize |
| Gateway-specific | `codemode.*`, `guardrail.*` (plus a `guardrail.finding` span event per finding) | all |

Eval runs (`npm run evals`) are exported the same way (`eval.run` → `eval.suite` → `eval.case` spans with `eval.score.*` attributes), so quality scores sit next to production traces.

## Configuration (standard `OTEL_*` variables)

| Variable | Meaning |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL; `/v1/traces` is appended. E.g. `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full traces URL (overrides the base) |
| `OTEL_EXPORTER_OTLP_HEADERS` | `k=v,k2=v2`, URL-encoded values. Use for auth |
| `OTEL_SERVICE_NAME` | Default `salesforce-codemode-gateway` |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | e.g. `dev`, `staging`, `prod` |
| `OTEL_TRACES_SAMPLER_ARG` | 0..1 head sampling for successful executions. Failures and guardrail hits are always kept |
| `OTEL_CAPTURE_CONTENT` | `true` attaches generated code and the (already redacted) result. **Refused in live mode** by config validation |
| `OTEL_SDK_DISABLED` | `true` turns export off |

Put them in `.dev.vars` locally or set them with `wrangler secret put` (headers carry credentials, so treat them as secrets).

## Option A: local open-source stack (Phoenix + Jaeger)

```bash
docker compose -f observability/docker-compose.yml up -d
echo 'OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318' >> .dev.vars
npm run dev:worker          # run some executions from Claude or the dashboard
npm run evals               # eval results are exported too
open http://localhost:6006  # Phoenix: agent/tool spans, span kinds, guardrail events
open http://localhost:16686 # Jaeger: service "salesforce-codemode-gateway"
```

The bundled OpenTelemetry Collector ([observability/otel-collector.yaml](../observability/otel-collector.yaml)) hashes `enduser.id`, batches, and fans out to both UIs over OTLP/gRPC. Ports bind to `127.0.0.1` only.

Note: `wrangler dev` runs the Worker locally, so `localhost:4318` is reachable. A **deployed** Worker cannot reach your laptop. Point it at a public collector or a hosted backend.

## Option B: Langfuse (open source, cloud or self-hosted)

```bash
# base64 of "<public key>:<secret key>"
OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64>
```

Self-hosted Langfuse uses `https://<your-host>/api/public/otel`. You can also route through the collector (commented exporter in `otel-collector.yaml`).

## Option C: Phoenix directly, Grafana Tempo, SigNoz, Honeycomb, ...

Phoenix's own `/v1/traces` endpoint expects protobuf, so send to Phoenix **through the collector** (Option A). Tempo and SigNoz accept OTLP/HTTP JSON directly at `<host>:4318/v1/traces`.

## Linking agent and gateway traces

MCP clients and agent frameworks that propagate W3C trace context send a `traceparent` header. The gateway reads it on `/mcp` and `/api/execute`, and the `execute_code` span becomes a child of the agent's tool-call span. One trace then covers model turns, the Code Mode program and every Salesforce call.

## Built-in metrics (no backend needed)

`GET /api/metrics` (dashboard → Monitoring) still reports latency p50/p95, per-tool calls and errors, Salesforce API usage, estimated token proxies, and now **guardrail counters**: executions with findings, tainted executions, blocked writes, findings by category.

## How it is built

[packages/observability/src/otel.ts](../packages/observability/src/otel.ts) is a dependency-free exporter, because the OTel JS SDK's Node exporters don't fit a Durable Object. Executions already record each tool call's start time and duration, so spans are built after the run and posted once. Export is fire-and-forget with a 3-second timeout. A failing collector increments `exported.failures` and never affects an execution. Tests: [tests/unit/otel.test.ts](../tests/unit/otel.test.ts).
