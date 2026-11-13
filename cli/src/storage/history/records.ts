// Port of the record envelope in internal/storage/history_jsonl.go: errors, the wire form of a
// HistoryRecord (field order and omitempty), the record hash, and chain validation.
import type {
  DocChange,
  DocChangeScope,
  DocHistoryGap,
  HistoryRecord,
  TaskChange,
} from "../../models/version.ts";
import { historyRecordSchema } from "../../models/version.ts";
import { type AnyMap, goMarshal, goTime, Sorted, sha256Hex } from "./go-json.ts";

export const HISTORY_SCHEMA_VERSION = 1;

export const LIFECYCLE_OPERATION_CREATE = "create";
export const LIFECYCLE_OPERATION_RENAME = "rename";
export const LIFECYCLE_OPERATION_DELETE = "delete";
export const LIFECYCLE_OPERATION_RESTORE = "restore";
export const LIFECYCLE_OPERATION_HARD_DELETE = "hard_delete";
export const LIFECYCLE_OPERATION_UPDATE = "update";

// --- errors ------------------------------------------------------------------------------------

/** ErrHistoryCorrupt: a complete line, sequence, or hash chain cannot be trusted. */
export class HistoryCorruptError extends Error {
  override readonly name = "HistoryCorruptError";
  constructor(detail: string) {
    super(`history is corrupt: ${detail}`);
  }
}

/** ErrHistoryConflict: an append was based on a stale canonical head. Carries no entity content. */
export class HistoryConflictError extends Error {
  override readonly name: string = "HistoryConflictError";
  constructor(detail?: string) {
    super(detail === undefined ? "history conflict" : `history conflict: ${detail}`);
  }
}

/** errors.Is(err, ErrHistoryCorrupt), including a cause chain. */
export function isHistoryCorrupt(err: unknown): boolean {
  return matchesError(err, HistoryCorruptError);
}

/** errors.Is(err, ErrHistoryConflict): conflict subclasses and wrapped causes count. */
export function isHistoryConflict(err: unknown): boolean {
  return matchesError(err, HistoryConflictError);
}

function matchesError(err: unknown, ctor: abstract new (...args: never[]) => Error): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 16 && e instanceof Error; depth++) {
    if (e instanceof (ctor as unknown as new () => Error)) return true;
    e = (e as Error).cause;
  }
  return false;
}

