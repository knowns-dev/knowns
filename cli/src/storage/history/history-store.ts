// Port of internal/storage/history_jsonl.go and history_migration.go: one append-only JSONL stream
// per stable entity, hash-chained, with per-entity locking, durable activation, legacy migration,
// compaction, and the authorized purge primitives.
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  DocHistoryGap,
  DocVersionHistory,
  HistoryReadResult,
  HistoryRecord,
  TaskVersionHistory,
} from "../../models/version.ts";
import { type LockOptions, safeHistoryId, withHistoryEntityLock } from "../core/locks.ts";
import { goJsonStringify } from "../core/util.ts";
import {
  applyDocChangesToState,
  applyDocSnapshot,
  applyTaskChangesToMap,
  type DocState,
  docHistoryFromRecords,
  docToSnapshot,
  hashSnapshot,
  legacyDocId,
  normalizeDocPath,
  taskCanonicalHash,
  taskHistoryFromRecords,
} from "./entities.ts";
import {
  type AnyMap,
  cloneJson,
  firstNonEmpty,
  goDeepEqual,
  goMarshal,
  goNow,
  sha256Hex,
  sortedKeys,
  timeMs,
} from "./go-json.ts";
import {
  decodeDocVersionHistory,
  decodeTaskVersionHistory,
  encodeDocVersionHistory,
  encodeTaskVersionHistory,
} from "./legacy.ts";
import {
  decodeRecord,
  HISTORY_SCHEMA_VERSION,
  HistoryConflictError,
  HistoryCorruptError,
  historyRecordHash,
  isHistoryConflict,
  isHistoryCorrupt,
  marshalRecordLine,
  recordWire,
  validateHistoryRecord,
  validHistoryEntityType,
} from "./records.ts";

export const DEFAULT_HISTORY_MAX_DETAILED_REVISIONS = 200;
export const DEFAULT_HISTORY_MAX_DETAILED_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface HistoryRetentionPolicy {
  maxDetailedRevisions?: number;
  /** Milliseconds. */
  maxDetailedAgeMs?: number;
  now?: Date;
  reason?: string;
}

export function defaultHistoryRetentionPolicy(): HistoryRetentionPolicy {
  return {
    maxDetailedRevisions: DEFAULT_HISTORY_MAX_DETAILED_REVISIONS,
    maxDetailedAgeMs: DEFAULT_HISTORY_MAX_DETAILED_AGE_MS,
  };
}

/** Deterministic failure injection seams, as in Go's HistoryStoreOptions. */
export interface HistoryStoreOptions {
  append?: (fd: number, data: Uint8Array) => number;
  sync?: (fd: number) => void;
  syncDirectory?: (dir: string) => void;
  payloadDecode?: () => void;
  /** Called against a fully staged replacement before activation. */
  validate?: (records: HistoryRecord[]) => void;
  /** Failure-injection seams for compaction tests. */
  compactSync?: (fd: number) => void;
  rename?: (from: string, to: string) => void;
}

export interface LegacyCleanupTarget {
  entityType: string;
  entityId: string;
  legacyPath: string;
  jsonlPath: string;
  verified: boolean;
  reason?: string;
  legacyDigest?: string;
  jsonlHeadHash?: string;
  previewToken?: string;
}

export interface LegacyCleanupReport {
  targets: LegacyCleanupTarget[];
}

interface ReadInternal extends HistoryReadResult {
  records: HistoryRecord[];
  validBytes: number;
  validOffsets: number[];
}

/**
 * Truncate a log opened for append. Windows opens an O_APPEND handle with FILE_APPEND_DATA but no
 * FILE_WRITE_DATA, so SetEndOfFile on it fails with "Access is denied" (Go's File.Truncate has the
 * same limit there, which makes Go's tail recovery and append rollback fail on Windows). A second
 * short-lived read-write handle truncates the file; the append handle keeps writing at the new end.
 */
function truncateAppendLog(fd: number, path: string, size: number): void {
  if (process.platform !== "win32") {
    ftruncateSync(fd, size);
    return;
  }
  const rw = openSync(path, "r+");
  try {
    ftruncateSync(rw, size);
  } finally {
    closeSync(rw);
  }
}

/** syncDirectory: fsync a directory; Windows cannot, and that is not an error. */
export function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (
      !(
        process.platform === "win32" &&
        (code === "EPERM" || code === "EACCES" || code === "EISDIR")
      )
    ) {
      throw e;
    }
  } finally {
    closeSync(fd);
  }
}

