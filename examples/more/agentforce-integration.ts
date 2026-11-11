// GENERATED from packages/salesforce-mcp/src/workflows.ts (agentforce-integration). Do not edit.
// This is the exact program a model would pass to execute_code.
async () => {
  const agentName: string = "Service_Triage_Agent";
  const cases = await sf.searchCases({ isClosed: false, priority: "High", limit: 1 });
  const c = cases.records[0];
  if (!c) return { message: "No open high-priority case to triage." };
  const reply = await sf.invokeApprovedAgent({ agentName, prompt: `Triage case ${c.CaseNumber}: ${c.Subject}` });
  return { case: { number: c.CaseNumber, subject: c.Subject }, agent: reply.agentName, response: reply.response, citations: reply.citations, executedBy: reply.source };
};

export {};
