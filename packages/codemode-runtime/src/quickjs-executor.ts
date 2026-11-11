import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";
import type { ExecuteResult, Executor, ResolvedProvider } from "./executor-types";

export interface QuickJsOptions {
  timeoutMs?: number;
  memoryLimitBytes?: number;
  maxStackBytes?: number;
  maxLogLines?: number;
  maxLogBytes?: number;
}

/**
 * Local/test Executor backed by QuickJS compiled to WebAssembly. Each execution gets a fresh,
 * empty JS realm with no I/O primitives at all (no fetch, timers, process, require), a hard
 * memory ceiling, and an interrupt deadline that also stops synchronous infinite loops.
 *
 * Production on Cloudflare uses DynamicWorkerExecutor instead; this class exists so the same
 * orchestration code and security tests can run in Node CI without Workers.
 */
export class QuickJsExecutor implements Executor {
  constructor(private readonly opts: QuickJsOptions = {}) {}

  async execute(code: string, providers: ResolvedProvider[]): Promise<ExecuteResult> {
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(this.opts.memoryLimitBytes ?? 64 * 1024 * 1024);
    runtime.setMaxStackSize(this.opts.maxStackBytes ?? 512 * 1024);
    const deadline = Date.now() + timeoutMs;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    const vm = runtime.newContext();
    const logs: string[] = [];
    let logBytes = 0;
    let closed = false;
    const maxLines = this.opts.maxLogLines ?? 200;
    const maxLogBytes = this.opts.maxLogBytes ?? 20_000;

    const fnsByNs = new Map(providers.map((p) => [p.name, p.fns]));

    const hostLog = vm.newFunction("__hostLog", (h: QuickJSHandle) => {
      const line = vm.getString(h);
      if (logs.length < maxLines && logBytes + line.length <= maxLogBytes) {
        logs.push(line);
        logBytes += line.length;
      }
    });
    const hostCall = vm.newFunction("__hostCall", (nsH: QuickJSHandle, nameH: QuickJSHandle, argsH: QuickJSHandle) => {
      const ns = vm.getString(nsH);
      const name = vm.getString(nameH);
      const argsJson = vm.getString(argsH);
      const deferred = vm.newPromise();
      const settle = (payload: unknown) => {
        if (closed || !vm.alive) return;
        const h = vm.newString(JSON.stringify(payload));
        deferred.resolve(h);
        h.dispose();
        runtime.executePendingJobs();
      };
      const fn = fnsByNs.get(ns)?.[name];
      if (!fn) settle({ error: `Tool "${ns}.${name}" not found` });
      else {
        Promise.resolve()
          .then(() => fn(JSON.parse(argsJson) as unknown))
          .then((v) => settle({ result: v === undefined ? null : v }))
          .catch((e: unknown) => settle({ error: e instanceof Error ? e.message : String(e) }));
      }
      return deferred.handle;
    });
    vm.setProp(vm.global, "__hostLog", hostLog);
    vm.setProp(vm.global, "__hostCall", hostCall);
    hostLog.dispose();
    hostCall.dispose();

    const prelude = `(function (call, log) {
      const fmt = (a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } };
      const mk = (ns, names) => {
        const o = {};
        for (const n of names) {
          o[n] = async (input) => {
            const raw = await call(ns, n, JSON.stringify(input === undefined ? {} : input));
            const d = JSON.parse(raw);
            if (d.error !== undefined) throw new Error(d.error);
            return d.result;
          };
        }
        return Object.freeze(o);
      };
      ${providers.map((p) => `Object.defineProperty(globalThis, ${JSON.stringify(p.name)}, { value: mk(${JSON.stringify(p.name)}, ${JSON.stringify(Object.keys(p.fns))}), enumerable: false });`).join("\n      ")}
      const con = { log: (...a) => log(a.map(fmt).join(" ")), warn: (...a) => log("[warn] " + a.map(fmt).join(" ")), error: (...a) => log("[error] " + a.map(fmt).join(" ")) };
      Object.defineProperty(globalThis, "console", { value: Object.freeze(con), enumerable: false });
    })(globalThis.__hostCall, globalThis.__hostLog);
    delete globalThis.__hostCall; delete globalThis.__hostLog;`;

    const finish = (r: ExecuteResult): ExecuteResult => {
      closed = true;
      try {
        vm.dispose();
        runtime.dispose();
      } catch {
        /* already torn down after timeout */
      }
      return { ...r, logs };
    };

    try {
      const pre = vm.evalCode(prelude);
      if (pre.error) {
        const e = vm.dump(pre.error) as { message?: string };
        pre.error.dispose();
        return finish({ result: undefined, error: `Sandbox init failed: ${e.message ?? "unknown"}` });
      }
      pre.value.dispose();

      const main = vm.evalCode(`(async () => { const __r = await (${code})(); const __s = JSON.stringify(__r); return __s === undefined ? "null" : __s; })()`);
      if (main.error) {
        const e = vm.dump(main.error) as { message?: string };
        main.error.dispose();
        return finish({ result: undefined, error: e.message ?? "Execution failed" });
      }
      const settled = await raceWithTimeout(settleVmPromise(vm, runtime, main.value), Math.max(1, deadline - Date.now()));
      if (settled === TIMEOUT) return finish({ result: undefined, error: "Execution timed out" });
      if (settled.error) return finish({ result: undefined, error: settled.error });
      return finish({ result: JSON.parse(settled.value ?? "null") as unknown });
    } catch (e) {
      return finish({ result: undefined, error: friendly(e) });
    }
  }
}

const TIMEOUT = Symbol("timeout");

function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /interrupted/i.test(m) ? "Execution timed out" : /out of memory|memory/i.test(m) ? "Sandbox memory limit exceeded" : m;
}

async function settleVmPromise(vm: QuickJSContext, runtime: { executePendingJobs(): unknown }, promiseHandle: QuickJSHandle): Promise<{ value?: string; error?: string }> {
  const nativePromise = vm.resolvePromise(promiseHandle);
  promiseHandle.dispose();
  runtime.executePendingJobs();
  const res = await nativePromise;
  if (res.error) {
    const e = vm.dump(res.error) as { message?: string; name?: string } | string;
    res.error.dispose();
    const msg = typeof e === "string" ? e : (e.message ?? e.name ?? "Execution failed");
    return { error: friendly(new Error(msg)) };
  }
  const value = vm.getString(res.value);
  res.value.dispose();
  return { value };
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(TIMEOUT), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}