function syncFilePath(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** durableWriteJSON: indented JSON + newline via a synced temp file and rename. */
export function durableWriteJson(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = join(
    dir,
    `.lifecycle-durable-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}.tmp`,
  );
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, `${goJsonStringify(sortKeysShallowDeep(value))}\n`);
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

function sortKeysShallowDeep(value: unknown): unknown {
  return JSON.parse(goMarshal(value, true));
}

function sameFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** HistoryStore persists one append-only JSONL stream per stable entity. */
export class HistoryStore {
  constructor(
    readonly root: string,
    private readonly opts: HistoryStoreOptions = {},
  ) {}

  historyRoot(): string {
    return join(this.root, "history");
  }

  entityDir(entityType: string): string {
    return join(this.historyRoot(), `${entityType.toLowerCase()}s`);
  }

  /** The stable path used for diagnostics and tests; "" for an unsupported type. */
  entityPath(entityType: string, entityId: string): string {
    if (!validHistoryEntityType(entityType)) return "";
    return join(this.entityDir(entityType), `${safeHistoryId(entityId)}.jsonl`);
  }

  lockPath(entityType: string, entityId: string): string {
    if (!validHistoryEntityType(entityType)) return "";
    return join(
      this.historyRoot(),
      "locks",
      `${entityType.toLowerCase()}-${safeHistoryId(entityId)}.lock`,
    );
  }

  hasHistory(entityType: string, entityId: string): boolean {
    return existsSync(this.entityPath(entityType, entityId));
  }

  /** withEntityLock: the per-entity cross-process lock (same file as the Go binary uses). */
  withEntityLock<T>(
    entityType: string,
    entityId: string,
    fn: () => T | Promise<T>,
    opts?: LockOptions,
  ): Promise<T> {
    if (!validHistoryEntityType(entityType)) {
      return Promise.reject(new Error(`unsupported history entity type "${entityType}"`));
    }
    return withHistoryEntityLock(this.root, entityType, entityId, fn, opts);
  }

  // --- append ----------------------------------------------------------------------------------

  /**
   * Append validates the existing stream, truncates only a recoverable final partial line, then
   * appends one newline-terminated record and fsyncs it.
   */
  async append(input: HistoryRecord, opts?: LockOptions): Promise<void> {
    const record: HistoryRecord = { ...input };
    if (!validHistoryEntityType(record.entityType)) {
      throw new Error(`unsupported history entity type "${record.entityType}"`);
    }
    if (!record.entityType || !record.entityId) {
      throw new Error("history record requires entity type and ID");
    }
    if (!record.schemaVersion) record.schemaVersion = HISTORY_SCHEMA_VERSION;
    if (record.schemaVersion !== HISTORY_SCHEMA_VERSION) {
      throw new Error(`unsupported history schema version ${record.schemaVersion}`);
    }
    const path = this.entityPath(record.entityType, record.entityId);
    await this.withEntityLock(
      record.entityType,
      record.entityId,
      () => {
        const read = this.readFile(path, record.entityType, record.entityId);
        const records = read.records;
        record.revision = records.length + 1;
        const last = records[records.length - 1];
        if (last) {
          record.prevRecordHash = last.recordHash;
          if (!record.legacyPath) record.legacyPath = last.legacyPath;
          if (!record.legacyDigest) record.legacyDigest = last.legacyDigest;
          if ((last.legacyRevision ?? 0) > 0) {
            record.legacyRevision = (last.legacyRevision as number) + 1;
            record.legacyId = `v${record.legacyRevision}`;
          }
        }
        record.recordHash = "";
        record.recordHash = historyRecordHash(record);
        try {
          validateHistoryRecord(
            record,
            record.revision,
            records,
            record.entityType,
            record.entityId,
          );
        } catch (err) {
          if (
            last &&
            record.newHash &&
            isHistoryCorrupt(err) &&
            (record.baseHash ?? "") !== (last.newHash ?? "")
          ) {
            throw new HistoryConflictError("stale history head");
          }
          throw err;
        }
        const data = Buffer.from(`${marshalRecordLine(record, false)}\n`, "utf8");
        mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
        const fd = openSync(path, "a", 0o600);
        try {
          if (read.tailTruncated) truncateAppendLog(fd, path, read.validBytes);
          const baseOffset = read.validBytes;
          const rollback = () => {
            try {
              truncateAppendLog(fd, path, baseOffset);
              fsyncSync(fd);
            } catch {
              // best effort, as in Go
            }
          };
          let n: number;
          try {
            n = (this.opts.append ?? ((f, b) => writeSync(f, b)))(fd, data);
          } catch (e) {
            rollback();
            throw new Error(`append history record: ${(e as Error).message}`, { cause: e });
          }
          if (n !== data.length) {
            rollback();
            throw new Error("short write");
          }
          try {
            (this.opts.sync ?? fsyncSync)(fd);
          } catch (e) {
            rollback();
            throw new Error(`sync history log: ${(e as Error).message}`, { cause: e });
          }
          try {
            (this.opts.syncDirectory ?? syncDirectory)(dirname(path));
          } catch (e) {
            rollback();
            throw new Error(`sync history directory: ${(e as Error).message}`, { cause: e });
          }
        } finally {
          closeSync(fd);
        }
      },
      opts,
    );
  }

  // --- reads -----------------------------------------------------------------------------------

  /**
   * Read returns all valid records and reports an incomplete final line. A complete malformed
   * line or any sequence/hash discontinuity fails closed.
   */
  async read(entityType: string, entityId: string, opts?: LockOptions): Promise<HistoryReadResult> {
    if (!validHistoryEntityType(entityType)) {
      throw new Error(`unsupported history entity type "${entityType}"`);
    }
    const path = this.entityPath(entityType, entityId);
    return this.withEntityLock(
      entityType,
      entityId,
      () => this.publicResult(this.readFile(path, entityType, entityId)),
      opts,
    );
  }

  /** Strictly read-only: creates no lock files when no history exists. */
  readPreview(entityType: string, entityId: string): HistoryReadResult {
    if (!validHistoryEntityType(entityType)) {
      throw new Error(`unsupported history entity type "${entityType}"`);
    }
    const path = this.entityPath(entityType, entityId);
    if (!existsSync(path)) return { records: [] };
    return this.publicResult(this.readFile(path, entityType, entityId));
  }

  private publicResult(read: ReadInternal): HistoryReadResult {
    const result: HistoryReadResult = { records: read.records };
    if (read.tailTruncated) result.tailTruncated = true;
    return result;
  }

  /** ReadRecord: one revision (physical numbering). */
  async readRecord(entityType: string, entityId: string, revision: number): Promise<HistoryRecord> {
    const window = await this.readRecordWindow(entityType, entityId, revision);
    return window[window.length - 1] as HistoryRecord;
  }

  /**
   * ReadRecordWindow: the nearest checkpoint and the payload-bearing records through `revision`.
   * Every record's envelope and hash are still verified.
   */
  async readRecordWindow(
    entityType: string,
    entityId: string,
    revision: number,
  ): Promise<HistoryRecord[]> {
    if (!validHistoryEntityType(entityType)) {
      throw new Error(`unsupported history entity type "${entityType}"`);
    }
    if (revision < 1) throw new Error(`history revision ${revision} not found`);
    const path = this.entityPath(entityType, entityId);
    return this.withEntityLock(entityType, entityId, () => {
      if (!existsSync(path)) throw new Error(`history revision ${revision} not found`);
      // Durability is defined at newline boundaries: an unterminated tail is never addressable.
      const read = this.readFile(path, entityType, entityId);
      if (revision > read.records.length) throw new Error(`history revision ${revision} not found`);
      let checkpoint = 0;
      for (let i = 0; i < revision; i++) if (read.records[i]?.checkpoint) checkpoint = i;
      return read.records.slice(checkpoint, revision);
    });
  }

  /** ListMetadata: payload-free records, paged by offset/limit (limit 0 = all). */
  async listMetadata(
    entityType: string,
    entityId: string,
    offset = 0,
    limit = 0,
  ): Promise<{ records: HistoryRecord[]; more: boolean; tailTruncated: boolean }> {
    if (!validHistoryEntityType(entityType)) {
      throw new Error(`unsupported history entity type "${entityType}"`);
    }
    const path = this.entityPath(entityType, entityId);
    const read = await this.withEntityLock(entityType, entityId, () => {
      if (!existsSync(path)) return undefined;
      return this.readFile(path, entityType, entityId);
    });
    const all = read?.records ?? [];
    const start = Math.min(Math.max(offset, 0), all.length);
    let end = all.length;
    if (limit > 0 && start + limit < end) end = start + limit;
    const records = all.slice(start, end).map((r) => {
      const copy: HistoryRecord = { ...r };
      delete copy.taskChanges;
      delete copy.docChanges;
      delete copy.changedScopes;
      delete copy.checkpointPayload;
      return copy;
    });
    return { records, more: end < all.length, tailTruncated: read?.tailTruncated ?? false };
  }

  /**
   * FindEntityByPath: locate a Doc history by its current or historical path, scanning every
   * stream (rename-safe, no index).
   */
  async findEntityByPath(entityType: string, entityPath: string): Promise<string | undefined> {
    if (!validHistoryEntityType(entityType)) {
      throw new Error(`unsupported history entity type "${entityType}"`);
    }
    const dir = this.entityDir(entityType);
    if (!existsSync(dir)) return undefined;
    const want = entityPath.trim().replace(/^\//, "");
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".jsonl") || statSync(join(dir, name)).isDirectory()) continue;
      const entityId = name.slice(0, -".jsonl".length);
      const result = await this.read(entityType, entityId);
      for (const record of result.records ?? []) {
        if (record.currentPath === want || record.previousPath === want) return record.entityId;
        const p = record.checkpointPayload?.path;
        if (typeof p === "string" && p === want) return record.entityId;
      }
    }
    return undefined;
  }

  /** FindEntityByPathMetadata: the same lookup without needing checkpoint payloads. */
  async findEntityByPathMetadata(
    entityType: string,
    entityPath: string,
  ): Promise<string | undefined> {
    if (!validHistoryEntityType(entityType)) {
      throw new Error(`unsupported history entity type "${entityType}"`);
    }
    const dir = this.entityDir(entityType);
    if (!existsSync(dir)) return undefined;
    const want = entityPath.trim().replace(/^\//, "");
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".jsonl") || statSync(join(dir, name)).isDirectory()) continue;
      const entityId = name.slice(0, -".jsonl".length);
      const { records } = await this.listMetadata(entityType, entityId);
      for (const record of records) {
        if (record.currentPath === want || record.previousPath === want) return record.entityId;
      }
    }
    return undefined;
  }

  // --- removal ---------------------------------------------------------------------------------

  /** Delete removes an entity's log through the same per-entity lock boundary. */
  async delete(entityType: string, entityId: string): Promise<void> {
    if (!validHistoryEntityType(entityType)) {
      throw new Error(`unsupported history entity type "${entityType}"`);
    }
    const path = this.entityPath(entityType, entityId);
    await this.withEntityLock(entityType, entityId, () => {
      if (!existsSync(path)) return;
      rmSync(path);
      syncDirectory(dirname(path));
    });
  }

  /**
   * PurgeAuthorized removes the exact JSONL stream and only a legacy successor proven to derive
   * from it. The caller is an already-authorized lifecycle adapter.
   */
  async purgeAuthorized(
    entityType: string,
    entityId: string,
    actor: string,
    reason: string,
    expectedHash: string,
  ): Promise<void> {
    if (reason.trim() === "") throw new Error("authorized history purge requires a reason");
    if (actor.trim() === "") actor = "task-lifecycle";
    await this.withEntityLock(entityType, entityId, async () => {
      let stream: ReadInternal | undefined;
      if (existsSync(this.entityPath(entityType, entityId))) {
        stream = this.readFile(this.entityPath(entityType, entityId), entityType, entityId);
      }
      const last = stream?.records[stream.records.length - 1];
      if (stream && expectedHash !== "" && last && (last.newHash ?? "") !== expectedHash) {
        throw new HistoryConflictError("history purge hash mismatch");
      }
      const marker: AnyMap = {
        entityType,
        entityId,
        actor,
        reason,
        expectedHash,
        phase: "authorized",
        purgedAt: goNow(),
      };
      const markerPath = join(
        this.root,
        "history",
        "purged",
        `${safeHistoryId(`${entityType}-${entityId}`)}.json`,
      );
      durableWriteJson(markerPath, marker);
      if (stream) {
        for (const target of this.previewLegacyCleanupLocked(entityType, entityId).targets) {
          if (target.verified) this.confirmLegacyCleanupLocked(target);
        }
        marker.phase = "legacy_removed";
        durableWriteJson(markerPath, marker);
      }
      rmSync(this.entityPath(entityType, entityId), { force: true });
      marker.phase = "history_removed";
      durableWriteJson(markerPath, marker);
    });
  }

  /**
   * PurgeLegacyOnly verifies and removes a legacy-only stream under the same entity lock. A false
   * result is a deliberate fail-closed retention decision.
   */
  async purgeLegacyOnly(
    entityType: string,
    entityId: string,
    actor: string,
    reason: string,
    legacyPath: string,
  ): Promise<boolean> {
    if (reason.trim() === "") throw new Error("authorized history purge requires a reason");
    if (actor.trim() === "") actor = "task-lifecycle";
    let removed = false;
    await this.withEntityLock(entityType, entityId, () => {
      const canonical = this.managedLegacyPath(entityType, entityId, legacyPath);
      if (canonical === undefined) return;
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(canonical);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
      if (info.isDirectory()) throw new Error("legacy cleanup target is not a regular file");
      if (!info.isFile() || info.isSymbolicLink()) return;
      const data = readFileSync(canonical);
      const identity = legacyIdentity(data);
      if (identity === undefined || identity.value !== entityId) return;
      const marker: AnyMap = {
        entityType,
        entityId,
        path: canonical,
        actor,
        reason,
        phase: "authorized",
        purgedAt: goNow(),
      };
      const markerPath = join(
        this.root,
        "history",
        "purged",
        `${safeHistoryId(`${entityType}-${entityId}`)}.json`,
      );
      durableWriteJson(markerPath, marker);
      // The proof and reservation are serialized by the entity lock, but a legacy file can still
      // be replaced by an actor that does not take it: re-read the exact bytes just before removal.
      let current: Buffer;
      try {
        const currentInfo = lstatSync(canonical);
        if (!currentInfo.isFile() || currentInfo.isSymbolicLink()) throw new Error("changed");
        current = readFileSync(canonical);
      } catch {
        throw new Error("legacy cleanup target changed after reservation");
      }
      if (!current.equals(data)) throw new Error("legacy cleanup target changed after reservation");
      const currentIdentity = legacyIdentity(current);
      if (currentIdentity === undefined) {
        throw new Error("legacy cleanup target changed after reservation");
      }
      if (currentIdentity.value !== entityId) {
        throw new Error("legacy cleanup target identity changed after reservation");
      }
      rmSync(canonical, { force: true });
      marker.phase = "legacy_removed";
      durableWriteJson(markerPath, marker);
      removed = true;
    });
    return removed;
  }

  /** RemoveLast removes exactly one already durable record for lifecycle rollback. */
  async removeLast(entityType: string, entityId: string): Promise<void> {
    if (!validHistoryEntityType(entityType)) {
      throw new Error(`unsupported history entity type "${entityType}"`);
    }
    const path = this.entityPath(entityType, entityId);
    await this.withEntityLock(entityType, entityId, () => {
      const read = this.readFile(path, entityType, entityId);
      if (read.records.length === 0) return;
      truncateSync(path, read.validOffsets[read.validOffsets.length - 2] as number);
      syncFilePath(path);
      syncDirectory(dirname(path));
    });
  }

  // --- parsing ---------------------------------------------------------------------------------

  /** readFile: parse and fully verify a stream; a missing file is an empty stream. */
  private readFile(path: string, entityType: string, entityId: string): ReadInternal {
    const result: ReadInternal = { records: [], validBytes: 0, validOffsets: [0] };
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return result;
      throw new Error(`read history log: ${(e as Error).message}`, { cause: e });
    }
    let start = 0;
    while (start < data.length) {
      const nl = data.indexOf(0x0a, start);
      if (nl < 0) {
        result.tailTruncated = true;
        break;
      }
      let line = data.subarray(start, nl).toString("utf8");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim() === "") throw new HistoryCorruptError(`empty line at byte ${start}`);
      let record: HistoryRecord;
      try {
        record = decodeRecord(JSON.parse(line));
      } catch (e) {
        throw new HistoryCorruptError(`line at byte ${start}: ${(e as Error).message}`);
      }
      this.opts.payloadDecode?.();
      validateHistoryRecord(
        record,
        result.records.length + 1,
        result.records,
        entityType,
        entityId,
      );
      result.records.push(record);
      result.validOffsets.push(nl + 1);
      result.validBytes = nl + 1;
      start = nl + 1;
    }
    return result;
  }

  // --- replacement (migration, compaction) ------------------------------------------------------

  /**
   * ReplaceRecords is the only path used to activate a migrated or compacted stream. No active
   * .jsonl exists until staging, validation, file sync, rename, and directory sync all succeed.
   */
  async replaceRecords(
    entityType: string,
    entityId: string,
    records: HistoryRecord[],
  ): Promise<void> {
    await this.replaceRecordsInternal(entityType, entityId, records, "", "", false);
  }

  private async replaceRecordsInternal(
    entityType: string,
    entityId: string,
    records: HistoryRecord[],
    legacyPath: string,
    legacyDigest: string,
    allowReconcileTimestamp: boolean,
  ): Promise<void> {
    if (!validHistoryEntityType(entityType) || entityId.trim() === "") {
      throw new Error(`invalid history entity ${entityType}/${entityId}`);
    }
    await this.withEntityLock(entityType, entityId, () => {
      if (legacyPath !== "") {
        const canonical = this.managedLegacyPath(entityType, entityId, legacyPath);
        if (canonical === undefined) {
          throw new Error("legacy provenance source is outside the managed versions store");
        }
        legacyPath = canonical;
        let regular = false;
        try {
          const info = lstatSync(legacyPath);
          regular = info.isFile() && !info.isSymbolicLink();
        } catch {
          regular = false;
        }
        if (!regular) throw new Error("legacy provenance source is not a regular file");
        let currentDigest: string;
        try {
          currentDigest = sha256Hex(readFileSync(legacyPath));
        } catch (e) {
          throw new Error(`read legacy provenance source: ${(e as Error).message}`, { cause: e });
        }
        if (currentDigest !== legacyDigest) {
          throw new Error("legacy provenance source changed during migration");
        }
      }
      const path = this.entityPath(entityType, entityId);
      if (existsSync(path)) {
        let active: ReadInternal;
        try {
          active = this.readFile(path, entityType, entityId);
        } catch (e) {
          throw new Error(`validate existing active history: ${(e as Error).message}`, {
            cause: e,
          });
        }
        if (active.tailTruncated) {
          throw new Error("validate existing active history: truncated final record");
        }
        try {
          semanticValidateRecords(active.records);
        } catch (e) {
          throw new Error(`validate existing active replay: ${(e as Error).message}`, { cause: e });
        }
        if (
          legacyPath !== "" &&
          !recordsProvenance(active.records, entityType, entityId, legacyPath, legacyDigest)
        ) {
          throw new Error("existing active history legacy provenance mismatch");
        }
        let prepared: HistoryRecord[];
        try {
          prepared = marshalReplacementRecords(records, entityType, entityId).prepared;
        } catch (e) {
          throw new Error(
            `validate replacement history against active stream: ${(e as Error).message}`,
            { cause: e },
          );
        }
        if (!recordsEquivalent(active.records, prepared, allowReconcileTimestamp)) {
          throw new Error("existing active history is not equivalent to replacement");
        }
        return;
      }
      const { data, prepared } = marshalReplacementRecords(records, entityType, entityId);
      if (this.opts.validate) {
        try {
          this.opts.validate(prepared);
        } catch (e) {
          throw new Error(`validate replacement history: ${(e as Error).message}`, { cause: e });
        }
      }
      this.activateReplacement(path, data, prepared);
    });
  }

  private activateReplacement(path: string, data: Buffer, records: HistoryRecord[]): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const tmpName = join(
      dir,
      `.history-migration-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}.tmp`,
    );
    const cleanup = () => rmSync(tmpName, { force: true });
    const syncFn = this.opts.compactSync ?? this.opts.sync ?? fsyncSync;
    let fd: number;
    try {
      fd = openSync(tmpName, "wx", 0o600);
    } catch (e) {
      throw new Error(`stage history replacement: ${(e as Error).message}`, { cause: e });
    }
    try {
      let n: number;
      try {
        n = (this.opts.append ?? ((f, b) => writeSync(f, b)))(fd, data);
      } catch (e) {
        throw new Error(`write staged history replacement: ${(e as Error).message}`, { cause: e });
      }
      if (n !== data.length) throw new Error("short write");
      try {
        syncFn(fd);
      } catch (e) {
        throw new Error(`sync staged history replacement: ${(e as Error).message}`, { cause: e });
      }
    } catch (e) {
      closeSync(fd);
      cleanup();
      throw e;
    }
    closeSync(fd);
    const syncDir = this.opts.syncDirectory ?? syncDirectory;
    try {
      syncDir(dir);
    } catch (e) {
      cleanup();
      throw new Error(`sync staging directory: ${(e as Error).message}`, { cause: e });
    }
    // Validate from disk as the final pre-activation check.
    const first = records[0] as HistoryRecord;
    let check: ReadInternal;
    try {
      check = this.readFile(tmpName, first.entityType, first.entityId);
      if (check.records.length !== records.length) throw new Error("record count mismatch");
    } catch (e) {
      cleanup();
      throw new Error(`validate staged history: ${(e as Error).message}`, { cause: e });
    }
    try {
      validateLegacyReconcile(check.records);
    } catch (e) {
      cleanup();
      throw new Error(`validate staged history: ${(e as Error).message}`, { cause: e });
    }
    try {
      if (first.entityType === "task") {
        taskHistoryFromRecords(first.entityId, check.records);
      } else {
        docHistoryFromRecords(
          firstNonEmpty(
            (check.records[check.records.length - 1] as HistoryRecord).currentPath,
            first.entityId,
          ),
          check.records,
        );
      }
    } catch (e) {
      cleanup();
      throw new Error(
        `validate staged ${first.entityType === "task" ? "Task" : "Doc"} replay: ${(e as Error).message}`,
        { cause: e },
      );
    }
    const rename = this.opts.rename ?? renameSync;
    let backup = "";
    if (existsSync(path)) {
      backup = `${path}.history-backup`;
      rmSync(backup, { force: true });
      try {
        copyDurableFile(path, backup, syncFn);
      } catch (e) {
        cleanup();
        throw new Error(`stage active history backup: ${(e as Error).message}`, { cause: e });
      }
      try {
        syncDir(dir);
      } catch (e) {
        cleanup();
        rmSync(backup, { force: true });
        throw new Error(`sync active history backup: ${(e as Error).message}`, { cause: e });
      }
    }
    try {
      rename(tmpName, path);
    } catch (e) {
      cleanup();
      throw new Error(`activate history replacement: ${(e as Error).message}`, { cause: e });
    }
    try {
      syncDir(dir);
    } catch (e) {
      // Roll back the newly named file; this preserves the previous durable head.
      try {
        if (backup !== "") renameSync(backup, path);
        else rmSync(path, { force: true });
        syncDir(dir);
      } catch {
        // best effort
      }
      throw new Error(`sync activated history directory: ${(e as Error).message}`, { cause: e });
    }
    if (backup !== "") rmSync(backup, { force: true });
  }

  // --- legacy migration ------------------------------------------------------------------------

  /**
   * MigrateLegacyTask translates every legacy snapshot without changing its source file.
   * Snapshots are retained as checkpoints because that is the only lossless representation of the
   * old full-snapshot format.
   */
  async migrateLegacyTask(
    legacyPath: string,
    taskId: string,
    legacy: TaskVersionHistory | null,
  ): Promise<void> {
    if (!legacy) throw new Error("legacy Task history is nil");
    const canonical = this.managedLegacyPath("task", taskId, legacyPath);
    if (canonical === undefined) {
      throw new Error("legacy Task provenance source is outside the managed versions store");
    }
    legacyPath = canonical;
    let legacyBytes: Buffer;
    try {
      legacyBytes = readFileSync(legacyPath);
    } catch (e) {
      throw new Error(`read legacy Task provenance: ${(e as Error).message}`, { cause: e });
    }
    const legacyDigest = sha256Hex(legacyBytes);
    let exact: TaskVersionHistory;
    try {
      exact = decodeTaskVersionHistory(JSON.parse(legacyBytes.toString("utf8")));
    } catch (e) {
      throw new Error(`parse legacy Task provenance: ${(e as Error).message}`, { cause: e });
    }
    if (!legacyPayloadMatches(legacyBytes, encodeTaskVersionHistory(legacy))) {
      throw new Error("legacy Task input does not match the exact provenance bytes");
    }
    if (exact.taskId !== taskId || !legacyFileMatches("task", taskId, legacyPath)) {
      throw new Error("legacy Task provenance entity binding mismatch");
    }
    const records: HistoryRecord[] = [];
    let previousHash = "";
    (exact.versions ?? []).forEach((v, i) => {
      const record: HistoryRecord = {
        schemaVersion: 0,
        entityType: "task",
        entityId: taskId,
        revision: 0,
        timestamp: v.timestamp,
        author: v.author,
        source: v.source,
        sessionId: v.sessionId,
        batchId: v.batchId,
        lifecycleEventId: v.lifecycleEventId,
        taskChanges: v.changes ? v.changes.map((c) => cloneJson(c)) : undefined,
        legacy: true,
        legacyRevision: v.version,
        legacyId: v.id,
        legacyPath,
        legacyDigest,
      };
      if (!record.legacyRevision) record.legacyRevision = i + 1;
      if (!record.legacyId) record.legacyId = `v${record.legacyRevision}`;
      const snapshot = v.snapshot ?? {};
      record.checkpoint = Object.keys(snapshot).length > 0;
      record.checkpointPayload = cloneJson(snapshot);
      const computed = taskCanonicalHash(snapshot);
      record.newHash = computed;
      record.baseHash = previousHash;
      if (v.newHash && v.newHash !== computed) record.legacyNewHash = v.newHash;
      if (v.baseHash && v.baseHash !== previousHash) record.legacyBaseHash = v.baseHash;
      if (!record.checkpoint || !record.newHash || record.legacyNewHash || record.legacyBaseHash) {
        record.legacyUnverified = true;
      }
      if (records.length > 0 && records[records.length - 1]?.legacyUnverified) {
        record.legacyUnverified = true;
      }
      previousHash = record.newHash;
      records.push(record);
    });
    if (records.length === 0) return;
    await this.replaceRecordsInternal("task", taskId, records, legacyPath, legacyDigest, false);
  }

  /** MigrateLegacyDoc: same lossless rule as tasks. */
  async migrateLegacyDoc(
    legacyPath: string,
    docId: string,
    docPath: string,
    legacy: DocVersionHistory | null,
  ): Promise<void> {
    await this.migrateLegacyDocWithCurrent(legacyPath, docId, docPath, legacy, undefined);
  }

  /**
   * MigrateLegacyDocWithCurrent appends a verified migration-reconcile checkpoint in the same
   * staged replacement whenever legacy continuity is incomplete or mismatched. `current` is read
   * from the canonical Doc by the caller, never synthesized from the broken chain.
   */
  async migrateLegacyDocWithCurrent(
    legacyPath: string,
    docId: string,
    docPath: string,
    legacy: DocVersionHistory | null,
    current: AnyMap | undefined,
  ): Promise<void> {
    if (!legacy) throw new Error("legacy Doc history is nil");
    const canonical = this.managedLegacyPath("doc", docId, legacyPath);
    if (canonical === undefined) {
      throw new Error("legacy Doc provenance source is outside the managed versions store");
    }
    legacyPath = canonical;
    let legacyBytes: Buffer;
    try {
      legacyBytes = readFileSync(legacyPath);
    } catch (e) {
      throw new Error(`read legacy Doc provenance: ${(e as Error).message}`, { cause: e });
    }
    const legacyDigest = sha256Hex(legacyBytes);
    let exact: DocVersionHistory;
    try {
      exact = decodeDocVersionHistory(JSON.parse(legacyBytes.toString("utf8")));
    } catch (e) {
      throw new Error(`parse legacy Doc provenance: ${(e as Error).message}`, { cause: e });
    }
    if (!legacyPayloadMatches(legacyBytes, encodeDocVersionHistory(legacy))) {
      throw new Error("legacy Doc input does not match the exact provenance bytes");
    }
    const actualDocPath = normalizeDocPath(firstNonEmpty(exact.currentPath, exact.docPath));
    if (
      (actualDocPath !== "" && normalizeDocPath(docPath) !== actualDocPath) ||
      !legacyFileMatches("doc", docId, legacyPath)
    ) {
      throw new Error("legacy Doc provenance entity/path binding mismatch");
    }
    const records: HistoryRecord[] = [];
    let previousHash = "";
    (exact.versions ?? []).forEach((v, i) => {
      const payload: AnyMap | null = v.snapshot ? cloneJson(v.snapshot) : null;
      if (payload && (payload.path === undefined || payload.path === null) && docPath !== "") {
        payload.path = docPath;
      }
      const computed = hashSnapshot(payload);
      const record: HistoryRecord = {
        schemaVersion: 0,
        entityType: "doc",
        entityId: docId,
        revision: 0,
        timestamp: v.timestamp,
        author: v.author,
        actor: v.actor,
        source: v.source,
        auditEventId: v.auditEventId,
        sessionId: v.sessionId,
        batchId: v.batchId,
        baseHash: previousHash,
        newHash: computed,
        checkpoint: !!payload && Object.keys(payload).length > 0,
        docChanges: v.changes ? v.changes.map((c) => cloneJson(c)) : undefined,
        changedScopes: v.changedScopes ? cloneJson(v.changedScopes) : undefined,
        currentPath: firstNonEmpty(v.currentPath, v.docPath, docPath),
        previousPath: v.previousPath,
        checkpointPayload: payload ?? undefined,
        legacy: true,
        legacyRevision: v.version,
        legacyId: v.id,
        legacyPath,
        legacyDigest,
      };
      if (!record.legacyRevision) record.legacyRevision = i + 1;
      if (!record.legacyId) record.legacyId = `v${record.legacyRevision}`;
      if (v.newHash && v.newHash !== computed) record.legacyNewHash = v.newHash;
      if (v.baseHash && v.baseHash !== previousHash) record.legacyBaseHash = v.baseHash;
      if (!record.checkpoint || !record.newHash || record.legacyNewHash || record.legacyBaseHash) {
        record.legacyUnverified = true;
      }
      if (records.length > 0 && records[records.length - 1]?.legacyUnverified) {
        record.legacyUnverified = true;
      }
      previousHash = record.newHash as string;
      records.push(record);
    });
    if (records.length === 0) return;
    const needsReconcile = records.some((r) => r.legacyUnverified);
    if (needsReconcile && current && Object.keys(current).length > 0) {
      const snapshot = cloneJson(current);
      if (snapshot.path === undefined || snapshot.path === null) snapshot.path = docPath;
      const last = records[records.length - 1] as HistoryRecord;
      const logical = (last.legacyRevision ?? 0) + 1;
      records.push({
        schemaVersion: 0,
        entityType: "doc",
        entityId: docId,
        revision: 0,
        timestamp: goNow(),
        source: "migration-reconcile",
        baseHash: last.newHash,
        newHash: hashSnapshot(snapshot),
        checkpoint: true,
        currentPath: docPath,
        checkpointPayload: snapshot,
        legacyRevision: logical,
        legacyId: `v${logical}`,
        legacyPath,
        legacyDigest,
      });
    }
    await this.replaceRecordsInternal(
      "doc",
      docId,
      records,
      legacyPath,
      legacyDigest,
      needsReconcile,
    );
  }

  // --- compaction ------------------------------------------------------------------------------

  /** Compact synthesizes a checkpoint at the retention boundary and records the gap. */
  async compact(
    entityType: string,
    entityId: string,
    policy: HistoryRetentionPolicy = {},
  ): Promise<void> {
    const maxRevisions =
      (policy.maxDetailedRevisions ?? 0) > 0
        ? (policy.maxDetailedRevisions as number)
        : DEFAULT_HISTORY_MAX_DETAILED_REVISIONS;
    const maxAgeMs =
      (policy.maxDetailedAgeMs ?? 0) > 0
        ? (policy.maxDetailedAgeMs as number)
        : DEFAULT_HISTORY_MAX_DETAILED_AGE_MS;
    const now = policy.now ?? new Date();
    await this.withEntityLock(entityType, entityId, () => {
      const path = this.entityPath(entityType, entityId);
      const read = this.readFile(path, entityType, entityId);
      if (read.tailTruncated) throw new Error("cannot compact truncated history stream");
      if (read.records.length > 0) {
        try {
          semanticValidateRecords(read.records);
        } catch (e) {
          throw new Error(`cannot compact semantically invalid history: ${(e as Error).message}`, {
            cause: e,
          });
        }
      }
      if (read.records.length <= 1) return;
      let boundary = read.records.length - maxRevisions;
      const cutoff = now.getTime() - maxAgeMs;
      read.records.forEach((r, i) => {
        const ts = timeMs(r.timestamp);
        if (!Number.isNaN(ts) && ts < cutoff && i + 1 > boundary) boundary = i + 1;
      });
      if (boundary <= 0 || boundary >= read.records.length) {
        if (boundary >= read.records.length) boundary = read.records.length - 1;
        if (boundary <= 0) return;
      }
      // Include the boundary revision itself: the synthesized checkpoint represents the state
      // after that revision, otherwise compaction would silently lose its change.
      const replay = replayGenericSnapshot(read.records.slice(0, boundary + 1), entityType);
      if (!replay.ok) return; // no safe state seed; retain the authoritative stream
      const seed: HistoryRecord = { ...(read.records[boundary] as HistoryRecord) };
      seed.checkpoint = true;
      seed.baseHash = "";
      seed.checkpointPayload = replay.state;
      seed.newHash =
        entityType === "task" ? taskCanonicalHash(replay.state) : hashSnapshot(replay.state);
      const selected = [seed, ...read.records.slice(boundary + 1).map((r) => ({ ...r }))];
      selected.forEach((r, i) => {
        if (!r.legacyRevision)
          r.legacyRevision = (read.records[boundary + i] as HistoryRecord).revision;
        if (!r.legacyId) r.legacyId = `v${r.legacyRevision}`;
      });
      const gap: DocHistoryGap = {
        type: "retention-gap",
        reason: policy.reason || "max_detailed_revisions_and_max_age",
        count: boundary,
        beforeVersion: logicalVersionId(read.records[boundary - 1] as HistoryRecord),
        afterVersion: logicalVersionId(read.records[boundary] as HistoryRecord),
        appliedAt: goNow(now),
      };
      (selected[0] as HistoryRecord).retentionGaps = [...(selected[0]?.retentionGaps ?? []), gap];
      const { data, prepared } = marshalReplacementRecords(selected, entityType, entityId);
      this.opts.validate?.(prepared);
      this.activateReplacement(path, data, prepared);
    });
  }

  // --- legacy cleanup --------------------------------------------------------------------------

  private previewLegacyCleanupLocked(
    entityType: string,
    entityId: string,
    ...legacyPaths: string[]
  ): LegacyCleanupReport {
    const targets: LegacyCleanupTarget[] = [];
    const jsonlPath = this.entityPath(entityType, entityId);
    let result: ReadInternal | undefined;
    let readErr: Error | undefined;
    try {
      result = this.readFile(jsonlPath, entityType, entityId);
    } catch (e) {
      readErr = e as Error;
    }
    let verifiedJsonl = !readErr && !!result && result.records.length > 0 && !result.tailTruncated;
    if (verifiedJsonl && result) {
      try {
        semanticValidateRecords(result.records);
      } catch {
        verifiedJsonl = false;
      }
    }
    for (let path of legacyPaths) {
      if (path.trim() === "") continue;
      const canonical = this.managedLegacyPath(entityType, entityId, path);
      if (canonical !== undefined) path = canonical;
      let pathOk = this.safeLegacyPath(entityType, entityId, path);
      try {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink()) pathOk = false;
      } catch {
        pathOk = false;
      }
      let pathErr: Error | undefined = readErr;
      if (!pathOk) pathErr = new Error("path is outside managed legacy store");
      let digest = "";
      if (pathOk) {
        try {
          digest = sha256Hex(readFileSync(path));
        } catch (e) {
          pathOk = false;
          pathErr = e as Error;
        }
      }
      const head =
        verifiedJsonl && result
          ? ((result.records[result.records.length - 1] as HistoryRecord).recordHash ?? "")
          : "";
      const provenanceOk =
        verifiedJsonl &&
        !!result &&
        pathOk &&
        digest !== "" &&
        recordsProvenance(result.records, entityType, entityId, path, digest) &&
        legacyFileMatches(entityType, entityId, path);
      const target: LegacyCleanupTarget = {
        entityType,
        entityId,
        legacyPath: path,
        jsonlPath,
        verified: provenanceOk,
        reason: cleanupReason(provenanceOk, pathErr),
        ...(digest ? { legacyDigest: digest } : {}),
        ...(head ? { jsonlHeadHash: head } : {}),
      };
      if (provenanceOk)
        target.previewToken = cleanupToken(entityType, entityId, path, digest, head);
      targets.push(target);
    }
    return { targets };
  }

  /** PreviewLegacyCleanup: which legacy files have a verified JSONL successor. */
  async previewLegacyCleanup(
    entityType: string,
    entityId: string,
    ...legacyPaths: string[]
  ): Promise<LegacyCleanupReport> {
    if (!validHistoryEntityType(entityType)) return { targets: [] };
    return this.withEntityLock(entityType, entityId, () =>
      this.previewLegacyCleanupLocked(entityType, entityId, ...legacyPaths),
    );
  }

  /** ConfirmLegacyCleanup: remove one previewed legacy file after an explicit confirmation. */
  async confirmLegacyCleanup(target: LegacyCleanupTarget, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error("legacy cleanup requires explicit confirmation");
    const canonical = this.managedLegacyPath(target.entityType, target.entityId, target.legacyPath);
    if (canonical === undefined) {
      throw new Error("legacy cleanup path is outside the managed versions store");
    }
    const normalized = { ...target, legacyPath: canonical };
    if (!normalized.verified) throw new Error("legacy cleanup target is not marked verified");
    if (normalized.jsonlPath !== this.entityPath(normalized.entityType, normalized.entityId)) {
      throw new Error("legacy cleanup successor path does not match the managed entity");
    }
    await this.withEntityLock(normalized.entityType, normalized.entityId, () =>
      this.confirmLegacyCleanupLocked(normalized),
    );
  }

  private confirmLegacyCleanupLocked(target: LegacyCleanupTarget): void {
    const report = this.previewLegacyCleanupLocked(
      target.entityType,
      target.entityId,
      target.legacyPath,
    );
    const t = report.targets[0];
    if (
      report.targets.length !== 1 ||
      !t ||
      !t.verified ||
      t.legacyPath !== target.legacyPath ||
      (t.legacyDigest ?? "") !== (target.legacyDigest ?? "") ||
      (t.jsonlHeadHash ?? "") !== (target.jsonlHeadHash ?? "") ||
      !t.previewToken ||
      t.previewToken !== target.previewToken
    ) {
      throw new Error("legacy cleanup preview is stale or successor is not verified");
    }
    const info = lstatSync(target.legacyPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("legacy cleanup target is not a regular file");
    }
    rmSync(target.legacyPath);
    syncDirectory(dirname(target.legacyPath));
  }

  safeLegacyPath(entityType: string, entityId: string, path: string): boolean {
    const root = resolve(this.root, "versions");
    const abs = resolve(path);
    const rel = relative(root, abs);
    if (
      rel === "" ||
      rel === "." ||
      rel.startsWith(`..${sep}`) ||
      rel === ".." ||
      isAbsolute(rel)
    ) {
      return false;
    }
    const base = basename(abs);
    if (entityType === "task") return base === `task-${entityId}.json`;
    return (
      (base.startsWith("doc-") && base.endsWith(".json")) ||
      base === `docid-${stableDocIdSlug(entityId)}.json`
    );
  }

  /** Canonicalize and constrain provenance to one of the store-derived legacy files. */
  managedLegacyPath(entityType: string, entityId: string, path: string): string | undefined {
    if (!validHistoryEntityType(entityType) || path.trim() === "") return undefined;
    const abs = resolve(path);
    if (!this.safeLegacyPath(entityType, entityId, abs)) return undefined;
    return abs;
  }
}

