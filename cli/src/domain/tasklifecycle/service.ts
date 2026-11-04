// Port of internal/tasklifecycle/service.go: the Task lifecycle service. Every public mutation runs
// under the task lifecycle lock through `withTaskLifecycleTransaction`, with optimistic-concurrency
// hashes, durable pending-lifecycle checkpoints, and index/event delivery after the lock is released.
//
// Go methods return (value, err) with a meaningful partial value. Here a failing method throws and
// the partial value rides on the error (`partialOf`); `executePublic` returns `{ response, error }`
// because adapters always need the response.
import { isAbsolute, normalize, relative, sep } from "node:path";
import { effectiveTaskLifecycle, type TaskLifecycleSettings } from "../../models/config.ts";
import { type Task, type TaskTombstone, taskLifecycleState } from "../../models/task.ts";
import type { TaskLifecyclePending } from "../../models/task-lifecycle.ts";
import type { TimeEntry } from "../../models/time.ts";
import {
  canonicalTaskHash,
  purgeTaskLifecycle,
  type TaskLifecycleTransaction,
  type TaskPurgeReconciler,
  withTaskLifecycleTransaction,
} from "../../storage/history/index.ts";
import { extract as extractDefault } from "../references/index.ts";
import { type Clock, epochMs, systemClock, wireTime } from "./clock.ts";
import { type ContractError, contractError, validatePublicRequest } from "./contract.ts";
import type { LifecycleCore, LifecycleStorage } from "./core.ts";
import { isNotFound, joinErrors, toError, withPartial, wrap } from "./errors.ts";
import {
  eventFromPending,
  lifecycleDataMatches,
  lifecycleEventId,
  orderedPending,
  pendingForTransition,
  pendingFromEvent,
  taskWithLifecycleData,
  withEventKeyOrder,
} from "./pending.ts";
import {
  applyStatusTransition,
  cloneTask,
  durableKnowledgeWarnings,
  evaluateInTransaction,
  type ReferenceExtractor,
} from "./policy.ts";
import { addTimeEntry, stopTimers } from "./time.ts";
import type {
  ArchiveOptions,
  BatchOptions,
  BatchResult,
  Eligibility,
  HardDeleteOptions,
  Hooks,
  LifecycleEvent,
  Operation,
  PublicCapabilities,
  Reason,
  ReopenOptions,
  ReorderItem,
  Request,
  Response,
  Result,
  StopTimerOptions,
  StopTimersOptions,
  TaskUpdateOptions,
  TimeMutationOptions,
  Warning,
} from "./types.ts";

const CLAIM_LEASE_MS = 5 * 60 * 1000;

export interface ServiceOptions {
  clock?: Clock;
  hooks?: Hooks;
  /** Required for hard-delete: the phased purge reconciler (storage `TaskPurgeReconciler`). */
  purgeReconciler?: TaskPurgeReconciler;
  /** Replaces the built-in reference extractor used for durable-knowledge warnings. */
  extractReferences?: ReferenceExtractor;
}

/** The outcome of a public request: the response always exists; `error` is the classified failure. */
export interface PublicOutcome {
  response: Response;
  error?: ContractError;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function uniqueSorted(ids: string[]): string[] {
  const sorted = [...ids].sort(byCodeUnit);
  return sorted.filter((id, i) => i === 0 || sorted[i - 1] !== id);
}

function emptyResult(): Result {
  return {
    taskId: "",
    operation: "" as Operation,
    changed: false,
    eligible: false,
    before: "",
    after: "",
    reasons: [],
  };
}

function resultFromEligibility(operation: Operation, e: Eligibility): Result {
  const result: Result = {
    taskId: e.taskId,
    operation,
    changed: false,
    eligible: e.eligible,
    before: e.lifecycle,
    after: e.lifecycle,
    reasons: e.reasons.length > 0 ? [...e.reasons] : null,
  };
  if (e.warnings) result.warnings = [...e.warnings];
  if (e.completedAt !== undefined) result.completedAt = e.completedAt;
  if (e.archivedAt !== undefined) result.archivedAt = e.archivedAt;
  if (e.deadline !== undefined) result.deadline = e.deadline;
  return result;
}

function addReason(result: Result, reason: Reason): void {
  result.reasons = [...(result.reasons ?? []), reason];
}

function publicFailureReason(err: unknown): Reason {
  const e = toError(err);
  return { code: isNotFound(e) ? "not_found" : "operation_failed", message: e.message };
}

const blank = (s: string | undefined): boolean => (s ?? "").trim() === "";

type Out<T> = [T, Error | undefined];

/** Runs `fn` and converts a throw into the error half of the Go-style (value, err) pair. */
async function attempt<T>(fn: () => Promise<T> | T): Promise<[T | undefined, Error | undefined]> {
  try {
    return [await fn(), undefined];
  } catch (e) {
    return [undefined, toError(e)];
  }
}

interface Flushed {
  warnings: Warning[];
  hadPending: boolean;
  error?: Error;
}

function appendWarnings(result: Result, warnings: Warning[]): void {
  if (warnings.length === 0) return;
  result.warnings = [...(result.warnings ?? []), ...warnings];
}

export class Service implements LifecycleCore {
  readonly clock: Clock;
  private readonly hooks: Hooks;
  private readonly purgeReconciler: TaskPurgeReconciler | undefined;
  private readonly extract: ReferenceExtractor;

  constructor(
    readonly storage: LifecycleStorage,
    options: ServiceOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.hooks = options.hooks ?? {};
    this.purgeReconciler = options.purgeReconciler;
    this.extract = options.extractReferences ?? extractDefault;
  }

  // --- LifecycleCore ---------------------------------------------------------------------------

  withTransaction<T>(fn: (tx: TaskLifecycleTransaction) => Promise<T> | T): Promise<T> {
    return withTaskLifecycleTransaction(this.storage.ctx, fn);
  }

  taskFor(taskId: string): Task {
    return this.storage.tasks.get(taskId);
  }

  /**
   * The compatibility base for public mutations whose callers give no expected hash. The read
   * happens before the owning transaction, which rechecks it under the lock, so a concurrent write
   * becomes a conflict rather than an overwrite.
   */
  observedTaskHash(taskId: string): string {
    return canonicalTaskHash(this.storage.tasks.get(taskId));
  }

  async indexTask(taskId: string): Promise<void> {
    if (!this.hooks.indexTask) return;
    try {
      await this.hooks.indexTask(taskId);
    } catch (e) {
      throw wrap(`index Task "${taskId}" lifecycle state`, e);
    }
  }

