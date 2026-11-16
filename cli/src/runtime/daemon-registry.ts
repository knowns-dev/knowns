// Version-scoped runtime daemons (spec D3, @task-KN-9FGFP0). Two daemons of different versions may
// run at once during an upgrade: the old one keeps serving the sessions it has and exits after its
// last one, the new one serves new sessions. They share one runtime root, so exactly one of them
// (the runner: the newest version alive) runs queue jobs and reconcile watchers; the others only
// serve their own sessions. The files:
//
//   daemons/<version>.json   one per live daemon: { pid, version, startedAt }
//   runner.json              the current runner: { pid, version, claimedAt }, guarded by runner.lock
//   knowns-runtime.pid, status.json   unchanged for 0.34.x readers, written by the runner only
//
// A function that touches the disk reads the runtime root at call time, so tests can move it.
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import type { Lease } from "./queue.ts";
import {
  isProcessAlive,
  isWindowsFileBusy,
  nowString,
  renameOverFile,
  retryWhileBusy,
  runtimeRoot,
  sleepSync,
} from "./queue.ts";

export interface DaemonEntry {
  pid: number;
  version: string;
  startedAt: string;
}

export interface RunnerClaim {
  pid: number;
  version: string;
  claimedAt: string;
}

const versionToken = (v: string): string => v.replace(/[^A-Za-z0-9._+-]/g, "_");
const daemonsDir = (): string => join(runtimeRoot(), "daemons");
const daemonFile = (version: string): string => join(daemonsDir(), `${versionToken(version)}.json`);
const runnerFile = (): string => join(runtimeRoot(), "runner.json");
const runnerLock = (): string => join(runtimeRoot(), "runner.lock");

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.${process.pid}.tmp`;
  retryWhileBusy(() => writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o644 }));
  renameOverFile(tmp, path);
}

/** Compares release versions: numeric parts first, a pre-release sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const m = /^v?(\d+(?:\.\d+)*)(?:-([^+]+))?/.exec(v.trim());
    return { nums: (m?.[1] ?? "0").split(".").map(Number), pre: m?.[2] ?? "" };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === "") return 1;
  if (y.pre === "") return -1;
  return x.pre < y.pre ? -1 : 1;
}

// --- registry ------------------------------------------------------------------------------------

/**
 * A registry file written before the machine last booted names a process that cannot be running:
 * after a reboot the pid may belong to something else entirely. `clock` is a seam for tests.
 */
export function predatesBoot(
  startedAt: string,
  clock: { now: number; uptimeSec: number } = { now: Date.now(), uptimeSec: uptime() },
): boolean {
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return false;
  const bootedAt = clock.now - clock.uptimeSec * 1000;
  return t < bootedAt - 60_000; // a minute of slack for clock steps
}

/** Thrown by registerDaemon when another live process already is the daemon of this version. */
export class DaemonAlreadyRunning extends Error {
  constructor(
    readonly version: string,
    readonly pid: number,
  ) {
    super(`a daemon of version ${version} is already running (pid ${pid})`);
  }
}

export function registerDaemon(version: string, pid: number = process.pid): void {
  const cur = readJson<DaemonEntry>(daemonFile(version));
  if (cur && cur.pid !== pid && isProcessAlive(cur.pid) && !predatesBoot(cur.startedAt)) {
    throw new DaemonAlreadyRunning(version, cur.pid);
  }
  writeAtomic(daemonFile(version), { pid, version, startedAt: nowString() } satisfies DaemonEntry);
}

/** Removes this process's entry (a replacement daemon of the same version keeps its own). */
export function unregisterDaemon(version: string, pid: number = process.pid): void {
  const cur = readJson<DaemonEntry>(daemonFile(version));
  if (cur && cur.pid !== pid) return;
  rmSync(daemonFile(version), { force: true });
}

/** The live daemon of this exact version, if any (a dead entry is dropped). */
export function findDaemon(version: string): DaemonEntry | undefined {
  const cur = readJson<DaemonEntry>(daemonFile(version));
  if (!cur) return undefined;
  if (isProcessAlive(cur.pid) && !predatesBoot(cur.startedAt)) return cur;
  rmSync(daemonFile(version), { force: true });
  return undefined;
}

export function listDaemons(): DaemonEntry[] {
  let names: string[];
  try {
    names = readdirSync(daemonsDir());
  } catch {
    return [];
  }
  const out: DaemonEntry[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const e = readJson<DaemonEntry>(join(daemonsDir(), n));
    if (e && isProcessAlive(e.pid) && !predatesBoot(e.startedAt)) out.push(e);
  }
  return out.sort((a, b) => compareVersions(a.version, b.version));
}

/** Is a live process registered under this pid (any version)? */
export function isRegisteredPid(pid: number): boolean {
  return listDaemons().some((d) => d.pid === pid);
}

// --- runner lock --------------------------------------------------------------------------------

interface LockHolder {
  pid: number;
  /** When this holder took the lock (ms since epoch). */
  at: number;
}

const LOCK_MAX_AGE_MS = 10_000;

/**
 * Is the lock's holder gone? A dead pid is. A live pid is too when it is not the daemon that took
 * the lock: only registered daemons take it, so a pid that is not registered, or registered with a
 * start time later than the lock's, is a different process that reused the pid. Age is the last
 * resort for a holder that hangs.
 */
function holderGone(h: LockHolder | undefined, mtimeMs: number): boolean {
  if (!h) return Date.now() - mtimeMs > 2000; // unreadable or half-written for too long
  if (!isProcessAlive(h.pid)) return true;
  const entry = listDaemons().find((d) => d.pid === h.pid);
  if (!entry) return true;
  if (Date.parse(entry.startedAt) > h.at + 1000) return true; // registered after it took the lock
  return Date.now() - h.at > LOCK_MAX_AGE_MS;
}

let stealSeq = 0;

/**
 * Removes a stale lock so that only one contender wins: the file is renamed to a name of our own
 * (rename succeeds for exactly one of several racers), its content is checked again, and only a
 * lock that is really stale is deleted. A live lock that was caught by mistake (its owner replaced
 * the stale one between our check and our rename) is put back. Returns whether the lock is gone.
 */
function stealStaleLock(path: string): boolean {
  const mine = `${path}.stale.${process.pid}.${++stealSeq}`;
  try {
    renameSync(path, mine);
  } catch {
    return true; // someone else removed or replaced it first: look again
  }
  let st: { mtimeMs: number };
  try {
    st = statSync(mine);
  } catch {
    return true;
  }
  if (holderGone(readJson<LockHolder>(mine), st.mtimeMs)) {
    rmSync(mine, { force: true });
    return true;
  }
  try {
    linkSync(mine, path); // fails if a newer lock already exists
  } catch {
    // the owner's lock is gone for good: it will notice at release, which is best effort anyway
  }
  rmSync(mine, { force: true });
  return false;
}

/** Takes runner.lock, replacing a holder that crashed; throws when it cannot within timeoutMs. */
function acquireRunnerLock(timeoutMs: number): () => void {
  const path = runnerLock();
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const holder: LockHolder = { pid: process.pid, at: Date.now() };
      retryWhileBusy(() =>
        writeFileSync(path, JSON.stringify(holder), { flag: "wx", mode: 0o644 }),
      );
      return () => {
        try {
          retryWhileBusy(() => rmSync(path, { force: true }));
        } catch {
          // a stale lock is detected by pid and age
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && !isWindowsFileBusy(err)) throw err;
    }
    try {
      const st = statSync(path);
      if (holderGone(readJson<LockHolder>(path), st.mtimeMs)) {
        if (stealStaleLock(path)) continue;
      }
    } catch {
      continue; // vanished: retry at once
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${path}`);
    sleepSync(25);
  }
}

