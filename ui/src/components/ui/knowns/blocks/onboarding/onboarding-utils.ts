export type ChecklistStatus = "done" | "current" | "todo" | "locked";

/** The fields the helpers read from a step. */
export interface ChecklistStepLike {
  id: string;
  done?: boolean;
  /** `true`, or the reason as a string ("Connect your agent first"). */
  locked?: boolean | string;
}

/** How many steps are done, out of how many. `complete` needs at least one step. */
export function checklistCounts(steps: readonly ChecklistStepLike[]): { done: number; total: number; complete: boolean } {
  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  return { done, total, complete: total > 0 && done === total };
}

/** "3 of 5". */
export const progressLabel = (done: number, total: number) => `${done} of ${total}`;

/** The step to do next: the first one that is neither done nor locked. Null when nothing is left to do. */
export function currentStepId(steps: readonly ChecklistStepLike[]): string | null {
  return steps.find((s) => !s.done && !s.locked)?.id ?? null;
}

/** Done wins over locked; the current step is the first available one; other available steps are "todo". */
export function checklistStatus(step: ChecklistStepLike, currentId: string | null): ChecklistStatus {
  if (step.done) return "done";
  if (step.locked) return "locked";
  return step.id === currentId ? "current" : "todo";
}

/** The reason a step is locked, when one was given. */
export const lockedReason = (step: ChecklistStepLike) => (typeof step.locked === "string" ? step.locked : undefined);
