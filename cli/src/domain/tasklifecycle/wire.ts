// JSON wire shapes of the lifecycle contract, in the key order and omitempty rules of Go's
// encoding/json for these structs. CLI `--json`, MCP and HTTP all serialize through these.
import type { Task } from "../../models/task.ts";
import type { ActiveTimer, TimeEntry } from "../../models/time.ts";
import type {
  HistoryMetadata,
  HistoryMetadataPage,
  TaskVersion,
  TaskVersionHistory,
} from "../../models/version.ts";
import { sortKeysDeep } from "../../storage/core/util.ts";
import type {
  BatchResult,
  Eligibility,
  LifecycleEvent,
  Reason,
  Response,
  Result,
  Warning,
} from "./types.ts";

export function reasonToWire(r: Reason): Record<string, unknown> {
  const out: Record<string, unknown> = { code: r.code, message: r.message };
  if (r.relatedTaskId) out.relatedTaskId = r.relatedTaskId;
  if (r.deadline !== undefined) out.deadline = r.deadline;
  return out;
}

export function warningToWire(w: Warning): Record<string, unknown> {
  const out: Record<string, unknown> = { code: w.code, message: w.message };
  if (w.references && w.references.length > 0) out.references = w.references;
  return out;
}

export function eventToWire(e: LifecycleEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { id: e.id, type: e.type, taskId: e.taskId, at: e.at };
  if (e.actor) out.actor = e.actor;
  if (e.reason) out.reason = e.reason;
  out.from = e.from;
  out.to = e.to;
  if (e.automatic) out.automatic = true;
  return out;
}

export function eligibilityToWire(e: Eligibility): Record<string, unknown> {
  const out: Record<string, unknown> = {
    taskId: e.taskId,
    eligible: e.eligible,
    lifecycle: e.lifecycle,
  };
  if (e.completedAt !== undefined) out.completedAt = e.completedAt;
  if (e.archivedAt !== undefined) out.archivedAt = e.archivedAt;
  if (e.deadline !== undefined) out.deadline = e.deadline;
  out.reasons = e.reasons.map(reasonToWire);
  if (e.warnings && e.warnings.length > 0) out.warnings = e.warnings.map(warningToWire);
  return out;
}

export function resultToWire(r: Result): Record<string, unknown> {
  const out: Record<string, unknown> = {
    taskId: r.taskId,
    operation: r.operation,
    changed: r.changed,
    eligible: r.eligible,
    before: r.before,
    after: r.after,
    reasons: r.reasons === null ? null : r.reasons.map(reasonToWire),
  };
  if (r.warnings && r.warnings.length > 0) out.warnings = r.warnings.map(warningToWire);
  if (r.event) out.event = eventToWire(r.event);
  if (r.completedAt !== undefined) out.completedAt = r.completedAt;
  if (r.archivedAt !== undefined) out.archivedAt = r.archivedAt;
  if (r.deadline !== undefined) out.deadline = r.deadline;
  return out;
}

/** Response and BatchResult share one shape. */
export function responseToWire(r: Response | BatchResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    operation: r.operation,
    execute: r.execute,
    completed: r.completed,
    processed: r.processed,
    changed: r.changed,
  };
  if (r.failedTaskId) out.failedTaskId = r.failedTaskId;
  out.items = r.items.map(resultToWire);
  return out;
}

// --- Task, time and version history (models.Task and friends) --------------------------------------

export function timeEntryToWire(e: TimeEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { id: e.id, startedAt: e.startedAt };
  if (e.endedAt !== undefined) out.endedAt = e.endedAt;
  out.duration = e.duration;
  if (e.note) out.note = e.note;
  return out;
}

export function activeTimerToWire(t: ActiveTimer): Record<string, unknown> {
  const out: Record<string, unknown> = { taskId: t.taskId };
  if (t.taskTitle) out.taskTitle = t.taskTitle;
  out.startedAt = t.startedAt;
  out.pausedAt = t.pausedAt ?? null;
  out.totalPausedMs = t.totalPausedMs;
  return out;
}

/** models.Task as encoding/json writes it: struct order, omitempty, nil slices as null. */
export function taskToWire(t: Task): Record<string, unknown> {
  const out: Record<string, unknown> = { id: t.id, title: t.title };
  if (t.description) out.description = t.description;
  out.status = t.status;
  out.priority = t.priority;
  if (t.assignee) out.assignee = t.assignee;
  out.labels = t.labels ?? null;
  if (t.parent) out.parent = t.parent;
  if (t.subtasks && t.subtasks.length > 0) out.subtasks = t.subtasks;
  if (t.spec) out.spec = t.spec;
  if (t.fulfills && t.fulfills.length > 0) out.fulfills = t.fulfills;
  if (t.order !== undefined) out.order = t.order;
  out.createdAt = t.createdAt;
  out.updatedAt = t.updatedAt;
  if (t.completedAt !== undefined) out.completedAt = t.completedAt;
  if (t.archivedAt !== undefined) out.archivedAt = t.archivedAt;
  out.archived = t.archived;
  out.acceptanceCriteria =
    t.acceptanceCriteria === null || t.acceptanceCriteria.length === 0
      ? null
      : t.acceptanceCriteria.map((ac) => ({ text: ac.text, completed: ac.completed }));
  out.timeSpent = t.timeSpent;
  if (t.timeEntries && t.timeEntries.length > 0)
    out.timeEntries = t.timeEntries.map(timeEntryToWire);
  if (t.activeTimer) out.activeTimer = activeTimerToWire(t.activeTimer);
  if (t.workedBy) {
    out.workedBy = {
      client: t.workedBy.client,
      ...(t.workedBy.version ? { version: t.workedBy.version } : {}),
      since: t.workedBy.since,
      active: t.workedBy.active,
    };
  }
  if (t.canonicalHash) out.canonicalHash = t.canonicalHash;
  if (t.implementationPlan) out.implementationPlan = t.implementationPlan;
  if (t.implementationNotes) out.implementationNotes = t.implementationNotes;
  return out;
}

