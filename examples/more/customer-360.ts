// GENERATED from packages/salesforce-mcp/src/workflows.ts (customer-360). Do not edit.
// This is the exact program a model would pass to execute_code.
async () => {
  const name: string = "Acme Corporation";
  const account = (await sf.searchAccounts({ query: name, limit: 1 })).records[0];
  if (!account) return { error: `No account matching "${name}"` };
  const id = account.Id as string;
  const [opps, cases, profile, churn] = await Promise.all([
    sf.getOpportunities({ accountId: id, isClosed: false, limit: 50 }),
    sf.getOpenCasesByAccount({ accountId: id, limit: 50 }),
    sf.retrieveUnifiedProfile({ accountId: id }),
    sf.queryApprovedDataCloudSources({ source: "ChurnScores", filters: { accountId: id }, limit: 20 }),
  ]);
  const avgChurn = churn.rows.length ? churn.rows.reduce((s, r) => s + Number(r.churnRisk ?? 0), 0) / churn.rows.length : null;
  return {
    account: { name: account.Name, industry: account.Industry },
    sales: { openOpportunities: opps.records.length, openAmount: opps.records.reduce((s, o) => s + (o.Amount ?? 0), 0) },
    service: { openCases: cases.records.length, highPriority: cases.records.filter((c) => c.Priority === "High").length },
    dataCloud: { source: profile.source, primaryProfile: profile.profile, avgChurnRisk: avgChurn === null ? null : Number(avgChurn.toFixed(2)) },
    insight: avgChurn !== null && avgChurn > 0.4 && cases.records.length > 1 ? "High churn risk with active support load: involve the account owner." : "No elevated cross-cloud risk signal.",
  };
};

export {};
