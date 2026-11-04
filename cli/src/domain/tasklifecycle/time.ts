// Port of internal/tasklifecycle/time.go: timer stop and manual time entries, applied to the
// canonical Task, the time files and Task history under one lifecycle transaction.
import { GO_ZERO_TIME } from "../../models/common.ts";
import type { Task } from "../../models/task.ts";
import type { ActiveTimer, TimeEntry, TimeState } from "../../models/time.ts";
import type { TaskLifecycleTransaction } from "../../storage/history/index.ts";
import { epochMs, unixNano, wireTime } from "./clock.ts";
import type { LifecycleCore } from "./core.ts";
import { joinErrors, toError } from "./errors.ts";
import { cloneTask } from "./policy.ts";
import type { StopTimersOptions, TimeMutationOptions } from "./types.ts";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Atomically stops all selected timers and updates every affected canonical Task plus its history
 * under one lifecycle transaction. Hashes are observed before the lock only for omitted-hash
 * compatibility and are always rechecked after the complete lock set is held.
 */
export async function stopTimers(
  core: LifecycleCore,
  taskIds: string[],
  options: StopTimersOptions = {},
): Promise<TimeEntry[]> {
  if (taskIds.length === 0) return [];
  const sorted = [...taskIds].sort(byCodeUnit);
  const ids: string[] = [];
  for (const id of sorted) {
    if (id.trim() === "") throw new Error("task ID is required");
    if (ids.length === 0 || ids[ids.length - 1] !== id) ids.push(id);
  }
  const expected = new Map<string, string>();
  for (const id of ids) {
    const given = (options.expectedHashes?.[id] ?? "").trim();
    expected.set(id, given !== "" ? given : core.observedTaskHash(id));
  }

  let recorded: TimeEntry[] = [];
  await core.withTransaction(async (tx) => {
    const state = await tx.getTimeState();
    const entries = await tx.getAllTimeEntries();
    const beforeState = cloneTimeState(state);
    const beforeEntries = cloneTimeEntries(entries);
    let nextState = cloneTimeState(state);
    const nextEntries = cloneTimeEntries(entries);
    const now = core.clock();
    interface Mutation {
      id: string;
      before: Task;
      after: Task;
      entry: TimeEntry;
      eventId: string;
      updated: boolean;
      history: boolean;
    }
    const mutations: Mutation[] = [];
    for (const id of ids) {
      const task = await activeTaskForTimeMutation(tx, id);
      tx.checkTaskExpectedHash(task, expected.get(id) as string);
      const completed = completedEntryForTimer(nextState, id, now);
      nextState = completed.state;
      nextEntries[id] = [...(nextEntries[id] ?? []), completed.entry];
      const after = cloneTask(task);
      after.timeSpent = totalTimeSpent(nextEntries[id] as TimeEntry[]);
      after.updatedAt = wireTime(now);
      mutations.push({
        id,
        before: cloneTask(task),
        after,
        entry: completed.entry,
        eventId: `time-stop-${unixNano(now)}-${id}`,
        updated: false,
        history: false,
      });
    }
    const rollback = async (cause: unknown): Promise<Error> => {
      const errs: Error[] = [];
      for (let index = mutations.length - 1; index >= 0; index--) {
        const mutation = mutations[index] as Mutation;
        if (mutation.history) {
          try {
            await tx.rollbackTaskLifecycleVersion(mutation.id, mutation.eventId);
          } catch (e) {
            errs.push(toError(e));
          }
        }
        if (mutation.updated) {
          try {
            await tx.updateTask(mutation.before);
          } catch (e) {
            errs.push(toError(e));
          }
        }
      }
      try {
        await tx.saveTimeState(beforeState);
      } catch (e) {
        errs.push(toError(e));
      }
      try {
        await tx.saveAllTimeEntries(beforeEntries);
      } catch (e) {
        errs.push(toError(e));
      }
      return joinErrors([toError(cause), joinErrors(errs)]) as Error;
    };
    try {
      await tx.saveAllTimeEntries(nextEntries);
    } catch (e) {
      throw await rollback(e);
    }
    try {
      await tx.saveTimeState(nextState);
    } catch (e) {
      throw await rollback(e);
    }
    for (const mutation of mutations) {
      try {
        await tx.updateTask(mutation.after);
      } catch (e) {
        throw await rollback(e);
      }
      mutation.updated = true;
      try {
        await tx.saveTaskVersion(
          mutation.before,
          mutation.after,
          options.actor ?? "",
          wireTime(now),
          mutation.eventId,
        );
      } catch (e) {
        throw await rollback(e);
      }
      mutation.history = true;
    }
    recorded = mutations.map((m) => m.entry);
  });
  for (const id of ids) await core.indexTask(id);
  return recorded;
}

/**
 * Atomically appends a manual entry and updates Task.timeSpent. Archived and hard-deleted Tasks
 * are rejected before any time data changes.
 */