// --- helpers shared by the store and the version store ------------------------------------------

export function stableDocIdSlug(docId: string): string {
  return docId.replaceAll("/", "-").replaceAll("\\", "-").replaceAll("..", "");
}

function legacyIdentity(data: Buffer): { value: string } | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(data.toString("utf8"));
  } catch {
    return undefined;
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return undefined;
  }
  for (const key of ["taskId", "docId", "entityId", "id"]) {
    const v = (envelope as AnyMap)[key];
    if (typeof v === "string" && v !== "") return { value: v };
  }
  return { value: "" };
}

/** legacyFileMatches: the legacy file really belongs to this entity. */
export function legacyFileMatches(
  entityType: string,
  entityId: string,
  legacyPath: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch {
    return false;
  }
  if (entityType === "task") {
    return decodeTaskVersionHistory(parsed).taskId === entityId;
  }
  const h = decodeDocVersionHistory(parsed);
  const base = basename(legacyPath);
  if (base.startsWith("docid-")) {
    return base === `docid-${stableDocIdSlug(entityId)}.json` && (h.docId ?? "") === entityId;
  }
  const path = normalizeDocPath(firstNonEmpty(h.currentPath, h.docPath));
  const expected = path === "" ? "" : `doc-${path.replaceAll("/", "--")}.json`;
  if (expected === "" || base !== expected) return false;
  if (h.docId === entityId) return true;
  if (h.docId) return false;
  return legacyDocId(path) === entityId;
}

