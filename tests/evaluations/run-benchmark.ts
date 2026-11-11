import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark, toMarkdown } from "./benchmark";

const dir = join(dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(dir, { recursive: true });
const runs = Number(process.argv[2] ?? process.env.BENCH_RUNS ?? 20);
console.log(`Running benchmark (${runs} runs per cell)…`);
const result = await runBenchmark(runs);
writeFileSync(join(dir, "benchmark.json"), JSON.stringify(result, null, 2));
writeFileSync(join(dir, "benchmark.md"), toMarkdown(result));
console.log(toMarkdown(result));
console.log(`\nWrote ${dir}/benchmark.{json,md}`);
