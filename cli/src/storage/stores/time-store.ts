// Port of internal/storage/time_store.go: .knowns/time.json (active timers) and
// .knowns/time-entries.json (completed entries keyed by task id).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ActiveTimer,
  type TimeEntry,
  type TimeState,
  timeEntriesFileSchema,
  timeStateSchema,
} from "../../models/time.ts";
import { parseBoundary } from "../../schema/index.ts";
import type { Store } from "../core/store.ts";
import { parseJsonPreservingNumbers, writeJson } from "../core/util.ts";
import { AgentWorkStore } from "./agent-work-store.ts";
import { goTimeJson, isNotFound, parseIso } from "./internal.ts";
import { TaskStore } from "./task-store.ts";

/** The key order of models.ActiveTimer / models.TimeEntry, so writes match Go byte for byte. */
function timerJson(t: ActiveTimer): Record<string, unknown> {
  const out: Record<string, unknown> = { taskId: t.taskId };
  if (t.taskTitle) out.taskTitle = t.taskTitle;
  out.startedAt = t.startedAt;
  out.pausedAt = t.pausedAt ?? null;
  out.totalPausedMs = t.totalPausedMs;
  return out;
}

function entryJson(e: TimeEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { id: e.id, startedAt: e.startedAt };
  if (e.endedAt !== undefined) out.endedAt = e.endedAt;
  out.duration = e.duration;
  if (e.note) out.note = e.note;
  return out;
}

const isoNow = () => new Date().toISOString();

export class TimeStore {
  readonly root: string;
  private readonly tasks: TaskStore;
  private readonly agentWork: AgentWorkStore;

  constructor(private readonly store: Pick<Store, "root" | "withTaskLifecycleLock">) {
    this.root = store.root;
    this.tasks = new TaskStore(store);
    this.agentWork = new AgentWorkStore(store);
  }

  statePath(): string {
    return join(this.root, "time.json");
  }
  entriesPath(): string {
    return join(this.root, "time-entries.json");
  }

  /** GetActiveTimer: the task's timer, or undefined; unreadable state is an error. */
  getActiveTimer(taskId: string): ActiveTimer | undefined {
    return this.getState().active?.find((a) => a.taskId === taskId);
  }

  getState(): TimeState {
    let data: string;
    try {
      data = readFileSync(this.statePath(), "utf8");
    } catch (e) {
      if (isNotFound(e)) return { active: [] };
      throw new Error(`read time.json: ${(e as Error).message}`);
    }
    let state: TimeState;
    try {
      state = parseBoundary(timeStateSchema, parseJsonPreservingNumbers(data), "time.json");
    } catch (e) {
      throw new Error(`parse time.json: ${(e as Error).message}`);
    }
    return { active: state.active ?? [] };
  }

  saveState(state: TimeState): Promise<void> {
    return this.store.withTaskLifecycleLock(() => this.saveStateUnlocked(state));
  }

  saveStateUnlocked(state: TimeState): void {
    writeJson(this.statePath(), { active: (state.active ?? []).map(timerJson) });
  }

  getEntries(taskId: string): TimeEntry[] {
    return this.getAllEntries()[taskId] ?? [];
  }

