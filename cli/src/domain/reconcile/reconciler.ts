// Port of internal/storage/reconciler.go and lifecycle_reconciler.go: the automatic reconciler.
//
// Filesystem events are hints only. This class rereads and validates canonical files, proves
// ownership from the project-local manifest and stable identity, and serializes history and
// manifest effects through the existing stores (decision a-briefly-missing-file-is-not-a-deletion).
import { createHash } from "node:crypto";
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { GO_ZERO_TIME } from "../../models/common.ts";
import type { Doc } from "../../models/doc.ts";
import type { Task } from "../../models/task.ts";
import type { HistoryRecord } from "../../models/version.ts";
import { createStorage, type Storage } from "../../storage/adapters.ts";
import { withFileLock } from "../../storage/core/file-lock.ts";
import { safeHistoryId, withDocMutationLocks } from "../../storage/core/locks.ts";
import { Store } from "../../storage/core/store.ts";
import { atomicWrite, goJsonStringify, goTrimSpace } from "../../storage/core/util.ts";
import {
  canonicalDocHash,
  canonicalDocHistoryPath,
  canonicalTaskHash,
  docHistoryFromRecords,
  docStateOf,
  docToSnapshot,
  hashSnapshot,
  historyDeltaInefficient,
  rawDocSnapshot,
  replayDocHistory,
  taskCanonicalHash,
  taskHistoryFromRecords,
  taskToSnapshot,
} from "../../storage/history/entities.ts";
import {
  type AnyMap,
  cloneJson,
  firstNonEmpty,
  goMarshal,
  goNow,
} from "../../storage/history/go-json.ts";
import { durableWriteJson } from "../../storage/history/history-store.ts";
import { decodeTaskVersionHistory } from "../../storage/history/legacy.ts";
import {
  docDeleteTransactionDir,
  docDeleteTransactionPath,
  removeDocDeleteTransaction,
} from "../../storage/history/mutation.ts";
import {
  LIFECYCLE_OPERATION_CREATE,
  LIFECYCLE_OPERATION_DELETE,
  LIFECYCLE_OPERATION_HARD_DELETE,
  LIFECYCLE_OPERATION_RENAME,
  LIFECYCLE_OPERATION_RESTORE,
  LIFECYCLE_OPERATION_UPDATE,
} from "../../storage/history/records.ts";
import { parseDocContent, renderDoc } from "../../storage/stores/doc-store.ts";
import { parseTaskContent, renderTask } from "../../storage/stores/task-store.ts";
import {
  AsyncMutex,
  asPathError,
  conflict,
  isNotExist,
  stableRead,
  toSlash,
  under,
  unsafe,
} from "./fs-util.ts";
import {
  manifestKey,
  manifestText,
  readManifestFile,
  resultFromWire,
  resultWire,
  sortedObject,
  writeFileDurable,
} from "./persist.ts";
import {
  DEFAULT_LIFECYCLE_BATCH_LIMIT,
  emptyResult,
  type HardDeleteOptions,
  type IndexIntent,
  type LifecycleBatch,
  type LifecycleFailureHooks,
  type LifecycleOptions,
  type ManifestEntry,
  RECONCILE_QUIET_WINDOW_MS,
  type ReconcileHint,
  type ReconcileManifest,
  type ReconcileResult,
  type RestoreOptions,
} from "./types.ts";

export {
  LIFECYCLE_OPERATION_CREATE,
  LIFECYCLE_OPERATION_DELETE,
  LIFECYCLE_OPERATION_HARD_DELETE,
  LIFECYCLE_OPERATION_RENAME,
  LIFECYCLE_OPERATION_RESTORE,
  LIFECYCLE_OPERATION_UPDATE,
};

type Kind = "task" | "doc";

export interface ReconcilerOptions {
  /** The runtime's indexing handoff (the Go `indexIntent` callback). */
  index?: IndexIntent;
  /** Enabled only by the authorized task purge coordinator; also scans `.knowns/archive`. */
  allowArchive?: boolean;
  /** Aborts long waits and loops (Go's context). */
  signal?: AbortSignal;
}

interface Parsed {
  kind: Kind;
  id: string;
  hash: string;
  snapshot: AnyMap;
  task?: Task;
  doc?: Doc;
}

function clean(p: string): string {
  const n = posix.normalize(toSlash(p));
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveFn, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveFn();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** lifecycleBatchID. */
export function lifecycleBatchId(root: string, source: string, keys: string[]): string {
  const sorted = [...keys].sort();
  const h = createHash("sha256");
  h.update(resolve(root), "utf8");
  h.update(`\0${source}\0`, "utf8");
  for (const key of sorted) h.update(`${key}\0`, "utf8");
  return `batch-${h.digest("hex").slice(0, 24)}`;
}

/** snapshotChanges: field-wise difference by compact JSON; absent is null. */
export function snapshotChanges(
  oldSnap: AnyMap | null | undefined,
  current: AnyMap,
): Map<string, [unknown, unknown]> {
  const changes = new Map<string, [unknown, unknown]>();
  const keys = new Set<string>([...Object.keys(oldSnap ?? {}), ...Object.keys(current)]);
  for (const key of keys) {
    const before = oldSnap && key in oldSnap ? oldSnap[key] : null;
    const after = key in current ? current[key] : null;
    if (goMarshal(before ?? null, true) !== goMarshal(after ?? null, true)) {
      changes.set(key, [before ?? null, after ?? null]);
    }
  }
  return changes;
}

function sortedChangeFields(changes: Map<string, [unknown, unknown]>): string[] {
  return [...changes.keys()].sort();
}

/** The delta as Go marshals it for the efficiency test: a map of field to [old, new]. */
function changesObject(changes: Map<string, [unknown, unknown]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of sortedChangeFields(changes)) out[field] = changes.get(field);
  return out;
}

function cloneMap(value: AnyMap | null | undefined): AnyMap | undefined {
  return value ? cloneJson(value) : undefined;
}

function docFromState(state: {
  id: string;
  path: string;
  title: string;
  description: string;
  content: string;
  tags: string[] | undefined;
}): Doc {
  const doc: Doc = {
    path: state.path,
    title: state.title,
    createdAt: GO_ZERO_TIME,
    updatedAt: GO_ZERO_TIME,
    content: state.content,
  };
  if (state.id !== "") doc.id = state.id;
  if (state.description !== "") doc.description = state.description;
  if (state.tags) doc.tags = [...state.tags];
  return doc;
}

export class FilesystemReconciler {
  readonly storeRoot: string;
  readonly storage: Storage;
  private readonly mu = new AsyncMutex();
  private index: IndexIntent | undefined;
  private readonly allowArchive: boolean;
  private readonly signal: AbortSignal | undefined;
  // Lifecycle metadata is set only while the serialized lifecycle resolver invokes the baseline
  // content reconciler.
  private activeBatchId = "";
  private activeSource = "";
  private activeOperation = "";
  private activePreviousPath = "";
  private activeCurrentPath = "";
  private lifecycleNow: () => Date = () => new Date();
  private absenceGrace = RECONCILE_QUIET_WINDOW_MS;
  private missingSince: Map<string, Date> | undefined;
  private failureHooks: LifecycleFailureHooks = {};

  constructor(storeRoot: string, opts: ReconcilerOptions = {}) {
    const root = resolve(storeRoot);
    let rootIsSymlink = false;
    try {
      rootIsSymlink = lstatSync(root).isSymbolicLink();
    } catch {
      // Go ignores an Lstat error here.
    }
    if (rootIsSymlink) throw unsafe("store root is a symlink");
    this.storeRoot = root;
    this.storage = createStorage(Store.open(root));
    this.index = opts.index;
    this.allowArchive = opts.allowArchive ?? false;
    this.signal = opts.signal;
  }

  get history() {
    return this.storage.history;
  }

  setLifecycleFailureHooks(hooks: LifecycleFailureHooks): void {
    this.failureHooks = hooks;
  }

  /** SetLifecycleClock: injected for deterministic quiet-window tests. */
  setLifecycleClock(now: (() => Date) | undefined): void {
    this.lifecycleNow = now ?? (() => new Date());
  }

  /** SetLifecycleAbsenceGrace: shortened only in a controlled test. */
  setLifecycleAbsenceGrace(ms: number): void {
    this.absenceGrace = Math.max(0, ms);
  }

  private checkAbort(): void {
    this.signal?.throwIfAborted();
  }

  manifestPath(): string {
    return join(this.storeRoot, "history", "state", "manifest.json");
  }

  private tasksRoot(): string {
    return join(this.storeRoot, "tasks");
  }
  private archiveRoot(): string {
    return join(this.storeRoot, "archive");
  }
  private docsRoot(): string {
    return join(this.storeRoot, "docs");
  }

  private isTaskPath(path: string): boolean {
    return under(this.tasksRoot(), path) || (this.allowArchive && under(this.archiveRoot(), path));
  }

  relative(path: string): string {
    return toSlash(relative(this.storeRoot, path));
  }

  // --- parsing -----------------------------------------------------------------------------

  private docRel(path: string): string {
    return toSlash(relative(this.docsRoot(), path));
  }

  private parseCanonical(kind: Kind, path: string, data: Buffer): Parsed {
    const text = data.toString("utf8");
    if (kind === "task") {
      let task: Task | undefined;
      let parseErr: unknown;
      try {
        task = parseTaskContent(text);
      } catch (e) {
        parseErr = e;
      }
      if (!task || parseErr || goTrim(task.id) === "") {
        const detail = parseErr ? (parseErr as Error).message : "missing stable Task id";
        throw unsafe(`${basename(path)}: ${detail}`);
      }
      task.archived = under(this.archiveRoot(), path);
      return {
        kind,
        id: task.id,
        hash: canonicalTaskHash(task),
        snapshot: taskToSnapshot(task),
        task,
      };
    }
    const rel = this.docRel(path);
    let doc: Doc | undefined;
    let parseErr: unknown;
    try {
      doc = parseDocContent(
        text,
        rel.endsWith(".md") ? rel.slice(0, -3) : rel,
        posix.dirname(rel),
        false,
        "",
      );
    } catch (e) {
      parseErr = e;
    }
    if (!doc || parseErr || goTrim(doc.id ?? "") === "") {
      const detail = parseErr ? (parseErr as Error).message : "missing stable Doc id";
      throw unsafe(`${basename(path)}: ${detail}`);
    }
    return {
      kind,
      id: doc.id as string,
      hash: canonicalDocHash(doc),
      snapshot: docToSnapshot(docStateOf(doc)),
      doc,
    };
  }

  private readStable(path: string): Buffer {
    try {
      return stableRead(path);
    } catch (e) {
      throw unsafe(`${basename(path)}: ${(e as Error).message}`);
    }
  }

  /** resolveCanonicalHint: the stable identity and canonical hash a path currently holds. */
  async resolveCanonicalHint(path: string): Promise<{ kind: Kind; id: string; hash: string }> {
    if (this.failureHooks.beforeCanonicalRead) {
      try {
        this.failureHooks.beforeCanonicalRead(path);
      } catch (e) {
        throw unsafe(`${basename(path)}: ${(e as Error).message}`);
      }
    }
    const data = this.readStable(path);
    const kind: Kind = this.isTaskPath(path) ? "task" : "doc";
    const parsed = this.parseCanonical(kind, path, data);
    this.uniqueIdentity(kind, parsed.id, path);
    return { kind, id: parsed.id, hash: parsed.hash };
  }

  // --- hints -------------------------------------------------------------------------------

