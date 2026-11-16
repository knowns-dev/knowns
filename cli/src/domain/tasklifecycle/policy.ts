// Port of internal/tasklifecycle/policy.go: status transitions, archive eligibility and the
// durable-knowledge warning.

import type { TaskLifecycleSettings } from "../../models/config.ts";
import { parseTaskLifecycleDuration } from "../../models/duration.ts";
import { type Task, taskLifecycleState } from "../../models/task.ts";
import type { TaskLifecycleTransaction } from "../../storage/history/index.ts";
import { extract as defaultExtractReferences } from "../references/index.ts";
import { epochMs, wireTime } from "./clock.ts";
import { wrap } from "./errors.ts";
import type { ArchiveOptions, Eligibility, Reason, TaskTreeSnapshot, Warning } from "./types.ts";

/**
 * Records the completion clock when entering done and clears stale live lifecycle clocks when
 * leaving done. Historical values stay available through Task version history.
 */
export function applyStatusTransition(task: Task | undefined, status: string, now: Date): void {
  if (!task || task.status === status) return;
  const at = wireTime(now);
  if (status === "done") {
    task.completedAt = at;
    delete task.archivedAt;
  } else if (task.status === "done" || task.archived) {
    delete task.completedAt;
    delete task.archivedAt;
  }
  task.status = status;
  task.updatedAt = at;
}

/** A deep-enough copy: Go's cloneTask copies the slices (an empty slice becomes nil). */
export function cloneTask(task: Task): Task {
  const clone: Task = { ...task };
  clone.labels = task.labels && task.labels.length > 0 ? [...task.labels] : null;
  if (task.subtasks && task.subtasks.length > 0) clone.subtasks = [...task.subtasks];
  else delete clone.subtasks;
  if (task.fulfills && task.fulfills.length > 0) clone.fulfills = [...task.fulfills];
  else delete clone.fulfills;
  clone.acceptanceCriteria =
    task.acceptanceCriteria && task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria.map((ac) => ({ ...ac }))
      : null;
  if (task.timeEntries && task.timeEntries.length > 0) {
    clone.timeEntries = task.timeEntries.map((e) => ({ ...e }));
  } else delete clone.timeEntries;
  return clone;
}

export async function evaluateInTransaction(
  tx: TaskLifecycleTransaction,
  task: Task,
  now: Date,
  settings: TaskLifecycleSettings,
  options: ArchiveOptions,
  extract: ReferenceExtractor = defaultExtractReferences,
): Promise<Eligibility> {
  const eligibility: Eligibility = {
    taskId: task.id,
    eligible: false,
    lifecycle: taskLifecycleState(task),
    reasons: [],
  };
  if (task.completedAt !== undefined) eligibility.completedAt = task.completedAt;
  if (task.archivedAt !== undefined) eligibility.archivedAt = task.archivedAt;
  const warnings = durableKnowledgeWarnings(task, extract);
  if (warnings) eligibility.warnings = warnings;
  const reasons: Reason[] = eligibility.reasons;

  if (task.archived) {
    reasons.push({ code: "already_archived", message: "Task is already archived" });
    return eligibility;
  }
  if (task.status !== "done") {
    reasons.push({ code: "not_done", message: "Task must be done before it can be archived" });
  }

  let minimumAgeMs = options.minimumAgeMs;
  if (options.automatic) {
    if (!settings.autoArchive) {
      reasons.push({
        code: "auto_archive_disabled",
        message: "Automatic Task archival is disabled",
      });
    }
    minimumAgeMs = Number(parseTaskLifecycleDuration(settings.archiveAfter) / 1_000_000n);
  }
  if (minimumAgeMs !== undefined && task.status === "done") {
    if (task.completedAt === undefined) {
      reasons.push({
        code: "completed_at_missing",
        message:
          "Task has no completion timestamp; reopen and complete it again or archive it manually",
      });
    } else {
      const deadlineMs = epochMs(task.completedAt) + minimumAgeMs;
      const deadline = wireTime(new Date(deadlineMs));
      eligibility.deadline = deadline;
      if (now.getTime() < deadlineMs) {
        reasons.push({
          code: "retention_pending",
          message: "Task has not reached its archive deadline",
          deadline,
        });
      }
    }
  }

  let hasActiveTimer: boolean;
  try {
    hasActiveTimer = await tx.hasActiveTimer(task.id);
  } catch (e) {
    throw wrap(`evaluate active timer for Task "${task.id}"`, e);
  }
  if (hasActiveTimer) reasons.push({ code: "active_timer", message: "Task has an active timer" });

  // A shared snapshot (an automatic sweep) may be old: it is a pre-filter that can only refuse. A
  // Task it clears is checked again against the tree as it is now, inside this transaction, so a
  // child reopened or created since the snapshot still blocks the archive.
  let unfinished: string[] = [];
  if (options.taskTree) unfinished = await unfinishedDescendants(tx, task.id, options.taskTree);
  if (unfinished.length === 0) unfinished = await unfinishedDescendants(tx, task.id);
  for (const descendantId of unfinished) {
    reasons.push({
      code: "unfinished_descendant",
      message: `Descendant Task ${descendantId} is not done or archived`,
      relatedTaskId: descendantId,
    });
  }
  eligibility.eligible = reasons.length === 0;
  return eligibility;
}

