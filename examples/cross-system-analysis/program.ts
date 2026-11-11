// GENERATED from packages/salesforce-mcp/src/workflows.ts (cross-system-analysis). Do not edit.
// This is the exact program a model would pass to execute_code.
async () => {
  const accounts = await sf.searchAccounts({ limit: 50 });
  const opps = await sf.getOpportunities({ accountIds: accounts.records.map((a) => a.Id as string), isClosed: false, limit: 200 });
  const rows = await Promise.all(
    accounts.records.map(async (a) => {
      const [overdue, credit] = await Promise.all([
        netsuite.getCustomerInvoices({ customerName: a.Name as string, status: "Overdue" }),
        netsuite.getCreditStatus({ customerName: a.Name as string }),
      ]);
      const open = opps.records.filter((o) => o.AccountId === a.Id);
      return {
        account: a.Name, openPipeline: open.reduce((s, o) => s + (o.Amount ?? 0), 0), overdueInvoices: overdue.count,
        overdueAmount: overdue.invoices.reduce((s, i) => s + i.amountRemaining, 0), creditHold: credit.onCreditHold, maxDaysOverdue: Math.max(0, ...overdue.invoices.map((i) => i.daysOverdue)),
      };
    }),
  );
  const exposed = rows.filter((r) => r.openPipeline > 0 && r.overdueAmount > 0).sort((a, b) => b.overdueAmount - a.overdueAmount);
  return { pipelineAtRisk: exposed, totalOverdue: exposed.reduce((s, r) => s + r.overdueAmount, 0), blockedByCreditHold: exposed.filter((r) => r.creditHold).map((r) => r.account) };
};

export {};