  private async removeFromIndex(taskId: string): Promise<void> {
    if (!this.hooks.removeTask) return;
    try {
      await this.hooks.removeTask(taskId);
    } catch (e) {
      throw wrap(`remove Task "${taskId}" from index`, e);
    }
  }

  private settings(): TaskLifecycleSettings {
    return effectiveTaskLifecycle(this.storage.config.load().settings as never);
  }

  // --- evaluate and archive --------------------------------------------------------------------

  /** Archive eligibility without mutating anything. */
  async evaluate(taskId: string, options: ArchiveOptions = {}): Promise<Eligibility> {
    const settings = this.settings();
    const now = this.clock();
    return this.withTransaction(async (tx) => {
      const task = await tx.getTask(taskId);
      return evaluateInTransaction(tx, task, now, settings, options, this.extract);
    });
  }

  async archive(taskId: string, options: ArchiveOptions = {}): Promise<Result> {
    const [result, err] = await this.archiveOut(taskId, options);
    if (err) throw withPartial(err, result);
    return result;
  }

  private async archiveOut(taskId: string, options: ArchiveOptions): Promise<Out<Result>> {
    const opts = { ...options };
    let result: Result = {
      taskId,
      operation: "archive",
      changed: false,
      eligible: false,
      before: "",
      after: "",
      reasons: [],
    };
    let preWarnings: Warning[] = [];
    let prePending = false;
    if (blank(opts.expectedHash)) {
      const pre = await this.flushTaskLifecyclePending(taskId);
      preWarnings = pre.warnings;
      prePending = pre.hadPending;
      appendWarnings(result, preWarnings);
      if (pre.error) return [result, pre.error];
    }
    if (blank(opts.expectedHash)) {
      const [hash, err] = await attempt(() => this.observedTaskHash(taskId));
      if (err) return [result, err];
      opts.expectedHash = hash;
    }
    const [settings, settingsErr] = await attempt(() => this.settings());
    if (settingsErr || !settings) return [result, settingsErr];
    const now = this.clock();
    const [, txErr] = await attempt(() =>
      this.withTransaction(async (tx) => {
        const [mutated, mutateErr] = await this.archiveInTransaction(
          tx,
          taskId,
          opts,
          settings,
          now,
        );
        mutated.warnings = [...preWarnings, ...(mutated.warnings ?? [])];
        if (mutated.warnings.length === 0) delete mutated.warnings;
        result = mutated;
        if (mutateErr) throw mutateErr;
      }),
    );
    if (txErr) return [result, txErr];
    const post = await this.flushTaskLifecyclePending(taskId);
    appendWarnings(result, post.warnings);
    if (post.error) return [result, post.error];
    if (result.eligible && !result.changed && !prePending && !post.hadPending) {
      const [, indexErr] = await attempt(() => this.indexTask(taskId));
      if (indexErr) return [result, indexErr];
    }
    this.populateResultLifecycle(result);
    return [result, undefined];
  }

  /** Alias for reopen: restoring an archived Task also makes it active and cancels stale timing. */
  unarchive(taskId: string, options: ReopenOptions = {}): Promise<Result> {
    return this.reopen(taskId, options);
  }

  async reopen(taskId: string, options: ReopenOptions = {}): Promise<Result> {
    const [result, err] = await this.reopenOut(taskId, options);
    if (err) throw withPartial(err, result);
    return result;
  }

  private async reopenOut(taskId: string, options: ReopenOptions): Promise<Out<Result>> {
    const opts = { ...options };
    let status = (opts.status ?? "").trim();
    if (status === "" || status === "done") status = "todo";
    const result: Result = {
      taskId,
      operation: "reopen",
      changed: false,
      eligible: true,
      before: "",
      after: "",
      reasons: [],
    };
    let prePending = false;
    if (blank(opts.expectedHash)) {
      const pre = await this.flushTaskLifecyclePending(taskId);
      prePending = pre.hadPending;
      appendWarnings(result, pre.warnings);
      if (pre.error) return [result, pre.error];
    }
    if (blank(opts.expectedHash)) {
      const [hash, err] = await attempt(() => this.observedTaskHash(taskId));
      if (err) return [result, err];
      opts.expectedHash = hash;
    }
    const now = this.clock();
    const [, txErr] = await attempt(() =>
      this.withTransaction(async (tx) => {
        const task = await tx.getTask(taskId);
        tx.checkTaskExpectedHash(task, opts.expectedHash ?? "");
        let pending = tx.getIncompleteTaskLifecyclePending(taskId, "reopen");
        if (pending) {
          result.before = pending.from;
          result.after = pending.from;
          result.event = eventFromPending(pending);
          if (pending.canonicalComplete) {
            result.after = pending.to;
            return;
          }
          try {
            await resumeLifecycleMutation(tx, pending);
          } catch (e) {
            throw await rollbackLifecycleMutation(tx, pending, e);
          }
          result.changed = true;
          result.after = pending.to;
          return;
        }
        result.before = taskLifecycleState(task);
        result.after = result.before;
        if (!task.archived && task.status !== "done") {
          result.eligible = false;
          addReason(result, { code: "already_active", message: "Task is already active" });
          return;
        }
        const event: LifecycleEvent = withEventKeyOrder({
          id: lifecycleEventId(taskId, "reopen", now),
          type: "reopen",
          taskId,
          at: wireTime(now),
          ...(opts.actor ? { actor: opts.actor } : {}),
          from: result.before,
          to: "active",
        });
        const desired = cloneTask(task);
        desired.archived = false;
        applyStatusTransition(desired, status, now);
        delete desired.completedAt;
        delete desired.archivedAt;
        desired.updatedAt = wireTime(now);
        pending = pendingForTransition(event, task, desired);
        savePending(tx, pending);
        try {
          await resumeLifecycleMutation(tx, pending);
        } catch (e) {
          throw await rollbackLifecycleMutation(tx, pending, e);
        }
        result.changed = true;
        result.after = "active";
        result.event = event;
      }),
    );
    if (txErr) return [result, txErr];
    const post = await this.flushTaskLifecyclePending(taskId);
    appendWarnings(result, post.warnings);
    if (post.error) return [result, post.error];
    if (!result.changed && !prePending && !post.hadPending) {
      const [, indexErr] = await attempt(() => this.indexTask(taskId));
      if (indexErr) return [result, indexErr];
    }
    this.populateResultLifecycle(result);
    return [result, undefined];
  }

  // --- batches ---------------------------------------------------------------------------------

  async batchArchive(options: BatchOptions): Promise<BatchResult> {
    const [batch, err] = await this.batchArchiveOut(options);
    if (err) throw withPartial(err, batch);
    return batch;
  }

