// Port of installer_lock*.go. Go holds an flock(2)/LockFileEx on <baseDir>/.locks/<sha256>.lock.
// Bun has no native flock without an addon, so this uses an exclusive-create lock file
// (<sha256>.tslock) holding the owner pid, with stale-owner takeover (dead pid, or an unreadable
// file older than 60s). It serializes TypeScript processes against each other; it does not
// exclude a concurrent Go 0.34.x installer (different file). Documented deviation.
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { type Ctx, ctxErr, sleep } from "./context.ts";

const POLL_MS = 20;
const UNREADABLE_STALE_MS = 60_000;

export interface InstallLock {
  unlock: () => void;
  /** True when another holder had to release the lock first. */
  waited: boolean;
}

function lockPath(baseDir: string, languageID: string): string {
  const digest = createHash("sha256").update(languageID).digest("hex");
  return join(baseDir, ".locks", `${digest}.tslock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return false; // vanished: the next create attempt decides
  }
  const pid = Number.parseInt(raw, 10);
  if (Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
  try {
    return Date.now() - statSync(path).mtimeMs > UNREADABLE_STALE_MS;
  } catch {
    return false;
  }
}

/** One non-blocking attempt. Returns an unlock function, or undefined when held. */
function tryCreate(path: string): (() => void) | undefined {
  try {
    const fd = openSync(path, "wx", 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw e;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  };
}

function prepare(baseDir: string, languageID: string): string {
  try {
    mkdirSync(join(baseDir, ".locks"), { recursive: true, mode: 0o755 });
  } catch (e) {
    throw new Error(`create install lock directory: ${(e as Error).message}`);
  }
  return lockPath(baseDir, languageID);
}

function attempt(path: string, state: { waited: boolean }): (() => void) | undefined {
  const unlock = tryCreate(path);
  if (unlock) return unlock;
  state.waited = true;
  if (isStale(path)) {
    try {
      unlinkSync(path);
    } catch {
      // someone else removed it
    }
  }
  return undefined;
}

export async function acquireLanguageInstallLock(
  ctx: Ctx,
  baseDir: string,
  languageID: string,
): Promise<InstallLock> {
  const path = prepare(baseDir, languageID);
  const state = { waited: false };
  for (;;) {
    const unlock = attempt(path, state);
    if (unlock) return { unlock, waited: state.waited };
    const e = ctxErr(ctx);
    if (e) throw new Error(`lock install for ${languageID}: ${e.message}`);
    await sleep(POLL_MS, ctx).catch((err: Error) => {
      throw new Error(`lock install for ${languageID}: ${err.message}`);
    });
  }
}

/** Blocking variant for the synchronous Cleanup API. Gives up after timeoutMs. */
export function acquireLanguageInstallLockSync(
  baseDir: string,
  languageID: string,
  timeoutMs = 30_000,
): InstallLock {
  const path = prepare(baseDir, languageID);
  const state = { waited: false };
  const deadline = Date.now() + timeoutMs;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const unlock = attempt(path, state);
    if (unlock) return { unlock, waited: state.waited };
    if (Date.now() > deadline) throw new Error(`lock install for ${languageID}: timed out`);
    Atomics.wait(cell, 0, 0, POLL_MS);
  }
}
