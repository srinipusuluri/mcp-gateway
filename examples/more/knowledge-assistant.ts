// GENERATED from packages/salesforce-mcp/src/workflows.ts (knowledge-assistant). Do not edit.
// This is the exact program a model would pass to execute_code.
async () => {
  const question: string = "How do I fix API latency spikes?";
  const stop = new Set(["how", "do", "i", "the", "a", "an", "to", "is", "my", "on", "for", "and", "of", "in", "what", "why", "can", "fix"]);
  const terms = question.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w));
  const results = await Promise.all(terms.slice(0, 4).map((t) => sf.getKnowledgeArticles({ query: t, bodyField: "Body__c", limit: 3 })));
  const seen = new Map<string, Record<string, any>>();
  for (const r of results) for (const a of r.articles) seen.set(a.Id as string, a);
  const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const ranked = [...seen.values()].map((a) => ({ a, hits: terms.filter((t) => `${a.Title} ${a.Summary}`.toLowerCase().includes(t)).length })).sort((x, y) => y.hits - x.hits);
  if (!ranked.length) return { question, grounded: false, answer: "No Knowledge article covers this question; escalate to a human agent.", sources: [] };
  const best = ranked[0]!.a;
  return {
    question, grounded: true,
    answer: strip((best.Body__c as string | undefined) ?? (best.Summary as string)),
    sources: ranked.slice(0, 3).map(({ a }) => ({ title: a.Title, urlName: a.UrlName })),
    note: "Answer text is quoted from the top-ranked article body; it is not model-generated.",
  };
};

export {};