  private async batchArchiveOut(options: BatchOptions): Promise<Out<BatchResult>> {
    const execute = options.execute === true;
    const batch: BatchResult = {
      operation: "batch_archive",
      execute,
      completed: false,
      processed: 0,
      changed: 0,
      items: [],
    };
    const failures: Error[] = [];
    const archiveOptions: ArchiveOptions = {
      ...(options.actor !== undefined && { actor: options.actor }),
      ...(options.automatic !== undefined && { automatic: options.automatic }),
      ...(options.minimumAgeMs !== undefined && { minimumAgeMs: options.minimumAgeMs }),
    };
    const [ids, idsErr] = await attempt(() => this.resolveBatchIds(options.ids ?? []));
    if (idsErr || !ids) return [batch, idsErr];
    for (const id of ids) {
      archiveOptions.expectedHash = options.expectedHashes?.[id] ?? "";
      let item: Result | undefined;
      let err: Error | undefined;
      if (execute) {
        [item, err] = await this.archiveOut(id, archiveOptions);
      } else {
        const [eligibility, evalErr] = await attempt(() => this.evaluate(id, archiveOptions));
        err = evalErr;
        item = resultFromEligibility(
          "archive",
          eligibility ?? { taskId: "", eligible: false, lifecycle: "" as never, reasons: [] },
        );
      }
      batch.processed++;
      if (item.taskId === "") item.taskId = id;
      if (item.operation === ("" as Operation)) item.operation = "archive";
      if (err && (item.reasons ?? []).length === 0) addReason(item, publicFailureReason(err));
      batch.items.push(item);
      if (item.changed) batch.changed++;
      if (err) {
        if (batch.failedTaskId === undefined) batch.failedTaskId = id;
        failures.push(wrap(`Task ${id}`, err));
      }
    }
    batch.completed = true;
    return [batch, joinErrors(failures)];
  }

  /** Previews or restores archived/done Tasks. Preview never mutates canonical state. */
  async batchUnarchive(options: BatchOptions): Promise<BatchResult> {
    const [batch, err] = await this.batchUnarchiveOut(options);
    if (err) throw withPartial(err, batch);
    return batch;
  }

  private async batchUnarchiveOut(options: BatchOptions): Promise<Out<BatchResult>> {
    const execute = options.execute === true;
    const batch: BatchResult = {
      operation: "batch_unarchive",
      execute,
      completed: false,
      processed: 0,
      changed: 0,
      items: [],
    };
    const failures: Error[] = [];
    const ids = uniqueSorted(options.ids ?? []);
    for (const id of ids) {
      const [task, getErr] = await attempt(() => this.storage.tasks.get(id));
      let err = getErr;
      let item: Result = {
        taskId: id,
        operation: "reopen",
        changed: false,
        eligible: err === undefined,
        before: "",
        after: "",
        reasons: [],
      };
      if (!err && task) {
        item.before = taskLifecycleState(task);
        item.after = item.before;
        if (task.completedAt !== undefined) item.completedAt = task.completedAt;
        if (task.archivedAt !== undefined) item.archivedAt = task.archivedAt;
        if (!task.archived && task.status !== "done") {
          item.eligible = false;
          addReason(item, { code: "already_active", message: "Task is already active" });
        }
      }
      if (!err && execute) {
        const [result, reopenErr] = await this.reopenOut(id, {
          ...(options.actor !== undefined && { actor: options.actor }),
          expectedHash: options.expectedHashes?.[id] ?? "",
        });
        err = reopenErr;
        item = result;
      }
      if (err && (item.reasons ?? []).length === 0) addReason(item, publicFailureReason(err));
      if (item.taskId === "") item.taskId = id;
      if (item.operation === ("" as Operation)) item.operation = "reopen";
      batch.processed++;
      if (item.changed) batch.changed++;
      batch.items.push(item);
      if (err) {
        if (batch.failedTaskId === undefined) batch.failedTaskId = id;
        failures.push(wrap(`Task ${id}`, err));
      }
    }
    batch.completed = true;
    return [batch, joinErrors(failures)];
  }

  autoArchive(actor: string): Promise<BatchResult> {
    return this.batchArchive({ execute: true, actor, automatic: true });
  }

  private async resolveBatchIds(requested: string[]): Promise<string[]> {
    if (requested.length > 0) return uniqueSorted(requested);
    const ids: string[] = [];
    await this.withTransaction(async (tx) => {
      for (const task of await tx.listActiveTasks()) ids.push(task.id);
      for (const record of tx.listTaskLifecyclePending("archive")) ids.push(record.taskId);
    });
    return uniqueSorted(ids);
  }

  // --- hard delete -----------------------------------------------------------------------------

  async hardDelete(taskId: string, options: HardDeleteOptions = {}): Promise<Result> {
    const [result, err] = await this.hardDeleteOut(taskId, options);
    if (err) throw withPartial(err, result);
    return result;
  }

