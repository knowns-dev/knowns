// Test preload (bunfig.toml): the test process never sees the developer's real home.
//
// Why: the in-process CLI (runTs) and every child it or a harness spawns resolve ~/.knowns from
// HOME/USERPROFILE. Before this preload, harnesses that did not mirror their sandbox env into
// process.env registered temp projects in the REAL ~/.knowns/runtime/projects.json and queued
// work for the user's live runtime (151 entries on one macOS machine, 25 on Windows).
//
// What it does, in order:
// 1. Snapshots, read-only, the temp-dir paths named in the real ~/.knowns/runtime/projects.json
//    and ~/.knowns/registry.json.
// 2. Points HOME and USERPROFILE at a fresh temp dir for the rest of the process. Go's caches
//    default to HOME-relative paths, so GOPATH/GOMODCACHE/GOCACHE are pinned to their current
//    values first (no rebuilds, no module downloads).
// 3. Gives in-process runs a runtime daemon command that works under `bun test` (the default uses
//    argv[1], which is the test file here). Suites that need their own still override it.
// 4. After the run, fails if a real registry file gained a temp-dir path, which means some code
//    escaped the sandbox. Only new temp paths count, so the user's own runtime may keep updating
//    the files.
//
// Limit: Bun fixes os.homedir() at process start, so code that calls homedir() without checking
// HOME first still sees the real home. The guard in step 4 is what catches such a regression.
import { afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setDaemonCommand } from "../../src/runtime/queue.ts";

const realHome = homedir();
const REAL_FILES = [
  join(realHome, ".knowns", "runtime", "projects.json"),
  join(realHome, ".knowns", "registry.json"),
];

function tempRoots(): string[] {
  const roots = new Set<string>();
  for (const t of [tmpdir(), process.env.TMPDIR, process.env.TEMP, process.env.TMP]) {
    if (!t) continue;
    roots.add(t.replace(/[\\/]+$/, ""));
    try {
      roots.add(realpathSync(t).replace(/[\\/]+$/, ""));
    } catch {
      // keep the raw form
    }
  }
  return [...roots];
}
const TEMP_ROOTS = tempRoots();

/** Every JSON string in the file that names a path under a temp root (with / or \ separators). */
export function tempPathsIn(file: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(file)) return out;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  const norm = (s: string) => s.replaceAll("\\\\", "/").replaceAll("\\", "/").toLowerCase();
  const roots = TEMP_ROOTS.map(norm);
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const s = norm(m[1] as string);
    if (roots.some((r) => r !== "" && s.startsWith(`${r}/`))) out.add(s);
  }
  return out;
}

const before = new Map(REAL_FILES.map((f) => [f, tempPathsIn(f)]));

// 2. Redirect the home for this process and everything it spawns.
function pinGoEnv(): void {
  if (process.env.GOPATH && process.env.GOMODCACHE && process.env.GOCACHE) return;
  const go = Bun.which("go");
  if (!go) return;
  const r = Bun.spawnSync([go, "env", "GOPATH", "GOMODCACHE", "GOCACHE"], { stdout: "pipe" });
  if (r.exitCode !== 0) return;
  const [gopath, modcache, cache] = r.stdout.toString().split(/\r?\n/);
  if (!process.env.GOPATH && gopath) process.env.GOPATH = gopath;
  if (!process.env.GOMODCACHE && modcache) process.env.GOMODCACHE = modcache;
  if (!process.env.GOCACHE && cache) process.env.GOCACHE = cache;
}
// Applied once per process. This module is loaded by the preload when `bun test` starts in cli/
// (cli/bunfig.toml) or at the repo root (bunfig.toml), and imported by test/cli/oracle.ts as a
// fallback for any other cwd: bun only reads bunfig.toml from the current directory, and a run
// from elsewhere silently skipped the sandbox (time.diff from the repo root on Windows).
// KNOWNS_TEST_REAL_HOME marks it applied; a child test process inherits the sandboxed HOME too.
const alreadyApplied = process.env.KNOWNS_TEST_REAL_HOME !== undefined;
if (!alreadyApplied) {
  pinGoEnv();
  const sandboxHome = realpathSync(mkdtempSync(join(tmpdir(), "knowns-test-home-")));
  process.env.KNOWNS_TEST_REAL_HOME = realHome;
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;

  // 3. A daemon command that starts the real CLI entry, not the test file.
  const MAIN = resolve(import.meta.dir, "..", "..", "src", "main.ts");
  setDaemonCommand(() => ({ cmd: process.execPath, args: [MAIN, "__runtime", "run"] }));
}

// 4. Fail loudly if anything still reached the real registry files.
if (!alreadyApplied)
  afterAll(() => {
    const leaks: string[] = [];
    for (const f of REAL_FILES) {
      const was = before.get(f) ?? new Set<string>();
      for (const p of tempPathsIn(f)) if (!was.has(p)) leaks.push(`${f}: ${p}`);
    }
    if (leaks.length > 0) {
      throw new Error(
        `a test wrote temp projects into the REAL home (${realHome}); fix the code path that ignores HOME:\n  ${leaks.join("\n  ")}`,
      );
    }
  });