  validateCanonicalPath(path: string): string {
    const abs = resolve(path);
    if (
      !under(this.tasksRoot(), abs) &&
      !(this.allowArchive && under(this.archiveRoot(), abs)) &&
      !under(this.docsRoot(), abs)
    ) {
      throw unsafe("path outside canonical roots");
    }
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(abs);
    } catch (e) {
      throw asPathError(e, "lstat", abs);
    }
    if (info.isSymbolicLink()) throw unsafe("symlink path");
    for (
      let current = abs;
      under(this.storeRoot, current) && clean(current) !== clean(this.storeRoot);
      current = dirname(current)
    ) {
      try {
        if (lstatSync(current).isSymbolicLink()) throw unsafe("symlink ancestor");
      } catch (e) {
        if ((e as Error).name === "ReconcileUnsafeError") throw e;
      }
    }
    if (!abs.toLowerCase().endsWith(".md")) throw unsafe("non-markdown path");
    return abs;
  }

  /** ResolveHints: the single resolver stage between filesystem events and reconciliation. */
  async resolveHints(
    hints: readonly ReconcileHint[],
  ): Promise<{ resolved: ReconcileHint[]; diagnostics: ReconcileResult[] }> {
    const groups = new Map<string, ReconcileHint>();
    const diagnostics: ReconcileResult[] = [];
    const pathsByIdentity = new Map<string, string[]>();
    for (const hint of hints) {
      let path: string;
      try {
        path = this.validateCanonicalPath(hint.path);
      } catch (e) {
        if ((hint.event === "remove" || hint.event === "rename") && isNotExist(e)) continue;
        diagnostics.push(emptyResult({ path: hint.path, diagnostic: (e as Error).message }));
        continue;
      }
      let resolved: { kind: Kind; id: string; hash: string };
      try {
        resolved = await this.resolveCanonicalHint(path);
      } catch (e) {
        if ((hint.event === "remove" || hint.event === "rename") && isNotExist(e)) continue;
        diagnostics.push(emptyResult({ path, diagnostic: (e as Error).message }));
        continue;
      }
      const { kind, id, hash } = resolved;
      const identity = `${kind}:${id}`;
      const known = pathsByIdentity.get(identity) ?? [];
      if (!known.includes(path)) pathsByIdentity.set(identity, [...known, path]);
      groups.set(`${identity}\0${hash}`, {
        path,
        previousPath: hint.previousPath ?? "",
        event: hint.event ?? "",
        at: hint.at,
        entityType: kind,
        entityId: id,
        hash,
      });
    }
    // Multiple final paths for one stable identity are ambiguous; do not hand either path to the
    // mutating reconciler.
    for (const [identity, paths] of pathsByIdentity) {
      if (paths.length < 2) continue;
      for (const path of paths) {
        diagnostics.push(
          emptyResult({ path, diagnostic: unsafe(`ambiguous identity ${identity}`).message }),
        );
      }
      for (const key of [...groups.keys()]) {
        if (key.startsWith(`${identity}\0`)) groups.delete(key);
      }
    }
    const resolved = [...groups.values()].sort((a, b) => {
      const at = a.entityType ?? "";
      const bt = b.entityType ?? "";
      if (at !== bt) return at < bt ? -1 : 1;
      const ai = a.entityId ?? "";
      const bi = b.entityId ?? "";
      if (ai !== bi) return ai < bi ? -1 : 1;
      const ah = a.hash ?? "";
      const bh = b.hash ?? "";
      return ah < bh ? -1 : ah > bh ? 1 : 0;
    });
    return { resolved, diagnostics };
  }

  // --- content reconciliation --------------------------------------------------------------

  /** Reconcile: a startup/explicit pass. Without `execute` it is entirely read-only. */
  reconcile(execute: boolean): Promise<ReconcileResult[]> {
    return this.mu.run(async () => {
      const paths = this.canonicalFiles();
      const manifest = readManifestFile(this.manifestPath());
      const results: ReconcileResult[] = [];
      const dirty: Record<string, ManifestEntry> = {};
      for (const path of paths) {
        this.checkAbort();
        let ident: { kind: Kind; id: string };
        try {
          ident = await this.resolveCanonicalHint(path);
        } catch (e) {
          results.push(emptyResult({ path, diagnostic: (e as Error).message }));
          continue;
        }
        const diagnostic = manifestPathConflict(
          manifest,
          ident.kind,
          ident.id,
          this.relative(path),
        );
        if (diagnostic !== "") {
          results.push(
            emptyResult({
              entityType: ident.kind,
              entityId: ident.id,
              path: this.relative(path),
              diagnostic,
            }),
          );
          continue;
        }
        await this.settleFile(path, execute, manifest, dirty, results);
      }
      await this.finishPass(execute, results, dirty);
      results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return results;
    });
  }

  /** ReconcileHints: reconcile exactly the files a watcher named. */
  reconcileHints(hints: readonly ReconcileHint[], execute: boolean): Promise<ReconcileResult[]> {
    return this.mu.run(async () => {
      const { resolved, diagnostics } = await this.resolveHints(hints);
      const results: ReconcileResult[] = [...diagnostics];
      const seen = new Set<string>();
      const paths: string[] = [];
      for (const hint of resolved) {
        let path: string;
        try {
          path = this.validateCanonicalPath(hint.path);
        } catch {
          paths.push(hint.path);
          continue;
        }
        if (!seen.has(path)) {
          seen.add(path);
          paths.push(path);
        }
      }
      paths.sort();
      const manifest = readManifestFile(this.manifestPath());
      const dirty: Record<string, ManifestEntry> = {};
      for (const path of paths) {
        try {
          lstatSync(path);
        } catch (e) {
          results.push(
            emptyResult({
              path,
              diagnostic: `filesystem hint unresolved: ${asPathError(e, "lstat", path).message}`,
            }),
          );
          continue;
        }
        let ident: { kind: Kind; id: string };
        try {
          ident = await this.resolveCanonicalHint(path);
        } catch (e) {
          results.push(emptyResult({ path, diagnostic: (e as Error).message }));
          continue;
        }
        const diagnostic = manifestPathConflict(
          manifest,
          ident.kind,
          ident.id,
          this.relative(path),
        );
        if (diagnostic !== "") {
          results.push(
            emptyResult({
              entityType: ident.kind,
              entityId: ident.id,
              path: this.relative(path),
              diagnostic,
            }),
          );
          continue;
        }
        await this.settleFile(path, execute, manifest, dirty, results);
      }
      await this.finishPass(execute, results, dirty);
      return results;
    });
  }

  /** The loop body Reconcile and ReconcileHints share after the manifest-conflict check. */
  private async settleFile(
    path: string,
    execute: boolean,
    manifest: ReconcileManifest,
    dirty: Record<string, ManifestEntry>,
    results: ReconcileResult[],
  ): Promise<void> {
    let result: ReconcileResult;
    let entry: ManifestEntry;
    try {
      ({ result, entry } = await this.reconcileFile(path, execute));
    } catch (e) {
      // A malformed or ambiguous file is an actionable, content-free result; other files may
      // still be safely reconciled in the same pass.
      results.push(emptyResult({ path, diagnostic: (e as Error).message }));
      return;
    }
    results.push(result);
    if (!execute) return;
    const key = manifestKey(entry.entityType, entry.entityId);
    if (result.diagnostic === "" && !result.changed) {
      const previous = manifest.entries[key];
      if (
        previous?.hash !== entry.hash ||
        previous?.headHash !== entry.headHash ||
        previous?.revision !== entry.revision
      ) {
        if (this.index) {
          try {
            await this.index(result);
          } catch (e) {
            (results[results.length - 1] as ReconcileResult).diagnostic =
              `indexing handoff failed: ${(e as Error).message}`;
            return;
          }
        }
      }
    }
    manifest.entries[key] = entry;
    dirty[key] = entry;
  }

  private async finishPass(
    execute: boolean,
    results: ReconcileResult[],
    dirty: Record<string, ManifestEntry>,
  ): Promise<void> {
    if (!execute) return;
    if (results.some((r) => r.diagnostic === "")) await this.writeManifestEntries(dirty);
  }

  /** appendHistoryRecord: the single history-append boundary (doc paths are canonical doc paths). */
  private async appendHistoryRecord(record: HistoryRecord): Promise<void> {
    const next = { ...record };
    if (next.entityType === "doc") {
      next.currentPath = canonicalDocHistoryPath(next.currentPath ?? "");
      next.previousPath = canonicalDocHistoryPath(next.previousPath ?? "");
    }
    await this.history.append(next);
  }

  private applyActive(record: HistoryRecord): void {
    if (this.activeBatchId !== "") record.batchId = this.activeBatchId;
    if (this.activeSource !== "") record.source = this.activeSource;
    if (this.activeOperation !== "") record.operation = this.activeOperation;
    if (this.activeCurrentPath !== "") record.currentPath = this.activeCurrentPath;
    if (this.activePreviousPath !== "") record.previousPath = this.activePreviousPath;
  }

  private async reconcileFile(
    path: string,
    execute: boolean,
  ): Promise<{ result: ReconcileResult; entry: ManifestEntry }> {
    const data = this.readStable(path);
    const kind: Kind = this.isTaskPath(path) ? "task" : "doc";
    const parsed = this.parseCanonical(kind, path, data);
    const { id: entityId, hash, snapshot } = parsed;
    this.uniqueIdentity(kind, entityId, path);
    let records: HistoryRecord[];
    try {
      const stream = execute
        ? await this.history.read(kind, entityId)
        : this.history.readPreview(kind, entityId);
      records = stream.records ?? [];
    } catch (e) {
      throw new Error(`read ${kind} history: ${(e as Error).message}`, { cause: e });
    }
    const entry: ManifestEntry = {
      entityType: kind,
      entityId,
      path: this.relative(path),
      hash,
      revision: 0,
      headHash: "",
    };
    const result = emptyResult({ entityType: kind, entityId, path: this.relative(path), hash });
    const last = records[records.length - 1];
    if (last) {
      entry.revision = last.revision;
      entry.headHash = last.newHash ?? "";
      if (last.newHash === hash) {
        if (last.tombstone && last.operation === LIFECYCLE_OPERATION_DELETE) {
          return this.reactivateReappearedEntity(
            kind,
            entityId,
            path,
            hash,
            last,
            execute,
            result,
            entry,
          );
        }
        return { result, entry };
      }
      if (!execute) {
        result.changed = true;
        result.revision = last.revision + 1;
        return { result, entry };
      }
      const record = this.filesystemRecord(
        kind,
        entityId,
        last.newHash ?? "",
        hash,
        snapshot,
        records,
      );
      this.applyActive(record);
      await this.appendHistoryRecord(record);
      entry.revision = last.revision + 1;
      entry.headHash = hash;
      result.changed = true;
      result.revision = entry.revision;
    } else {
      // Legacy-only streams must migrate through VersionStore. A raw JSONL append here would
      // manufacture revision 1 and orphan logical history.
      if (execute) {
        const migrated = await this.appendLegacyAware(
          kind,
          entityId,
          hash,
          snapshot,
          parsed.task,
          parsed.doc,
        );
        if (migrated) {
          const migratedStream = await this.history.read(kind, entityId).catch(() => undefined);
          const migratedRecords = migratedStream?.records ?? [];
          const tail = migratedRecords[migratedRecords.length - 1];
          if (tail) {
            entry.revision = tail.revision;
            entry.headHash = tail.newHash ?? "";
            result.revision = tail.revision;
            result.changed = tail.source === "filesystem";
            if (result.changed && this.index) await this.index(result);
            return { result, entry };
          }
          const legacy = await this.legacyHead(kind, entityId, hash, parsed.doc);
          if (legacy.revision > 0) {
            entry.revision = legacy.revision;
            entry.headHash = legacy.newHash;
            result.revision = entry.revision;
            return { result, entry };
          }
          entry.revision = 0;
          const again = await this.history.read(kind, entityId).catch(() => undefined);
          const againRecords = again?.records ?? [];
          const again1 = againRecords[againRecords.length - 1];
          if (again1) {
            entry.revision = again1.revision;
            entry.headHash = again1.newHash ?? "";
            result.changed = true;
            result.revision = again1.revision;
          }
          if (result.changed && this.index) await this.index(result);
          return { result, entry };
        }
      }
      if (!execute) {
        const legacy = await this.legacyHead(kind, entityId, hash, parsed.doc);
        if (legacy.revision > 0) {
          entry.revision = legacy.revision;
          entry.headHash = legacy.newHash;
          result.revision = legacy.revision;
          if (legacy.newHash !== hash) {
            result.changed = true;
            result.revision = legacy.revision + 1;
          }
          return { result, entry };
        }
        result.changed = true;
        result.revision = 1;
        return { result, entry };
      }
      const record = this.filesystemRecord(kind, entityId, "", hash, snapshot, []);
      this.applyActive(record);
      await this.appendHistoryRecord(record);
      entry.revision = 1;
      entry.headHash = hash;
      result.changed = true;
      result.revision = 1;
    }
    if (result.changed && this.index) {
      try {
        await this.index(result);
      } catch (e) {
        throw new Error(
          `filesystem revision durable but indexing handoff failed: ${(e as Error).message}`,
          {
            cause: e,
          },
        );
      }
    }
    return { result, entry };
  }

  private async legacyHead(
    kind: Kind,
    id: string,
    canonical: string,
    doc: Doc | undefined,
  ): Promise<{ revision: number; newHash: string }> {
    try {
      const vs = this.storage.versions;
      if (kind === "task") {
        const h = this.readTaskHistoryPreview(id);
        const v = h.versions?.[(h.versions?.length ?? 0) - 1];
        if (!v) return { revision: 0, newHash: "" };
        return {
          revision: v.version,
          newHash: firstNonEmpty(
            v.newHash,
            v.snapshot ? taskCanonicalHash(v.snapshot) : "",
            canonical,
          ),
        };
      }
      if (!doc) return { revision: 0, newHash: "" };
      const h = vs.readDocHistoryPreview(doc.path);
      const v = h.versions?.[(h.versions?.length ?? 0) - 1];
      if (!v) return { revision: 0, newHash: "" };
      return {
        revision: v.version,
        newHash: firstNonEmpty(v.newHash, v.snapshot ? hashSnapshot(v.snapshot) : "", canonical),
      };
    } catch {
      return { revision: 0, newHash: "" };
    }
  }

  private readTaskHistoryPreview(id: string) {
    const jsonl = this.history.entityPath("task", id);
    if (existsSync(jsonl)) {
      const stream = this.history.readPreview("task", id);
      return taskHistoryFromRecords(id, stream.records ?? []);
    }
    let data: string;
    try {
      data = readFileSync(this.storage.versions.versionPath(id), "utf8");
    } catch (e) {
      if (isNotExist(e)) return { taskId: id, currentVersion: 0, versions: [] };
      throw e;
    }
    const history = decodeTaskVersionHistory(JSON.parse(data));
    if (!history.versions) history.versions = [];
    return history;
  }

  private async appendLegacyAware(
    kind: Kind,
    id: string,
    hash: string,
    snapshot: AnyMap,
    task: Task | undefined,
    doc: Doc | undefined,
  ): Promise<boolean> {
    const vs = this.storage.versions;
    if (kind === "task") {
      let history: Awaited<ReturnType<typeof vs.getHistory>>;
      try {
        history = await vs.getHistory(id);
      } catch {
        return false;
      }
      const versions = history.versions ?? [];
      if (versions.length === 0) return false;
      const old = versions[versions.length - 1];
      if (!old) return false;
      if (old.newHash === hash || !task) return true;
      const changes = snapshotChanges(old.snapshot, snapshot);
      const taskChanges = sortedChangeFields(changes).map((field) => {
        const [oldValue, newValue] = changes.get(field) as [unknown, unknown];
        return { field, oldValue, newValue };
      });
      await vs.saveVersion(id, {
        snapshot,
        changes: taskChanges,
        source: "filesystem",
        checkpoint: false,
        timestamp: goNow(),
      });
      return true;
    }
    if (!doc) return false;
    let history: Awaited<ReturnType<typeof vs.getDocHistory>>;
    try {
      history = await vs.getDocHistory(doc.path);
    } catch {
      return false;
    }
    if ((history.versions ?? []).length === 0) return false;
    const oldState = await vs.resolveDocState(doc.path, "");
    const old = docFromState(oldState);
    if (canonicalDocHash(old) === hash) return true;
    await vs.saveDocRevisionWithOptions(old, doc, { source: "filesystem" });
    return true;
  }

  private filesystemRecord(
    kind: Kind,
    id: string,
    baseHash: string,
    newHash: string,
    snapshot: AnyMap,
    records: readonly HistoryRecord[],
  ): HistoryRecord {
    const record: HistoryRecord = {
      schemaVersion: 0,
      entityType: kind,
      entityId: id,
      revision: 0,
      source: "filesystem",
      timestamp: goNow(),
      baseHash,
      newHash,
      checkpoint: true,
      checkpointPayload: snapshot,
    };
    if (records.length === 0) return record;
    if (kind === "task") {
      try {
        const history = taskHistoryFromRecords(id, records);
        const versions = history.versions ?? [];
        const lastVersion = versions[versions.length - 1];
        if (lastVersion) {
          const oldSnapshot = (cloneMap(lastVersion.snapshot) ?? {}) as AnyMap;
          const newSnapshot = cloneMap(snapshot) as AnyMap;
          delete oldSnapshot.createdAt;
          delete oldSnapshot.updatedAt;
          delete newSnapshot.createdAt;
          delete newSnapshot.updatedAt;
          const changes = snapshotChanges(oldSnapshot, newSnapshot);
          if (changes.size > 0 && !historyDeltaInefficient(changesObject(changes), snapshot)) {
            record.checkpoint = false;
            delete record.checkpointPayload;
            record.taskChanges = sortedChangeFields(changes).map((field) => {
              const [oldValue, newValue] = changes.get(field) as [unknown, unknown];
              return { field, oldValue, newValue };
            });
          }
        }
      } catch {
        // Go ignores a replay failure here and keeps the checkpoint.
      }
    } else {
      try {
        const first = records[0] as HistoryRecord;
        const history = docHistoryFromRecords(firstNonEmpty(first.currentPath, ""), records);
        const versions = history.versions ?? [];
        const lastVersion = versions[versions.length - 1];
        if (lastVersion) {
          const changes = snapshotChanges(lastVersion.snapshot, snapshot);
          if (changes.size > 0 && !historyDeltaInefficient(changesObject(changes), snapshot)) {
            record.checkpoint = false;
            delete record.checkpointPayload;
            record.docChanges = sortedChangeFields(changes).map((field) => {
              const [oldValue, newValue] = changes.get(field) as [unknown, unknown];
              return { field, oldValue, newValue };
            });
          }
        }
      } catch {
        // as above
      }
    }
    return record;
  }

  // --- inventory ---------------------------------------------------------------------------

  /** canonicalFiles: every non-symlink `.md` under the canonical roots, sorted. */
  canonicalFiles(): string[] {
    const files: string[] = [];
    const roots = [this.tasksRoot(), this.docsRoot()];
    if (this.allowArchive) roots.push(this.archiveRoot());
    const walk = (dir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        if (isNotExist(e)) return;
        throw e;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (entry.name.toLowerCase().endsWith(".md")) files.push(full);
      }
    };
    for (const root of roots) walk(root);
    files.sort();
    return files;
  }

  private uniqueIdentity(kind: Kind, id: string, target: string): void {
    const roots = [join(this.storeRoot, `${kind}s`)];
    if (this.allowArchive && kind === "task") {
      // Authorized archive purges must prove uniqueness across both active and archived roots.
      roots.push(this.archiveRoot());
    }
    const matches: string[] = [];
    const visit = (dir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          visit(full);
          continue;
        }
        if (!entry.name.endsWith(".md")) continue;
        let data: Buffer;
        try {
          data = stableRead(full);
        } catch {
          continue;
        }
        try {
          if (kind === "task") {
            const t = parseTaskContent(data.toString("utf8"));
            if (t.id === id) matches.push(full);
          } else {
            const rel = this.docRel(full);
            const d = parseDocContent(
              data.toString("utf8"),
              rel.endsWith(".md") ? rel.slice(0, -3) : rel,
              posix.dirname(rel),
              false,
              "",
            );
            if (d.id === id) matches.push(full);
          }
        } catch {
          // unparseable files own no identity
        }
      }
    };
    for (const root of roots) visit(root);
    const [only] = matches;
    if (matches.length !== 1 || only === undefined || clean(only) !== clean(target)) {
      throw unsafe(`ambiguous ${kind} identity ${goQuoted(id)}`);
    }
  }

  // --- manifest ----------------------------------------------------------------------------

  /** writeManifestEntries: a locked read-modify-write for only the entries this pass changed. */
  private async writeManifestEntries(entries: Record<string, ManifestEntry>): Promise<void> {
    if (Object.keys(entries).length === 0) return;
    const lockPath = join(dirname(this.manifestPath()), "manifest.lock");
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o755 });
    await withFileLock(lockPath, () => {
      const m: ReconcileManifest = { schemaVersion: 1, entries: { ...entries } };
      let current: ReconcileManifest | undefined;
      try {
        current = readManifestFile(this.manifestPath());
      } catch (e) {
        if (!isNotExist(e))
          throw new Error(`manifest is corrupt or unreadable: ${(e as Error).message}`, {
            cause: e,
          });
      }
      if (current) {
        const merged: Record<string, ManifestEntry> = { ...current.entries };
        for (const [key, entry] of Object.entries(m.entries)) {
          const existing = merged[key];
          if (existing && (existing.revision ?? 0) > (entry.revision ?? 0)) continue;
          merged[key] = entry;
        }
        m.entries = merged;
      }
      writeFileDurable(this.manifestPath(), manifestText(m), ".manifest-");
    });
  }

  private async writeManifestMutations(
    upserts: Record<string, ManifestEntry> | null,
    deletes: readonly string[] | null,
  ): Promise<void> {
    const lockPath = join(dirname(this.manifestPath()), "manifest.lock");
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o755 });
    await withFileLock(lockPath, () => {
      const m = readManifestFile(this.manifestPath());
      for (const [key, entry] of Object.entries(upserts ?? {})) m.entries[key] = entry;
      for (const key of deletes ?? []) delete m.entries[key];
      m.schemaVersion = 1;
      writeFileDurable(this.manifestPath(), manifestText(m), ".manifest-lifecycle-");
    });
  }

  // --- missing-since state -----------------------------------------------------------------

  private missingStatePath(): string {
    return join(this.storeRoot, "history", "state", "missing-since.json");
  }

  private loadMissingSince(): Map<string, Date> {
    if (this.missingSince) return this.missingSince;
    let values: Record<string, string> = {};
    try {
      values = JSON.parse(readFileSync(this.missingStatePath(), "utf8")) as Record<string, string>;
    } catch (e) {
      if (!isNotExist(e)) throw e;
    }
    const map = new Map<string, Date>();
    for (const [path, value] of Object.entries(values)) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) map.set(path, parsed);
    }
    this.missingSince = map;
    return map;
  }

  private saveMissingSince(values: Map<string, Date>): void {
    const encoded: Record<string, string> = {};
    for (const [path, value] of values) encoded[path] = goNow(value);
    this.missingSince = values;
    durableWriteJson(this.missingStatePath(), encoded);
  }

  /**
   * confirmStableAbsent is a temporal proof, not a pair of immediate stats. The first absence is
   * persisted as a pending observation; only a later pass after the quiet window may append a
   * tombstone.
   */
  private confirmStableAbsent(
    path: string,
    execute: boolean,
  ): { stable: boolean; pendingUntil: Date } {
    let present = true;
    try {
      lstatSync(path);
    } catch (e) {
      if (!isNotExist(e)) throw asPathError(e, "lstat", path);
      present = false;
    }
    if (present) {
      const values = this.loadMissingSince();
      if (values.has(path) && execute) {
        values.delete(path);
        this.saveMissingSince(values);
      }
      return { stable: false, pendingUntil: new Date(0) };
    }
    const values = this.loadMissingSince();
    const now = this.lifecycleNow();
    const since = values.get(path);
    if (!since) {
      if (execute) {
        values.set(path, now);
        this.saveMissingSince(values);
      }
      return { stable: false, pendingUntil: new Date(now.getTime() + this.absenceGrace) };
    }
    const grace = this.absenceGrace > 0 ? this.absenceGrace : RECONCILE_QUIET_WINDOW_MS;
    const until = new Date(since.getTime() + grace);
    if (now < until) return { stable: false, pendingUntil: until };
    if (execute) {
      values.delete(path);
      this.saveMissingSince(values);
    }
    return { stable: true, pendingUntil: until };
  }

  // --- lifecycle pass ----------------------------------------------------------------------

  /** ReconcileLifecycle: startup state and direct filesystem lifecycle changes. */
  reconcileLifecycle(execute: boolean): Promise<ReconcileResult[]> {
    return this.reconcileLifecycleWithOptions(execute, { source: "filesystem" });
  }

  async reconcileLifecycleWithOptions(
    execute: boolean,
    opts: LifecycleOptions = {},
  ): Promise<ReconcileResult[]> {
    for (;;) {
      const results = await this.reconcileLifecycleOnce(execute, opts);
      if (!opts.wait || !execute) return results;
      let retryAt: Date | undefined;
      for (const r of results) {
        if (r.pending && r.retryAt && (!retryAt || r.retryAt < retryAt)) retryAt = r.retryAt;
      }
      if (!retryAt) return results;
      const now = this.lifecycleNow();
      if (now >= retryAt) continue;
      await sleep(retryAt.getTime() - now.getTime(), this.signal);
    }
  }

  private reconcileLifecycleOnce(
    execute: boolean,
    optsIn: LifecycleOptions,
  ): Promise<ReconcileResult[]> {
    return this.mu.run(() => this.lifecyclePass(execute, optsIn));
  }

  private async lifecyclePass(
    execute: boolean,
    optsIn: LifecycleOptions,
  ): Promise<ReconcileResult[]> {
    const opts: LifecycleOptions = { ...optsIn };
    if (goTrim(opts.source ?? "") === "") opts.source = "filesystem";
    const source = opts.source as string;
    const manifest = readManifestFile(this.manifestPath());
    const recovered = await this.recoverDocDeleteTransactions(execute);
    const paths = this.canonicalFiles();
    const observed = new Set<string>();
    for (const p of opts.observedPaths ?? []) observed.add(this.relative(resolve(p)));
    // Keep the complete canonical inventory. A platform may report only the old side of a rename;
    // seeing the new stable ID is required to avoid a false delete.
    const byPath = new Set<string>();
    const byIdentity = new Map<string, string>();
    // unreadable holds files that exist but whose identity this pass could not read.
    const unreadable = new Set<string>();
    const results: ReconcileResult[] = [...recovered];
    results.push(...(await this.flushLifecycleIntents()));
    for (const path of paths) {
      byPath.add(this.relative(path));
      let ident: { kind: Kind; id: string };
      try {
        ident = await this.resolveCanonicalHint(path);
      } catch (e) {
        unreadable.add(this.relative(path));
        results.push(emptyResult({ path: this.relative(path), diagnostic: (e as Error).message }));
        continue;
      }
      const key = manifestKey(ident.kind, ident.id);
      const prior = byIdentity.get(key);
      if (prior !== undefined && prior !== path) {
        results.push(
          emptyResult({
            entityType: ident.kind,
            entityId: ident.id,
            path: this.relative(path),
            diagnostic: unsafe(`duplicate stable identity ${goQuoted(ident.id)}`).message,
          }),
        );
        continue;
      }
      byIdentity.set(key, path);
    }

    // First resolve every manifest-owned path. This makes rename-before-create and
    // create-before-remove converge to the same proof: one old owner and one final canonical file
    // with the same stable ID.
    const keys = Object.keys(manifest.entries).sort();
    const deletes: string[] = [];
    const upserts: Record<string, ManifestEntry> = {};
    let batchId = opts.batchId ?? "";
    if (batchId === "") {
      const batchKeys = [...keys];
      for (const [identity, currentPath] of byIdentity) {
        batchKeys.push(`${identity}\0${this.relative(currentPath)}`);
      }
      batchId = lifecycleBatchId(this.storeRoot, source, batchKeys);
    }
    for (const key of keys) {
      const entry = manifest.entries[key] as ManifestEntry;
      if (
        opts.exactEntityId &&
        (entry.entityType !== opts.exactEntityType || entry.entityId !== opts.exactEntityId)
      ) {
        continue;
      }
      if (opts.exactEntityId && opts.exactPath) {
        const current = byIdentity.get(key);
        if (
          (current === undefined || clean(this.relative(current)) !== clean(opts.exactPath)) &&
          clean(entry.path) !== clean(opts.exactPath)
        ) {
          continue;
        }
      }
      if (observed.size > 0 && !observed.has(toSlash(entry.path))) {
        const current = byIdentity.get(key);
        if (current === undefined || clean(entry.path) === clean(this.relative(current))) continue;
      }
      if ((opts.limit ?? 0) > 0 && lifecycleResultCount(results) >= (opts.limit as number)) {
        results.push(
          emptyResult({
            entityType: entry.entityType,
            entityId: entry.entityId,
            path: entry.path,
            diagnostic: "lifecycle batch limit reached; hint remains retryable",
          }),
        );
        continue;
      }
      const current = byIdentity.get(key);
      if (current !== undefined) {
        const currentRel = this.relative(current);
        if (clean(entry.path) === clean(currentRel)) {
          // Same-path edits still need the content reconciler. Suppress its callback so the
          // lifecycle result can carry operation/batch data.
          try {
            const { result, next } = await this.reconcileLifecycleContent(
              current,
              entry,
              execute,
              source,
              batchId,
            );
            results.push(result);
            if (execute) upserts[key] = next;
          } catch (e) {
            results.push(
              emptyResult({
                entityType: entry.entityType,
                entityId: entry.entityId,
                path: currentRel,
                diagnostic: (e as Error).message,
              }),
            );
          }
          continue;
        }
        // A second file at the old owned path is an ambiguous copy, even when both files carry
        // the same ID.
        if (byPath.has(entry.path)) {
          results.push(
            emptyResult({
              entityType: entry.entityType,
              entityId: entry.entityId,
              path: currentRel,
              diagnostic: unsafe("old and new canonical paths both exist").message,
            }),
          );
          byIdentity.delete(key);
          continue;
        }
        if (batchId === "")
          batchId = lifecycleBatchId(this.storeRoot, source, [`${key}\0${currentRel}`]);
        try {
          const { result, next } = await this.reconcileLifecycleFile(
            current,
            entry,
            execute,
            source,
            batchId,
            LIFECYCLE_OPERATION_RENAME,
          );
          results.push(result);
          if (execute) upserts[key] = next;
        } catch (e) {
          results.push(
            emptyResult({
              entityType: entry.entityType,
              entityId: entry.entityId,
              path: currentRel,
              diagnostic: (e as Error).message,
            }),
          );
          continue;
        }
        byIdentity.delete(key);
        continue;
      }

      // Missing owned path: confirm absence twice before creating a tombstone.
      const owned = join(this.storeRoot, ...clean(entry.path).split("/"));
      if (byPath.has(entry.path)) {
        // The file is there but this pass never learned who owns it, for example because the
        // process ran out of file descriptors. That is not evidence of a replacement.
        if (unreadable.has(entry.path)) {
          results.push(
            emptyResult({
              entityType: entry.entityType,
              entityId: entry.entityId,
              path: entry.path,
              diagnostic: unsafe("owned path was unreadable during inventory; retry").message,
            }),
          );
          continue;
        }
        // Same-path replacement by a different stable ID is a delete of the old owner plus a
        // create for the new owner. Never infer the old content from the replacement bytes.
        let ident: { kind: Kind; id: string };
        try {
          ident = await this.resolveCanonicalHint(owned);
        } catch (e) {
          results.push(
            emptyResult({
              entityType: entry.entityType,
              entityId: entry.entityId,
              path: entry.path,
              diagnostic: (e as Error).message,
            }),
          );
          continue;
        }
        // Only a different owner proves a replacement.
        if (ident.kind === entry.entityType && ident.id === entry.entityId) {
          results.push(
            emptyResult({
              entityType: entry.entityType,
              entityId: entry.entityId,
              path: entry.path,
              diagnostic: unsafe("owned path still holds its owner; retry").message,
            }),
          );
          continue;
        }
        if (batchId === "") batchId = lifecycleBatchId(this.storeRoot, source, [`${key}\0replace`]);
        try {
          const result = await this.appendLifecycleTombstone(entry, execute, source, batchId);
          results.push(result);
          if (execute) deletes.push(key);
        } catch (e) {
          results.push(
            emptyResult({
              entityType: entry.entityType,
              entityId: entry.entityId,
              path: entry.path,
              diagnostic: (e as Error).message,
            }),
          );
        }
        continue;
      }
      if (transientSibling(owned)) {
        results.push(
          emptyResult({
            entityType: entry.entityType,
            entityId: entry.entityId,
            path: entry.path,
            diagnostic: unsafe("transient editor replacement is still settling").message,
          }),
        );
        continue;
      }
      let absence: { stable: boolean; pendingUntil: Date };
      try {
        absence = this.confirmStableAbsent(owned, execute);
      } catch (e) {
        results.push(
          emptyResult({
            entityType: entry.entityType,
            entityId: entry.entityId,
            path: entry.path,
            diagnostic: (e as Error).message,
          }),
        );
        continue;
      }
      if (!absence.stable) {
        results.push(
          emptyResult({
            entityType: entry.entityType,
            entityId: entry.entityId,
            path: entry.path,
            pending: true,
            retryAt: absence.pendingUntil,
            diagnostic: unsafe(
              `owned path absence pending until ${goNanoTime(absence.pendingUntil)}`,
            ).message,
          }),
        );
        continue;
      }
      if (batchId === "") batchId = lifecycleBatchId(this.storeRoot, source, [`${key}\0delete`]);
      try {
        const result = await this.appendLifecycleTombstone(entry, execute, source, batchId);
        results.push(result);
        if (execute) deletes.push(key);
      } catch (e) {
        results.push(
          emptyResult({
            entityType: entry.entityType,
            entityId: entry.entityId,
            path: entry.path,
            diagnostic: (e as Error).message,
          }),
        );
      }
    }

    // New IDs and same-path replacement IDs are reconciled only after old ownership has been
    // proven and tombstoned. This prevents implicit reuse.
    const remaining = [...byIdentity.keys()].sort();
    for (const key of remaining) {
      const path = byIdentity.get(key) as string;
      if (opts.exactEntityId) {
        if (
          key !== manifestKey(opts.exactEntityType ?? "", opts.exactEntityId) ||
          (opts.exactPath && clean(this.relative(path)) !== clean(opts.exactPath))
        ) {
          continue;
        }
      }
      if (observed.size > 0 && !observed.has(this.relative(path))) continue;
      if ((opts.limit ?? 0) > 0 && lifecycleResultCount(results) >= (opts.limit as number)) {
        results.push(
          emptyResult({
            path: this.relative(path),
            diagnostic: "lifecycle batch limit reached; hint remains retryable",
          }),
        );
        continue;
      }
      // The baseline reconciler remains the source of content parsing/delta selection.
      const saved = this.saveActive();
      this.index = undefined;
      this.activeBatchId = batchId;
      this.activeSource = source;
      this.activeOperation = LIFECYCLE_OPERATION_CREATE;
      this.activePreviousPath = "";
      this.activeCurrentPath = this.relative(path);
      let settled: { result: ReconcileResult; entry: ManifestEntry } | undefined;
      let failure: unknown;
      try {
        settled = await this.reconcileFile(path, execute);
      } catch (e) {
        failure = e;
      } finally {
        this.restoreActive(saved);
      }
      if (!settled) {
        results.push(
          emptyResult({ path: this.relative(path), diagnostic: (failure as Error).message }),
        );
        continue;
      }
      const { result } = settled;
      const next = settled.entry;
      if (result.operation === "") result.operation = LIFECYCLE_OPERATION_CREATE;
      if (batchId === "")
        batchId = lifecycleBatchId(this.storeRoot, source, [`${key}\0${this.relative(path)}`]);
      result.batchId = batchId;
      result.currentPath = result.path;
      result.newHash = result.hash;
      results.push(result);
      if (execute) {
        next.path = this.relative(path);
        next.entityType = result.entityType;
        next.entityId = result.entityId;
        next.hash = result.hash;
        upserts[key] = next;
      }
    }
    if (execute) {
      // Stage content-free intents before ownership activation. The flush gate below delivers
      // them only after the manifest reflects the result, making a crash between the two phases
      // recoverable.
      for (const result of [...results]) {
        if (result.diagnostic !== "" || !this.index) continue;
        if (
          result.changed ||
          result.operation === LIFECYCLE_OPERATION_CREATE ||
          result.operation === LIFECYCLE_OPERATION_UPDATE ||
          result.operation === LIFECYCLE_OPERATION_RENAME ||
          result.operation === LIFECYCLE_OPERATION_DELETE ||
          result.operation === LIFECYCLE_OPERATION_RESTORE ||
          result.operation === LIFECYCLE_OPERATION_HARD_DELETE
        ) {
          try {
            await this.queueLifecycleIntent(result);
          } catch (e) {
            results.push(
              emptyResult({
                entityType: result.entityType,
                entityId: result.entityId,
                path: result.path,
                diagnostic: (e as Error).message,
              }),
            );
            return results;
          }
        }
      }
    }
    if (execute && (Object.keys(upserts).length > 0 || deletes.length > 0)) {
      await this.writeManifestMutations(upserts, deletes);
    }
    if (execute) results.push(...(await this.flushLifecycleIntents()));
    // sort.SliceStable by Path
    return stableSortByPath(results);
  }

  private saveActive() {
    return {
      index: this.index,
      batch: this.activeBatchId,
      source: this.activeSource,
      operation: this.activeOperation,
      previous: this.activePreviousPath,
      current: this.activeCurrentPath,
    };
  }

  private restoreActive(saved: ReturnType<FilesystemReconciler["saveActive"]>): void {
    this.index = saved.index;
    this.activeBatchId = saved.batch;
    this.activeSource = saved.source;
    this.activeOperation = saved.operation;
    this.activePreviousPath = saved.previous;
    this.activeCurrentPath = saved.current;
  }

  /** ReconcileLifecycleBatch: one bounded project-local burst, coalesced by stable identity. */
  async reconcileLifecycleBatch(
    batchIn: LifecycleBatch,
    execute: boolean,
  ): Promise<ReconcileResult[]> {
    const batch: LifecycleBatch = { ...batchIn };
    if (!batch.limit || batch.limit <= 0) batch.limit = DEFAULT_LIFECYCLE_BATCH_LIMIT;
    if (!batch.source) batch.source = "filesystem-batch";
    const hints = batch.hints ?? [];
    let { resolved, diagnostics } = await this.resolveHints(hints);
    if (resolved.length > batch.limit) resolved = resolved.slice(0, batch.limit);
    const keys = resolved.map(
      (hint) =>
        `${hint.entityType}:${hint.entityId}\0${this.relative(clean(hint.path))}\0${hint.hash}`,
    );
    // Removed paths cannot be resolved by ResolveHints, but remain valid observations for the
    // manifest-owned tombstone decision.
    let observedPaths: string[] = [];
    const seenPaths = new Set<string>();
    for (const hint of hints) {
      const p = clean(hint.path);
      if (!seenPaths.has(p)) {
        seenPaths.add(p);
        observedPaths.push(p);
      }
    }
    observedPaths.sort();
    if (observedPaths.length > batch.limit) {
      for (const skipped of observedPaths.slice(batch.limit)) {
        diagnostics = [
          ...diagnostics,
          emptyResult({
            path: skipped,
            diagnostic: "lifecycle batch limit reached; observation remains retryable",
          }),
        ];
      }
      observedPaths = observedPaths.slice(0, batch.limit);
    }
    if (keys.length === 0) {
      for (const p of observedPaths) keys.push(`path\0${this.relative(p)}`);
    }
    if (!batch.id) batch.id = lifecycleBatchId(this.storeRoot, batch.source, keys);
    const results = await this.reconcileLifecycleWithOptions(execute, {
      source: batch.source,
      batchId: batch.id,
      limit: batch.limit,
      observedPaths,
      wait: batch.wait ?? false,
      exactEntityType: batch.exactEntityType ?? "",
      exactEntityId: batch.exactEntityId ?? "",
      exactPath: batch.exactPath ?? "",
    });
    // Preserve malformed/ambiguous hint diagnostics so bounded work remains diagnosable.
    return [...diagnostics, ...results];
  }

  /** ReconcileLifecycleBatchWithOptions: an explicit wait argument for schedulers. */
  reconcileLifecycleBatchWithOptions(
    batch: LifecycleBatch,
    execute: boolean,
    wait: boolean,
  ): Promise<ReconcileResult[]> {
    return this.reconcileLifecycleBatch({ ...batch, wait }, execute);
  }

  /** ReconcileBulk: a compatibility alias for import/Git coordinators. */
  reconcileBulk(batch: LifecycleBatch, execute: boolean): Promise<ReconcileResult[]> {
    return this.reconcileLifecycleBatch(batch, execute);
  }

  private async reconcileLifecycleFile(
    path: string,
    previous: ManifestEntry,
    execute: boolean,
    source: string,
    batchId: string,
    operation: string,
  ): Promise<{ result: ReconcileResult; next: ManifestEntry }> {
    let data: Buffer;
    try {
      data = stableRead(path);
    } catch {
      throw unsafe("unstable canonical file");
    }
    const { kind, id, hash } = await this.resolveCanonicalHint(path);
    if (kind !== previous.entityType || id !== previous.entityId) {
      throw unsafe("lifecycle identity changed");
    }
    const parsed = this.parseCanonical(kind, path, data);
    const snapshot = parsed.snapshot;
    const stream = await this.history.read(kind, id);
    const records = stream.records ?? [];
    const result = emptyResult({
      entityType: kind,
      entityId: id,
      path: this.relative(path),
      hash,
      operation,
      batchId,
      previousPath: previous.path,
      currentPath: this.relative(path),
      baseHash: previous.headHash ?? "",
      newHash: hash,
    });
    const entry: ManifestEntry = {
      entityType: kind,
      entityId: id,
      path: this.relative(path),
      hash,
    };
    const tail = records[records.length - 1];
    if (
      tail &&
      tail.operation === operation &&
      tail.currentPath === this.relative(path) &&
      tail.newHash === hash
    ) {
      entry.revision = tail.revision;
      entry.headHash = tail.newHash ?? "";
      result.revision = tail.revision;
      result.changed = false;
      return { result, next: entry };
    }
    if (!execute) {
      if (!tail) {
        result.changed = true;
        result.revision = 1;
      } else {
        result.revision = tail.revision + 1;
        result.changed = true;
      }
      return { result, next: entry };
    }
    let base = "";
    let rev = 1;
    if (tail) {
      base = tail.newHash ?? "";
      rev = tail.revision + 1;
    }
    const record = this.filesystemRecord(kind, id, base, hash, snapshot, records);
    record.operation = operation;
    record.batchId = batchId;
    record.source = source;
    record.previousPath = previous.path;
    record.currentPath = this.relative(path);
    await this.appendHistoryRecord(record);
    entry.revision = rev;
    entry.headHash = hash;
    result.revision = rev;
    result.changed = true;
    return { result, next: entry };
  }

  private async reconcileLifecycleContent(
    path: string,
    previous: ManifestEntry,
    execute: boolean,
    source: string,
    batchId: string,
  ): Promise<{ result: ReconcileResult; next: ManifestEntry }> {
    const saved = this.saveActive();
    this.index = undefined;
    this.activeBatchId = batchId;
    this.activeSource = source;
    this.activeOperation = LIFECYCLE_OPERATION_UPDATE;
    this.activePreviousPath = previous.path;
    this.activeCurrentPath = this.relative(path);
    let settled: { result: ReconcileResult; entry: ManifestEntry };
    try {
      settled = await this.reconcileFile(path, execute);
    } finally {
      this.restoreActive(saved);
    }
    const { result, entry } = settled;
    const operation =
      result.operation === LIFECYCLE_OPERATION_RESTORE
        ? LIFECYCLE_OPERATION_RESTORE
        : LIFECYCLE_OPERATION_UPDATE;
    result.operation = operation;
    result.batchId = batchId;
    result.previousPath = previous.path;
    result.currentPath = this.relative(path);
    result.baseHash = previous.headHash ?? "";
    result.newHash = result.hash;
    return { result, next: entry };
  }

  // --- tombstones --------------------------------------------------------------------------

  private withLifecycleEntityLock<T>(kind: string, id: string, fn: () => Promise<T>): Promise<T> {
    // Prefix the lifecycle coordinator's lock identity so it is distinct from HistoryStore's own
    // entity lock acquired by Read/Append; this avoids non-reentrant deadlocks.
    return this.history.withEntityLock(kind, `__lifecycle__:${id}`, fn);
  }

  private appendLifecycleTombstone(
    entry: ManifestEntry,
    execute: boolean,
    source: string,
    batchId: string,
  ): Promise<ReconcileResult> {
    return this.withLifecycleEntityLock(entry.entityType, entry.entityId, () =>
      this.appendLifecycleTombstoneLocked(entry, execute, source, batchId),
    );
  }

  private async appendLifecycleTombstoneLocked(
    entry: ManifestEntry,
    execute: boolean,
    source: string,
    batchId: string,
  ): Promise<ReconcileResult> {
    const stream = await this.history.read(entry.entityType, entry.entityId);
    const records = stream.records ?? [];
    const last = records[records.length - 1];
    if (!last) {
      throw unsafe(
        `no verified history for deleted ${entry.entityType} ${goQuoted(entry.entityId)}`,
      );
    }
    if (last.tombstone && last.operation === LIFECYCLE_OPERATION_DELETE) {
      return emptyResult({
        entityType: entry.entityType,
        entityId: entry.entityId,
        path: entry.path,
        hash: last.newHash ?? "",
        operation: LIFECYCLE_OPERATION_DELETE,
        batchId: last.batchId ?? "",
        previousPath: entry.path,
        currentPath: entry.path,
        baseHash: last.newHash ?? "",
        newHash: last.newHash ?? "",
        revision: last.revision,
      });
    }
    const snapshot = this.replaySnapshot(entry.entityType, entry.entityId, records);
    const result = emptyResult({
      entityType: entry.entityType,
      entityId: entry.entityId,
      path: entry.path,
      hash: last.newHash ?? "",
      operation: LIFECYCLE_OPERATION_DELETE,
      batchId,
      previousPath: entry.path,
      currentPath: entry.path,
      baseHash: last.newHash ?? "",
      newHash: last.newHash ?? "",
      changed: true,
      revision: last.revision + 1,
    });
    if (!execute) return result;
    const record: HistoryRecord = {
      schemaVersion: 0,
      entityType: entry.entityType,
      entityId: entry.entityId,
      revision: 0,
      source,
      batchId,
      operation: LIFECYCLE_OPERATION_DELETE,
      tombstone: true,
      timestamp: goNow(),
      baseHash: last.newHash ?? "",
      newHash: last.newHash ?? "",
      checkpoint: true,
      checkpointPayload: snapshot,
      previousPath: entry.path,
      currentPath: entry.path,
    };
    await this.appendHistoryRecord(record);
    return result;
  }

  /** replaySnapshot: the full replayed entity state (never a version's display snapshot). */
  private replaySnapshot(
    kind: string,
    id: string,
    records: readonly HistoryRecord[],
  ): AnyMap | undefined {
    if (kind === "task") {
      const h = taskHistoryFromRecords(id, records);
      const versions = h.versions ?? [];
      const lastVersion = versions[versions.length - 1];
      if (!lastVersion) return undefined;
      return cloneMap(lastVersion.snapshot);
    }
    let path = "";
    for (const rec of records) path = firstNonEmpty(rec.currentPath, rec.previousPath, path);
    const { history, state } = replayDocHistory(path, records);
    if ((history.versions ?? []).length === 0) return undefined;
    // A version Snapshot omits content after a section-scoped revision; a persisted checkpoint
    // needs the full replayed state.
    return rawDocSnapshot(state);
  }

  /** recoverDocDeleteTransactions: resolves an interrupted API delete journal. */
  private async recoverDocDeleteTransactions(execute: boolean): Promise<ReconcileResult[]> {
    const dir = docDeleteTransactionDir(this.storeRoot);
    let files: Dirent[];
    try {
      files = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (isNotExist(e)) return [];
      throw e;
    }
    files.sort((a, b) => (a.name < b.name ? -1 : 1));
    const results: ReconcileResult[] = [];
    for (const file of files) {
      if (file.isDirectory() || !file.name.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = readFileSync(join(dir, file.name), "utf8");
      } catch (e) {
        results.push(emptyResult({ diagnostic: (e as Error).message }));
        continue;
      }
      let marker: {
        schemaVersion?: number;
        entityId?: string;
        path?: string;
        hash?: string;
        source?: string;
        batchId?: string;
      };
      try {
        marker = JSON.parse(raw);
      } catch {
        results.push(
          emptyResult({ diagnostic: unsafe("invalid doc delete transaction marker").message }),
        );
        continue;
      }
      const mPath = marker.path ?? "";
      const mId = marker.entityId ?? "";
      const mHash = marker.hash ?? "";
      const cleanPath = clean(mPath);
      if (
        marker.schemaVersion !== 1 ||
        goTrim(mId) === "" ||
        goTrim(mHash) === "" ||
        file.name !== basename(docDeleteTransactionPath(this.storeRoot, mId)) ||
        mPath.includes("\\") ||
        mPath.startsWith("/") ||
        cleanPath !== mPath ||
        !cleanPath.startsWith("docs/") ||
        cleanPath.includes("../")
      ) {
        results.push(
          emptyResult({
            path: mPath,
            diagnostic: unsafe("invalid doc delete transaction marker").message,
          }),
        );
        continue;
      }
      let abs: string;
      try {
        abs = this.safeMissingDocTransactionPath(mPath);
      } catch (e) {
        results.push(emptyResult({ path: mPath, diagnostic: (e as Error).message }));
        continue;
      }
      let result = emptyResult();
      try {
        await this.withLifecycleEntityLock("doc", mId, async () => {
          let stream: Awaited<ReturnType<typeof this.history.read>> | undefined;
          try {
            stream = await this.history.read("doc", mId);
          } catch {
            stream = undefined;
          }
          const recs = stream?.records ?? [];
          const last = recs[recs.length - 1];
          if (!stream || !last) throw unsafe("delete transaction has no verified history");
          let statErr: unknown;
          try {
            statSync(abs);
          } catch (e) {
            statErr = e;
          }
          if (statErr === undefined) {
            if (last.tombstone) throw unsafe("tombstoned Doc canonical file is live");
            if (last.newHash !== mHash) throw unsafe("delete transaction history hash mismatch");
            if (execute) removeDocDeleteTransaction(this.storeRoot, mId);
            return;
          }
          if (!isNotExist(statErr)) throw statErr;
          const entry: ManifestEntry = {
            entityType: "doc",
            entityId: mId,
            path: mPath,
            hash: "",
            headHash: mHash,
            revision: last.revision,
          };
          if (last.tombstone && last.operation === LIFECYCLE_OPERATION_DELETE) {
            result = emptyResult({
              entityType: "doc",
              entityId: mId,
              path: mPath,
              hash: last.newHash ?? "",
              operation: LIFECYCLE_OPERATION_DELETE,
              previousPath: mPath,
              currentPath: mPath,
              baseHash: last.newHash ?? "",
              newHash: last.newHash ?? "",
              revision: last.revision,
            });
            if (execute) removeDocDeleteTransaction(this.storeRoot, mId);
            return;
          }
          if (last.newHash !== mHash) throw unsafe("delete transaction history hash mismatch");
          result = await this.appendLifecycleTombstoneLocked(
            entry,
            execute,
            marker.source ?? "",
            marker.batchId ?? "",
          );
          if (execute) removeDocDeleteTransaction(this.storeRoot, mId);
        });
        if (result.entityId !== "") results.push(result);
      } catch (e) {
        results.push(
          emptyResult({
            entityType: "doc",
            entityId: mId,
            path: mPath,
            diagnostic: (e as Error).message,
          }),
        );
      }
    }
    return results;
  }

  /**
   * safeMissingDocTransactionPath validates a journal target without requiring the final file to
   * exist. Existing ancestors must remain real directories.
   */
  private safeMissingDocTransactionPath(relativePath: string): string {
    const docsRoot = resolve(join(this.storeRoot, "docs"));
    const abs = resolve(join(this.storeRoot, ...relativePath.split("/")));
    if (!under(docsRoot, abs) || clean(abs) === clean(docsRoot)) {
      throw unsafe("doc delete transaction path outside docs root");
    }
    try {
      const info = lstatSync(abs);
      if (info.isSymbolicLink()) throw unsafe("symlink target in doc delete transaction path");
      if (!info.isFile()) throw unsafe("non-regular target in doc delete transaction path");
    } catch (e) {
      if ((e as Error).name === "ReconcileUnsafeError") throw e;
      if (!isNotExist(e)) throw e;
    }
    for (let current = dirname(abs); under(docsRoot, current); current = dirname(current)) {
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(current);
      } catch (e) {
        if (isNotExist(e)) continue;
        throw e;
      }
      if (info.isSymbolicLink()) throw unsafe("symlink ancestor in doc delete transaction path");
      if (clean(current) === clean(docsRoot)) break;
    }
    return abs;
  }

  // --- restore -----------------------------------------------------------------------------

  /**
   * Restore recreates the canonical file from the verified tombstone state and appends one restore
   * revision. Existing canonical content or stale expected hashes fail closed and produce no
   * history or manifest mutation.
   */
  restore(
    entityType: string,
    entityId: string,
    opts: RestoreOptions = {},
  ): Promise<ReconcileResult> {
    return this.withLifecycleEntityLock(entityType, entityId, () =>
      this.mu.run(() => this.restoreLocked(entityType as Kind, entityId, opts)),
    );
  }

  private async restoreLocked(
    entityType: Kind,
    entityId: string,
    optsIn: RestoreOptions,
  ): Promise<ReconcileResult> {
    const opts = { ...optsIn };
    const manifest = readManifestFile(this.manifestPath());
    const stream = await this.history.read(entityType, entityId);
    const records = stream.records ?? [];
    const last = records[records.length - 1];
    if (!last || (!last.tombstone && last.operation !== LIFECYCLE_OPERATION_RESTORE)) {
      throw unsafe("entity is not tombstoned");
    }
    if (opts.expectedBaseHash && opts.expectedBaseHash !== last.newHash) {
      throw conflict("restore base hash mismatch");
    }
    const entry = manifest.entries[manifestKey(entityType, entityId)];
    let path = opts.path ?? "";
    if (goTrim(path) !== "" && isAbsolutePath(path)) throw unsafe("absolute restore path");
    if (path === "" && entry) path = entry.path;
    if (path === "") path = last.currentPath ?? "";
    path = toSlash(posix.normalize(toSlash(path)).replace(/^\/+/, ""));
    if (!path.endsWith(".md")) path += ".md";
    if (
      isAbsolutePath(path) ||
      path === "." ||
      path.startsWith("../") ||
      path === ".." ||
      !under(this.storeRoot, join(this.storeRoot, ...path.split("/")))
    ) {
      throw unsafe("restore path outside project root");
    }
    const wantRoot = `${entityType}s/`;
    if (!path.startsWith(wantRoot)) throw unsafe(`restore path outside ${entityType} root`);
    if (!opts.batchId) {
      opts.batchId = lifecycleBatchId(this.storeRoot, "restore", [
        `${entityType}:${entityId}\0${path}`,
      ]);
    }
    const batchId = opts.batchId;
    const abs = join(this.storeRoot, ...path.split("/"));
    // A restore head is only idempotent for the exact canonical path that was already restored.
    if (last.operation === LIFECYCLE_OPERATION_RESTORE) {
      if (entry && entry.path !== path) throw conflict(`entity already restored at ${entry.path}`);
      const paths = await this.canonicalIdentityPaths(entityType, entityId);
      for (const existing of paths) {
        if (existing !== path) throw conflict(`entity already restored at ${existing}`);
      }
    }
    let present = true;
    try {
      lstatSync(abs);
    } catch (e) {
      if (!isNotExist(e)) throw e;
      present = false;
    }
    if (present) {
      // An interrupted restore may have durable history and canonical bytes already present. A
      // spurious tombstone reaches the same shape: the head says deleted while the canonical file
      // never left. Both are identified by the content hash below.
      const data = stableRead(abs);
      let currentHash: string;
      if (entityType === "task") {
        currentHash = canonicalTaskHash(parseTaskContent(data.toString("utf8")));
      } else {
        const rel = toSlash(relative(this.docsRoot(), abs));
        currentHash = canonicalDocHash(
          parseDocContent(
            data.toString("utf8"),
            rel.endsWith(".md") ? rel.slice(0, -3) : rel,
            posix.dirname(rel),
            false,
            "",
          ),
        );
      }
      if (currentHash !== last.newHash) {
        if (last.operation !== LIFECYCLE_OPERATION_RESTORE) {
          // A different entity's bytes occupy the path. Reactivating would adopt content this
          // identity never owned.
          throw unsafe("restore path already exists");
        }
        throw conflict("interrupted restore hash mismatch");
      }
      if (last.operation !== LIFECYCLE_OPERATION_RESTORE) {
        // The head is a tombstone but the canonical file is present and carries exactly the
        // content the tombstone recorded, so the deletion never happened on disk. Append a
        // durable restore so the stream stops contradicting the filesystem.
        return this.reactivateTombstonedEntity(
          entityType,
          entityId,
          path,
          abs,
          currentHash,
          last,
          records,
          {
            ...opts,
            batchId,
          },
        );
      }
      const result = emptyResult({
        entityType,
        entityId,
        path,
        hash: currentHash,
        operation: LIFECYCLE_OPERATION_RESTORE,
        batchId: last.batchId ?? "",
        currentPath: path,
        changed: false,
        revision: last.revision,
        newHash: currentHash,
      });
      if (this.index) await this.queueLifecycleIntent(result);
      const next: ManifestEntry = {
        entityType,
        entityId,
        path,
        hash: currentHash,
        revision: last.revision,
        headHash: currentHash,
      };
      await this.writeManifestMutations({ [manifestKey(entityType, entityId)]: next }, null);
      if (this.index) {
        const pending = await this.flushLifecycleIntents();
        const first = pending[0];
        if (first && first.diagnostic !== "") throw new Error(first.diagnostic);
      }
      return result;
    }
    let snapshot: AnyMap | undefined;
    try {
      snapshot = this.replaySnapshot(entityType, entityId, records.slice(0, -1));
    } catch {
      snapshot = cloneMap(last.checkpointPayload);
    }
    if (!snapshot || Object.keys(snapshot).length === 0)
      throw unsafe("tombstone has no replayable state");
    let content: string;
    if (entityType === "task") {
      const task = { ...cloneJson(snapshot) } as unknown as Task;
      task.id = entityId;
      content = renderTask(task);
    } else {
      const doc = { ...cloneJson(snapshot) } as unknown as Doc;
      doc.id = entityId;
      doc.path = toSlash(path.replace(/^docs\//, "")).replace(/\.md$/, "");
      if (doc.createdAt === undefined) doc.createdAt = GO_ZERO_TIME;
      if (doc.updatedAt === undefined) doc.updatedAt = GO_ZERO_TIME;
      snapshot = cloneJson(snapshot);
      snapshot.id = doc.id;
      snapshot.path = doc.path;
      content = renderDoc(doc);
    }
    let hash = "";
    const finalSnapshot = snapshot;
    const restoreCanonical = async (): Promise<void> => {
      try {
        const info = lstatSync(abs);
        if (info.isSymbolicLink()) throw unsafe("restore path is symlink");
        throw unsafe("restore path already exists");
      } catch (e) {
        if (!isNotExist(e)) throw e;
      }
      mkdirSync(dirname(abs), { recursive: true, mode: 0o755 });
      atomicWrite(abs, content);
      let data: Buffer;
      try {
        data = stableRead(abs);
      } catch (e) {
        rmSync(abs, { force: true });
        throw e;
      }
      try {
        if (entityType === "task") {
          hash = canonicalTaskHash(parseTaskContent(data.toString("utf8")));
        } else {
          const rel = toSlash(relative(this.docsRoot(), abs));
          hash = canonicalDocHash(
            parseDocContent(
              data.toString("utf8"),
              rel.endsWith(".md") ? rel.slice(0, -3) : rel,
              posix.dirname(rel),
              false,
              "",
            ),
          );
        }
      } catch (e) {
        rmSync(abs, { force: true });
        throw e;
      }
      const record: HistoryRecord = {
        schemaVersion: 0,
        entityType,
        entityId,
        revision: 0,
        source: "restore",
        operation: LIFECYCLE_OPERATION_RESTORE,
        batchId,
        timestamp: goNow(),
        baseHash: last.newHash ?? "",
        newHash: hash,
        checkpoint: true,
        checkpointPayload: finalSnapshot,
        previousPath: last.currentPath ?? "",
        currentPath: path,
      };
      try {
        await this.appendHistoryRecord(record);
      } catch (e) {
        rmSync(abs, { force: true });
        throw e;
      }
    };
    if (entityType === "doc") {
      const publicPath = toSlash(path).replace(/^docs\//, "");
      await withDocMutationLocks(this.storeRoot, [publicPath], restoreCanonical);
    } else {
      await restoreCanonical();
    }
    const result = emptyResult({
      entityType,
      entityId,
      path,
      hash,
      operation: LIFECYCLE_OPERATION_RESTORE,
      batchId,
      previousPath: last.currentPath ?? "",
      currentPath: path,
      changed: true,
      revision: last.revision + 1,
      baseHash: last.newHash ?? "",
      newHash: hash,
    });
    if (this.index) await this.queueLifecycleIntent(result);
    const next: ManifestEntry = {
      entityType,
      entityId,
      path,
      hash,
      revision: last.revision + 1,
      headHash: hash,
    };
    await this.writeManifestMutations({ [manifestKey(entityType, entityId)]: next }, null);
    if (this.index) {
      const pending = await this.flushLifecycleIntents();
      const first = pending[0];
      if (first && first.diagnostic !== "") throw new Error(first.diagnostic);
    }
    return result;
  }

  private async canonicalIdentityPaths(entityType: string, entityId: string): Promise<string[]> {
    const matched: string[] = [];
    for (const path of this.canonicalFiles()) {
      try {
        const { kind, id } = await this.resolveCanonicalHint(path);
        if (kind === entityType && id === entityId) matched.push(this.relative(path));
      } catch {
        // an unreadable file proves nothing
      }
    }
    return matched.sort();
  }

  /**
   * reactivateReappearedEntity settles a live canonical file whose history head is a delete
   * tombstone carrying exactly that file's hash: the signature of a spurious deletion (`git stash
   * -u`, a checkout, a pull). A Doc with an unfinished delete transaction is left alone: there
   * the tombstone records a deletion the user asked for.
   */
  private async reactivateReappearedEntity(
    entityType: Kind,
    entityId: string,
    abs: string,
    hash: string,
    last: HistoryRecord,
    execute: boolean,
    result: ReconcileResult,
    entry: ManifestEntry,
  ): Promise<{ result: ReconcileResult; entry: ManifestEntry }> {
    if (entityType === "doc") {
      try {
        statSync(docDeleteTransactionPath(this.storeRoot, entityId));
        return { result, entry };
      } catch (e) {
        if (!isNotExist(e)) throw e;
      }
    }
    const rel = this.relative(abs);
    if (!execute) {
      result.operation = LIFECYCLE_OPERATION_RESTORE;
      result.changed = true;
      result.revision = last.revision + 1;
      result.baseHash = last.newHash ?? "";
      result.newHash = hash;
      result.previousPath = last.currentPath ?? "";
      result.currentPath = rel;
      return { result, entry };
    }
    let restored = result;
    let head: HistoryRecord | undefined;
    let settled = false;
    await this.withLifecycleEntityLock(entityType, entityId, async () => {
      const stream = await this.history.read(entityType, entityId);
      const records = stream.records ?? [];
      head = records[records.length - 1];
      if (!head) throw unsafe(`reappeared ${entityType} ${goQuoted(entityId)} has no history`);
      if (
        !head.tombstone ||
        head.operation !== LIFECYCLE_OPERATION_DELETE ||
        head.newHash !== hash
      ) {
        // Another writer settled the entity between the first read and the lock.
        settled = true;
        return;
      }
      restored = await this.reactivateTombstonedEntity(
        entityType,
        entityId,
        rel,
        abs,
        hash,
        head,
        records,
        {
          path: rel,
          batchId: this.activeBatchId,
        },
      );
    });
    if (settled && head) {
      entry.revision = (head as HistoryRecord).revision;
      entry.headHash = (head as HistoryRecord).newHash ?? "";
      return { result, entry };
    }
    entry.revision = restored.revision;
    entry.headHash = hash;
    return { result: restored, entry };
  }

  /**
   * reactivateTombstonedEntity repairs an entity whose durable history head is a tombstone while
   * its canonical file is still present with exactly the content that tombstone recorded. The
   * canonical bytes are already correct, so no file is written: only a durable restore record and
   * the reactivated manifest ownership are needed.
   */
  private async reactivateTombstonedEntity(
    entityType: Kind,
    entityId: string,
    path: string,
    abs: string,
    currentHash: string,
    last: HistoryRecord,
    records: readonly HistoryRecord[],
    opts: RestoreOptions,
  ): Promise<ReconcileResult> {
    const info = lstatSync(abs);
    if (info.isSymbolicLink()) throw unsafe("restore path is symlink");
    let snapshot: AnyMap | undefined;
    try {
      snapshot = this.replaySnapshot(entityType, entityId, records.slice(0, -1));
    } catch {
      snapshot = undefined;
    }
    if (!snapshot || Object.keys(snapshot).length === 0)
      snapshot = cloneMap(last.checkpointPayload);
    if (!snapshot || Object.keys(snapshot).length === 0)
      throw unsafe("tombstone has no replayable state");
    const record: HistoryRecord = {
      schemaVersion: 0,
      entityType,
      entityId,
      revision: 0,
      source: "restore",
      operation: LIFECYCLE_OPERATION_RESTORE,
      batchId: opts.batchId ?? "",
      timestamp: goNow(),
      baseHash: last.newHash ?? "",
      newHash: currentHash,
      checkpoint: true,
      checkpointPayload: snapshot,
      previousPath: last.currentPath ?? "",
      currentPath: path,
    };
    const appendRecord = () => this.appendHistoryRecord(record);
    if (entityType === "doc") {
      const publicPath = toSlash(path).replace(/^docs\//, "");
      await withDocMutationLocks(this.storeRoot, [publicPath], appendRecord);
    } else {
      await appendRecord();
    }
    const result = emptyResult({
      entityType,
      entityId,
      path,
      hash: currentHash,
      operation: LIFECYCLE_OPERATION_RESTORE,
      batchId: opts.batchId ?? "",
      previousPath: last.currentPath ?? "",
      currentPath: path,
      changed: true,
      revision: last.revision + 1,
      baseHash: last.newHash ?? "",
      newHash: currentHash,
    });
    if (this.index) await this.queueLifecycleIntent(result);
    const next: ManifestEntry = {
      entityType,
      entityId,
      path,
      hash: currentHash,
      revision: last.revision + 1,
      headHash: currentHash,
    };
    await this.writeManifestMutations({ [manifestKey(entityType, entityId)]: next }, null);
    if (this.index) {
      const pending = await this.flushLifecycleIntents();
      const first = pending[0];
      if (first && first.diagnostic !== "") throw new Error(first.diagnostic);
    }
    return result;
  }

  // --- hard delete -------------------------------------------------------------------------

  /**
   * HardDelete is the reconciler-level Doc/Task purge boundary. It is not reachable from
   * filesystem observations; adapters must set trusted, confirmed and a reason, and provide an
   * exact path/hash proof.
   */
  hardDelete(entityType: string, entityId: string, opts: HardDeleteOptions): Promise<void> {
    return this.withLifecycleEntityLock(entityType, entityId, () =>
      this.hardDeleteLocked(entityType as Kind, entityId, opts),
    );
  }

  purgeReservationPath(kind: string, id: string): string {
    return join(this.storeRoot, "history", "purged", `${safeHistoryId(`${kind}-${id}`)}.json`);
  }

  private writePurgeReservation(kind: string, id: string, opts: HardDeleteOptions): void {
    const payload = {
      entityType: kind,
      entityId: id,
      path: opts.path ?? "",
      hash: opts.expectedHash ?? "",
      phase: "authorized",
      actor: opts.actor ?? "",
      reason: opts.reason,
      purgedAt: goNow(),
    };
    durableWriteJson(this.purgeReservationPath(kind, id), payload);
  }

  private setPurgePhase(
    kind: string,
    id: string,
    phase: string,
    marker: Record<string, unknown>,
  ): void {
    marker.entityType = kind;
    marker.entityId = id;
    marker.phase = phase;
    marker.updatedAt = goNow();
    durableWriteJson(this.purgeReservationPath(kind, id), marker);
  }

  private async cleanupLegacy(entityType: string, entityId: string): Promise<void> {
    const report = await this.history.previewLegacyCleanup(entityType, entityId);
    for (const target of report.targets) {
      if (target.verified) await this.history.confirmLegacyCleanup(target, true);
    }
  }

  private hardDeleteLocked(
    entityType: Kind,
    entityId: string,
    optsIn: HardDeleteOptions,
  ): Promise<void> {
    return this.mu.run(() => this.hardDeleteBody(entityType, entityId, optsIn));
  }

  private async hardDeleteBody(
    entityType: Kind,
    entityId: string,
    optsIn: HardDeleteOptions,
  ): Promise<void> {
    const opts = { ...optsIn };
    if (!opts.trusted || !opts.confirmed || goTrim(opts.reason) === "") {
      throw new Error("hard delete requires trusted authorization, confirmation, and reason");
    }
    const manifest = readManifestFile(this.manifestPath());
    const key = manifestKey(entityType, entityId);
    let entry = manifest.entries[key];
    let ok = entry !== undefined;
    const reservation = this.purgeReservationPath(entityType, entityId);
    let hasReservation = true;
    try {
      statSync(reservation);
    } catch (e) {
      if (!isNotExist(e)) throw e;
      hasReservation = false;
    }
    if (hasReservation) {
      const marker = JSON.parse(readFileSync(reservation, "utf8")) as Record<string, unknown>;
      const markerKind = typeof marker.entityType === "string" ? marker.entityType : "";
      if (markerKind !== "" && markerKind !== entityType)
        throw unsafe("purge marker entity mismatch");
      const markerId = typeof marker.entityId === "string" ? marker.entityId : "";
      if (markerId !== "" && markerId !== entityId) throw unsafe("purge marker entity mismatch");
      let markerPath = typeof marker.path === "string" ? marker.path : "";
      const markerHash = typeof marker.hash === "string" ? marker.hash : "";
      const entryPath = entry?.path ?? "";
      if (entryPath !== "" && markerPath !== "" && clean(entryPath) !== clean(markerPath)) {
        throw unsafe("purge marker path mismatch");
      }
      if (markerPath === "") markerPath = entryPath;
      const paths = await this.canonicalIdentityPaths(entityType, entityId);
      for (const currentPath of paths) {
        if (markerPath === "" || clean(currentPath) !== clean(markerPath)) {
          throw unsafe("stable identity moved while purge reservation was pending");
        }
      }
      if (markerPath !== "") {
        const abs = join(this.storeRoot, ...markerPath.split("/"));
        if (!under(this.storeRoot, abs) || !abs.endsWith(".md")) {
          throw unsafe("purge marker path outside canonical roots");
        }
        const removeMarkerCanonical = async (): Promise<void> => {
          let info: ReturnType<typeof lstatSync> | undefined;
          try {
            info = lstatSync(abs);
          } catch (e) {
            if (!isNotExist(e)) throw e;
          }
          if (info) {
            if (info.isSymbolicLink()) throw unsafe("purge marker canonical symlink");
            stableRead(abs);
            let ident: { kind: Kind; id: string; hash: string } | undefined;
            try {
              ident = await this.resolveCanonicalHint(abs);
            } catch {
              ident = undefined;
            }
            if (!ident || ident.kind !== entityType || ident.id !== entityId) {
              throw unsafe("purge marker identity mismatch");
            }
            if (markerHash !== "" && markerHash !== ident.hash)
              throw conflict("purge marker hash mismatch");
            try {
              rmSync(abs);
            } catch (e) {
              if (!isNotExist(e)) throw e;
            }
            this.setPurgePhase(entityType, entityId, "canonical_removed", marker);
            return;
          }
          const again = await this.canonicalIdentityPaths(entityType, entityId);
          for (const currentPath of again) {
            if (clean(currentPath) !== clean(markerPath))
              throw unsafe("stable identity moved during purge retry");
          }
        };
        if (entityType === "doc") {
          const publicPath = toSlash(markerPath).replace(/^docs\//, "");
          await withDocMutationLocks(this.storeRoot, [publicPath], removeMarkerCanonical);
        } else {
          await removeMarkerCanonical();
        }
      }
      // Recheck after the locked canonical phase and before any history cleanup.
      const remaining = await this.canonicalIdentityPaths(entityType, entityId);
      if (remaining.length > 0) throw unsafe("stable identity remains after purge canonical phase");
      // A crash can happen after the canonical phase marker was written but before legacy/history
      // cleanup. Re-run only exact, verified targets.
      await this.cleanupLegacy(entityType, entityId);
      this.setPurgePhase(entityType, entityId, "legacy_removed", marker);
      if (this.index) {
        const current = manifest.entries[key] ?? {
          entityType: "",
          entityId: "",
          path: "",
          hash: "",
        };
        if (current.path === "") {
          if (typeof marker.path === "string") current.path = marker.path;
          try {
            const stream = await this.history.read(entityType, entityId);
            const recs = stream.records ?? [];
            const tail = recs[recs.length - 1];
            if (tail) current.path = firstNonEmpty(tail.currentPath, tail.previousPath);
          } catch {
            // as in Go: a failed read leaves the path as is
          }
        }
        let batchId = typeof marker.batchId === "string" ? marker.batchId : "";
        if (batchId === "")
          batchId = lifecycleBatchId(this.storeRoot, "hard-delete", [`${key}\0${current.path}`]);
        const intent = emptyResult({
          entityType,
          entityId,
          path: current.path,
          operation: LIFECYCLE_OPERATION_HARD_DELETE,
          previousPath: current.path,
          batchId,
        });
        if (typeof marker.hash === "string") {
          intent.hash = marker.hash;
          intent.baseHash = marker.hash;
          intent.newHash = marker.hash;
        }
        await this.queueLifecycleIntent(intent);
      }
      await this.history.delete(entityType, entityId);
      this.setPurgePhase(entityType, entityId, "history_removed", marker);
      await this.writeManifestMutations(null, [key]);
      const pending = await this.flushLifecycleIntents();
      const first = pending[0];
      if (first && first.diagnostic !== "") throw new Error(first.diagnostic);
      return;
    }
    const stream = await this.history.read(entityType, entityId);
    const records = stream.records ?? [];
    const last = records[records.length - 1];
    if (!last) {
      if (!ok) return;
      throw unsafe("missing verified history");
    }
    if (!ok) {
      if (!last.tombstone) throw unsafe("manifest ownership missing");
      entry = {
        entityType,
        entityId,
        path: firstNonEmpty(last.currentPath, last.previousPath),
        hash: "",
      };
      ok = true;
    }
    const live = entry as ManifestEntry;
    if (opts.path && clean(opts.path) !== clean(live.path))
      throw unsafe("hard-delete path proof mismatch");
    if (opts.expectedHash && opts.expectedHash !== last.newHash)
      throw conflict("hard-delete hash proof mismatch");
    const abs = join(this.storeRoot, ...clean(live.path).split("/"));
    if (!under(this.storeRoot, abs) || !abs.endsWith(".md"))
      throw unsafe("hard-delete path outside canonical roots");
    let info: ReturnType<typeof lstatSync> | undefined;
    try {
      info = lstatSync(abs);
    } catch (e) {
      if (!isNotExist(e)) throw e;
    }
    if (info) {
      if (info.isSymbolicLink()) throw unsafe("canonical path is symlink");
      stableRead(abs);
      let ident: { kind: Kind; id: string } | undefined;
      try {
        ident = await this.resolveCanonicalHint(abs);
      } catch {
        ident = undefined;
      }
      if (!ident || ident.kind !== entityType || ident.id !== entityId) {
        throw unsafe("exact canonical identity proof failed");
      }
    } else {
      const paths = await this.canonicalIdentityPaths(entityType, entityId);
      if (paths.length > 0) throw unsafe("stable identity moved from missing manifest path");
      if (!last.tombstone) throw unsafe("active manifest path is missing without tombstone");
    }
    // Reserve the authorized purge before every irreversible phase.
    if (!opts.path) opts.path = live.path;
    if (!opts.expectedHash) opts.expectedHash = last.newHash ?? "";
    const batchId = lifecycleBatchId(this.storeRoot, "hard-delete", [`${key}\0${opts.path}`]);
    const marker: Record<string, unknown> = {
      entityType,
      entityId,
      path: opts.path,
      hash: opts.expectedHash,
      batchId,
      actor: opts.actor ?? "",
      reason: opts.reason,
      purgedAt: goNow(),
    };
    const removeCanonical = async (): Promise<void> => {
      // Re-read under the same cross-process document mutation lock used by public Doc writes.
      let cur: ReturnType<typeof lstatSync> | undefined;
      try {
        cur = lstatSync(abs);
      } catch (e) {
        if (!isNotExist(e)) throw e;
      }
      if (cur) {
        if (cur.isSymbolicLink()) throw unsafe("canonical path is symlink");
        stableRead(abs);
        let ident: { kind: Kind; id: string; hash: string } | undefined;
        try {
          ident = await this.resolveCanonicalHint(abs);
        } catch {
          ident = undefined;
        }
        if (!ident || ident.kind !== entityType || ident.id !== entityId) {
          throw unsafe("exact canonical identity proof failed");
        }
        if (opts.expectedHash && ident.hash !== opts.expectedHash)
          throw conflict("canonical hash changed during purge");
      } else {
        const paths = await this.canonicalIdentityPaths(entityType, entityId);
        if (paths.length > 0) throw unsafe("stable identity moved during purge");
        if (!last.tombstone) throw unsafe("active canonical disappeared during purge");
      }
      this.writePurgeReservation(entityType, entityId, opts);
      this.failureHooks.beforeCanonicalRemove?.(entityType, entityId, opts.path ?? "");
      try {
        rmSync(abs);
      } catch (e) {
        if (!isNotExist(e)) throw e;
      }
      this.setPurgePhase(entityType, entityId, "canonical_removed", marker);
    };
    if (entityType === "doc") {
      const publicPath = toSlash(live.path).replace(/^docs\//, "");
      await withDocMutationLocks(this.storeRoot, [publicPath], removeCanonical);
    } else {
      await removeCanonical();
    }
    const remaining = await this.canonicalIdentityPaths(entityType, entityId);
    if (remaining.length > 0) throw unsafe("stable identity remains after purge canonical phase");
    // Verify and remove only legacy successors whose immutable provenance binds them to this exact
    // JSONL stream. Unverified copies are intentionally left.
    await this.cleanupLegacy(entityType, entityId);
    this.setPurgePhase(entityType, entityId, "legacy_removed", marker);
    await this.history.delete(entityType, entityId);
    this.setPurgePhase(entityType, entityId, "history_removed", marker);
    if (this.index) {
      const result = emptyResult({
        entityType,
        entityId,
        path: live.path,
        operation: LIFECYCLE_OPERATION_HARD_DELETE,
        previousPath: live.path,
        batchId,
        hash: opts.expectedHash,
        baseHash: opts.expectedHash,
        newHash: opts.expectedHash,
      });
      await this.queueLifecycleIntent(result);
      await this.writeManifestMutations(null, [key]);
      const pending = await this.flushLifecycleIntents();
      const first = pending[0];
      if (first && first.diagnostic !== "") throw new Error(first.diagnostic);
      return;
    }
    await this.writeManifestMutations(null, [key]);
  }

  // --- lifecycle intents (the outbox for index handoffs) -----------------------------------

  private lifecycleIntentPath(): string {
    return join(this.storeRoot, "history", "state", "lifecycle-intents.json");
  }

  private withLifecycleIntentLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const lockPath = join(this.storeRoot, "history", "state", "lifecycle-intents.lock");
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o755 });
    return withFileLock(lockPath, fn);
  }

  private readIntents(): Record<string, ReconcileResult> {
    const out: Record<string, ReconcileResult> = {};
    const raw = JSON.parse(readFileSync(this.lifecycleIntentPath(), "utf8")) as Record<
      string,
      Record<string, unknown>
    > | null;
    for (const [key, value] of Object.entries(raw ?? {})) out[key] = resultFromWire(value);
    return out;
  }

  private writeIntents(intents: Record<string, ReconcileResult>): void {
    const wire: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sortedObject(intents))) wire[key] = resultWire(value);
    writeFileDurable(
      this.lifecycleIntentPath(),
      `${goJsonStringify(wire)}\n`,
      ".lifecycle-durable-",
    );
  }

  private queueLifecycleIntent(result: ReconcileResult): Promise<void> {
    return this.withLifecycleIntentLock(() => {
      let intents: Record<string, ReconcileResult> = {};
      try {
        intents = this.readIntents();
      } catch (e) {
        if (!isNotExist(e)) throw e;
      }
      const key = lifecycleIntentKey(result);
      const existing = intents[key];
      if (existing && existing.revision > result.revision) return;
      // One identity has one current lifecycle handoff. Remove superseded rename/update/delete
      // intents so a rename-back cannot replay stale ownership or index work after restart.
      for (const [existingKey, ex] of Object.entries(intents)) {
        if (
          existingKey === key ||
          ex.entityType !== result.entityType ||
          ex.entityId !== result.entityId
        )
          continue;
        if (
          ex.revision <= result.revision ||
          result.operation === LIFECYCLE_OPERATION_HARD_DELETE
        ) {
          delete intents[existingKey];
        }
      }
      intents[key] = result;
      this.writeIntents(intents);
    });
  }

  private async flushLifecycleIntents(): Promise<ReconcileResult[]> {
    try {
      return await this.withLifecycleIntentLock(() => this.flushLifecycleIntentsLocked());
    } catch (e) {
      return [emptyResult({ diagnostic: (e as Error).message })];
    }
  }

  private async flushLifecycleIntentsLocked(): Promise<ReconcileResult[]> {
    if (!this.index) return [];
    let intents: Record<string, ReconcileResult>;
    try {
      intents = this.readIntents();
    } catch (e) {
      if (isNotExist(e)) return [];
      return [emptyResult({ diagnostic: (e as Error).message })];
    }
    const results: ReconcileResult[] = [];
    for (const key of Object.keys(intents).sort()) {
      const result = intents[key] as ReconcileResult;
      let manifest: ReconcileManifest;
      try {
        manifest = readManifestFile(this.manifestPath());
      } catch (e) {
        result.diagnostic = (e as Error).message;
        results.push(result);
        continue;
      }
      const owned = manifest.entries[manifestKey(result.entityType, result.entityId)];
      if (
        result.operation !== LIFECYCLE_OPERATION_DELETE &&
        result.operation !== LIFECYCLE_OPERATION_HARD_DELETE
      ) {
        if (!owned || clean(owned.path) !== clean(result.path)) {
          // A newer durable history head supersedes this intent (for example rename A->B followed
          // by B->C). Keep an intent only when its exact revision is still recoverable.
          let supersede = false;
          try {
            const stream = await this.history.read(result.entityType, result.entityId);
            const recs = stream.records ?? [];
            const tail = recs[recs.length - 1];
            supersede = !tail || tail.revision > result.revision;
          } catch {
            supersede = true;
          }
          if (supersede) delete intents[key];
          continue;
        }
      } else if (owned) {
        // A delete intent is expected to see the old manifest while a crash-retry is in flight.
        // If a later restore/recreate head is durable, this intent is conclusively superseded.
        let supersede = false;
        try {
          const stream = await this.history.read(result.entityType, result.entityId);
          const recs = stream.records ?? [];
          const tail = recs[recs.length - 1];
          supersede =
            !tail ||
            tail.revision > result.revision ||
            tail.operation === LIFECYCLE_OPERATION_RESTORE;
        } catch {
          supersede = true;
        }
        if (supersede) delete intents[key];
        continue;
      }
      try {
        await this.index(result);
      } catch (e) {
        result.diagnostic = `lifecycle handoff failed after durable ownership: ${(e as Error).message}`;
        results.push(result);
        continue;
      }
      delete intents[key];
    }
    try {
      this.writeIntents(intents);
    } catch (e) {
      results.push(emptyResult({ diagnostic: (e as Error).message }));
    }
    return results;
  }
}

