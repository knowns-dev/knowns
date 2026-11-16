// Bounded retry of transient Windows busy-file errors for storage reads and renames.
// On Windows a rename over a file another process has open fails (EPERM, EBUSY, EACCES) until the
// handle closes, and a reader can hit the replace in flight. Every other platform and every other
// error code passes through untouched, so a real permission error still surfaces.

import { readFileSync, renameSync } from "node:fs";

/** How long a rename or read waits out another handle on Windows, and the delay between tries. */
export const FILE_BUSY_TIMEOUT_MS = 2000;
export const FILE_BUSY_RETRY_DELAY_MS = 5;

/** ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION, only on Windows. */
export function isWindowsFileBusy(err: unknown, platform: string = process.platform): boolean {
  if (platform !== "win32") return false;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RetryOptions {
  platform?: string;
  timeoutMs?: number;
  delayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => void;
}

/** Run op, retrying a transient Windows busy-file error until the timeout passes. */
export function retryWhileBusy<T>(op: () => T, opts: RetryOptions = {}): T {
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? pause;
  const deadline = now() + (opts.timeoutMs ?? FILE_BUSY_TIMEOUT_MS);
  for (;;) {
    try {
      return op();
    } catch (err) {
      if (!isWindowsFileBusy(err, platform) || now() > deadline) throw err;
      sleep(opts.delayMs ?? FILE_BUSY_RETRY_DELAY_MS);
    }
  }
}

export function renameRetrying(from: string, to: string): void {
  retryWhileBusy(() => renameSync(from, to));
}

/** readFileSync(path, "utf8") for a file that atomicWrite may replace. */
export function readUtf8Retrying(path: string): string {
  return retryWhileBusy(() => readFileSync(path, "utf8"));
}
