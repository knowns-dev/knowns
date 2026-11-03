// Port of internal/storage/task_lifecycle_transaction.go and task_lifecycle_purge.go: the storage
// primitives that are safe to compose while the task lifecycle lock is held, and the Task
// hard-delete coordinator.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Task, TaskTombstone } from "../../models/task.ts";
import type { TaskLifecyclePending } from "../../models/task-lifecycle.ts";
import type { TimeEntry, TimeState } from "../../models/time.ts";
import type { TaskChange, TaskVersion } from "../../models/version.ts";
import { goTrimSpace, writeJson } from "../core/util.ts";
import { MutationConflictError } from "./conflicts.ts";
import { canonicalTaskHash, taskToSnapshot, trackTaskChanges } from "./entities.ts";
import { goTime, timeMs } from "./go-json.ts";
import type { HistoryContext } from "./ports.ts";
import { wrapError } from "./records.ts";
import { explainConflict, type SyncConflictResolver } from "./sync-provenance.ts";

const PENDING_OPERATIONS = ["archive", "reopen", "hard_delete"];

/** TaskLifecycleTransaction: storage primitives valid only inside the lifecycle lock. */
export class TaskLifecycleTransaction {
  constructor(private readonly ctx: HistoryContext) {}

  async getTask(id: string): Promise<Task> {
    return this.ctx.tasks.get(id);
  }

  /** The exact path selected while the lifecycle lock is held; content-free purge proof. */
  async canonicalTaskPath(id: string): Promise<string> {
    return this.ctx.tasks.canonicalPath(id);
  }

  /** CheckTaskExpectedHash: compare a caller-supplied base with the fresh canonical Task. */
  checkTaskExpectedHash(task: Task | null | undefined, expected: string): void {
    if (!task) return;
    if (goTrimSpace(expected) === "") {
      throw new Error(`task "${task.id}" expected canonical hash is required`);
    }
    const current = canonicalTaskHash(task);
    if (expected !== current) throw new MutationConflictError("task", task.id, expected, current);
  }

  async listActiveTasks(): Promise<Task[]> {
    return this.ctx.tasks.listActive();
  }

  async listArchivedTasks(): Promise<Task[]> {
    return this.ctx.tasks.listArchived();
  }

  async hasActiveTimer(id: string): Promise<boolean> {
    const time = this.requireTime();
    return (await time.getActiveTimer(id)) !== undefined;
  }

  async getTimeState(): Promise<TimeState> {
    return this.requireTime().getState();
  }

  async saveTimeState(state: TimeState): Promise<void> {
    await this.requireTime().saveStateUnlocked(state);
  }

  async getAllTimeEntries(): Promise<Record<string, TimeEntry[]>> {
    return this.requireTime().getAllEntries();
  }

  async saveAllTimeEntries(entries: Record<string, TimeEntry[]>): Promise<void> {
    await this.requireTime().saveAllEntriesUnlocked(entries);
  }

  /** PatchTaskLifecycle: only status/timing frontmatter, so unknown content survives. */
  async patchTaskLifecycle(task: Task): Promise<void> {
    await this.ctx.tasks.patchLifecycleUnlocked(task);
  }

  /** UpdateTask: write a complete Task; callers must first read it through this transaction. */
  async updateTask(task: Task): Promise<void> {
    await this.ctx.tasks.updateUnlocked(task);
  }

  trackTaskChanges(before: Task | null, after: Task): TaskChange[] {
    return trackTaskChanges(before, after);
  }

  async createTask(task: Task): Promise<void> {
    await this.ctx.tasks.createUnlocked(task);
  }

  async archiveTask(id: string): Promise<void> {
    await this.ctx.tasks.archiveUnlocked(id);
  }

  async unarchiveTask(id: string): Promise<void> {
    await this.ctx.tasks.unarchiveUnlocked(id);
  }

  async deleteTask(id: string): Promise<void> {
    await this.ctx.tasks.deleteAllUnlocked(id);
  }

  async saveTombstone(tombstone: TaskTombstone): Promise<void> {
    await this.ctx.tasks.saveTombstoneUnlocked(tombstone);
  }