function legacyPayloadMatches(data: Buffer, supplied: AnyMap): boolean {
  let disk: unknown;
  try {
    disk = JSON.parse(data.toString("utf8"));
  } catch {
    return false;
  }
  return goDeepEqual(disk, JSON.parse(goMarshal(supplied, true)));
}

function recordsProvenance(
  records: readonly HistoryRecord[],
  entityType: string,
  entityId: string,
  legacyPath: string,
  digest: string,
): boolean {
  if (records.length === 0 || digest === "" || legacyPath === "") return false;
  return records.every(
    (r) =>
      r.entityType === entityType &&
      r.entityId === entityId &&
      r.legacyPath === legacyPath &&
      r.legacyDigest === digest,
  );
}

function recordsEquivalent(
  a: readonly HistoryRecord[],
  b: readonly HistoryRecord[],
  allowReconcileTimestamp: boolean,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let left = a[i] as HistoryRecord;
    let right = b[i] as HistoryRecord;
    if (
      allowReconcileTimestamp &&
      left.source === "migration-reconcile" &&
      right.source === "migration-reconcile"
    ) {
      // Only the wall-clock timestamp generated for a retry is ignored.
      left = { ...left, timestamp: "", recordHash: "" };
      right = { ...right, timestamp: "", recordHash: "" };
    }
    if (goMarshal(recordWire(left, true), false) !== goMarshal(recordWire(right, true), false)) {
      return false;
    }
  }
  return true;
}

