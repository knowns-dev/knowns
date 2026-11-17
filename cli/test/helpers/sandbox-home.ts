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
import { afterAll, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setDaemonCommand } from "../../src/runtime/queue.ts";
// Side effect: restores the fixtures' empty directories that a clean clone lacks.
import "./fixture-dirs.ts";

// Bun 1.3.12 ignores `timeout` in bunfig.toml, and this call only covers the first file of a
// multi-file run (probed: with three 7 s async tests in three files, two died at 5 s). The real
// default is the `--timeout 30000` flag in the `test` script of package.json, which CI uses; this
// line only helps a bare `bun test` on a single file. 5 s is too tight for tests that spawn real
// processes on a loaded or Windows runner; 30 s still ends a hang fast. Files that call
// setDefaultTimeout or pass a per-test timeout keep theirs.
setDefaultTimeout(30_000);

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

// 5. Fail the run when a runtime-selecting env key is still changed at its end. bun runs every
// file in ONE process, so a file that sets KNOWNS_RUNTIME_ROOT and does not put it back points all
// later files at its dead temp dir; one unrestored override once failed 24 tests in other suites.
// The snapshot is taken after step 2.
//
// This is deliberately an end-of-run check only. Hooks registered here run once for the whole run,
// not once per file, so there is no point between files at which "the previous file is finished"
// can be told from "this file's beforeAll has set its own root". A check at a file boundary (an
// earlier version) blamed the next file's own setup and, by restoring the keys, broke its tests.
// The value in the message names the leaking suite (its temp dir prefix, for example
// knowns-tray-rt-...). HOME and USERPROFILE are not guarded: a harness moves them for the length of
// an in-process runTs, and a call still in flight at the end is not a leak. A leak that a later file
// overwrites and restores to the original is not seen, which is the price of the simple check.
const GUARDED_ENV = [
  "KNOWNS_RUNTIME_ROOT",
  "KNOWNS_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "APPDATA",
  "LOCALAPPDATA",
] as const;
const envSnapshot = new Map<string, string | undefined>(
  GUARDED_ENV.map((k) => [k, process.env[k]]),
);
afterAll(() => {
  const drift: string[] = [];
  for (const [k, was] of envSnapshot) {
    const now = process.env[k];
    if (now !== was) drift.push(`${k}: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
  }
  if (drift.length === 0) return;
  throw new Error(
    `a test file left test-environment keys changed at the end of the run; the value names its temp dir. Restore them in afterAll/finally:\n  ${drift.join("\n  ")}`,
  );
});