  private async hardDeleteOut(taskId: string, options: HardDeleteOptions): Promise<Out<Result>> {
    const opts = { ...options };
    const now = this.clock();
    const result: Result = {
      taskId,
      operation: "hard_delete",
      changed: false,
      eligible: false,
      before: "",
      after: "",
      reasons: [],
    };
    if (!opts.confirmed) {
      addReason(result, {
        code: "confirmation_required",
        message: "Hard-delete requires explicit confirmation",
      });
    }
    opts.reason = (opts.reason ?? "").trim();
    if (opts.reason === "") {
      addReason(result, {
        code: "delete_reason_required",
        message: "Hard-delete requires a reason",
      });
    }
    if ((result.reasons ?? []).length > 0) return [result, undefined];
    result.eligible = true;
    let prePending = false;
    if (blank(opts.expectedHash)) {
      const pre = await this.flushTaskLifecyclePending(taskId);
      prePending = pre.hadPending;
      appendWarnings(result, pre.warnings);
      if (pre.error) return [result, pre.error];
    }
    if (blank(opts.expectedHash)) {
      try {
        opts.expectedHash = this.observedTaskHash(taskId);
      } catch (e) {
        if (!isNotFound(e)) return [result, toError(e)];
      }
    }

    let purgePath = "";
    let purgeHash = "";
    let needsPurge = false;
    let centralRemoveDelivered = false;
    let centralAlreadyDelivered = false;
    const root = this.storage.store.root;
    const [, txErr] = await attempt(() =>
      this.withTransaction(async (tx) => {
        const [task, taskErr] = await attempt(() => tx.getTask(taskId));
        const [existingRead, tombstoneErr] = await attempt(() => tx.getTombstone(taskId));
        const [pendingRead, pendingErr] = await attempt(() =>
          tx.getTaskLifecyclePending(taskId, "hard_delete"),
        );
        if (taskErr && !isNotFound(taskErr)) throw taskErr;
        if (tombstoneErr && !isNotFound(tombstoneErr)) throw tombstoneErr;
        if (pendingErr) throw pendingErr;
        let existing: TaskTombstone | undefined = tombstoneErr ? undefined : existingRead;
        let pending: TaskLifecyclePending | undefined = pendingRead;
        const hasTombstone = existing !== undefined;
        if (
          existing &&
          (existing.reason !== opts.reason || (existing.actor ?? "") !== (opts.actor ?? ""))
        ) {
          result.eligible = false;
          addReason(result, {
            code: "tombstone_conflict",
            message: "Task ID is reserved by a tombstone with different audit metadata",
          });
          return;
        }
        if (taskErr && !hasTombstone) throw taskErr;
        if (task && !blank(opts.expectedHash)) {
          tx.checkTaskExpectedHash(task, opts.expectedHash ?? "");
        }
        result.before = task ? taskLifecycleState(task) : "archived";

        if (!existing) {
          existing = {
            id: taskId,
            deletedAt: wireTime(now),
            ...(opts.actor ? { actor: opts.actor } : {}),
            reason: opts.reason ?? "",
          };
          await tx.saveTombstone(existing);
          result.changed = true;
        }
        // A tombstone without either a live Task or a pending record is an already-completed
        // legacy/idempotent delete. Do not infer a canonical path or purge unrelated legacy data.
        if (!task && !pending) {
          addReason(result, { code: "already_deleted", message: "Task is already hard-deleted" });
          result.after = "archived";
          return;
        }
        if (!pending) {
          pending = pendingFromEvent(
            withEventKeyOrder({
              id: lifecycleEventId(taskId, "hard_delete", existing.deletedAt),
              type: "hard_delete",
              taskId,
              at: existing.deletedAt,
              ...(existing.actor ? { actor: existing.actor } : {}),
              ...(existing.reason ? { reason: existing.reason } : {}),
              from: result.before as never,
              to: "archived",
            }),
          );
          savePending(tx, pending);
        }
        if (task) {
          const path = await tx.canonicalTaskPath(taskId);
          const relPath = relative(root, path);
          if (relPath === "." || relPath.startsWith(`..${sep}`)) {
            throw new Error("hard-delete canonical path is outside project root");
          }
          purgePath = relPath.split(sep).join("/");
          if (blank(opts.expectedHash)) opts.expectedHash = canonicalTaskHash(task);
          purgeHash = opts.expectedHash ?? "";
          result.changed = true;
        } else {
          purgePath = pending.canonicalPath ?? "";
          if (isAbsolute(purgePath)) purgePath = relative(root, purgePath).split(sep).join("/");
          purgeHash = pending.canonicalHash ?? "";
        }
        if (purgePath.trim() === "" || purgeHash.trim() === "") {
          throw new Error("hard-delete pending proof is incomplete");
        }
        let pendingPath = pending.canonicalPath ?? "";
        if (isAbsolute(pendingPath)) pendingPath = relative(root, pendingPath).split(sep).join("/");
        if (pendingPath !== "" && normalize(pendingPath) !== normalize(purgePath)) {
          throw new Error("hard-delete pending canonical path changed");
        }
        if (pending.canonicalHash && pending.canonicalHash !== purgeHash) {
          throw new Error("hard-delete pending canonical hash changed");
        }
        pending.canonicalPath = purgePath;
        pending.canonicalHash = purgeHash;
        needsPurge = !pending.canonicalComplete;
        centralAlreadyDelivered = pending.derivedApplied;
        savePending(tx, pending);
        result.after = "archived";
        result.event = eventFromPending(pending);
      }),
    );
    if (txErr) return [result, txErr];
    if (!result.eligible) return [result, undefined];
    if (needsPurge) {
      let centralRemove: ((id: string) => Promise<void>) | undefined;
      if (centralAlreadyDelivered) {
        centralRemoveDelivered = true;
      } else {
        centralRemove = async (id: string) => {
          await this.removeFromIndex(id);
          centralRemoveDelivered = true;
          // Record successful removal before phase 3 so a crash after the external handoff cannot
          // cause a duplicate index removal.
          await this.withTransaction((tx) => {
            const current = tx.getTaskLifecyclePending(taskId, "hard_delete");
            if (!current) {
              throw new Error("hard-delete pending record disappeared after remove handoff");
            }
            current.derivedApplied = true;
            savePending(tx, current);
          });
        };
      }
      const [, purgeErr] = await attempt(() => {
        if (!this.purgeReconciler) {
          throw new Error("hard-delete purge reconciler is not wired in this build");
        }
        return purgeTaskLifecycle(
          this.purgeReconciler,
          root,
          taskId,
          purgePath,
          purgeHash,
          opts.actor ?? "",
          opts.reason ?? "",
          centralRemove,
        );
      });
      if (purgeErr) return [result, purgeErr];
      const [, completeErr] = await attempt(() =>
        this.withTransaction(async (tx) => {
          const pending = tx.getTaskLifecyclePending(taskId, "hard_delete");
          if (!pending) {
            throw new Error("hard-delete pending record disappeared before canonical completion");
          }
          if (pending.canonicalPath !== purgePath || pending.canonicalHash !== purgeHash) {
            throw new Error("hard-delete pending proof changed during purge");
          }
          await tx.deleteTaskTimeData(taskId);
          pending.canonicalComplete = true;
          pending.derivedApplied = centralRemoveDelivered;
          savePending(tx, pending);
        }),
      );
      if (completeErr) return [result, completeErr];
    }
    const post = await this.flushTaskLifecyclePending(taskId);
    appendWarnings(result, post.warnings);
    if (post.error) return [result, post.error];
    if (result.operation !== "hard_delete" && !result.changed && !prePending && !post.hadPending) {
      const [, removeErr] = await attempt(() => this.removeFromIndex(taskId));
      if (removeErr) return [result, removeErr];
    }
    return [result, undefined];
  }

  // --- public request contract -----------------------------------------------------------------

  /**
   * Maps the shared public request contract onto the lifecycle service. `hardDeleteAuthorized` is
   * supplied only by a trusted adapter boundary and is never read from the request.
   */
  executePublic(request: Request, hardDeleteAuthorized: boolean): Promise<PublicOutcome> {
    return this.executePublicWithCapabilities(request, {
      archive: true,
      hardDelete: hardDeleteAuthorized,
    });
  }