export async function addTimeEntry(
  core: LifecycleCore,
  taskId: string,
  options: TimeMutationOptions,
): Promise<TimeEntry> {
  let entry: TimeEntry = { ...options.entry };
  if (entry.duration < 0) throw new Error("time entry duration must be non-negative");
  const nowDate = core.clock();
  entry.startedAt =
    entry.startedAt === "" || entry.startedAt === GO_ZERO_TIME
      ? wireTime(nowDate)
      : wireTime(new Date(epochMs(entry.startedAt)));
  entry.endedAt =
    entry.endedAt === undefined
      ? wireTime(new Date(epochMs(entry.startedAt) + entry.duration * 1000))
      : wireTime(new Date(epochMs(entry.endedAt)));
  if (entry.id.trim() === "") entry.id = `te-${unixNano(nowDate)}-${taskId}`;
  let expectedHash = (options.expectedHash ?? "").trim();
  if (expectedHash === "") expectedHash = core.observedTaskHash(taskId);

  await core.withTransaction(async (tx) => {
    const task = await activeTaskForTimeMutation(tx, taskId);
    tx.checkTaskExpectedHash(task, expectedHash);
    const entries = await tx.getAllTimeEntries();
    const beforeEntries = cloneTimeEntries(entries);
    const beforeTask = cloneTask(task);
    let alreadyRecorded = false;
    for (const existing of entries[taskId] ?? []) {
      if (existing.id === entry.id) {
        if (
          existing.duration === entry.duration &&
          epochMs(existing.startedAt) === epochMs(entry.startedAt)
        ) {
          entry = existing;
          alreadyRecorded = true;
          break;
        }
        throw new Error(`time entry "${entry.id}" already exists with different content`);
      }
    }
    const nextEntries = cloneTimeEntries(entries);
    if (!alreadyRecorded) nextEntries[taskId] = [...(nextEntries[taskId] ?? []), entry];
    const now = core.clock();
    const nextTask = cloneTask(task);
    nextTask.timeSpent = totalTimeSpent(nextEntries[taskId] ?? []);
    nextTask.updatedAt = wireTime(now);
    if (alreadyRecorded && nextTask.timeSpent === task.timeSpent) return;

    await tx.saveAllTimeEntries(nextEntries);
    try {
      await tx.updateTask(nextTask);
    } catch (e) {
      throw await rollbackTimeMutation(tx, beforeTask, undefined, beforeEntries, e);
    }
    try {
      await tx.saveTaskVersion(beforeTask, nextTask, options.actor ?? "", wireTime(now), "");
    } catch (e) {
      throw await rollbackTimeMutation(tx, beforeTask, undefined, beforeEntries, e);
    }
  });
  await core.indexTask(taskId);
  return entry;
}

async function activeTaskForTimeMutation(
  tx: TaskLifecycleTransaction,
  taskId: string,
): Promise<Task> {
  const task = await tx.getTask(taskId);
  if (task.archived) throw new Error(`cannot mutate time for archived Task "${taskId}"`);
  return task;
}

function completedEntryForTimer(
  state: TimeState,
  taskId: string,
  now: Date,
): { entry: TimeEntry; state: TimeState } {
  const next: TimeState = { active: [] };
  let timer: ActiveTimer | undefined;
  for (const active of state.active ?? []) {
    if (active.taskId === taskId) {
      timer = { ...active };
      continue;
    }
    next.active?.push(active);
  }
  if (!timer) throw new Error(`no active timer for task "${taskId}"`);
  const nowMs = now.getTime();
  let startedMs = parseTimerTime(timer.startedAt);
  if (Number.isNaN(startedMs)) startedMs = nowMs - 1000;
  let pausedMillis = timer.totalPausedMs;
  if (timer.pausedAt !== null) {
    const pausedAt = parseTimerTime(timer.pausedAt);
    if (!Number.isNaN(pausedAt)) pausedMillis += nowMs - pausedAt;
  }
  let elapsed = nowMs - startedMs - pausedMillis;
  if (elapsed < 0) elapsed = 0;
  return {
    entry: {
      id: `te-${nowMs}-${taskId}`,
      startedAt: wireTime(new Date(startedMs)),
      endedAt: wireTime(now),
      duration: Math.trunc(elapsed / 1000),
    },
    state: next,
  };
}

const TIMER_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** parseTimerTime: the RFC 3339 layouts Go tries, as epoch ms (NaN when none fits). */
export function parseTimerTime(value: string): number {
  return TIMER_TIME.test(value) ? Date.parse(value) : Number.NaN;
}

export function cloneTimeState(state: TimeState | undefined): TimeState {
  if (!state) return { active: [] };
  return { active: (state.active ?? []).map((t) => ({ ...t })) };
}

export function cloneTimeEntries(
  entries: Record<string, TimeEntry[]>,
): Record<string, TimeEntry[]> {
  const copy: Record<string, TimeEntry[]> = {};
  for (const [taskId, list] of Object.entries(entries)) copy[taskId] = list.map((e) => ({ ...e }));
  return copy;
}

export function totalTimeSpent(entries: TimeEntry[]): number {
  return entries.reduce((sum, e) => sum + e.duration, 0);
}

async function rollbackTimeMutation(
  tx: TaskLifecycleTransaction,
  task: Task | undefined,
  state: TimeState | undefined,
  entries: Record<string, TimeEntry[]> | undefined,
  cause: unknown,
): Promise<Error> {
  const problems: string[] = [];
  if (task) {
    try {
      await tx.updateTask(task);
    } catch (e) {
      problems.push(`task: ${toError(e).message}`);
    }
  }
  if (state) {
    try {
      await tx.saveTimeState(state);
    } catch (e) {
      problems.push(`timer: ${toError(e).message}`);
    }
  }
  if (entries) {
    try {
      await tx.saveAllTimeEntries(entries);
    } catch (e) {
      problems.push(`entries: ${toError(e).message}`);
    }
  }
  const base = toError(cause);
  if (problems.length > 0) {
    return new Error(`${base.message}; rollback time mutation: ${problems.join("; ")}`, {
      cause: base,
    });
  }
  return base;
}