/** references.Extract, or any extractor that yields each reference's type and canonical form. */
export type ReferenceExtractor = (
  content: string,
) => ReadonlyArray<{ type: string; canonical: string }>;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The whole Task tree as it is now: one listing of every active and archived Task. */
export async function snapshotTaskTree(tx: TaskLifecycleTransaction): Promise<TaskTreeSnapshot> {
  const active = await tx.listActiveTasks();
  const archived = await tx.listArchivedTasks();
  const all = new Map<string, Task>();
  for (const task of active) all.set(task.id, task);
  for (const task of archived) all.set(task.id, task);
  const children = new Map<string, string[]>();
  const tasks = new Map<string, { archived: boolean; status: string }>();
  for (const task of all.values()) {
    tasks.set(task.id, { archived: task.archived, status: task.status });
    if (task.parent) {
      const list = children.get(task.parent);
      if (list) list.push(task.id);
      else children.set(task.parent, [task.id]);
    }
  }
  for (const list of children.values()) list.sort(byCodeUnit);
  return { children, tasks };
}

async function unfinishedDescendants(
  tx: TaskLifecycleTransaction,
  rootId: string,
  shared?: TaskTreeSnapshot,
): Promise<string[]> {
  const { children, tasks: all } = shared ?? (await snapshotTaskTree(tx));

  const visited = new Set<string>([rootId]);
  const queue = [...(children.get(rootId) ?? [])];
  const unfinished: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const task = all.get(id);
    if (!task) continue;
    if (!task.archived && task.status !== "done") unfinished.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return unfinished.sort(byCodeUnit);
}

/** Warns, never blocks, when a Task with a plan or notes may hold durable knowledge. */
export function durableKnowledgeWarnings(
  task: Task | undefined,
  extract: ReferenceExtractor = defaultExtractReferences,
): Warning[] | undefined {
  if (!task) return undefined;
  const plan = task.implementationPlan ?? "";
  const notes = task.implementationNotes ?? "";
  if (plan.trim() === "" && notes.trim() === "") return undefined;
  const combined = `${task.description ?? ""}\n${plan}\n${notes}`;
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const ref of extract(combined)) {
    if (ref.type !== "doc" && ref.type !== "decision" && ref.type !== "memory") continue;
    if (seen.has(ref.canonical)) continue;
    seen.add(ref.canonical);
    refs.push(ref.canonical);
  }
  refs.sort(byCodeUnit);
  const warning: Warning = {
    code: "durable_knowledge_review",
    message:
      "Review the Task Plan and Notes for durable knowledge before archival; this warning does not block the operation",
  };
  if (refs.length > 0) warning.references = refs;
  return [warning];
}
