# Benchmark: traditional MCP vs Code Mode

Generated 2026-11-11T13:11:25.764Z · 30 runs per cell · built-in mock Salesforce org · sandbox: quickjs-wasm (local); production uses Cloudflare Dynamic Workers

Columns marked **est** are estimates (see caveats). All others are measured from executed runs.

| workflow | approach | model round trips | tool invocations | SF API calls | input tokens (est) | output tokens (est) | gateway latency ms (median) | completion ms (est, median) | success |
|---|---|---|---|---|---|---|---|---|---|
| account-360 | traditional-mcp | 3 | 4 | 8 | 14903 | 346 | 0.48 | 10030 | 100% |
| account-360 | code-mode (discover + execute) | 3 | 2 | 8 | 23450 | 662 | 6.35 | 16371 | 100% |
| account-360 | code-mode (execute only, types preloaded) | 2 | 1 | 8 | 13781 | 644 | 2.39 | 14058 | 100% |
| sales-pipeline | traditional-mcp | 3 | 3 | 5 | 16841 | 396 | 0.56 | 11106 | 100% |
| sales-pipeline | code-mode (discover + execute) | 3 | 2 | 5 | 23516 | 587 | 4.84 | 15128 | 100% |
| sales-pipeline | code-mode (execute only, types preloaded) | 2 | 1 | 5 | 13847 | 569 | 2.15 | 12816 | 100% |
| customer-risk | traditional-mcp | 3 | 3 | 6 | 17893 | 370 | 0.45 | 10804 | 100% |
| customer-risk | code-mode (discover + execute) | 3 | 2 | 6 | 23299 | 641 | 5.27 | 16001 | 100% |
| customer-risk | code-mode (execute only, types preloaded) | 2 | 1 | 6 | 13630 | 623 | 2.41 | 13689 | 100% |
| service-intelligence | traditional-mcp | 4 | 3 | 4 | 20871 | 310 | 0.28 | 10976 | 100% |
| service-intelligence | code-mode (discover + execute) | 3 | 2 | 4 | 23223 | 553 | 4.17 | 14524 | 100% |
| service-intelligence | code-mode (execute only, types preloaded) | 2 | 1 | 4 | 13554 | 535 | 1.9 | 12213 | 100% |
| cross-system-analysis | traditional-mcp | 3 | 18 | 4 | 17611 | 677 | 1.06 | 15886 | 100% |
| cross-system-analysis | code-mode (discover + execute) | 3 | 2 | 4 | 24154 | 594 | 4.95 | 15324 | 100% |
| cross-system-analysis | code-mode (execute only, types preloaded) | 2 | 1 | 4 | 14485 | 576 | 2.89 | 13014 | 100% |

## Caveats
- No live model is called: model behaviour (e.g. whether Claude batches parallel tool calls) is a stated assumption: the traditional plan is the BEST case (parallel calls per turn, describe-cache shared across calls).
- Traditional success means every planned tool call succeeded; it does not grade a model-written final answer.
- Mock data is small; with larger real result sets the traditional input-token cost grows with raw payload size while Code Mode returns only the aggregated result.
- Gateway latency excludes network RTT to a deployed Worker.