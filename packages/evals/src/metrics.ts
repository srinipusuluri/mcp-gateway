/**
 * Evaluation metrics. Pure functions, no I/O: usable from vitest gates, the CLI runner and notebooks.
 * Definitions follow the standard IR / agent-eval literature so numbers are comparable with
 * open-source tools (ragas, DeepEval, Phoenix evals, TruLens): see docs/evals.md.
 */

// ---------- statistics ----------
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/** Wilson score interval for a pass rate (95% by default). Honest with small samples. */
export function wilson(passes: number, n: number, z = 1.96): { low: number; high: number } {
  if (!n) return { low: 0, high: 0 };
  const p = passes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
}

// ---------- retrieval (RAG) ----------
export function precisionAtK(ranked: string[], relevant: Set<string>, k: number): number {
  const top = ranked.slice(0, k);
  return top.length ? top.filter((id) => relevant.has(id)).length / top.length : relevant.size ? 0 : 1;
}

export function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (!relevant.size) return ranked.length ? 0 : 1; // unanswerable: perfect only if nothing is retrieved
  return ranked.slice(0, k).filter((id) => relevant.has(id)).length / relevant.size;
}

export function hitAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (!relevant.size) return ranked.length ? 0 : 1;
  return ranked.slice(0, k).some((id) => relevant.has(id)) ? 1 : 0;
}

export function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  if (!relevant.size) return ranked.length ? 0 : 1;
  const i = ranked.findIndex((id) => relevant.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
}

/** nDCG@k with binary relevance. */
export function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (!relevant.size) return ranked.length ? 0 : 1;
  const dcg = ranked.slice(0, k).reduce((s, id, i) => s + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(k, relevant.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return ideal ? dcg / ideal : 0;
}

// ---------- grounding (generation side of RAG) ----------
const tokens = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, " ").match(/[a-z0-9]+/g)?.filter((t) => t.length > 2) ?? [];

/**
 * Lexical faithfulness proxy: share of answer content tokens that appear in the retrieved context.
 * 1.0 = every content word is supported by context. Cheap, deterministic, no model needed; the optional
 * LLM judge gives a semantic score on top. (ragas "faithfulness" is the claim-level version of this.)
 */
export function tokenSupport(answer: string, context: string): number {
  const a = tokens(answer);
  if (!a.length) return 1;
  const c = new Set(tokens(context));
  return a.filter((t) => c.has(t)).length / a.length;
}

/** Share of reference key facts (short phrases) present in the answer: a deterministic answer-correctness proxy. */
export function keyFactRecall(answer: string, facts: string[]): number {
  if (!facts.length) return 1;
  const a = answer.toLowerCase();
  return facts.filter((f) => a.includes(f.toLowerCase())).length / facts.length;
}

// ---------- agent / tool trajectory ----------
export interface TrajectoryScore {
  /** expected tools that were called / expected tools */
  toolRecall: number;
  /** called tools that were expected or allowed / called tools */
  toolPrecision: number;
  /** order constraints satisfied (each [a,b] means first a call precedes first b call) */
  orderScore: number;
  forbiddenCalls: string[];
  /** tool calls within budget (1) or over (0) */
  withinBudget: number;
  failedCalls: number;
}

export function scoreTrajectory(
  called: string[],
  spec: { expected: string[]; allowed?: string[]; forbidden?: string[]; order?: Array<[string, string]>; maxCalls?: number },
  failed = 0,
): TrajectoryScore {
  const set = new Set(called);
  const ok = new Set([...spec.expected, ...(spec.allowed ?? [])]);
  const order = spec.order ?? [];
  return {
    toolRecall: spec.expected.length ? spec.expected.filter((t) => set.has(t)).length / spec.expected.length : 1,
    toolPrecision: set.size ? [...set].filter((t) => ok.has(t)).length / set.size : 1,
    orderScore: order.length ? order.filter(([a, b]) => called.indexOf(a) >= 0 && called.indexOf(b) >= 0 && called.indexOf(a) < called.indexOf(b)).length / order.length : 1,
    forbiddenCalls: [...set].filter((t) => spec.forbidden?.includes(t)),
    withinBudget: spec.maxCalls === undefined || called.length <= spec.maxCalls ? 1 : 0,
    failedCalls: failed,
  };
}

// ---------- classification (guardrail detector) ----------
export interface Confusion { tp: number; fp: number; tn: number; fn: number }
export function prf(c: Confusion) {
  const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 1;
  const recall = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const fpr = c.fp + c.tn ? c.fp / (c.fp + c.tn) : 0;
  return { precision, recall, f1, falsePositiveRate: fpr, accuracy: (c.tp + c.tn) / Math.max(1, c.tp + c.fp + c.tn + c.fn) };
}