  /** For policy-aware trusted adapters such as MCP; capabilities are never read from request data. */
  async executePublicWithCapabilities(
    request: Request,
    capabilities: PublicCapabilities,
  ): Promise<PublicOutcome> {
    const response: Response = {
      operation: request.operation,
      execute: request.execute,
      completed: false,
      processed: 0,
      changed: 0,
      items: [],
    };
    const finish = (cause?: Error): PublicOutcome => {
      const error = contractError(response, cause);
      return error ? { response, error } : { response };
    };
    const reasonItem = (reason: Reason): Result => ({
      ...emptyResult(),
      taskId: request.taskId ?? "",
      operation: request.operation,
      reasons: [reason],
    });
    const invalid = validatePublicRequest(request);
    if (invalid) {
      response.items.push(reasonItem(invalid));
      return finish();
    }
    if (isArchiveOperation(request.operation) && !capabilities.archive) {
      response.items.push(
        reasonItem({
          code: "permission_required",
          message: "Task lifecycle operation requires a trusted archive capability",
        }),
      );
      return finish();
    }
    let minimumAgeMs: number | undefined;
    if (request.minimumAgeMs !== undefined) {
      if (request.minimumAgeMs < 0 || request.minimumAgeMs > 9223372036854) {
        response.items.push(
          reasonItem({
            code: "invalid_request",
            message: "minimumAgeMs must be a non-negative duration",
          }),
        );
        return finish();
      }
      minimumAgeMs = request.minimumAgeMs;
    }
    const actor = request.actor;
    const taskId = request.taskId ?? "";
    let err: Error | undefined;
    const addItem = (result: Result | undefined) => {
      if (!result) return;
      response.items.push(result);
      response.processed = 1;
      if (result.changed) response.changed = 1;
    };
    switch (request.operation) {
      case "archive": {
        let result: Result | undefined;
        if (request.execute) {
          [result, err] = await this.archiveOut(taskId, {
            ...(actor !== undefined && { actor }),
            ...(minimumAgeMs !== undefined && { minimumAgeMs }),
            expectedHash: request.expectedHash ?? "",
          });
        } else {
          const [eligibility, evalErr] = await attempt(() =>
            this.evaluate(taskId, {
              ...(actor !== undefined && { actor }),
              ...(minimumAgeMs !== undefined && { minimumAgeMs }),
            }),
          );
          err = evalErr;
          result = resultFromEligibility(
            "archive",
            eligibility ?? { taskId: "", eligible: false, lifecycle: "" as never, reasons: [] },
          );
        }
        addItem(result);
        response.completed = err === undefined;
        break;
      }
      case "reopen": {
        if (request.execute) {
          let result: Result | undefined;
          [result, err] = await this.reopenOut(taskId, {
            ...(actor !== undefined && { actor }),
            ...(request.status !== undefined && { status: request.status }),
            expectedHash: request.expectedHash ?? "",
          });
          addItem(result);
        } else {
          const [batch, batchErr] = await this.batchUnarchiveOut({
            ids: [taskId],
            execute: false,
            ...(actor !== undefined && { actor }),
            ...(request.expectedHashes !== undefined && { expectedHashes: request.expectedHashes }),
          });
          copyBatchResponse(response, batch);
          err = batchErr;
        }
        response.completed = err === undefined;
        break;
      }
      case "batch_archive": {
        const [batch, batchErr] = await this.batchArchiveOut({
          ids: request.ids ?? [],
          execute: request.execute,
          ...(actor !== undefined && { actor }),
          ...(minimumAgeMs !== undefined && { minimumAgeMs }),
          ...(request.expectedHashes !== undefined && { expectedHashes: request.expectedHashes }),
        });
        copyBatchResponse(response, batch);
        err = batchErr;
        break;
      }
      case "batch_unarchive": {
        const [batch, batchErr] = await this.batchUnarchiveOut({
          ids: request.ids ?? [],
          execute: request.execute,
          ...(actor !== undefined && { actor }),
          ...(request.expectedHashes !== undefined && { expectedHashes: request.expectedHashes }),
        });
        copyBatchResponse(response, batch);
        err = batchErr;
        break;
      }
      case "hard_delete": {
        if (!capabilities.hardDelete) {
          response.items.push(
            reasonItem({
              code: "permission_required",
              message: "Hard-delete requires a trusted delete capability",
            }),
          );
          response.processed = 1;
          response.completed = false;
          break;
        }
        const [result, deleteErr] = await this.hardDeleteOut(taskId, {
          ...(actor !== undefined && { actor }),
          ...(request.reason !== undefined && { reason: request.reason }),
          ...(request.confirmed !== undefined && { confirmed: request.confirmed }),
          expectedHash: request.expectedHash ?? "",
        });
        addItem(result);
        response.completed = deleteErr === undefined && result.eligible;
        err = deleteErr;
        break;
      }
    }
    if (err && response.failedTaskId === undefined) response.failedTaskId = taskId;
    if (err) {
      const last = response.items[response.items.length - 1];
      if (!last) {
        response.items.push({
          ...emptyResult(),
          taskId,
          operation: request.operation,
          reasons: [publicFailureReason(err)],
        });
        response.processed = 1;
      } else if ((last.reasons ?? []).length === 0) {
        addReason(last, publicFailureReason(err));
      }
    }
    for (const item of response.items) {
      try {
        const task = this.storage.tasks.get(item.taskId);
        item.after = taskLifecycleState(task);
        setOptional(item, "completedAt", task.completedAt);
        setOptional(item, "archivedAt", task.archivedAt);
      } catch {
        // The Task is gone or unreadable: keep what the operation recorded.
      }
    }
    return finish(err);
  }

  private populateResultLifecycle(result: Result): void {
    if (result.taskId === "") return;
    let task: Task;
    try {
      task = this.storage.tasks.get(result.taskId);
    } catch {
      return;
    }
    result.after = taskLifecycleState(task);
    setOptional(result, "completedAt", task.completedAt);
    setOptional(result, "archivedAt", task.archivedAt);
  }

  // --- task updates ----------------------------------------------------------------------------

