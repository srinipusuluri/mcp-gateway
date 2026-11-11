// GENERATED from packages/salesforce-mcp/src/workflows.ts (service-intelligence). Do not edit.
// This is the exact program a model would pass to execute_code.
async () => {
  const all: Array<Record<string, any>> = [];
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const r = await sf.searchCases({ isClosed: false, limit: 5, offset });
    all.push(...r.records);
    if (!r.hasMore || r.nextOffset === null) break;
    offset = r.nextOffset;
  }
  const ageDays = (d: string) => Math.floor((Date.now() - Date.parse(d)) / 86400000);
  const count = (key: string) => all.reduce<Record<string, number>>((m, c) => ((m[c[key] ?? "none"] = (m[c[key] ?? "none"] ?? 0) + 1), m), {});
  const candidates = all
    .map((c) => ({ number: c.CaseNumber, subject: c.Subject, accountId: c.AccountId, priority: c.Priority, status: c.Status, ageDays: ageDays(c.CreatedDate), escalated: c.IsEscalated }))
    .filter((c) => c.escalated || (c.priority === "High" && c.ageDays >= 7))
    .sort((a, b) => b.ageDays - a.ageDays);
  return { openCases: all.length, byPriority: count("Priority"), byStatus: count("Status"), oldestDays: Math.max(0, ...all.map((c) => ageDays(c.CreatedDate))), escalationCandidates: candidates };
};

export {};
