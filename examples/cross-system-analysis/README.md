# Enterprise Cross-System Analysis

Salesforce pipeline joined with NetSuite receivables to find revenue at risk.

- Requires permissions: `sf.read.sales`, `external.read`
- Uses mock-only adapters: yes (live adapter needed for a real org)

Run it against the mock org:

```bash
npm run example -- cross-system-analysis
```

Or paste `program.ts` into the dashboard Playground, or send it to the `execute_code` MCP tool.
