// GENERATED from packages/salesforce-mcp/src/workflows.ts (account-360). Do not edit.
// This is the exact program a model would pass to execute_code.
async () => {
  const name: string = "Acme Corporation";
  const found = await sf.searchAccounts({ query: name, limit: 1 });
  const account = found.records[0];
  if (!account) return { error: `No account matching "${name}"` };

  // Independent reads run in parallel inside the sandbox.
  const [contacts, opps, cases] = await Promise.all([
    sf.getContactsByAccount({ accountId: account.Id as string, limit: 50 }),
    sf.getOpportunities({ accountId: account.Id as string, limit: 50, orderBy: "CloseDate" }),
    sf.getOpenCasesByAccount({ accountId: account.Id as string, limit: 50 }),
  ]);
  const open = opps.records.filter((o) => !o.IsClosed);
  const sum = (xs: Array<{ Amount?: number | null }>) => xs.reduce((s, o) => s + (o.Amount ?? 0), 0);
  return {
    account: { id: account.Id, name: account.Name, industry: account.Industry, rating: account.Rating, annualRevenue: account.AnnualRevenue ?? "(not visible to this user)" },
    contacts: contacts.records.map((c) => ({ name: c.Name, title: c.Title, email: c.Email })),
    opportunities: { open: open.length, openAmount: sum(open), won: opps.records.filter((o) => o.IsWon).length, next: open[0] ? { name: open[0].Name, closeDate: open[0].CloseDate, stage: open[0].StageName } : null },
    openCases: cases.records.map((c) => ({ number: c.CaseNumber, subject: c.Subject, priority: c.Priority, status: c.Status, escalated: c.IsEscalated })),
    omittedFields: [...new Set([...found.omittedFields, ...opps.omittedFields])],
  };
};

export {};
