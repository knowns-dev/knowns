// D5 budgets: per target, knowns may exceed an EMPTY Bun-compiled binary (same Bun version,
// same target, same signing) by at most 30MB; `knowns --version` median <= 150ms on macOS/Linux and
// <= 400ms on Windows (see MAX_MS).
// Usage: bun scripts/budget.ts            -> host binary: size delta + startup
//        bun scripts/budget.ts a b ...    -> size delta only for each path (dist/<platform>/knowns[.exe])
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { compile, exeName } from "./lib.ts";

const MAX_DELTA = 30 * 1024 * 1024;
// A Bun-compiled exe on Windows starts slower than on macOS/Linux whatever the code does: the PE
// is ~127MB and Defender real-time protection is on. Measured 2026-11-18 with `knowns.exe --version`,
// 25 interleaved runs x 3 on a Windows PC with Defender on: median 213ms for 8d5d3e8 and 217ms for
// 56d4287 (no regression; the first run after a copy costs no more), and the hosted windows-latest
// runner measured 225ms. 400ms is about 1.8x that floor: it still fails a real regression (a
// startup that loads the engine eagerly adds hundreds of ms) without flaking on runner noise.
const MAX_MS = process.platform === "win32" ? 400 : 150;
// On a shared runner the wall clock swings with whatever else the host is doing: medians of 86-169ms
// were seen for the same tree on GitHub macOS and Ubuntu runners, so a wall-clock limit alone fails
// builds that did not change. CPU time (user + system) of the same process hardly moves with host
// load (here 170-195ms idle and loaded, where wall went 173-266ms), and an empty Bun binary run
// interleaved with knowns takes out the cost of the runtime itself. A run passes when the wall
// median is within MAX_MS, or the CPU time above an empty binary is within MAX_CPU_DELTA_MS: a quiet
// runner passes on wall exactly as before, a noisy one is judged on work done. A startup that loads
// the engine eagerly adds hundreds of ms of CPU and fails both. Windows keeps wall only: its
// process accounting counts in 15.6ms ticks and includes the runtime's own threads.
const MAX_CPU_DELTA_MS = 200;
const CPU_VERDICT = process.platform !== "win32";
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
  // Hosted macOS runners show medians of 92-183 ms for identical code, so on CI the best of up to 3
  // rounds counts; locally one round. Every round is printed.
  const maxRounds = process.env.CI === "1" || process.env.CI === "true" ? 3 : 1;
  const medians: number[] = [];
  const emptyExe = join(
    baselineDir,
    `${Bun.version}-bun-${platform}`,
    process.platform === "win32" ? "knowns.exe" : "knowns",
  );
  const useCpu = CPU_VERDICT && existsSync(emptyExe);
  const cpuOf = (p: { resourceUsage?: { cpuTime: { user: unknown; system: unknown } } }) =>
    p.resourceUsage
      ? (Number(p.resourceUsage.cpuTime.user) + Number(p.resourceUsage.cpuTime.system)) / 1000
      : Number.NaN;
  const cpuKnowns: number[] = [];
  const cpuEmpty: number[] = [];
  const median = (xs: number[]) =>
    [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.POSITIVE_INFINITY;
  for (let round = 0; round < maxRounds; round++) {
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
      if (useCpu) {
        // The empty binary right after, so both see the same host load.
        cpuKnowns.push(cpuOf(p));
        cpuEmpty.push(
          cpuOf(Bun.spawnSync([emptyExe, "--version"], { stdout: "pipe", stderr: "pipe" })),
        );
      }
    }
    if (times.length < RUNS) break;
    times.sort((a, b) => a - b);
    const med = times[Math.floor(RUNS / 2)] ?? Number.POSITIVE_INFINITY;
    medians.push(med);
    console.log(`     round ${round + 1}: median ${med.toFixed(1)}ms over ${RUNS} runs`);
    if (med <= MAX_MS) break;
  }
  const cpuDelta =
    useCpu && cpuKnowns.every(Number.isFinite) && cpuEmpty.every(Number.isFinite)
      ? median(cpuKnowns) - median(cpuEmpty)
      : Number.NaN;
  if (useCpu) {
    console.log(
      `     cpu: knowns ${median(cpuKnowns).toFixed(1)}ms, empty ${median(cpuEmpty).toFixed(1)}ms, delta ${cpuDelta.toFixed(1)}ms over ${cpuKnowns.length} runs (limit ${MAX_CPU_DELTA_MS}ms)`,
    );
  }
  if (medians.length) {
    const best = Math.min(...medians);
    const wallOk = best <= MAX_MS;
    const cpuOk = Number.isFinite(cpuDelta) && cpuDelta <= MAX_CPU_DELTA_MS;
    const ok = wallOk || cpuOk;
    console.log(
      `${ok ? "ok  " : "FAIL"} startup best median ${best.toFixed(1)}ms of ${medians.length} round(s) (limit ${MAX_MS}ms)${!wallOk && cpuOk ? `, passes on cpu delta ${cpuDelta.toFixed(1)}ms (limit ${MAX_CPU_DELTA_MS}ms)` : ""}`,
    );
    if (!ok) failed = true;
  }
}
process.exit(failed ? 1 : 0);
