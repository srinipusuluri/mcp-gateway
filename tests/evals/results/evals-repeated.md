# Repeated eval runs (10 runs, darwin-arm64, Node v24.10.0)

| suite | cases | passed per run | gate all runs | unstable metrics | wall ms p50 / p95 |
|---|---|---|---|---|---|
| tools | 19 | 19 | yes | none | 4.6 / 31.7 |
| agent | 12 | 12 | yes | none | 28 / 89.3 |
| rag | 15 | 13 | yes | none | 25.7 / 45.3 |
| guardrails | 80 | 77 | yes | none | 34.7 / 48.3 |

## Guardrail overhead (30 interleaved executions per workflow, median)

| workflow | off ms | on ms | Δ ms | Δ % | result bytes |
|---|---|---|---|---|---|
| account-360 | 1.3 | 2 | 0.7 | 56.9 | 965 |
| sales-pipeline | 1.5 | 2.9 | 1.4 | 95.6 | 1401 |
| customer-risk | 1.7 | 3.7 | 2 | 121.5 | 765 |
| service-intelligence | 1.6 | 2.2 | 0.6 | 37.3 | 812 |
| opportunity-intelligence | 1.5 | 2.6 | 1.2 | 78.4 | 1512 |
| cpq-analysis | 1.6 | 2 | 0.4 | 25.4 | 737 |
| customer-360 | 2 | 2.6 | 0.6 | 30 | 647 |
| knowledge-assistant | 1.8 | 2 | 0.1 | 7.3 | 415 |
| agentforce-integration | 1.6 | 1.8 | 0.2 | 10.1 | 420 |
| cross-system-analysis | 3.6 | 5.2 | 1.6 | 43.7 | 622 |

## Detector throughput

| chars | ms / scan | MB/s |
|---|---|---|
| 1000 | 0.031 | 32.3 |
| 10000 | 0.144 | 69.3 |
| 50000 | 0.697 | 71.8 |
