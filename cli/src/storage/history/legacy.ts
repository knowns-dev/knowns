// The two legacy JSON shapes under .knowns/versions/: per-task `task-<id>.json` and per-doc
// `doc-<path>.json` / `docid-<id>.json`. Decoders mimic encoding/json into models.TaskVersionHistory
// and models.DocVersionHistory; encoders reproduce what Go would marshal back (used to prove that
// the history handed to a migration is exactly what is on disk).
import type {
  DocChange,
  DocChangeScope,
  DocHistoryGap,
  DocVersion,
  DocVersionHistory,
  TaskChange,
  TaskVersion,
  TaskVersionHistory,
} from "../../models/version.ts";
import { type AnyMap, goTime } from "./go-json.ts";

const isObj = (v: unknown): v is AnyMap => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

function assign(target: AnyMap, fields: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) target[k] = v;
}

function decodeChanges(v: unknown): TaskChange[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((c) => {
    const o = isObj(c) ? c : {};
    return {
      field: str(o.field) ?? "",
      oldValue: o.oldValue ?? null,
      newValue: o.newValue ?? null,
    };
  });
}

function decodeScopes(v: unknown): DocChangeScope[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((s) => {
    const o = isObj(s) ? s : {};
    const scope: AnyMap = { type: str(o.type) ?? "" };
    assign(scope, {
      field: str(o.field),
      section: str(o.section),
      summary: str(o.summary),
      oldBytes: num(o.oldBytes),
      newBytes: num(o.newBytes),
      deltaBytes: num(o.deltaBytes),
    });
    return scope as unknown as DocChangeScope;
  });
}

function decodeGaps(v: unknown): DocHistoryGap[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((g) => {
    const o = isObj(g) ? g : {};
    return {
      type: str(o.type) ?? "",
      reason: str(o.reason) ?? "",
      count: num(o.count) ?? 0,
      beforeVersion: str(o.beforeVersion),
      afterVersion: str(o.afterVersion),
      appliedAt: goTime(str(o.appliedAt)),
    };
  });
}

function snapshotOf(v: unknown): AnyMap | null {
  return isObj(v) ? v : null;
}

export function decodeTaskVersionHistory(input: unknown): TaskVersionHistory {
  const o = isObj(input) ? input : {};
  const versions = Array.isArray(o.versions) ? o.versions : [];
  const history: TaskVersionHistory = {
    taskId: str(o.taskId) ?? "",
    currentVersion: num(o.currentVersion) ?? 0,
    versions: versions.map((raw): TaskVersion => {
      const v = isObj(raw) ? raw : {};
      const version: AnyMap = {
        id: str(v.id) ?? "",
        taskId: str(v.taskId) ?? "",
        version: num(v.version) ?? 0,
        timestamp: goTime(str(v.timestamp)),
        changes: decodeChanges(v.changes),
        snapshot: snapshotOf(v.snapshot),
      };
      for (const key of [
        "author",
        "lifecycleEventId",
        "baseHash",
        "newHash",
        "source",
        "sessionId",
        "batchId",
        "operation",
        "legacyPath",
        "legacyDigest",
      ]) {
        const s = str(v[key]);
        if (s) version[key] = s;
      }
      if (num(v.schemaVersion)) version.schemaVersion = num(v.schemaVersion);
      for (const key of ["checkpoint", "tombstone", "legacyUnverified"])
        if (bool(v[key])) version[key] = true;
      return version as unknown as TaskVersion;
    }),
  };
  if (bool(o.tailTruncated)) history.tailTruncated = true;
  return history;
}

export function decodeDocVersionHistory(input: unknown): DocVersionHistory {
  const o = isObj(input) ? input : {};
  const versions = Array.isArray(o.versions) ? o.versions : [];
  const history: AnyMap = {
    docPath: str(o.docPath) ?? "",
    currentVersion: num(o.currentVersion) ?? 0,
    versions: versions.map((raw): DocVersion => {
      const v = isObj(raw) ? raw : {};
      const version: AnyMap = {
        id: str(v.id) ?? "",
        docPath: str(v.docPath) ?? "",
        version: num(v.version) ?? 0,
        timestamp: goTime(str(v.timestamp)),
        changes: decodeChanges(v.changes),
        snapshot: snapshotOf(v.snapshot),
      };
      for (const key of [
        "docId",
        "currentPath",
        "previousPath",
        "author",
        "actor",
        "source",
        "auditEventId",
        "sessionId",
        "baseHash",
        "newHash",
        "batchId",
        "recordHash",
        "operation",
        "legacyPath",
        "legacyDigest",
      ]) {
        const s = str(v[key]);
        if (s) version[key] = s;
      }
      if (num(v.schemaVersion)) version.schemaVersion = num(v.schemaVersion);
      for (const key of ["checkpoint", "tombstone", "legacyUnverified"])
        if (bool(v[key])) version[key] = true;
      const scopes = decodeScopes(v.changedScopes);
      if (scopes && scopes.length > 0) version.changedScopes = scopes;
      return version as unknown as DocVersion;
    }),
  };
  assign(history, {
    docId: str(o.docId) || undefined,
    currentPath: str(o.currentPath) || undefined,
  });
  const gaps = decodeGaps(o.retentionGaps);
  if (gaps && gaps.length > 0) history.retentionGaps = gaps;
  if (bool(o.tailTruncated)) history.tailTruncated = true;
  return history as unknown as DocVersionHistory;
}