  /**
   * Applies an arbitrary public Task patch to a fresh canonical copy, including status lifecycle
   * clocks, and persists Task plus history under one lifecycle transaction. Index hooks run only
   * after the lock is released.
   */
  async updateTask(taskId: string, options: TaskUpdateOptions = {}): Promise<Task> {
    let expectedHash = options.expectedHash ?? "";
    if (blank(expectedHash)) expectedHash = this.observedTaskHash(taskId);
    let updated: Task | undefined;
    await this.withTransaction(async (tx) => {
      const current = await tx.getTask(taskId);
      tx.checkTaskExpectedHash(current, expectedHash);
      if (current.archived) {
        throw new Error(`Task "${taskId}" is archived; reopen it before updating`);
      }
      const before = cloneTask(current);
      const candidate = cloneTask(current);
      if (options.mutate) await options.mutate(candidate);
      const requestedStatus = candidate.status;
      candidate.id = current.id;
      candidate.createdAt = current.createdAt;
      candidate.archived = current.archived;
      setOptional(candidate, "completedAt", current.completedAt);
      setOptional(candidate, "archivedAt", current.archivedAt);
      candidate.status = current.status;
      const now = this.clock();
      applyStatusTransition(candidate, requestedStatus, now);
      candidate.updatedAt = wireTime(now);
      await tx.updateTask(candidate);
      try {
        await tx.saveTaskVersion(before, candidate, options.actor ?? "", wireTime(now), "");
      } catch (e) {
        try {
          await tx.updateTask(before);
        } catch (rollbackErr) {
          throw new Error(
            `${toError(e).message}; rollback Task "${taskId}" failed: ${toError(rollbackErr).message}`,
            { cause: e },
          );
        }
        throw e;
      }
      candidate.canonicalHash = canonicalTaskHash(candidate);
      updated = cloneTask(candidate);
    });
    const result = updated as Task;
    try {
      await this.indexTask(taskId);
    } catch (e) {
      throw withPartial(toError(e), result);
    }
    return result;
  }

  /**
   * Applies a batch of order changes under one lifecycle transaction. All expected bases are
   * established before the lock when the caller omitted them, then every base is rechecked while
   * the lock is held. History and canonical writes are rolled back together on a late failure;
   * indexing hooks run only after the complete commit.
   */
  async reorderTasks(
    items: ReorderItem[],
    expectedHashes?: Record<string, string>,
  ): Promise<number> {
    if (items.length === 0) return 0;
    const expected = new Map<string, string>();
    for (const item of items) {
      if (blank(item.taskId)) throw new Error("Task ID is required for reorder");
      if (expected.has(item.taskId)) {
        throw new Error(`Task "${item.taskId}" appears more than once in reorder`);
      }
      let value = (expectedHashes?.[item.taskId] ?? "").trim();
      if (value === "") value = this.observedTaskHash(item.taskId);
      expected.set(item.taskId, value);
    }
    interface Mutation {
      id: string;
      before: Task;
      eventId: string;
    }
    const mutations: Mutation[] = [];
    let changed = 0;
    await this.withTransaction(async (tx) => {
      const candidates: Mutation[] = [];
      const now = this.clock();
      for (const item of items) {
        const current = await tx.getTask(item.taskId);
        tx.checkTaskExpectedHash(current, expected.get(item.taskId) as string);
        if (current.order !== undefined && current.order === item.order) continue;
        candidates.push({
          id: item.taskId,
          before: cloneTask(current),
          eventId: `reorder-${item.taskId}-${BigInt(now.getTime()) * 1_000_000n}`,
        });
      }
      const rollback = async (cause: unknown): Promise<Error> => {
        const errs: Error[] = [];
        for (let index = mutations.length - 1; index >= 0; index--) {
          const entry = mutations[index] as Mutation;
          try {
            await tx.rollbackTaskLifecycleVersion(entry.id, entry.eventId);
          } catch (e) {
            errs.push(wrap(`rollback Task "${entry.id}" history`, e));
          }
          try {
            await tx.updateTask(entry.before);
          } catch (e) {
            errs.push(wrap(`rollback Task "${entry.id}" canonical`, e));
          }
        }
        return joinErrors([toError(cause), joinErrors(errs)]) as Error;
      };
      for (const candidate of candidates) {
        let after: Task;
        try {
          const current = await tx.getTask(candidate.id);
          // Candidate values are rebuilt from the preflight state so a late failure cannot
          // accidentally persist an unrelated field change.
          after = cloneTask(current);
          const item = items.find((i) => i.taskId === candidate.id);
          if (item) after.order = item.order;
          after.updatedAt = wireTime(now);
          await tx.updateTask(after);
        } catch (e) {
          throw await rollback(e);
        }
        try {
          await tx.saveTaskVersion(
            candidate.before,
            after,
            "api",
            wireTime(now),
            candidate.eventId,
          );
        } catch (e) {
          try {
            await tx.updateTask(candidate.before);
          } catch (rollbackErr) {
            throw await rollback(
              new Error(
                `${toError(e).message}; rollback Task "${candidate.id}" canonical: ${toError(rollbackErr).message}`,
              ),
            );
          }
          throw await rollback(e);
        }
        mutations.push(candidate);
        changed++;
      }
    });
    for (const mutation of mutations) {
      try {
        await this.indexTask(mutation.id);
      } catch (e) {
        throw withPartial(toError(e), changed);
      }
    }
    return changed;
  }

  // --- time ------------------------------------------------------------------------------------

  /**
   * Atomically removes an active timer, appends its completed entry, increments the canonical
   * Task.timeSpent and records the Task version while the lifecycle lock is held. Index
   * reconciliation runs after the lock is released.
   */
  async stopTimer(taskId: string, options: StopTimerOptions = {}): Promise<TimeEntry> {
    const entries = await this.stopTimers([taskId], {
      ...(options.actor !== undefined && { actor: options.actor }),
      expectedHashes: { [taskId]: options.expectedHash ?? "" },
    });
    const entry = entries[0];
    if (!entry) throw new Error(`no timer stopped for task "${taskId}"`);
    return entry;
  }

  stopTimers(taskIds: string[], options: StopTimersOptions = {}): Promise<TimeEntry[]> {
    return stopTimers(this, taskIds, options);
  }

  /** Atomically appends a manual entry and updates Task.timeSpent. */
  addTimeEntry(taskId: string, options: TimeMutationOptions): Promise<TimeEntry> {
    return addTimeEntry(this, taskId, options);
  }

  // --- archive transaction ---------------------------------------------------------------------