  async getTombstone(id: string): Promise<TaskTombstone> {
    return this.ctx.tasks.getTombstone(id);
  }

  async isIdReserved(id: string): Promise<boolean> {
    return this.ctx.tasks.isIdReserved(id);
  }

  // --- pending lifecycle checkpoints -------------------------------------------------------------

  private pendingDir(): string {
    return join(this.ctx.root, ".search", "task-lifecycle", "pending");
  }

  private pendingPath(taskId: string, operation: string, eventId: string): string {
    if (taskId === "" || taskId === "." || taskId === ".." || /[/\\\0]/.test(taskId)) {
      throw new Error(`invalid task ID "${taskId}"`);
    }
    if (!PENDING_OPERATIONS.includes(operation)) {
      throw new Error(`invalid Task lifecycle operation "${operation}"`);
    }
    if (goTrimSpace(eventId) === "") throw new Error("pending Task lifecycle event ID is required");
    const digest = createHash("sha256").update(eventId, "utf8").digest("hex");
    return join(this.pendingDir(), `${digest}.json`);
  }

  /** ListTaskLifecyclePending: sorted by time, then task, operation and event. */
  listTaskLifecyclePending(operation = ""): TaskLifecyclePending[] {
    const dir = this.pendingDir();
    if (!existsSync(dir)) return [];
    const result: TaskLifecyclePending[] = [];
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      let pending: TaskLifecyclePending;
      try {
        pending = JSON.parse(readFileSync(join(dir, name), "utf8")) as TaskLifecyclePending;
      } catch (e) {
        throw new Error(`parse pending Task lifecycle "${name}": ${(e as Error).message}`, {
          cause: e,
        });
      }
      if (operation === "" || pending.operation === operation) result.push(pending);
    }
    result.sort((a, b) => {
      const ta = timeMs(a.at);
      const tb = timeMs(b.at);
      if (ta !== tb) return ta - tb;
      if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
      if (a.operation !== b.operation) return a.operation < b.operation ? -1 : 1;
      return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    });
    return result;
  }

  getTaskLifecyclePending(taskId: string, operation: string): TaskLifecyclePending | undefined {
    let latest: TaskLifecyclePending | undefined;
    for (const pending of this.listTaskLifecyclePending(operation)) {
      if (pending.taskId !== taskId) continue;
      if (!pending.canonicalComplete) return pending;
      latest = pending;
    }
    return latest;
  }

  getIncompleteTaskLifecyclePending(
    taskId: string,
    operation: string,
  ): TaskLifecyclePending | undefined {
    for (const pending of this.listTaskLifecyclePending(operation)) {
      let canonicalComplete = pending.canonicalComplete;
      if (operation === "archive" || operation === "reopen") {
        canonicalComplete =
          canonicalComplete &&
          !!pending.moveComplete &&
          !!pending.patchComplete &&
          !!pending.versionComplete;
      }
      if (pending.taskId === taskId && !canonicalComplete) return pending;
    }
    return undefined;
  }

  getTaskLifecyclePendingEvent(
    taskId: string,
    operation: string,
    eventId: string,
  ): TaskLifecyclePending | undefined {
    const path = this.pendingPath(taskId, operation, eventId);
    let data: string;
    try {
      data = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(
        `read pending Task lifecycle "${taskId}"/"${operation}"/"${eventId}": ${(e as Error).message}`,
        { cause: e },
      );
    }
    let pending: TaskLifecyclePending;
    try {
      pending = JSON.parse(data) as TaskLifecyclePending;
    } catch (e) {
      throw new Error(
        `parse pending Task lifecycle "${taskId}"/"${operation}"/"${eventId}": ${(e as Error).message}`,
        { cause: e },
      );
    }
    if (
      pending.taskId !== taskId ||
      pending.operation !== operation ||
      pending.eventId !== eventId
    ) {
      throw new Error(
        `pending Task lifecycle identity mismatch for "${taskId}"/"${operation}"/"${eventId}"`,
      );
    }
    return pending;
  }

  saveTaskLifecyclePending(pending: TaskLifecyclePending | null): void {
    if (!pending?.eventId || !pending.at || goTime(pending.at) === "0001-01-01T00:00:00Z") {
      throw new Error("pending Task lifecycle requires eventId and timestamp");
    }
    writeJson(this.pendingPath(pending.taskId, pending.operation, pending.eventId), pending);
  }

  deleteTaskLifecyclePending(taskId: string, operation: string, eventId: string): void {
    const path = this.pendingPath(taskId, operation, eventId);
    try {
      rmSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw wrapError(`delete pending Task lifecycle "${taskId}"/"${operation}"`, e);
    }
  }

  // --- versions ----------------------------------------------------------------------------------

  /** SaveTaskVersion: a lifecycle version, skipped when nothing changed. */
  async saveTaskVersion(
    oldTask: Task | null,
    newTask: Task | null,
    actor: string,
    timestamp: string,
    lifecycleEventId: string,
  ): Promise<void> {
    if (!newTask) throw new Error("save lifecycle version: task is required");
    const changes = trackTaskChanges(oldTask, newTask);
    if (changes.length === 0) return;
    const version: Partial<TaskVersion> = {
      timestamp,
      author: actor,
      lifecycleEventId,
      changes,
      snapshot: taskToSnapshot(newTask),
    };
    await this.ctx.versions.saveVersionUnlocked(newTask.id, version);
  }

  async hasTaskLifecycleVersion(taskId: string, eventId: string): Promise<boolean> {
    if (eventId === "") return false;
    const history = await this.ctx.versions.getHistory(taskId);
    return (history.versions ?? []).some((v) => v.lifecycleEventId === eventId);
  }

  /** RollbackTaskLifecycleVersion: drop the tail version when it is this event's. */
  async rollbackTaskLifecycleVersion(taskId: string, eventId: string): Promise<void> {
    if (eventId === "") return;
    const history = await this.ctx.versions.getHistory(taskId);
    const versions = history.versions ?? [];
    const last = versions[versions.length - 1];
    if (!last || last.lifecycleEventId !== eventId) return;
    if (this.ctx.versions.hasJsonlHistory("task", taskId)) {
      await this.ctx.versions.historyStore().removeLast("task", taskId);
      return;
    }
    history.versions = versions.slice(0, -1);
    history.currentVersion--;
    if (history.versions.length === 0) {
      rmSync(this.ctx.versions.versionPath(taskId), { force: true });
      return;
    }
    const { encodeTaskVersionHistory } = await import("./legacy.ts");
    writeJson(this.ctx.versions.versionPath(taskId), encodeTaskVersionHistory(history));
  }

  async deleteTaskVersionHistory(id: string): Promise<void> {
    await this.purgeTaskVersionHistory(id, "legacy", "lifecycle purge", "");
  }

  /**
   * PurgeTaskVersionHistory is the storage-side hard-delete contract, used only after the trusted
   * lifecycle adapter has validated confirmation, reason and OCC. It leaves a content-free
   * reservation marker before deleting JSONL or a verified legacy successor.
   */
  async purgeTaskVersionHistory(
    id: string,
    actor: string,
    reason: string,
    expectedHash: string,
  ): Promise<void> {
    const legacyPath = this.ctx.versions.versionPath(id);
    const history = this.ctx.versions.historyStore();
    if (!this.ctx.versions.hasJsonlHistory("task", id)) {
      try {
        await history.purgeLegacyOnly("task", id, actor, reason, legacyPath);
      } catch (e) {
        throw wrapError(`delete task version history "${id}"`, e);
      }
      return;
    }
    await history.purgeAuthorized("task", id, actor, reason, expectedHash);
  }

  /** DeleteTaskTimeData: remove active and completed time data; idempotent for resumed deletes. */
  async deleteTaskTimeData(id: string): Promise<void> {
    const time = this.requireTime();
    const state = await time.getState();
    state.active = (state.active ?? []).filter((timer) => timer.taskId !== id);
    try {
      await time.saveStateUnlocked(state);
    } catch (e) {
      throw wrapError(`delete task timer "${id}"`, e);
    }
    const entries = await time.getAllEntries();
    if (Object.hasOwn(entries, id)) {
      delete entries[id];
      try {
        await time.writeEntriesFile(entries);
      } catch (e) {
        throw wrapError(`delete task time entries "${id}"`, e);
      }
    }
  }

  private requireTime() {
    if (!this.ctx.time) throw new Error("task lifecycle transaction: time store is unavailable");
    return this.ctx.time;
  }
}