// --- free helpers --------------------------------------------------------------------------

function lifecycleIntentKey(result: ReconcileResult): string {
  return `${manifestKey(result.entityType, result.entityId)}\0${result.operation}\0${result.path}`;
}

function lifecycleResultCount(results: readonly ReconcileResult[]): number {
  return results.filter((r) => r.operation !== "" && r.diagnostic === "").length;
}

function manifestPathConflict(
  manifest: ReconcileManifest,
  kind: string,
  id: string,
  path: string,
): string {
  const previous = manifest.entries[manifestKey(kind, id)];
  if (!previous || goTrim(previous.path) === "" || clean(previous.path) === clean(path)) return "";
  return unsafe(
    `stable ${kind} identity ${goQuoted(id)} moved from ${previous.path} to ${path}; lifecycle reconciliation is required`,
  ).message;
}

function transientSibling(path: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dirname(path), { withFileTypes: true });
  } catch {
    return false;
  }
  const base = basename(path);
  for (const entry of entries) {
    const name = entry.name;
    if (name === base) continue;
    const lower = name.toLowerCase();
    if (
      name.startsWith(".") ||
      lower.endsWith(".tmp") ||
      lower.endsWith(".swp") ||
      lower.endsWith("~") ||
      lower.includes(".autosave")
    ) {
      return true;
    }
  }
  return false;
}

function stableSortByPath(results: ReconcileResult[]): ReconcileResult[] {
  return results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.path < b.r.path ? -1 : a.r.path > b.r.path ? 1 : a.i - b.i))
    .map((x) => x.r);
}

const goTrim = goTrimSpace;

function isAbsolutePath(p: string): boolean {
  return (
    p.startsWith("/") ||
    p.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(p) ||
    (sep === "\\" && /^[A-Za-z]:/.test(p))
  );
}

/** time.RFC3339Nano in UTC. */
function goNanoTime(d: Date): string {
  return goNow(d);
}

/** `%q` for an identifier. */
function goQuoted(s: string): string {
  return JSON.stringify(s);
}
