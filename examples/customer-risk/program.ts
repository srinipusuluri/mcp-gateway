// GENERATED from packages/salesforce-mcp/src/workflows.ts (customer-risk). Do not edit.
// This is the exact program a model would pass to execute_code.
async () => {
  const accounts = await sf.searchAccounts({ limit: 100, extraFields: ["Overdue_Invoices__c", "Past_Due_Amount__c"] });
  const ids = accounts.records.map((a) => a.Id as string);
  const [cases, opps] = await Promise.all([
    sf.searchCases({ isClosed: false, limit: 200 }),
    sf.getOpportunities({ accountIds: ids, isClosed: false, limit: 200, extraFields: ["Previous_Amount__c"] }),
  ]);
  const scored = accounts.records.map((a) => {
    const id = a.Id as string;
    const myCases = cases.records.filter((c) => c.AccountId === id);
    const declining = opps.records.filter((o) => typeof o.Previous_Amount__c === "number" && (o.Amount ?? 0) < (o.Previous_Amount__c as number));
    const mineDeclining = declining.filter((o) => o.AccountId === id);
    const overdue = Number(a.Overdue_Invoices__c ?? 0);
    const highCases = myCases.filter((c) => c.Priority === "High").length;
    const score = overdue * 20 + highCases * 15 + myCases.length * 5 + mineDeclining.length * 15;
    return { account: a.Name, score, overdueInvoices: overdue, pastDue: a.Past_Due_Amount__c ?? "(hidden)", openCases: myCases.length, highPriorityCases: highCases, decliningOpportunities: mineDeclining.map((o) => o.Name) };
  });
  return { atRisk: scored.filter((s) => s.score >= 40).sort((a, b) => b.score - a.score), scoring: "overdue*20 + highCases*15 + openCases*5 + decliningOpps*15; threshold 40" };
};

export {};
