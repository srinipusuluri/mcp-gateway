// GENERATED from packages/salesforce-mcp/src/workflows.ts (cpq-analysis). Do not edit.
// This is the exact program a model would pass to execute_code.
async () => {
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
};

export {};