/**
 * WithTaskLifecycleTransaction: run `fn` under the task lifecycle lock. A stale-hash conflict
 * whose current state arrived through store sync is explained (FR-12, FR-13).
 */
export async function withTaskLifecycleTransaction<T>(
  ctx: HistoryContext,
  fn: (tx: TaskLifecycleTransaction) => Promise<T> | T,
): Promise<T> {
  if (typeof fn !== "function") throw new Error("task lifecycle transaction: callback is required");
  try {
    return await ctx.withTaskLifecycleLock(async () => fn(new TaskLifecycleTransaction(ctx)));
  } catch (err) {
    throw await explainConflict(conflictResolverOf(ctx), err);
  }
}

/** The conflict-path lookups explainConflict needs, derived from a context. */
export function conflictResolverOf(ctx: HistoryContext): SyncConflictResolver {
  return {
    root: ctx.root,
    taskCanonicalPath: async (id) => {
      try {
        return await ctx.tasks.canonicalPath(id);
      } catch {
        return undefined;
      }
    },
    listDocs: async () => {
      try {
        return await ctx.docs.list();
      } catch {
        return undefined;
      }
    },
  };
}

// --- purge -------------------------------------------------------------------------------------

/** The phased reconciler purge (task TSR-MBTAN6), injected so this module stays free of it. */
export interface TaskPurgeReconciler {
  /** ReconcileLifecycleBatch for the exact task, bootstrapping its history before the purge. */
  bootstrapTask(args: {
    root: string;
    relPath: string;
    absPath: string;
    taskId: string;
  }): Promise<{ diagnostic?: string }[]>;
  /** HardDelete with Trusted/Confirmed set; `remove` is the caller's authorized handoff. */
  hardDelete(args: {
    root: string;
    taskId: string;
    relPath: string;
    reason: string;
    actor: string;
    expectedHash: string;
    remove?: (entityId: string) => Promise<void> | void;
  }): Promise<void>;
}

