// GENERATED from packages/salesforce-mcp/src/workflows.ts (sales-pipeline). Do not edit.
// This is the exact program a model would pass to execute_code.
async () => {
  const accounts = await sf.searchAccounts({ limit: 50 });
  const ids = accounts.records.map((a) => a.Id as string);
  const [summary, opps] = await Promise.all([
    sf.getPipelineSummary({ accountIds: ids }),
    sf.getOpportunities({ accountIds: ids, isClosed: false, limit: 200, orderBy: "Amount", direction: "DESC" }),
  ]);
  const nameOf = new Map(accounts.records.map((a) => [a.Id as string, a.Name as string]));
  const byAccount = new Map<string, { account: string; open: number; amount: number; weighted: number }>();
  for (const o of opps.records) {
    const k = o.AccountId as string;
    const e = byAccount.get(k) ?? { account: nameOf.get(k) ?? k, open: 0, amount: 0, weighted: 0 };
    e.open++; e.amount += o.Amount ?? 0; e.weighted += (o.Amount ?? 0) * ((o.Probability ?? 0) / 100);
    byAccount.set(k, e);
  }
  return {
    totals: summary.totals, byStage: summary.byStage,
    topAccounts: [...byAccount.values()].sort((a, b) => b.weighted - a.weighted).slice(0, 5).map((e) => ({ ...e, weighted: Math.round(e.weighted) })),
    topDeals: opps.records.slice(0, 5).map((o) => ({ name: o.Name, amount: o.Amount, stage: o.StageName, closeDate: o.CloseDate })),
  };
};

export {};
