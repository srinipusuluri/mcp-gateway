/**
 * The ten demonstration workflows. Each one is a Code Mode program: ONE execute_code call that
 * orchestrates many Salesforce operations and returns a compact result.
 * Generated code is plain TypeScript run in the sandbox: only `sf.*` / `netsuite.*` exist.
 */
export interface WorkflowParams {
  accountName?: string;
  question?: string;
  agentName?: string;
}

export interface Workflow {
  id: string;
  title: string;
  description: string;
  /** Natural-language triggers for the template-based generator. */
  keywords: string[];
  requires: string[];
  usesMockOnly: boolean;
  defaults: Required<WorkflowParams>;
  build(p: WorkflowParams): string;
}

const lit = (v: unknown) => JSON.stringify(v);

export const WORKFLOWS: Workflow[] = [
  {
    id: "account-360", title: "Account 360", description: "Account, contacts, opportunities and open cases in one execution.",
    keywords: ["account 360", "360 view", "everything about", "account overview"], requires: ["sf.read.sales", "sf.read.service"], usesMockOnly: false,
    defaults: { accountName: "Acme Corporation", question: "", agentName: "" },
    build: (p) => `async () => {
  const name: string = ${lit(p.accountName ?? "Acme Corporation")};
  const found = await sf.searchAccounts({ query: name, limit: 1 });
  const account = found.records[0];
  if (!account) return { error: \`No account matching "\${name}"\` };

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
}`,
  },
  {
    id: "sales-pipeline", title: "Sales Pipeline", description: "Pipeline analysis across many accounts: totals, top accounts and top deals.",
    keywords: ["pipeline", "sales pipeline", "across accounts"], requires: ["sf.read.sales"], usesMockOnly: false,
    defaults: { accountName: "", question: "", agentName: "" },
    build: () => `async () => {
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
}`,
  },
  {
    id: "customer-risk", title: "Customer Risk", description: "Accounts with overdue indicators, open cases and declining opportunities, scored.",
    keywords: ["risk", "at risk", "churn", "overdue"], requires: ["sf.read.sales", "sf.read.service"], usesMockOnly: false,
    defaults: { accountName: "", question: "", agentName: "" },
    build: () => `async () => {
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
}`,
  },
  {
    id: "service-intelligence", title: "Service Intelligence", description: "Open-case summary and escalation candidates (paginated).",
    keywords: ["service", "cases", "escalation", "support backlog"], requires: ["sf.read.service"], usesMockOnly: false,
    defaults: { accountName: "", question: "", agentName: "" },
    build: () => `async () => {
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
}`,
  },
  {
    id: "opportunity-intelligence", title: "Opportunity Intelligence", description: "Stage distribution, close-date slippage and near-term closes.",
    keywords: ["opportunity", "stage distribution", "close date", "slipp"], requires: ["sf.read.sales"], usesMockOnly: false,
    defaults: { accountName: "", question: "", agentName: "" },
    build: () => `async () => {
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
}`,
  },
  {
    id: "cpq-analysis", title: "CPQ Analysis", description: "Quotes and quote lines: discounting, expiry and line mix.",
    keywords: ["quote", "cpq", "pricing", "discount"], requires: ["sf.read.cpq"], usesMockOnly: false,
    defaults: { accountName: "", question: "", agentName: "" },
    build: () => `async () => {
  const quotes = await sf.getQuotes({ limit: 100 });
  const lines = await sf.getQuoteLines({ quoteIds: quotes.records.slice(0, 20).map((q) => q.Id as string), limit: 200 });
  const today = new Date().toISOString().slice(0, 10);
  const perQuote = quotes.records.map((q) => {
    const ls = lines.records.filter((l) => l.QuoteId === q.Id);
    const list = ls.reduce((s, l) => s + (l.ListPrice ?? 0) * (l.Quantity ?? 0), 0);
    const net = ls.reduce((s, l) => s + (l.TotalPrice ?? 0), 0);
    return {
      quote: q.QuoteNumber, name: q.Name, status: q.Status, expired: !!q.ExpirationDate && (q.ExpirationDate as string) < today,
      lines: ls.length, listTotal: list, netTotal: net, effectiveDiscountPct: list ? Number((((list - net) / list) * 100).toFixed(1)) : 0,
      deepDiscountLines: ls.filter((l) => (l.Discount ?? 0) >= 20).map((l) => ({ product: l.Product2Id, discount: l.Discount })),
    };
  });
  return { quotes: perQuote, flags: { expiredWithOpenStatus: perQuote.filter((q) => q.expired).map((q) => q.quote), needsApproval: perQuote.filter((q) => q.effectiveDiscountPct >= 15).map((q) => q.quote) } };
}`,
  },
  {
    id: "customer-360", title: "Customer 360", description: "Sales Cloud + Service Cloud + Data Cloud for one account.",
    keywords: ["customer 360", "unified profile", "data cloud"], requires: ["sf.read.sales", "sf.read.service", "sf.read.datacloud"], usesMockOnly: true,
    defaults: { accountName: "Acme Corporation", question: "", agentName: "" },
    build: (p) => `async () => {
  const name: string = ${lit(p.accountName ?? "Acme Corporation")};
  const account = (await sf.searchAccounts({ query: name, limit: 1 })).records[0];
  if (!account) return { error: \`No account matching "\${name}"\` };
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
}`,
  },
  {
    id: "knowledge-assistant", title: "Knowledge Assistant", description: "Grounded answer assembled only from retrieved Knowledge articles.",
    keywords: ["knowledge", "how do i", "how to", "article", "kb"], requires: ["sf.read.knowledge"], usesMockOnly: false,
    defaults: { accountName: "", question: "How do I fix API latency spikes?", agentName: "" },
    build: (p) => `async () => {
  const question: string = ${lit(p.question ?? "How do I fix API latency spikes?")};
  const stop = new Set(["how", "do", "i", "the", "a", "an", "to", "is", "my", "on", "for", "and", "of", "in", "what", "why", "can", "fix"]);
  const terms = question.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\\s+/).filter((w) => w.length > 2 && !stop.has(w));
  const results = await Promise.all(terms.slice(0, 4).map((t) => sf.getKnowledgeArticles({ query: t, bodyField: "Body__c", limit: 3 })));
  const seen = new Map<string, Record<string, any>>();
  for (const r of results) for (const a of r.articles) seen.set(a.Id as string, a);
  const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").trim();
  const ranked = [...seen.values()].map((a) => ({ a, hits: terms.filter((t) => \`\${a.Title} \${a.Summary}\`.toLowerCase().includes(t)).length })).sort((x, y) => y.hits - x.hits);
  if (!ranked.length) return { question, grounded: false, answer: "No Knowledge article covers this question; escalate to a human agent.", sources: [] };
  const best = ranked[0]!.a;
  return {
    question, grounded: true,
    answer: strip((best.Body__c as string | undefined) ?? (best.Summary as string)),
    sources: ranked.slice(0, 3).map(({ a }) => ({ title: a.Title, urlName: a.UrlName })),
    note: "Answer text is quoted from the top-ranked article body; it is not model-generated.",
  };
}`,
  },
  {
    id: "agentforce-integration", title: "Agentforce Integration", description: "Invoke an approved Agentforce agent with case context and return its response.",
    keywords: ["agentforce", "agent", "triage"], requires: ["sf.read.service", "sf.agentforce.invoke"], usesMockOnly: true,
    defaults: { accountName: "", question: "", agentName: "Service_Triage_Agent" },
    build: (p) => `async () => {
  const agentName: string = ${lit(p.agentName ?? "Service_Triage_Agent")};
  const cases = await sf.searchCases({ isClosed: false, priority: "High", limit: 1 });
  const c = cases.records[0];
  if (!c) return { message: "No open high-priority case to triage." };
  const reply = await sf.invokeApprovedAgent({ agentName, prompt: \`Triage case \${c.CaseNumber}: \${c.Subject}\` });
  return { case: { number: c.CaseNumber, subject: c.Subject }, agent: reply.agentName, response: reply.response, citations: reply.citations, executedBy: reply.source };
}`,
  },
  {
    id: "cross-system-analysis", title: "Enterprise Cross-System Analysis", description: "Salesforce pipeline joined with NetSuite receivables to find revenue at risk.",
    keywords: ["netsuite", "cross-system", "receivable", "invoices", "revenue at risk"], requires: ["sf.read.sales", "external.read"], usesMockOnly: true,
    defaults: { accountName: "", question: "", agentName: "" },
    build: () => `async () => {
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
}`,
  },
];

export function findWorkflow(id: string): Workflow | undefined {
  return WORKFLOWS.find((w) => w.id === id);
}

export function matchWorkflow(task: string): Workflow | undefined {
  const t = task.toLowerCase();
  let best: { w: Workflow; score: number } | undefined;
  for (const w of WORKFLOWS) {
    const score = w.keywords.reduce((s, k) => (t.includes(k) ? s + k.length : s), 0) + (t.includes(w.id.replace(/-/g, " ")) ? 10 : 0);
    if (score > 0 && (!best || score > best.score)) best = { w, score };
  }
  return best?.w;
}

/** Pull a quoted or Capitalized account name out of free text ("for Acme", "for 'Globex Industries'"). */
export function extractAccountName(task: string): string | undefined {
  const q = task.match(/["'“]([^"'”]{2,60})["'”]/);
  if (q) return q[1];
  const m = task.match(/\b(?:for|about|on|of)\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,3})/);
  return m?.[1];
}