/**
 * PurgeTaskLifecycle is the storage-internal Task hard-delete coordinator. It validates the
 * canonical path, exact-bootstraps the target into the filesystem history, then invokes the
 * phased purge with the caller's already-authorized remove handoff.
 */
export async function purgeTaskLifecycle(
  reconciler: TaskPurgeReconciler,
  root: string,
  taskId: string,
  canonicalPath: string,
  expectedHash: string,
  actor: string,
  reason: string,
  remove?: (taskId: string) => Promise<void> | void,
): Promise<void> {
  if (goTrimSpace(taskId) === "" || goTrimSpace(canonicalPath) === "") {
    throw new Error("task lifecycle purge requires task identity and canonical path");
  }
  const absRoot = resolve(root);
  let absPath = canonicalPath;
  if (!isAbsolute(absPath)) absPath = join(absRoot, canonicalPath);
  absPath = resolve(absPath);
  const underRoot = (r: string, p: string) => {
    const rel = relative(r, p);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!underRoot(absRoot, absPath) || extname(absPath) !== ".md") {
    throw new Error("task lifecycle purge canonical path is outside project root");
  }
  const rel = relative(absRoot, absPath).split(sep).join("/");
  if (!rel.startsWith("tasks/") && !rel.startsWith("archive/")) {
    throw new Error("task lifecycle purge canonical path is outside Task roots");
  }
  // A missing canonical is a valid retry state after reservation/canonical removal.
  if (existsSync(absPath)) {
    const results = await reconciler.bootstrapTask({
      root: absRoot,
      relPath: rel,
      absPath,
      taskId,
    });
    for (const result of results) {
      if (result.diagnostic) throw new Error(result.diagnostic);
    }
  }
  await reconciler.hardDelete({
    root: absRoot,
    taskId,
    relPath: rel,
    reason,
    actor,
    expectedHash,
    remove: remove ? (id) => remove(id) : undefined,
  });
}
