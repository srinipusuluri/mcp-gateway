// GENERATED from packages/salesforce-mcp/src/workflows.ts (opportunity-intelligence). Do not edit.
// This is the exact program a model would pass to execute_code.
async () => {
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const [summary, open] = await Promise.all([
    sf.getPipelineSummary({}),
    sf.getOpportunities({ isClosed: false, limit: 200, orderBy: "CloseDate" }),
  ]);
  const slipped = open.records.filter((o) => (o.CloseDate as string) < today);
  const closingSoon = open.records.filter((o) => (o.CloseDate as string) >= today && (o.CloseDate as string) <= in30);
  const pick = (o: Record<string, any>) => ({ name: o.Name, stage: o.StageName, amount: o.Amount, closeDate: o.CloseDate, probability: o.Probability });
  return {
    stageDistribution: summary.byStage, closeMonths: summary.byCloseMonth, totals: summary.totals,
    slippedOpportunities: slipped.map(pick), closingWithin30Days: closingSoon.map(pick),
    healthFlags: { slippedCount: slipped.length, lowProbabilityLateStage: open.records.filter((o) => ["Negotiation/Review", "Proposal/Price Quote"].includes(o.StageName as string) && (o.Probability ?? 0) < 60).length },
  };
};

export {};
