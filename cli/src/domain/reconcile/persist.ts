// Durable file writes of the reconciler (manifest, lifecycle intents) and the manifest codec.
//
// Go marshals the manifest and the intents file with encoding/json: struct fields in declaration
// order, map keys sorted. The objects built here follow that order, so the bytes match.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { GO_ZERO_TIME } from "../../models/common.ts";
import { goJsonStringify } from "../../storage/core/util.ts";
import { goTime } from "../../storage/history/go-json.ts";
import { syncDirectory } from "../../storage/history/history-store.ts";
import { isNotExist } from "./fs-util.ts";
import {
  emptyResult,
  type ManifestEntry,
  type ReconcileManifest,
  type ReconcileResult,
} from "./types.ts";

/** Write `text` through a synced temp file and a rename, then fsync the directory. */
export function writeFileDurable(path: string, text: string, tmpPrefix: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = join(dir, `${tmpPrefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}.tmp`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  syncDirectory(dir);
}

/** Go's `map[string]T` marshal order: keys sorted bytewise. */
export function sortedObject<T>(entries: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(entries).sort()) out[key] = entries[key] as T;
  return out;
}

export function manifestKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function entryWire(e: ManifestEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    entityType: e.entityType,
    entityId: e.entityId,
    path: e.path,
    hash: e.hash,
  };
  if (e.revision) out.revision = e.revision;
  if (e.headHash) out.headHash = e.headHash;
  return out;
}

export function manifestText(m: ReconcileManifest): string {
  const entries: Record<string, unknown> = {};
  for (const key of Object.keys(m.entries).sort())
    entries[key] = entryWire(m.entries[key] as ManifestEntry);
  return `${goJsonStringify({ schemaVersion: m.schemaVersion, entries })}\n`;
}

/** readManifest: a missing file is an empty manifest; an unparseable one is an error. */
export function readManifestFile(path: string): ReconcileManifest {
  const m: ReconcileManifest = { schemaVersion: 1, entries: {} };
  let data: string;
  try {
    data = readFileSync(path, "utf8");
  } catch (e) {
    if (isNotExist(e)) return m;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (e) {
    throw new Error(`parse reconciliation manifest: ${(e as Error).message}`, { cause: e });
  }
  if (parsed && typeof parsed === "object") {
    const p = parsed as { schemaVersion?: unknown; entries?: unknown };
    if (typeof p.schemaVersion === "number") m.schemaVersion = p.schemaVersion;
    if (p.entries && typeof p.entries === "object") {
      for (const [key, raw] of Object.entries(
        p.entries as Record<string, Record<string, unknown>>,
      )) {
        m.entries[key] = {
          entityType: String(raw.entityType ?? ""),
          entityId: String(raw.entityId ?? ""),
          path: String(raw.path ?? ""),
          hash: String(raw.hash ?? ""),
          revision: typeof raw.revision === "number" ? raw.revision : 0,
          headHash: String(raw.headHash ?? ""),
        };
      }
    }
  }
  return m;
}

// --- lifecycle intents (ReconcileResult has no JSON tags, so Go's field names are the keys) ----

export function resultWire(r: ReconcileResult): Record<string, unknown> {
  return {
    EntityType: r.entityType,
    EntityID: r.entityId,
    Path: r.path,
    Hash: r.hash,
    Changed: r.changed,
    Revision: r.revision,
    Diagnostic: r.diagnostic,
    Operation: r.operation,
    BatchID: r.batchId,
    PreviousPath: r.previousPath,
    CurrentPath: r.currentPath,
    BaseHash: r.baseHash,
    NewHash: r.newHash,
    Pending: r.pending,
    RetryAt: r.retryAt ? goTime(r.retryAt.toISOString()) : GO_ZERO_TIME,
  };
}

export function resultFromWire(raw: Record<string, unknown>): ReconcileResult {
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const retry = s("RetryAt");
  const result = emptyResult({
    entityType: s("EntityType"),
    entityId: s("EntityID"),
    path: s("Path"),
    hash: s("Hash"),
    changed: raw.Changed === true,
    revision: typeof raw.Revision === "number" ? raw.Revision : 0,
    diagnostic: s("Diagnostic"),
    operation: s("Operation"),
    batchId: s("BatchID"),
    previousPath: s("PreviousPath"),
    currentPath: s("CurrentPath"),
    baseHash: s("BaseHash"),
    newHash: s("NewHash"),
    pending: raw.Pending === true,
  });
  if (retry !== "" && retry !== GO_ZERO_TIME) result.retryAt = new Date(retry);
  return result;
}
