// The named locks of internal/storage/*_lock*.go, at the same paths the Go binary uses, so a TS
// process and a Go process serialize against each other on the same project.
//
//   <root>/.search/locks/tasks.lock                      task lifecycle transactions
//   <root>/.search/locks/decisions.lock                  decision lifecycle transitions
//   <root>/.search/locks/decision-memory-migration.lock  decision/memory migration
//   <root>/.search/locks/qdrant-watermarks.lock          qdrant watermark read-modify-write
//   <globalRoot>/.search/locks/memories/<id>.lock        one memory mutation (global root!)
//   <root>/history/locks/<type>-<id>.lock                history stream append / doc mutation
//   <root>/history/state/lifecycle-intents.lock          lifecycle reconciler intents
//
// `.search` is an ignored runtime directory in every git tracking mode, so lock files never leak
// into tracked knowledge. Files are 0600 and never deleted.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type LockOptions, withFileLock } from "./file-lock.ts";
import { globalRootPath } from "./global-root.ts";

export type { LockOptions } from "./file-lock.ts";
export { acquireFileLock, LockError, tryAcquireFileLock, withFileLock } from "./file-lock.ts";

/** `<root>/.search/locks`. */
export function searchLocksDir(root: string): string {
  return join(root, ".search", "locks");
}

export const taskLifecycleLockPath = (root: string) => join(searchLocksDir(root), "tasks.lock");
export const decisionLifecycleLockPath = (root: string) =>
  join(searchLocksDir(root), "decisions.lock");
export const decisionMemoryMigrationLockPath = (root: string) =>
  join(searchLocksDir(root), "decision-memory-migration.lock");
export const qdrantWatermarkLockPath = (root: string) =>
  join(searchLocksDir(root), "qdrant-watermarks.lock");

/**
 * safeHistoryID: ids made only of [A-Za-z0-9_.-] are used as file names verbatim; anything else
 * becomes the hex SHA-256 of the id, and an empty id becomes "empty".
 */
export function safeHistoryId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "") return "empty";
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) return trimmed;
  return createHash("sha256").update(trimmed, "utf8").digest("hex");
}

/** memoryMutationLock path: lives under the GLOBAL root so global memories serialize across projects. */
export function memoryMutationLockPath(lockRoot: string, id: string): string {
  return join(searchLocksDir(lockRoot), "memories", `${safeHistoryId(id)}.lock`);
}

/** Entity types that have a history stream. */
export type HistoryLockEntity = "task" | "doc";

export function historyEntityLockPath(
  storeRoot: string,
  entityType: HistoryLockEntity,
  entityId: string,
): string {
  return join(storeRoot, "history", "locks", `${entityType}-${safeHistoryId(entityId)}.lock`);
}

export const lifecycleIntentsLockPath = (storeRoot: string) =>
  join(storeRoot, "history", "state", "lifecycle-intents.lock");

export function withTaskLifecycleLock<T>(
  root: string,
  fn: () => T | Promise<T>,
  opts?: LockOptions,
) {
  return withFileLock(taskLifecycleLockPath(root), fn, opts);
}

export function withDecisionLifecycleLock<T>(
  root: string,
  fn: () => T | Promise<T>,
  opts?: LockOptions,
) {
  return withFileLock(decisionLifecycleLockPath(root), fn, opts);
}

export function withDecisionMemoryMigrationLock<T>(
  root: string,
  fn: () => T | Promise<T>,
  opts?: LockOptions,
) {
  return withFileLock(decisionMemoryMigrationLockPath(root), fn, opts);
}

export function withQdrantWatermarkLock<T>(
  root: string,
  fn: () => T | Promise<T>,
  opts?: LockOptions,
) {
  return withFileLock(qdrantWatermarkLockPath(root), fn, opts);
}

/** One memory's mutation lock. `lockRoot` defaults to the machine-level root (~/.knowns). */
export function withMemoryMutationLock<T>(
  id: string,
  fn: () => T | Promise<T>,
  opts?: LockOptions & { lockRoot?: string },
) {
  return withFileLock(memoryMutationLockPath(opts?.lockRoot ?? globalRootPath(), id), fn, opts);
}

/** Several memory locks, taken in sorted id order and de-duplicated (no lock-order inversions). */
export async function withMemoryMutationLocks<T>(
  ids: readonly string[],
  fn: () => T | Promise<T>,
  opts?: LockOptions & { lockRoot?: string },
): Promise<T> {
  const ordered = [...new Set(ids.filter((id) => id !== ""))].sort();
  const acquire = (i: number): Promise<T> =>
    i === ordered.length
      ? Promise.resolve().then(fn)
      : withMemoryMutationLock(ordered[i] as string, () => acquire(i + 1), opts);
  return acquire(0);
}

/** One history stream's lock (task or doc). */
export function withHistoryEntityLock<T>(
  storeRoot: string,
  entityType: HistoryLockEntity,
  entityId: string,
  fn: () => T | Promise<T>,
  opts?: LockOptions,
) {
  return withFileLock(historyEntityLockPath(storeRoot, entityType, entityId), fn, opts);
}

/** normalizeDocPath (version_store.go): trim, drop a leading "/" and ".md", trim "/". */
export function normalizeDocPath(path: string): string {
  return path
    .trim()
    .replace(/^\//, "")
    .replace(/\.md$/, "")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * withDocMutationLocks: the per-doc mutation locks (history stream id `mutation:<path>`), taken in
 * sorted order, de-duplicated.
 */
export async function withDocMutationLocks<T>(
  storeRoot: string,
  paths: readonly string[],
  fn: () => T | Promise<T>,
  opts?: LockOptions,
): Promise<T> {
  const ordered = [...new Set(paths.map(normalizeDocPath).filter((p) => p !== ""))].sort();
  const acquire = (i: number): Promise<T> =>
    i === ordered.length
      ? Promise.resolve().then(fn)
      : withHistoryEntityLock(
          storeRoot,
          "doc",
          `mutation:${ordered[i]}`,
          () => acquire(i + 1),
          opts,
        );
  return acquire(0);
}

/**
 * WithSyncLocks: hold every lock a local mutation of the entities behind `relPaths` holds, in the
 * order existing writers use: doc mutation locks (sorted), then the task lifecycle lock, then the
 * decision lifecycle lock. Paths outside tasks, archive, docs and decisions need no entity lock.
 */
export async function withSyncLocks<T>(
  root: string,
  relPaths: readonly string[],
  fn: () => T | Promise<T>,
  opts?: LockOptions,
): Promise<T> {
  const docs: string[] = [];
  let needTasks = false;
  let needDecisions = false;
  for (const raw of relPaths) {
    const rel = raw.trim().replaceAll("\\", "/");
    if (rel.startsWith("docs/")) docs.push(rel.slice("docs/".length));
    else if (rel.startsWith("tasks/") || rel.startsWith("archive/")) needTasks = true;
    else if (rel.startsWith("decisions/")) needDecisions = true;
  }
  const withDecisions = () =>
    needDecisions ? withDecisionLifecycleLock(root, fn, opts) : Promise.resolve().then(fn);
  const withTasks = () =>
    needTasks ? withTaskLifecycleLock(root, withDecisions, opts) : withDecisions();
  return docs.length === 0 ? withTasks() : withDocMutationLocks(root, docs, withTasks, opts);
}
