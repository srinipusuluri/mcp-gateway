/**
 * @cloudflare/codemode's DynamicWorkerExecutor only enforces a wall-clock Promise.race timeout, which
 * cannot fire while the isolate is spinning in a synchronous loop. In a single-Durable-Object gateway that
 * would stall every user. The Worker Loader supports `limits.cpuMs`; this wrapper injects it into every
 * dynamically loaded worker so the runtime itself terminates runaway CPU use.
 */
export interface SandboxLimits {
  cpuMs: number;
  subRequests?: number;
}

export function withLimits(loader: WorkerLoader, limits: SandboxLimits): WorkerLoader {
  return {
    load: (code: WorkerLoaderWorkerCode) => loader.load({ ...code, limits: { ...code.limits, ...limits } }),
    get: (id: string, getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>) =>
      loader.get(id, async () => ({ ...(await getCode()), limits: { ...limits } })),
  } as WorkerLoader;
}