/** models.TaskVersion: struct order; the snapshot and change values are maps, so keys sort. */
export function taskVersionToWire(v: TaskVersion): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: v.id,
    taskId: v.taskId,
    version: v.version,
    timestamp: v.timestamp,
  };
  if (v.author) out.author = v.author;
  if (v.lifecycleEventId) out.lifecycleEventId = v.lifecycleEventId;
  out.changes =
    v.changes === null
      ? null
      : v.changes.map((c) => ({
          field: c.field,
          oldValue: sortKeysDeep(c.oldValue ?? null),
          newValue: sortKeysDeep(c.newValue ?? null),
        }));
  out.snapshot = v.snapshot ? sortKeysDeep(v.snapshot) : null;
  if (v.schemaVersion) out.schemaVersion = v.schemaVersion;
  if (v.baseHash) out.baseHash = v.baseHash;
  if (v.newHash) out.newHash = v.newHash;
  if (v.checkpoint) out.checkpoint = true;
  if (v.source) out.source = v.source;
  if (v.sessionId) out.sessionId = v.sessionId;
  if (v.batchId) out.batchId = v.batchId;
  if (v.operation) out.operation = v.operation;
  if (v.tombstone) out.tombstone = true;
  if (v.legacyUnverified) out.legacyUnverified = true;
  if (v.legacyPath) out.legacyPath = v.legacyPath;
  if (v.legacyDigest) out.legacyDigest = v.legacyDigest;
  return out;
}

export function taskVersionHistoryToWire(h: TaskVersionHistory): Record<string, unknown> {
  const out: Record<string, unknown> = {
    taskId: h.taskId,
    currentVersion: h.currentVersion,
    versions: h.versions === null ? null : h.versions.map(taskVersionToWire),
  };
  if (h.tailTruncated) out.tailTruncated = true;
  return out;
}

/** models.HistoryMetadata: struct order, omitempty. */
export function historyMetadataToWire(m: HistoryMetadata): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (m.schemaVersion) out.schemaVersion = m.schemaVersion;
  out.entityType = m.entityType;
  out.entityId = m.entityId;
  out.revision = m.revision;
  out.id = m.id;
  out.timestamp = m.timestamp;
  const optional: [string, unknown][] = [
    ["author", m.author],
    ["actor", m.actor],
    ["source", m.source],
    ["auditEventId", m.auditEventId],
    ["sessionId", m.sessionId],
    ["batchId", m.batchId],
    ["operation", m.operation],
    ["tombstone", m.tombstone],
    ["lifecycleEventId", m.lifecycleEventId],
    ["baseHash", m.baseHash],
    ["newHash", m.newHash],
    ["prevRecordHash", m.prevRecordHash],
    ["recordHash", m.recordHash],
    ["checkpoint", m.checkpoint],
    ["legacyRevision", m.legacyRevision],
    ["legacyId", m.legacyId],
    ["legacy", m.legacy],
    ["legacyUnverified", m.legacyUnverified],
    ["legacyPath", m.legacyPath],
    ["legacyDigest", m.legacyDigest],
  ];
  for (const [key, value] of optional) if (value) out[key] = value;
  if (m.retentionGaps && m.retentionGaps.length > 0) out.retentionGaps = m.retentionGaps;
  if (m.currentPath) out.currentPath = m.currentPath;
  if (m.previousPath) out.previousPath = m.previousPath;
  return out;
}

/** models.HistoryMetadataPage: struct order, omitempty. */
export function historyMetadataPageToWire(p: HistoryMetadataPage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.entityType) out.entityType = p.entityType;
  if (p.entityId) out.entityId = p.entityId;
  if (p.docPath) out.docPath = p.docPath;
  if (p.currentPath) out.currentPath = p.currentPath;
  if (p.retentionGaps && p.retentionGaps.length > 0) out.retentionGaps = p.retentionGaps;
  out.offset = p.offset;
  out.limit = p.limit;
  out.hasMore = p.hasMore;
  if (p.nextOffset !== undefined) out.nextOffset = p.nextOffset;
  out.currentVersion = p.currentVersion;
  out.items = p.items === null ? null : p.items.map(historyMetadataToWire);
  if (p.tailTruncated) out.tailTruncated = true;
  return out;
}