function validateLegacyReconcile(records: readonly HistoryRecord[]): void {
  let lastUnverified = -1;
  let lastReconcile = -1;
  records.forEach((r, i) => {
    if (r.legacyUnverified) lastUnverified = i;
    if (!r.legacyUnverified && r.source === "migration-reconcile" && r.checkpoint && r.newHash) {
      lastReconcile = i;
    }
  });
  if (lastUnverified >= 0 && lastReconcile <= lastUnverified) {
    throw new Error("unverified legacy chain has no verified reconcile checkpoint");
  }
}

/** semanticValidateRecords: replay a candidate stream the way a reader would. */
export function semanticValidateRecords(records: readonly HistoryRecord[]): void {
  if (records.length === 0) throw new Error("empty history replacement");
  validateLegacyReconcile(records);
  const first = records[0] as HistoryRecord;
  if (first.entityType === "task") {
    taskHistoryFromRecords(first.entityId, records);
    return;
  }
  docHistoryFromRecords(
    firstNonEmpty((records[records.length - 1] as HistoryRecord).currentPath, first.entityId),
    records,
  );
}

/** marshalReplacementRecords: renumber, rechain, rehash and serialize a replacement stream. */
export function marshalReplacementRecords(
  records: readonly HistoryRecord[],
  entityType: string,
  entityId: string,
): { data: Buffer; prepared: HistoryRecord[] } {
  if (records.length === 0) throw new Error("cannot activate empty history");
  const prepared = records.map((r) => ({ ...r }));
  const previous: HistoryRecord[] = [];
  prepared.forEach((r, i) => {
    r.schemaVersion = HISTORY_SCHEMA_VERSION;
    r.entityType = entityType;
    r.entityId = entityId;
    r.revision = i + 1;
    if (i === 0) {
      r.prevRecordHash = "";
    } else {
      const prev = prepared[i - 1] as HistoryRecord;
      r.prevRecordHash = prev.recordHash;
      if (!r.baseHash && !r.legacyUnverified) r.baseHash = prev.newHash;
    }
    r.recordHash = "";
    r.recordHash = historyRecordHash(r);
    validateHistoryRecord(r, i + 1, previous, entityType, entityId);
    previous.push(r);
  });
  // Replacement records are what Go would have read back from JSON, so `any` payloads are
  // emitted with sorted keys.
  const text = prepared.map((r) => `${marshalRecordLine(r, true)}\n`).join("");
  return { data: Buffer.from(text, "utf8"), prepared };
}

