// Task, memory and decision visibility rules (engine.go) shared by the lexical backend and the
// engine.

import type { DecisionEntry } from "../models/decision.ts";
import { decisionCurrentForDefaultRetrieval, validDecisionStatus } from "../models/decision.ts";
import type { MemoryEntry } from "../models/memory.ts";
import { memoryCurrentForDefaultRetrieval, validMemoryStatus } from "../models/memory.ts";
import { type Task, type TaskLifecycleState, taskLifecycleState } from "../models/task.ts";
import { containsStr } from "./text.ts";
import type { SearchOptions } from "./types.ts";

export function taskVisibleForSearch(task: Task | undefined, opts: SearchOptions): boolean {
  if (!task) return false;
  const state = taskLifecycleState(task);
  switch (opts.taskVisibility) {
    case "active-done-archived":
      return true;
    case "active-only":
      return state === "active";
    default:
      // "active-and-done" and unresolved options: everything except archived.
      return state !== "archived";
  }
}

export function taskMatchesSearchFilters(task: Task, opts: SearchOptions): boolean {
  if (opts.status && task.status !== opts.status) return false;
  if (opts.priority && task.priority !== opts.priority) return false;
  if (opts.assignee && (task.assignee ?? "") !== opts.assignee) return false;
  if (opts.label && !containsStr(task.labels ?? [], opts.label)) return false;
  return true;
}

export function taskLifecycleRank(state: TaskLifecycleState | undefined): number {
  switch (state) {
    case "active":
      return 0;
    case "done":
      return 1;
    case "archived":
      return 2;
    default:
      return 3;
  }
}

export function memoryVisibleForSearch(
  entry: MemoryEntry | undefined,
  opts: Pick<SearchOptions, "status" | "includeHistorical">,
): boolean {
  if (!entry) return false;
  if (opts.status && validMemoryStatus(opts.status)) return (entry.status ?? "") === opts.status;
  if (opts.includeHistorical) return true;
  return memoryCurrentForDefaultRetrieval(entry);
}

export function decisionVisibleForSearch(
  decision: DecisionEntry | undefined,
  opts: Pick<SearchOptions, "status" | "includeHistorical">,
): boolean {
  if (!decision) return false;
  if (opts.status && validDecisionStatus(opts.status)) return decision.status === opts.status;
  if (opts.includeHistorical) return true;
  return decisionCurrentForDefaultRetrieval(decision);
}