  getAllEntries(): Record<string, TimeEntry[]> {
    let data: string;
    try {
      data = readFileSync(this.entriesPath(), "utf8");
    } catch (e) {
      if (isNotFound(e)) return {};
      throw new Error(`read time-entries.json: ${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = parseJsonPreservingNumbers(data);
    } catch (e) {
      throw new Error(`parse time-entries.json: ${(e as Error).message}`);
    }
    if (parsed === null) return {};
    try {
      return parseBoundary(timeEntriesFileSchema, parsed, "time-entries.json");
    } catch (e) {
      throw new Error(`parse time-entries.json: ${(e as Error).message}`);
    }
  }

  saveEntry(taskId: string, entry: TimeEntry): Promise<void> {
    return this.store.withTaskLifecycleLock(() => this.saveEntryUnlocked(taskId, entry));
  }

  saveEntryUnlocked(taskId: string, entry: TimeEntry): void {
    this.rejectHardDeletedTask(taskId);
    let archived: boolean;
    try {
      archived = this.tasks.get(taskId).archived;
    } catch (e) {
      throw new Error(`cannot save time data for Task "${taskId}": ${(e as Error).message}`);
    }
    if (archived) throw new Error(`cannot save time data for archived Task "${taskId}"`);
    const all = this.getAllEntries();
    all[taskId] = [...(all[taskId] ?? []), entry];
    this.saveAllEntriesUnlocked(all);
  }

  /** Entries marshal as a Go map: keys sorted, each entry in struct order. */
  saveAllEntriesUnlocked(all: Record<string, TimeEntry[]>): void {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(all).sort()) {
      out[key] = (all[key] as TimeEntry[]).map(entryJson);
    }
    writeJson(this.entriesPath(), out);
  }

  /** Start: begin a timer for the task; an error if one is already running. */
  start(taskId: string, taskTitle: string): Promise<void> {
    return this.store.withTaskLifecycleLock(() => {
      this.rejectHardDeletedTask(taskId);
      let archived: boolean;
      try {
        archived = this.tasks.get(taskId).archived;
      } catch (e) {
        throw new Error(`start timer: ${(e as Error).message}`);
      }
      if (archived) throw new Error(`cannot start timer for archived Task "${taskId}"`);
      const state = this.getState();
      if (state.active?.some((a) => a.taskId === taskId)) {
        throw new Error(`timer already running for task "${taskId}"`);
      }
      const timer: ActiveTimer = { taskId, startedAt: isoNow(), pausedAt: null, totalPausedMs: 0 };
      if (taskTitle !== "") timer.taskTitle = taskTitle;
      state.active = [...(state.active ?? []), timer];
      this.saveStateUnlocked(state);
    });
  }

  /** Stop: stop the task's timer and record a completed TimeEntry. */
  stop(taskId: string): Promise<TimeEntry> {
    return this.store.withTaskLifecycleLock(() => {
      const state = this.getState();
      const timer = state.active?.find((a) => a.taskId === taskId);
      if (!timer) throw new Error(`no active timer for task "${taskId}"`);
      const remaining = (state.active ?? []).filter((a) => a.taskId !== taskId);

      const now = Date.now();
      const startedMs = parseIso(timer.startedAt)?.ms ?? now - 1000;
      let pausedMs = timer.totalPausedMs;
      if (timer.pausedAt !== null) {
        const pausedAt = parseIso(timer.pausedAt);
        if (pausedAt) pausedMs += now - pausedAt.ms;
      }
      const elapsed = Math.max(0, now - startedMs - pausedMs);
      const entry: TimeEntry = {
        id: `te-${now}-${taskId}`,
        startedAt: goTimeJson(new Date(startedMs).toISOString()),
        endedAt: goTimeJson(new Date(now).toISOString()),
        duration: Math.trunc(elapsed / 1000),
      };
      try {
        this.saveEntryUnlocked(taskId, entry);
      } catch (e) {
        throw new Error(`save entry: ${(e as Error).message}`);
      }
      state.active = remaining;
      try {
        this.saveStateUnlocked(state);
      } catch (e) {
        throw new Error(`save state: ${(e as Error).message}`);
      }
      // The agent's work ends with its timer, whoever stops it (KN-4FQN0P). Advisory data: never fail a stop.
      try {
        this.agentWork.releaseUnlocked(taskId);
      } catch {
        // best effort
      }
      return entry;
    });
  }

  pause(taskId: string): Promise<void> {
    return this.store.withTaskLifecycleLock(() => {
      const state = this.getState();
      const timer = state.active?.find((a) => a.taskId === taskId);
      if (!timer) throw new Error(`no active timer for task "${taskId}"`);
      if (timer.pausedAt !== null) throw new Error(`timer for task "${taskId}" is already paused`);
      timer.pausedAt = isoNow();
      this.saveStateUnlocked(state);
    });
  }

  resume(taskId: string): Promise<void> {
    return this.store.withTaskLifecycleLock(() => {
      const state = this.getState();
      const timer = state.active?.find((a) => a.taskId === taskId);
      if (!timer) throw new Error(`no active timer for task "${taskId}"`);
      if (timer.pausedAt === null) throw new Error(`timer for task "${taskId}" is not paused`);
      const pausedAt = parseIso(timer.pausedAt);
      if (pausedAt) timer.totalPausedMs += Date.now() - pausedAt.ms;
      timer.pausedAt = null;
      this.saveStateUnlocked(state);
    });
  }

  private rejectHardDeletedTask(taskId: string): void {
    let reserved: boolean;
    try {
      reserved = this.tasks.isIdReserved(taskId);
    } catch (e) {
      throw new Error(`check Task tombstone before saving time data: ${(e as Error).message}`);
    }
    if (reserved) throw new Error(`cannot save time data for hard-deleted Task "${taskId}"`);
  }
}