function copyDurableFile(src: string, dst: string, syncFn: (fd: number) => void): void {
  copyFileSync(src, dst);
  const fd = openSync(dst, "r+");
  try {
    syncFn(fd);
  } finally {
    closeSync(fd);
  }
}

function cleanupToken(
  entityType: string,
  entityId: string,
  legacyPath: string,
  digest: string,
  head: string,
): string {
  return sha256Hex(`${entityType}\0${entityId}\0${legacyPath}\0${digest}\0${head}`);
}

function cleanupReason(verified: boolean, err: Error | undefined): string {
  if (verified) return "authoritative JSONL successor verified";
  if (err) return "JSONL successor failed validation";
  return "JSONL successor is missing or empty";
}

export function logicalVersionId(record: HistoryRecord): string {
  if (record.legacyId) return record.legacyId;
  if ((record.legacyRevision ?? 0) > 0) return `v${record.legacyRevision}`;
  return `v${record.revision}`;
}

/** replayGenericSnapshot: the entity state after `records`, used to seed a compaction checkpoint. */
export function replayGenericSnapshot(
  records: readonly HistoryRecord[],
  entityType: string,
): { state: AnyMap; ok: boolean } {
  if (entityType === "doc") {
    let state: DocState = {
      id: "",
      path: "",
      title: "",
      description: "",
      content: "",
      tags: undefined,
    };
    let seeded = false;
    for (const record of records) {
      if (record.checkpoint) {
        state = { id: "", path: "", title: "", description: "", content: "", tags: undefined };
        applyDocSnapshot(state, record.checkpointPayload);
        seeded = !!record.checkpointPayload && Object.keys(record.checkpointPayload).length > 0;
      }
      if (!seeded) continue;
      if (!record.checkpoint) {
        try {
          applyDocChangesToState(state, record);
        } catch {
          return { state: {}, ok: false };
        }
      }
    }
    return { state: docToSnapshot(state), ok: seeded };
  }
  let state: AnyMap = {};
  let seeded = false;
  for (const record of records) {
    if (record.checkpoint) {
      state = cloneJson(record.checkpointPayload ?? {});
      seeded = Object.keys(state).length > 0;
    }
    if (!seeded) continue;
    if (!record.checkpoint && entityType === "task") {
      state = applyTaskChangesToMap(state, record.taskChanges);
    }
  }
  return { state, ok: seeded && Object.keys(state).length > 0 };
}

export { isHistoryConflict, sameFile, sortedKeys };