// --- runner --------------------------------------------------------------------------------------

export function currentRunner(): RunnerClaim | undefined {
  const c = readJson<RunnerClaim>(runnerFile());
  if (!c || !isProcessAlive(c.pid)) return undefined;
  // Only a registered daemon of that version can be the runner: after a reboot the pid may have
  // been reused by an unrelated process, and the claim file outlives the daemon.
  return listDaemons().some((d) => d.pid === c.pid && d.version === c.version) ? c : undefined;
}

/**
 * Tries to become the runner. The newest version alive wins: a dead runner, or one of an older
 * version, is replaced; an equal or newer one stays. Returns whether this process now runs jobs.
 */
export function claimRunner(version: string, pid: number = process.pid): boolean {
  let unlock: () => void;
  try {
    unlock = acquireRunnerLock(2000);
  } catch {
    // Cannot decide: keep the role we already hold, otherwise stand by.
    return currentRunner()?.pid === pid;
  }
  try {
    const cur = currentRunner();
    if (cur && cur.pid !== pid && compareVersions(cur.version, version) >= 0) return false;
    if (cur?.pid !== pid) {
      writeAtomic(runnerFile(), { pid, version, claimedAt: nowString() } satisfies RunnerClaim);
    }
    return true;
  } finally {
    unlock();
  }
}

/** Cheap periodic check: keep the role, or claim it when the runner is gone or older. */
export function checkRunner(version: string, pid: number = process.pid): boolean {
  const cur = currentRunner();
  if (cur?.pid === pid) return true;
  if (cur && compareVersions(cur.version, version) >= 0) return false;
  return claimRunner(version, pid);
}

export function releaseRunner(pid: number = process.pid): void {
  let unlock: (() => void) | undefined;
  try {
    unlock = acquireRunnerLock(1000);
  } catch {
    // best effort: a dead pid is replaced by the next claim anyway
  }
  try {
    const cur = readJson<RunnerClaim>(runnerFile());
    if (cur && cur.pid === pid) rmSync(runnerFile(), { force: true });
  } finally {
    unlock?.();
  }
}

// --- leases --------------------------------------------------------------------------------------

/**
 * The leases a daemon answers for: those written by clients of its own version, plus, for the
 * runner, those of clients that predate the version field. The runner alone watches projects, so
 * it also watches for the leases of other versions (`all`).
 */
export function partitionLeases(
  all: Lease[],
  version: string,
  isRunner: boolean,
): { own: Lease[]; watchFor: Lease[] } {
  const own = all.filter((l) => (l.version ?? "") === version || (isRunner && !l.version));
  return { own, watchFor: isRunner ? all : [] };
}