  private async archiveInTransaction(
    tx: TaskLifecycleTransaction,
    taskId: string,
    options: ArchiveOptions,
    settings: TaskLifecycleSettings,
    now: Date,
  ): Promise<Out<Result>> {
    const [task, taskErr] = await attempt(() => tx.getTask(taskId));
    if (taskErr || !task) return [emptyResult(), taskErr];
    const [, hashErr] = await attempt(() =>
      tx.checkTaskExpectedHash(task, options.expectedHash ?? ""),
    );
    if (hashErr) return [emptyResult(), hashErr];
    const [pending, pendingErr] = await attempt(() =>
      tx.getIncompleteTaskLifecyclePending(taskId, "archive"),
    );
    if (pendingErr) return [emptyResult(), pendingErr];
    if (pending) {
      const result: Result = {
        taskId: task.id,
        operation: "archive",
        changed: false,
        eligible: true,
        before: pending.from,
        after: pending.from,
        reasons: [],
        event: eventFromPending(pending),
      };
      const warnings = durableKnowledgeWarnings(task, this.extract);
      if (warnings) result.warnings = warnings;
      if (pending.canonicalComplete) {
        result.after = pending.to;
        return [result, undefined];
      }
      try {
        await resumeLifecycleMutation(tx, pending);
      } catch (e) {
        return [result, await rollbackLifecycleMutation(tx, pending, e)];
      }
      result.changed = true;
      result.after = pending.to;
      return [result, undefined];
    }
    if (task.archived) {
      const result: Result = {
        taskId: task.id,
        operation: "archive",
        changed: false,
        eligible: true,
        before: "archived",
        after: "archived",
        reasons: [{ code: "already_archived", message: "Task is already archived" }],
      };
      const warnings = durableKnowledgeWarnings(task, this.extract);
      if (warnings) result.warnings = warnings;
      if (task.archivedAt === undefined) {
        const event = withEventKeyOrder({
          id: lifecycleEventId(task.id, "archive", now),
          type: "archive",
          taskId: task.id,
          at: wireTime(now),
          ...(options.actor ? { actor: options.actor } : {}),
          from: "archived",
          to: "archived",
          ...(options.automatic ? { automatic: true } : {}),
        });
        const desired = cloneTask(task);
        desired.archivedAt = wireTime(now);
        desired.updatedAt = wireTime(now);
        const record = pendingForTransition(event, task, desired);
        try {
          savePending(tx, record);
        } catch (e) {
          return [result, toError(e)];
        }
        try {
          await resumeLifecycleMutation(tx, record);
        } catch (e) {
          return [result, await rollbackLifecycleMutation(tx, record, e)];
        }
        result.changed = true;
        result.event = event;
      }
      return [result, undefined];
    }
    const [eligibility, evalErr] = await attempt(() =>
      evaluateInTransaction(tx, task, now, settings, options, this.extract),
    );
    if (evalErr || !eligibility) return [emptyResult(), evalErr];
    if (!eligibility.eligible) return [resultFromEligibility("archive", eligibility), undefined];
    return this.archiveTaskInTransaction(tx, task, options, eligibility, now);
  }

  private async archiveTaskInTransaction(
    tx: TaskLifecycleTransaction,
    task: Task,
    options: ArchiveOptions,
    eligibility: Eligibility,
    now: Date,
  ): Promise<Out<Result>> {
    const result = resultFromEligibility("archive", eligibility);
    const event = withEventKeyOrder({
      id: lifecycleEventId(task.id, "archive", now),
      type: "archive",
      taskId: task.id,
      at: wireTime(now),
      ...(options.actor ? { actor: options.actor } : {}),
      from: result.before as never,
      to: "archived",
      ...(options.automatic ? { automatic: true } : {}),
    });
    const desired = cloneTask(task);
    desired.archived = true;
    desired.archivedAt = wireTime(now);
    desired.updatedAt = wireTime(now);
    const pending = pendingForTransition(event, task, desired);
    try {
      savePending(tx, pending);
    } catch (e) {
      return [result, toError(e)];
    }
    try {
      await resumeLifecycleMutation(tx, pending);
    } catch (e) {
      return [result, await rollbackLifecycleMutation(tx, pending, e)];
    }
    result.changed = true;
    result.after = "archived";
    result.event = event;
    return [result, undefined];
  }

  // --- pending delivery ------------------------------------------------------------------------

  /**
   * Delivers durable lifecycle side effects without holding the project lock across callbacks.
   * Durable leases prevent concurrent invocation in the normal case. Delivery remains at-least-once
   * across a crash after a hook succeeds but before its checkpoint is saved; event sinks must
   * deduplicate by Event.id.
   */
  private async flushTaskLifecyclePending(taskId: string): Promise<Flushed> {
    const warnings: Warning[] = [];
    let pending: TaskLifecyclePending[] = [];
    const [, listErr] = await attempt(() =>
      this.withTransaction((tx) => {
        for (const record of tx.listTaskLifecyclePending("")) {
          let canonicalReady = record.canonicalComplete;
          if (record.operation === "archive" || record.operation === "reopen") {
            canonicalReady =
              canonicalReady &&
              !!record.moveComplete &&
              !!record.patchComplete &&
              !!record.versionComplete;
          }
          if (record.taskId === taskId && canonicalReady) pending.push({ ...record });
        }
      }),
    );
    if (listErr) return { warnings: [], hadPending: false, error: listErr };
    const hadPending = pending.length > 0;
    const fail = (error: Error): Flushed => ({ warnings, hadPending, error });
    for (let record of pending) {
      if (!record.eventDelivered) {
        const [claim, claimErr] = await attempt(() => this.claimPendingPhase(record, false));
        if (claimErr || !claim) return fail(claimErr as Error);
        if (!claim.acquired) {
          if (!claim.record?.eventDelivered) continue;
          record = claim.record;
        } else {
          record = claim.record as TaskLifecyclePending;
          if (this.hooks.emit) {
            const [, emitErr] = await attempt(() =>
              (this.hooks.emit as NonNullable<Hooks["emit"]>)(eventFromPending(record)),
            );
            if (emitErr) {
              warnings.push({ code: "event_delivery_failed", message: emitErr.message });
              const [, releaseErr] = await attempt(() => this.releasePendingClaim(record, false));
              if (releaseErr) return fail(releaseErr);
            } else {
              record.eventDelivered = true;
              const [, completeErr] = await attempt(() => this.completePendingPhase(record, false));
              if (completeErr) return fail(completeErr);
            }
          } else {
            record.eventDelivered = true;
            const [, completeErr] = await attempt(() => this.completePendingPhase(record, false));
            if (completeErr) return fail(completeErr);
          }
        }
      }
      if (!record.derivedApplied) {
        const [claim, claimErr] = await attempt(() => this.claimPendingPhase(record, true));
        if (claimErr || !claim) return fail(claimErr as Error);
        if (!claim.acquired) continue;
        record = claim.record as TaskLifecyclePending;
        const target = record;
        const [, derivedErr] = await attempt(() =>
          target.operation === "hard_delete"
            ? this.removeFromIndex(target.taskId)
            : this.indexTask(target.taskId),
        );
        if (derivedErr) {
          const [, releaseErr] = await attempt(() => this.releasePendingClaim(target, true));
          if (releaseErr) {
            return fail(
              new Error(`${derivedErr.message}; release derived claim: ${releaseErr.message}`, {
                cause: derivedErr,
              }),
            );
          }
          return fail(derivedErr);
        }
        record.derivedApplied = true;
        const [, completeErr] = await attempt(() => this.completePendingPhase(target, true));
        if (completeErr) return fail(completeErr);
      }
    }
    pending = [];
    return { warnings, hadPending };
  }