// --- encoders (what Go's json.Marshal writes for the same structs) ------------------------------

function omit(target: AnyMap, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== "" && value !== 0 && value !== false) {
    target[key] = value;
  }
}

const changeOut = (c: TaskChange | DocChange) => ({
  field: c.field,
  oldValue: c.oldValue ?? null,
  newValue: c.newValue ?? null,
});

export function encodeTaskVersionHistory(h: TaskVersionHistory): AnyMap {
  const out: AnyMap = {
    taskId: h.taskId,
    currentVersion: h.currentVersion,
    versions: (h.versions ?? []).map((v) => {
      const o: AnyMap = {
        id: v.id,
        taskId: v.taskId,
        version: v.version,
        timestamp: goTime(v.timestamp),
      };
      omit(o, "author", v.author);
      omit(o, "lifecycleEventId", v.lifecycleEventId);
      o.changes = v.changes ? v.changes.map(changeOut) : null;
      o.snapshot = v.snapshot ?? null;
      omit(o, "schemaVersion", v.schemaVersion);
      omit(o, "baseHash", v.baseHash);
      omit(o, "newHash", v.newHash);
      omit(o, "checkpoint", v.checkpoint);
      omit(o, "source", v.source);
      omit(o, "sessionId", v.sessionId);
      omit(o, "batchId", v.batchId);
      omit(o, "operation", v.operation);
      omit(o, "tombstone", v.tombstone);
      omit(o, "legacyUnverified", v.legacyUnverified);
      omit(o, "legacyPath", v.legacyPath);
      omit(o, "legacyDigest", v.legacyDigest);
      return o;
    }),
  };
  omit(out, "tailTruncated", h.tailTruncated);
  return out;
}

export function encodeDocVersionHistory(h: DocVersionHistory): AnyMap {
  const out: AnyMap = {};
  omit(out, "docId", h.docId);
  out.docPath = h.docPath;
  omit(out, "currentPath", h.currentPath);
  out.currentVersion = h.currentVersion;
  out.versions = (h.versions ?? []).map((v) => {
    const o: AnyMap = { id: v.id };
    omit(o, "docId", v.docId);
    o.docPath = v.docPath;
    omit(o, "currentPath", v.currentPath);
    omit(o, "previousPath", v.previousPath);
    o.version = v.version;
    o.timestamp = goTime(v.timestamp);
    omit(o, "author", v.author);
    omit(o, "actor", v.actor);
    omit(o, "source", v.source);
    omit(o, "auditEventId", v.auditEventId);
    omit(o, "sessionId", v.sessionId);
    omit(o, "baseHash", v.baseHash);
    omit(o, "newHash", v.newHash);
    omit(o, "checkpoint", v.checkpoint);
    o.changes = v.changes ? v.changes.map(changeOut) : null;
    if (v.changedScopes && v.changedScopes.length > 0) o.changedScopes = v.changedScopes;
    o.snapshot = v.snapshot ?? null;
    omit(o, "schemaVersion", v.schemaVersion);
    omit(o, "batchId", v.batchId);
    omit(o, "recordHash", v.recordHash);
    omit(o, "operation", v.operation);
    omit(o, "tombstone", v.tombstone);
    omit(o, "legacyUnverified", v.legacyUnverified);
    omit(o, "legacyPath", v.legacyPath);
    omit(o, "legacyDigest", v.legacyDigest);
    return o;
  });
  if (h.retentionGaps && h.retentionGaps.length > 0) {
    out.retentionGaps = h.retentionGaps.map((g) => {
      const o: AnyMap = { type: g.type, reason: g.reason, count: g.count };
      omit(o, "beforeVersion", g.beforeVersion);
      omit(o, "afterVersion", g.afterVersion);
      o.appliedAt = goTime(g.appliedAt);
      return o;
    });
  }
  omit(out, "tailTruncated", h.tailTruncated);
  return out;
}
