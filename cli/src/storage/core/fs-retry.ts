// Bounded retry of transient Windows busy-file errors for storage reads, renames and links.
// On Windows a rename over a file another process has open fails (EPERM, EBUSY, EACCES) until the
// handle closes, and a reader can hit the replace in flight. Every other platform and every other
// error code passes through untouched, so a real permission error still surfaces.
//
// The wait is synchronous (the storage layer is), so it is kept short where a daemon or server
// might be the caller:
//  - reads wait at most READ_BUSY_TIMEOUT_MS, renames and links at most WRITE_BUSY_TIMEOUT_MS;
//  - the delay doubles from 1 ms to 50 ms, so a stalled call makes tens of attempts, not hundreds;
//  - EBUSY is always retried, but EPERM and EACCES only briefly (DENIAL_MAX_TRIES tries inside
//    DENIAL_WINDOW_MS) unless the target is an ordinary writable file, the case a competing handle
//    explains; a read-only file or an ACL denial fails fast with the original error;
//  - withRetryBudget() gives a whole listing one shared deadline, so one locked file among
//    hundreds cannot multiply the wait.

import { linkSync, readFileSync, renameSync, statSync, truncateSync } from "node:fs";

/** How long a read, and a rename or link, waits out another handle on Windows. */
export const READ_BUSY_TIMEOUT_MS = 250;
export const WRITE_BUSY_TIMEOUT_MS = 2000;
/** Kept for callers of the first version: the write budget. */
export const FILE_BUSY_TIMEOUT_MS = WRITE_BUSY_TIMEOUT_MS;
/** First delay between tries; it doubles up to MAX_RETRY_DELAY_MS. */
export const FILE_BUSY_RETRY_DELAY_MS = 1;
export const MAX_RETRY_DELAY_MS = 50;
/** An EPERM or EACCES on a target that does not look like a busy writable file. */
export const DENIAL_MAX_TRIES = 5;
export const DENIAL_WINDOW_MS = 100;
/** A file a directory listing just returned and that then reads as missing: one more try. */
const MISSING_RETRY_DELAY_MS = 5;

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION, only on Windows. */
export function isWindowsFileBusy(err: unknown, platform: string = process.platform): boolean {
  if (platform !== "win32") return false;
  const code = codeOf(err);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RetryOptions {
  platform?: string;
  /** Total wait; default WRITE_BUSY_TIMEOUT_MS. */
  timeoutMs?: number;
  /** First delay; default FILE_BUSY_RETRY_DELAY_MS. */
  delayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => void;
  /** The file the operation targets; EPERM and EACCES get the full budget only if it is writable. */
  target?: string;
  /** Replaces the writable check (tests). */
  isWritable?: () => boolean;
  /** One extra try on ENOENT, for a file a directory listing just returned (Windows only). */
  retryMissing?: boolean;
}

let sharedDeadline: number | undefined;

/**
 * Runs fn with a deadline that every retry inside it respects, so a listing of many files that
 * hits one locked file waits at most `ms` in total instead of once per file.
 */
export function withRetryBudget<T>(ms: number, fn: () => T, now: () => number = Date.now): T {
  const prev = sharedDeadline;
  const mine = now() + ms;
  sharedDeadline = prev === undefined ? mine : Math.min(prev, mine);
  try {
    return fn();
  } finally {
    sharedDeadline = prev;
  }
}

function looksWritable(target: string | undefined): boolean {
  if (target === undefined) return false;
  try {
    const st = statSync(target);
    return st.isFile() && (st.mode & 0o200) !== 0;
  } catch {
    return false;
  }
}

/** Run op, retrying a transient Windows busy-file error until the budget is spent. */
export function retryWhileBusy<T>(op: () => T, opts: RetryOptions = {}): T {
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? pause;
  const start = now();
  let deadline = start + (opts.timeoutMs ?? WRITE_BUSY_TIMEOUT_MS);
  if (sharedDeadline !== undefined) deadline = Math.min(deadline, sharedDeadline);
  let delay = opts.delayMs ?? FILE_BUSY_RETRY_DELAY_MS;
  let tries = 0;
  let missingRetried = false;
  let writable: boolean | undefined;
  for (;;) {
    try {
      return op();
    } catch (err) {
      tries++;
      const code = codeOf(err);
      if (platform === "win32" && code === "ENOENT" && opts.retryMissing && !missingRetried) {
        missingRetried = true;
        sleep(MISSING_RETRY_DELAY_MS);
        continue;
      }
      if (!isWindowsFileBusy(err, platform) || now() > deadline) throw err;
      if (code !== "EBUSY") {
        writable ??= opts.isWritable ? opts.isWritable() : looksWritable(opts.target);
        if (!writable && (tries >= DENIAL_MAX_TRIES || now() - start >= DENIAL_WINDOW_MS)) {
          throw err;
        }
      }
      sleep(delay);
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

export function renameRetrying(from: string, to: string): void {
  retryWhileBusy(() => renameSync(from, to), { target: to });
}

/** truncateSync for a file another process may have open (a history log being rolled back). */
export function truncateRetrying(path: string, size: number): void {
  retryWhileBusy(() => truncateSync(path, size), { target: path });
}

export function linkRetrying(from: string, to: string): void {
  retryWhileBusy(() => linkSync(from, to), { target: to });
}

/** readFileSync for a file another process may be replacing. */
export function readFileRetrying(
  path: string,
  encoding: "utf8",
  opts?: { listed?: boolean },
): string;
export function readFileRetrying(
  path: string,
  encoding?: undefined,
  opts?: { listed?: boolean },
): Buffer;
export function readFileRetrying(
  path: string,
  encoding?: "utf8",
  opts: { listed?: boolean } = {},
): string | Buffer {
  return retryWhileBusy(() => (encoding ? readFileSync(path, encoding) : readFileSync(path)), {
    timeoutMs: READ_BUSY_TIMEOUT_MS,
    target: path,
    retryMissing: opts.listed,
  });
}

/** readFileSync(path, "utf8") for a file atomicWrite may replace. `listed`: a listing returned it. */
export function readUtf8Retrying(path: string, opts: { listed?: boolean } = {}): string {
  return readFileRetrying(path, "utf8", opts);
}