  private async claimPendingPhase(
    pending: TaskLifecyclePending,
    derived: boolean,
  ): Promise<{ record: TaskLifecyclePending | undefined; acquired: boolean }> {
    let claimed: TaskLifecyclePending | undefined;
    let acquired = false;
    await this.withTransaction((tx) => {
      const current = tx.getTaskLifecyclePendingEvent(
        pending.taskId,
        pending.operation,
        pending.eventId,
      );
      if (!current) return;
      if ((!derived && current.eventDelivered) || (derived && current.derivedApplied)) {
        claimed = { ...current };
        return;
      }
      const now = this.clock();
      const claim = derived ? current.derivedClaim : current.eventClaim;
      if (claim && now.getTime() < epochMs(claim.claimedAt) + CLAIM_LEASE_MS) return;
      const newClaim = {
        token: lifecycleEventId(current.taskId, current.operation as Operation, now),
        claimedAt: wireTime(now),
      };
      if (derived) current.derivedClaim = newClaim;
      else current.eventClaim = newClaim;
      savePending(tx, current);
      claimed = { ...current };
      acquired = true;
    });
    return { record: claimed, acquired };
  }

  private completePendingPhase(pending: TaskLifecyclePending, derived: boolean): Promise<void> {
    return this.withTransaction((tx) => {
      const current = tx.getTaskLifecyclePendingEvent(
        pending.taskId,
        pending.operation,
        pending.eventId,
      );
      if (!current) return;
      if (derived) {
        current.derivedApplied = true;
        delete current.derivedClaim;
      } else {
        current.eventDelivered = true;
        delete current.eventClaim;
      }
      if (current.eventDelivered && current.derivedApplied) {
        tx.deleteTaskLifecyclePending(current.taskId, current.operation, current.eventId);
        return;
      }
      savePending(tx, current);
    });
  }

  private releasePendingClaim(pending: TaskLifecyclePending, derived: boolean): Promise<void> {
    return this.withTransaction((tx) => {
      const current = tx.getTaskLifecyclePendingEvent(
        pending.taskId,
        pending.operation,
        pending.eventId,
      );
      if (!current) return;
      const expected = derived ? pending.derivedClaim : pending.eventClaim;
      const actual = derived ? current.derivedClaim : current.eventClaim;
      if (!expected || !actual || expected.token !== actual.token) return;
      if (derived) delete current.derivedClaim;
      else delete current.eventClaim;
      savePending(tx, current);
    });
  }
}

function setOptional<K extends "completedAt" | "archivedAt">(
  target: Partial<Record<K, string>>,
  key: K,
  value: string | undefined,
): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function savePending(tx: TaskLifecycleTransaction, pending: TaskLifecyclePending): void {
  tx.saveTaskLifecyclePending(orderedPending(pending));
}

function isArchiveOperation(operation: Operation): boolean {
  return (
    operation === "archive" ||
    operation === "reopen" ||
    operation === "batch_archive" ||
    operation === "batch_unarchive"
  );
}

function copyBatchResponse(response: Response, batch: BatchResult): void {
  response.execute = batch.execute;
  response.completed = batch.completed;
  response.processed = batch.processed;
  response.changed = batch.changed;
  if (batch.failedTaskId !== undefined) response.failedTaskId = batch.failedTaskId;
  response.items = [...batch.items];
}

async function rollbackLifecycleMutation(
  tx: TaskLifecycleTransaction,
  pending: TaskLifecyclePending | undefined,
  cause: unknown,
): Promise<Error> {
  const base = toError(cause);
  if (!pending?.original) return base;
  const problems: string[] = [];
  try {
    await tx.rollbackTaskLifecycleVersion(pending.taskId, pending.eventId);
  } catch (e) {
    problems.push(`version: ${toError(e).message}`);
  }
  try {
    const current = await tx.getTask(pending.taskId);
    const original = taskWithLifecycleData(current, pending.original);
    await tx.patchTaskLifecycle(original);
    if (pending.original.archived !== current.archived) {
      if (pending.original.archived) await tx.archiveTask(original.id);
      else await tx.unarchiveTask(original.id);
    }
  } catch (e) {
    problems.push(`canonical: ${toError(e).message}`);
  }
  try {
    tx.deleteTaskLifecyclePending(pending.taskId, pending.operation, pending.eventId);
  } catch (e) {
    problems.push(`pending: ${toError(e).message}`);
  }
  if (problems.length > 0) {
    return new Error(
      `${base.message}; rollback Task "${pending.taskId}" lifecycle mutation: ${problems.join("; ")}`,
      { cause: base },
    );
  }
  return base;
}

async function resumeLifecycleMutation(
  tx: TaskLifecycleTransaction,
  pending: TaskLifecyclePending,
): Promise<Task> {
  if (!pending.original || !pending.desired) {
    throw new Error("resume Task lifecycle: original and desired metadata are required");
  }
  let task = await tx.getTask(pending.taskId);

  // A completed checkpoint may only be trusted after every durable phase is present. Current
  // location/status alone never implies completion.
  if (
    pending.canonicalComplete &&
    pending.moveComplete &&
    pending.patchComplete &&
    pending.versionComplete &&
    lifecycleDataMatches(task, pending.desired)
  ) {
    if (await tx.hasTaskLifecycleVersion(pending.taskId, pending.eventId)) return task;
  }
  pending.canonicalComplete = false;

  if (task.archived !== pending.desired.archived) {
    if (pending.desired.archived) await tx.archiveTask(task.id);
    else await tx.unarchiveTask(task.id);
    task = await tx.getTask(task.id);
  }
  pending.moveComplete = true;
  savePending(tx, pending);

  if (!lifecycleDataMatches(task, pending.desired)) {
    const desired = taskWithLifecycleData(task, pending.desired);
    await tx.patchTaskLifecycle(desired);
    task = desired;
  }
  pending.patchComplete = true;
  savePending(tx, pending);

  if (!(await tx.hasTaskLifecycleVersion(pending.taskId, pending.eventId))) {
    const original = taskWithLifecycleData(task, pending.original);
    const desired = taskWithLifecycleData(task, pending.desired);
    await tx.saveTaskVersion(original, desired, pending.actor ?? "", pending.at, pending.eventId);
  }
  pending.versionComplete = true;
  savePending(tx, pending);

  pending.canonicalComplete = true;
  savePending(tx, pending);
  return taskWithLifecycleData(task, pending.desired);
}
