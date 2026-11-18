// Safe cancel of a running daemon job (spec activity-tray, AC-2/AC-4 of KN-7H0YXB).
//
// A cancel request is a file under runtime/cancel/<jobId>. The queue file is not touched, so a
// 0.34.x daemon reading it sees nothing new. The runner checks the request at the safe points of
// the kinds that have them (between sources in a reindex) and stops with JobCancelledError.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobKind } from "./queue.ts";
import { runtimeRoot } from "./queue.ts";

/** Thrown by a job that stopped at a safe point because a cancel was requested. */
export class JobCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "JobCancelledError";
  }
}

/** Kinds that have a safe point to stop at. Others run to the end (entity writes are atomic and short). */
const CANCELLABLE_KINDS: ReadonlySet<string> = new Set<JobKind>(["reindex-search"]);

export const isCancellableKind = (kind: string): boolean => CANCELLABLE_KINDS.has(kind);

const cancelDir = (): string => join(runtimeRoot(), "cancel");

export function requestJobCancel(jobId: string): void {
  mkdirSync(cancelDir(), { recursive: true, mode: 0o755 });
  writeFileSync(join(cancelDir(), jobId), "");
}

export const cancelRequested = (jobId: string): boolean => existsSync(join(cancelDir(), jobId));

export function clearJobCancel(jobId: string): void {
  rmSync(join(cancelDir(), jobId), { force: true });
}

/** Drops requests whose job is gone (a finished job, a crashed runner). */
export function sweepCancelRequests(liveJobIds: ReadonlySet<string>): void {
  let names: string[];
  try {
    names = readdirSync(cancelDir());
  } catch {
    return;
  }
  for (const n of names) if (!liveJobIds.has(n)) clearJobCancel(n);
}
