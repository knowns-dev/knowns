// D5 budgets: per target, knowns may exceed an EMPTY Bun-compiled binary (same Bun version,
// same target, same signing) by at most 30MB; `knowns --version` median <= 150ms on the host.
// Usage: bun scripts/budget.ts            -> host binary: size delta + startup
//        bun scripts/budget.ts a b ...    -> size delta only for each path (dist/<platform>/knowns[.exe])
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { compile, exeName } from "./lib.ts";

const MAX_DELTA = 30 * 1024 * 1024;
const MAX_MS = 150;
const RUNS = 11;

const cliDir = resolve(import.meta.dir, "..");
const baselineDir = join(cliDir, "dist", ".baseline");
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
let failed = false;

/** Size of an empty compiled binary for the target at this Bun version; cached on disk. */
async function emptySize(target: string): Promise<number> {
  const dir = join(baselineDir, `${Bun.version}-${target}`);
  const out = join(dir, exeName(target));
  if (!existsSync(out)) {
    const entry = join(baselineDir, "empty.ts");
    writeFileSync(entry, "export {};\n");
    await compile(entry, target, out);
  }
  return statSync(out).size;
}

async function checkSize(path: string): Promise<void> {
  const platform = basename(dirname(path));
  const target = `bun-${platform}`;
  const size = statSync(path).size;
  const empty = await emptySize(target);
  const delta = size - empty;
  const ok = delta <= MAX_DELTA;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${platform}: knowns ${mb(size)}MB, empty ${mb(empty)}MB, delta ${mb(delta)}MB (limit ${mb(MAX_DELTA)}MB)`,
  );
  if (!ok) failed = true;
}

mkdirSync(baselineDir, { recursive: true });

const args = process.argv.slice(2);
if (args.length > 0) {
  for (const p of args) await checkSize(resolve(p));
} else {
  const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const exe = join(
    cliDir,
    "dist",
    platform,
    process.platform === "win32" ? "knowns.exe" : "knowns",
  );
  await checkSize(exe);
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const p = Bun.spawnSync([exe, "--version"], { stdout: "pipe", stderr: "pipe" });
    times.push(performance.now() - t0);
    if (p.exitCode !== 0) {
      console.log(`FAIL --version exited ${p.exitCode}`);
      failed = true;
      break;
    }
  }
  if (times.length === RUNS) {
    times.sort((a, b) => a - b);
    const median = times[Math.floor(RUNS / 2)] ?? Number.POSITIVE_INFINITY;
    const ok = median <= MAX_MS;
    console.log(
      `${ok ? "ok  " : "FAIL"} startup median ${median.toFixed(1)}ms over ${RUNS} runs (limit ${MAX_MS}ms)`,
    );
    if (!ok) failed = true;
  }
}
process.exit(failed ? 1 : 0);
