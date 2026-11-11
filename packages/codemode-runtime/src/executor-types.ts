/**
 * Structurally identical to the Executor contract of @cloudflare/codemode, so
 * DynamicWorkerExecutor (production) and QuickJsExecutor (Node tests/dev) are interchangeable.
 */
export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

export interface ResolvedProvider {
  /** Sandbox global name, e.g. "sf". */
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
}

export interface Executor {
  /** Must never throw: failures are returned in ExecuteResult.error. */
  execute(code: string, providers: ResolvedProvider[]): Promise<ExecuteResult>;
}