/** Wrap with `%w` semantics: message gets a prefix, the cause stays reachable. */
export function wrapError(prefix: string, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${prefix}: ${message}`, { cause });
}

export function validHistoryEntityType(entityType: string): entityType is "task" | "doc" {
  return entityType === "task" || entityType === "doc";
}

// --- wire form ---------------------------------------------------------------------------------

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && v !== 0 && v !== false;

function put(out: AnyMap, key: string, value: unknown): void {
  if (isSet(value)) out[key] = value;
}

function gapWire(gap: DocHistoryGap): AnyMap {
  const out: AnyMap = { type: gap.type, reason: gap.reason, count: gap.count };
  put(out, "beforeVersion", gap.beforeVersion);
  put(out, "afterVersion", gap.afterVersion);
  out.appliedAt = goTime(gap.appliedAt);
  return out;
}

function scopeWire(scope: DocChangeScope): AnyMap {
  const out: AnyMap = { type: scope.type };
  put(out, "field", scope.field);
  put(out, "section", scope.section);
  put(out, "summary", scope.summary);
  put(out, "oldBytes", scope.oldBytes);
  put(out, "newBytes", scope.newBytes);
  put(out, "deltaBytes", scope.deltaBytes);
  return out;
}

function changeWire(change: TaskChange | DocChange, sort: boolean): AnyMap {
  const wrap = (v: unknown) => (sort ? new Sorted(v ?? null) : (v ?? null));
  return { field: change.field, oldValue: wrap(change.oldValue), newValue: wrap(change.newValue) };
}

/**
 * models.HistoryRecord in struct order with `omitempty` applied. With `sortPayloads` the
 * `any`-typed payloads (change values, checkpoint payload) are emitted with sorted keys, which is
 * what Go produces after any JSON read and what the record hash always covers.
 */
export function recordWire(record: HistoryRecord, sortPayloads: boolean): AnyMap {
  const out: AnyMap = {
    schemaVersion: record.schemaVersion ?? 0,
    entityType: record.entityType ?? "",
    entityId: record.entityId ?? "",
    revision: record.revision ?? 0,
    timestamp: goTime(record.timestamp),
  };
  put(out, "author", record.author);
  put(out, "actor", record.actor);
  put(out, "source", record.source);
  put(out, "auditEventId", record.auditEventId);
  put(out, "sessionId", record.sessionId);
  put(out, "batchId", record.batchId);
  put(out, "operation", record.operation);
  put(out, "tombstone", record.tombstone);
  put(out, "lifecycleEventId", record.lifecycleEventId);
  put(out, "baseHash", record.baseHash);
  put(out, "newHash", record.newHash);
  put(out, "prevRecordHash", record.prevRecordHash);
  put(out, "recordHash", record.recordHash);
  put(out, "checkpoint", record.checkpoint);
  put(out, "legacyRevision", record.legacyRevision);
  put(out, "legacyId", record.legacyId);
  put(out, "legacy", record.legacy);
  put(out, "legacyUnverified", record.legacyUnverified);
  put(out, "legacyBaseHash", record.legacyBaseHash);
  put(out, "legacyNewHash", record.legacyNewHash);
  put(out, "legacyPath", record.legacyPath);
  put(out, "legacyDigest", record.legacyDigest);
  if (record.retentionGaps && record.retentionGaps.length > 0) {
    out.retentionGaps = record.retentionGaps.map(gapWire);
  }
  if (record.taskChanges && record.taskChanges.length > 0) {
    out.taskChanges = record.taskChanges.map((c) => changeWire(c, sortPayloads));
  }
  if (record.docChanges && record.docChanges.length > 0) {
    out.docChanges = record.docChanges.map((c) => changeWire(c, sortPayloads));
  }
  if (record.changedScopes && record.changedScopes.length > 0) {
    out.changedScopes = record.changedScopes.map(scopeWire);
  }
  put(out, "currentPath", record.currentPath);
  put(out, "previousPath", record.previousPath);
  if (record.checkpointPayload && Object.keys(record.checkpointPayload).length > 0) {
    out.checkpointPayload = new Sorted(record.checkpointPayload);
  }
  return out;
}

/**
 * historyRecordHash: SHA-256 of the record with an empty RecordHash, after the JSON normalization
 * Go applies (so payload maps are key-sorted and numbers are float64).
 */
export function historyRecordHash(record: HistoryRecord): string {
  const wire = recordWire({ ...record, recordHash: "" }, true);
  return sha256Hex(goMarshal(wire, false));
}

/** One JSONL line (no newline) as `json.Marshal(record)` writes it on the append path. */
export function marshalRecordLine(record: HistoryRecord, sortPayloads = false): string {
  return goMarshal(recordWire(record, sortPayloads), false);
}

/** json.Unmarshal of a line into models.HistoryRecord; throws HistoryCorruptError detail text. */
export function decodeRecord(parsed: unknown): HistoryRecord {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }
  const input: AnyMap = {};
  for (const [key, value] of Object.entries(parsed as AnyMap)) {
    // Go leaves a field at its zero value for JSON null.
    if (value !== null || key === "checkpointPayload") input[key] = value;
  }
  if (input.checkpointPayload === null) delete input.checkpointPayload;
  if (input.timestamp === undefined) input.timestamp = goTime(undefined);
  for (const list of ["taskChanges", "docChanges"] as const) {
    const items = input[list];
    if (Array.isArray(items)) {
      input[list] = items.map((c) => {
        const item = (c ?? {}) as AnyMap;
        return {
          field: item.field,
          oldValue: item.oldValue ?? null,
          newValue: item.newValue ?? null,
        };
      });
    }
  }
  const result = historyRecordSchema.safeParse(input);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? "invalid record");
  const record = result.data as HistoryRecord;
  record.timestamp = goTime(record.timestamp);
  for (const gap of record.retentionGaps ?? []) gap.appliedAt = goTime(gap.appliedAt);
  return record;
}

// --- validation --------------------------------------------------------------------------------

export function checkpointPayloadPresent(record: HistoryRecord): boolean {
  return !!record.checkpointPayload && Object.keys(record.checkpointPayload).length > 0;
}

export function validateHistoryRecord(
  record: HistoryRecord,
  expected: number,
  previous: readonly HistoryRecord[],
  entityType: string,
  entityId: string,
): void {
  validateHistoryEnvelope(
    record,
    expected,
    previous,
    entityType,
    entityId,
    checkpointPayloadPresent(record),
    false,
  );
}

export function validateHistoryEnvelope(
  record: HistoryRecord,
  expected: number,
  previous: readonly HistoryRecord[],
  entityType: string,
  entityId: string,
  payloadPresent: boolean,
  recordHashVerified: boolean,
): void {
  if (
    record.schemaVersion !== HISTORY_SCHEMA_VERSION ||
    !validHistoryEntityType(record.entityType) ||
    !record.entityId
  ) {
    throw new HistoryCorruptError(`invalid record identity/schema at revision ${expected}`);
  }
  if (entityType !== "" && (record.entityType !== entityType || record.entityId !== entityId)) {
    throw new HistoryCorruptError(
      `record entity does not match history stream at revision ${expected}`,
    );
  }
  if (record.revision !== expected) {
    throw new HistoryCorruptError(`revision gap, got ${record.revision} want ${expected}`);
  }
  if (!record.newHash && !record.legacyUnverified) {
    throw new HistoryCorruptError(`empty canonical hash at revision ${expected}`);
  }
  if (
    !recordHashVerified &&
    (!record.recordHash || record.recordHash !== historyRecordHash(record))
  ) {
    throw new HistoryCorruptError(`record hash mismatch at revision ${expected}`);
  }
  if (record.checkpoint && !payloadPresent && !record.legacyUnverified) {
    throw new HistoryCorruptError(`checkpoint payload missing at revision ${expected}`);
  }
  if (previous.length === 0) {
    if (
      (!record.checkpoint && !record.legacyUnverified) ||
      (record.baseHash && !record.legacyUnverified)
    ) {
      throw new HistoryCorruptError(
        "first history record must be a checkpoint with empty base hash",
      );
    }
    return;
  }
  const last = previous[previous.length - 1] as HistoryRecord;
  if ((record.prevRecordHash ?? "") !== (last.recordHash ?? "")) {
    throw new HistoryCorruptError(`record hash chain mismatch at revision ${expected}`);
  }
  const reconcileAfterLegacy = record.source === "migration-reconcile" && !!last.legacyUnverified;
  if (
    !record.legacyUnverified &&
    !reconcileAfterLegacy &&
    (!record.baseHash || !last.newHash || record.baseHash !== last.newHash)
  ) {
    throw new HistoryCorruptError(`canonical hash chain mismatch at revision ${expected}`);
  }
}
