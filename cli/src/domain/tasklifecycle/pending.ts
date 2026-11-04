// Pending-lifecycle records: building them in Go's field order and the pure helpers that apply
// lifecycle data to a Task. Task files and tombstones stay canonical; a pending record only tracks
// one stable lifecycle event and its derived delivery state.
import { randomBytes } from "node:crypto";
import type { Task } from "../../models/task.ts";
import type { TaskLifecycleData, TaskLifecyclePending } from "../../models/task-lifecycle.ts";
import { sameInstant, sameOptionalInstant, unixNano, wireTime } from "./clock.ts";
import { cloneTask } from "./policy.ts";
import type { LifecycleEvent, Operation } from "./types.ts";

/** task:<id>:<operation>:<unix-nano>:<8 random bytes, hex>; the stable id of one event. */
export function lifecycleEventId(taskId: string, operation: Operation, at: Date | string): string {
  const date = typeof at === "string" ? new Date(Date.parse(at)) : at;
  return `task:${taskId}:${operation}:${unixNano(date)}:${randomBytes(8).toString("hex")}`;
}

export function pendingFromEvent(event: LifecycleEvent): TaskLifecyclePending {
  const pending: TaskLifecyclePending = {
    eventId: event.id,
    taskId: event.taskId,
    operation: event.type,
    at: event.at,
    from: event.from,
    to: event.to,
    canonicalComplete: false,
    eventDelivered: false,
    derivedApplied: false,
  };
  if (event.actor) pending.actor = event.actor;
  if (event.reason) pending.reason = event.reason;
  if (event.automatic) pending.automatic = true;
  return pending;
}

export function pendingForTransition(
  event: LifecycleEvent,
  original: Task,
  desired: Task,
): TaskLifecyclePending {
  const pending = pendingFromEvent(event);
  pending.original = lifecycleDataFromTask(original);
  pending.desired = lifecycleDataFromTask(desired);
  return pending;
}

/** Go's json field order for TaskLifecyclePending, with omitempty applied. */
export function orderedPending(p: TaskLifecyclePending): TaskLifecyclePending {
  const out: Record<string, unknown> = {
    eventId: p.eventId,
    taskId: p.taskId,
    operation: p.operation,
    at: wireTime(new Date(Date.parse(p.at))),
  };
  if (p.actor) out.actor = p.actor;
  if (p.reason) out.reason = p.reason;
  out.from = p.from;
  out.to = p.to;
  if (p.automatic) out.automatic = true;
  if (p.original) out.original = orderedData(p.original);
  if (p.desired) out.desired = orderedData(p.desired);
  if (p.moveComplete) out.moveComplete = true;
  if (p.patchComplete) out.patchComplete = true;
  if (p.versionComplete) out.versionComplete = true;
  out.canonicalComplete = p.canonicalComplete;
  out.eventDelivered = p.eventDelivered;
  out.derivedApplied = p.derivedApplied;
  if (p.canonicalPath) out.canonicalPath = p.canonicalPath;
  if (p.canonicalHash) out.canonicalHash = p.canonicalHash;
  if (p.eventClaim)
    out.eventClaim = { token: p.eventClaim.token, claimedAt: p.eventClaim.claimedAt };
  if (p.derivedClaim) {
    out.derivedClaim = { token: p.derivedClaim.token, claimedAt: p.derivedClaim.claimedAt };
  }
  return out as TaskLifecyclePending;
}

function orderedData(d: TaskLifecycleData): TaskLifecycleData {
  const out: Record<string, unknown> = { status: d.status, updatedAt: d.updatedAt };
  if (d.completedAt !== undefined) out.completedAt = d.completedAt;
  if (d.archivedAt !== undefined) out.archivedAt = d.archivedAt;
  out.archived = d.archived;
  return out as TaskLifecycleData;
}

export function lifecycleDataFromTask(task: Task): TaskLifecycleData {
  const data: TaskLifecycleData = {
    status: task.status,
    updatedAt: task.updatedAt,
    archived: task.archived,
  };
  if (task.completedAt !== undefined) data.completedAt = task.completedAt;
  if (task.archivedAt !== undefined) data.archivedAt = task.archivedAt;
  return data;
}

export function taskWithLifecycleData(task: Task, data: TaskLifecycleData | undefined): Task {
  const result = cloneTask(task);
  if (!data) return result;
  result.status = data.status;
  result.updatedAt = data.updatedAt;
  if (data.completedAt !== undefined) result.completedAt = data.completedAt;
  else delete result.completedAt;
  if (data.archivedAt !== undefined) result.archivedAt = data.archivedAt;
  else delete result.archivedAt;
  result.archived = data.archived;
  return result;
}

export function lifecycleDataMatches(task: Task, data: TaskLifecycleData | undefined): boolean {
  if (!data) return false;
  return (
    task.status === data.status &&
    sameInstant(task.updatedAt, data.updatedAt) &&
    sameOptionalInstant(task.completedAt, data.completedAt) &&
    sameOptionalInstant(task.archivedAt, data.archivedAt) &&
    task.archived === data.archived
  );
}

export function eventFromPending(pending: TaskLifecyclePending): LifecycleEvent {
  const event: LifecycleEvent = {
    id: pending.eventId,
    type: pending.operation as Operation,
    taskId: pending.taskId,
    at: wireTime(new Date(Date.parse(pending.at))),
    from: pending.from,
    to: pending.to,
  };
  if (pending.actor) event.actor = pending.actor;
  if (pending.reason) event.reason = pending.reason;
  if (pending.automatic) event.automatic = true;
  return withEventKeyOrder(event);
}

/** Go's Event field order: id, type, taskId, at, actor, reason, from, to, automatic. */
export function withEventKeyOrder(e: LifecycleEvent): LifecycleEvent {
  const out: Record<string, unknown> = { id: e.id, type: e.type, taskId: e.taskId, at: e.at };
  if (e.actor) out.actor = e.actor;
  if (e.reason) out.reason = e.reason;
  out.from = e.from;
  out.to = e.to;
  if (e.automatic) out.automatic = true;
  return out as unknown as LifecycleEvent;
}
