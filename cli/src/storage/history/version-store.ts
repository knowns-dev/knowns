// Port of internal/storage/version_store.go: task and doc revision history over the JSONL
// HistoryStore, with the legacy `.knowns/versions/*.json` formats still readable and migrated on
// first write.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Doc } from "../../models/doc.ts";
import type { Task } from "../../models/task.ts";
import type {
  DocChange,
  DocRevisionDiff,
  DocVersion,
  DocVersionHistory,
  DocVersionHistoryPage,
  HistoryMetadata,
  HistoryMetadataPage,
  HistoryRecord,
  TaskChange,
  TaskVersion,
  TaskVersionHistory,
  TaskVersionHistoryPage,
} from "../../models/version.ts";
import { goTrimSpace, writeJson } from "../core/util.ts";
import { MutationConflictError } from "./conflicts.ts";
import {
  anyStringSlice,
  applyDocChangesToState,
  applyTaskChangesToMap,
  cloneDocState,
  compactDocPaths,
  type DocState,
  docChangeScopes,
  docHashRecognized,
  docHistoryFromRecords,
  docStateOf,
  docToSnapshot,
  findDocVersionIndex,
  firstSectionScopeOf,
  hashDoc,
  hashSnapshot,
  historyDeltaInefficient,
  historyRevisionMatches,
  legacyDocId,
  logicalVersionOf,
  newDocId,
  normalizeDocPath,
  normalizeStateMap,
  resolveDocStateFromHistory,
  taskCanonicalHash,
  taskHistoryFromRecords,
  trackDocChanges,
  trackTaskChanges,
} from "./entities.ts";
import { type AnyMap, cloneJson, firstNonEmpty, firstPositive, goNow, timeMs } from "./go-json.ts";
import {
  type HistoryRetentionPolicy,
  HistoryStore,
  type LegacyCleanupReport,
  type LegacyCleanupTarget,
  stableDocIdSlug,
} from "./history-store.ts";
import {
  decodeDocVersionHistory,
  decodeTaskVersionHistory,
  encodeDocVersionHistory,
  encodeTaskVersionHistory,
} from "./legacy.ts";
import {
  HISTORY_SCHEMA_VERSION,
  HistoryConflictError,
  HistoryCorruptError,
  isHistoryConflict,
} from "./records.ts";

/** DocRevisionOptions: optional context for document history entries. */
export interface DocRevisionOptions {
  section?: string;
  actor?: string;
  source?: string;
  auditEventId?: string;
  sessionId?: string;
  retention?: DocHistoryRetentionPolicy;
  expectedHash?: string;
}

/** DocHistoryRetentionPolicy bounds retained document history detail. */
export interface DocHistoryRetentionPolicy {
  maxVersions?: number;
  /** Milliseconds. */
  maxAgeMs?: number;
  now?: Date;
}

export interface VersionStoreOptions {
  historyStore?: HistoryStore;
  /** Serializes whole-store task writes; Go's `taskLifecycleLock`. */
  withTaskLifecycleLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Canonical Doc lookup used when a legacy doc history is migrated on demand. */
  getDoc?: (path: string) => Promise<Doc | undefined> | Doc | undefined;
}

/** A TaskVersion handed to saveVersion: ids, numbers and hashes are assigned here. */
export type TaskVersionInput = Partial<TaskVersion>;

export interface ActivityEntry {
  taskId: string;
  taskTitle: string;
  version: number;
  timestamp: string;
  author?: string;
  changes: TaskChange[] | null;
}

function retentionReason(policy: DocHistoryRetentionPolicy): string {
  const v = (policy.maxVersions ?? 0) > 0;
  const a = (policy.maxAgeMs ?? 0) > 0;
  if (v && a) return "max_versions_and_max_age";
  if (v) return "max_versions";
  if (a) return "max_age";
  return "manual";
}

export function historyHasUnverifiedLegacy(h: DocVersionHistory | null): boolean {
  return !!h && (h.versions ?? []).some((v) => v.legacyUnverified);
}

/** TaskStore.IsIDReserved: a hard-delete tombstone prevents ID reuse. */
export function isTaskIdReserved(root: string, id: string): boolean {
  if (id === "" || id === "." || id === ".." || /[/\\\0]/.test(id)) {
    throw new Error(`invalid task ID "${id}"`);
  }
  return existsSync(join(root, "tombstones", "tasks", `${id}.json`));
}

function copyList<T>(list: readonly T[] | null | undefined): T[] | undefined {
  return list && list.length > 0 ? list.map((x) => cloneJson(x)) : undefined;
}

export class VersionStore {
  readonly history: HistoryStore;

  constructor(
    readonly root: string,
    private readonly options: VersionStoreOptions = {},
  ) {
    this.history = options.historyStore ?? new HistoryStore(root);
  }

  historyStore(): HistoryStore {
    return this.history;
  }

  private versionsDir(): string {
    return join(this.root, "versions");
  }

  versionPath(taskId: string): string {
    return join(this.versionsDir(), `task-${taskId}.json`);
  }

  hasJsonlHistory(entityType: string, entityId: string): boolean {
    return this.history.hasHistory(entityType, entityId);
  }

  // --- tasks -----------------------------------------------------------------------------------

  /** GetHistory: the full version history for a task; empty (not an error) when none exists. */
  async getHistory(taskId: string): Promise<TaskVersionHistory> {
    const result = await this.history.read("task", taskId);
    if ((result.records ?? []).length > 0 || result.tailTruncated) {
      const history = taskHistoryFromRecords(taskId, result.records ?? []);
      if (result.tailTruncated) history.tailTruncated = true;
      return history;
    }
    let data: string;
    try {
      data = readFileSync(this.versionPath(taskId), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { taskId, currentVersion: 0, versions: [] };
      }
      throw new Error(`read version history ${taskId}: ${(e as Error).message}`, { cause: e });
    }
    let h: TaskVersionHistory;
    try {
      h = decodeTaskVersionHistory(JSON.parse(data));
    } catch (e) {
      throw new Error(`parse version history ${taskId}: ${(e as Error).message}`, { cause: e });
    }
    if (!h.versions) h.versions = [];
    return h;
  }

  /** ListTaskHistoryMetadata: a payload-free, newest-first page. */
  async listTaskHistoryMetadata(
    taskId: string,
    offset = 0,
    limit = 0,
  ): Promise<TaskVersionHistoryPage> {
    if (this.hasJsonlHistory("task", taskId)) {
      const { records, tailTruncated } = await this.history.listMetadata("task", taskId, 0, 0);
      const page = historyMetadataPage(records, offset, limit);
      page.entityType = "task";
      page.entityId = taskId;
      if (tailTruncated) page.tailTruncated = true;
      return page;
    }
    const history = await this.getHistory(taskId);
    const records = (history.versions ?? []).map((v) => historyRecordFromTaskVersion(taskId, v));
    const page = historyMetadataPage(records, offset, limit);
    page.entityType = "task";
    page.entityId = taskId;
    if (history.tailTruncated) page.tailTruncated = true;
    return page;
  }

  /** GetTaskRevisionDetail: one revision with its reconstructed snapshot. */
  async getTaskRevisionDetail(taskId: string, revisionId: string): Promise<TaskVersion> {
    if (this.hasJsonlHistory("task", taskId)) {
      const { records } = await this.history.listMetadata("task", taskId, 0, 0);
      const physical = resolveHistoryRecordRevision(records, revisionId);
      const window = await this.history.readRecordWindow("task", taskId, physical);
      const history = taskHistoryFromRecords(taskId, window);
      const versions = history.versions ?? [];
      const version = versions[versions.length - 1];
      if (!version) throw new Error(`revision "${revisionId}" not found`);
      return version;
    }
    const history = await this.getHistory(taskId);
    for (const version of history.versions ?? []) {
      if (historyRevisionMatches(version.id, version.version, revisionId)) {
        return { ...version, snapshot: version.snapshot ? cloneJson(version.snapshot) : null };
      }
    }
    throw new Error(`revision "${revisionId}" not found`);
  }

  getTaskRevision(taskId: string, revisionId: string): Promise<TaskVersion> {
    return this.getTaskRevisionDetail(taskId, revisionId);
  }

  /** SaveVersion: append a new version entry (takes the task lifecycle lock when configured). */
  async saveVersion(taskId: string, version: TaskVersionInput): Promise<void> {
    const lock = this.options.withTaskLifecycleLock;
    if (!lock) return this.saveVersionUnlocked(taskId, version);
    return lock(() => this.saveVersionUnlocked(taskId, version));
  }

  /** saveVersionUnlocked: callers already hold the task lifecycle lock. */
  async saveVersionUnlocked(taskId: string, input: TaskVersionInput): Promise<void> {
    if (isTaskIdReserved(this.root, taskId)) {
      throw new Error(`cannot save version for hard-deleted Task "${taskId}"`);
    }
    if (!this.hasJsonlHistory("task", taskId)) await this.migrateLegacyTask(taskId);
    const h = await this.getHistory(taskId);
    h.currentVersion++;
    const version: TaskVersion = {
      changes: null,
      snapshot: null,
      ...input,
      id: `v${h.currentVersion}`,
      version: h.currentVersion,
      taskId,
      timestamp: input.timestamp && input.timestamp !== "" ? input.timestamp : goNow(),
    };
    // Normalize before storing so the write and replay paths agree on snapshot shape.
    if (version.snapshot) version.snapshot = normalizeStateMap(version.snapshot);
    const versions = [...(h.versions ?? []), version];
    const delta = version.changes && version.changes.length > 0 ? version.changes : null;
    const checkpoint =
      versions.length === 1 ||
      !!version.checkpoint ||
      historyDeltaInefficient(delta, version.snapshot);
    let baseHash = "";
    const prev = versions[versions.length - 2];
    if (prev) {
      baseHash = prev.newHash ?? "";
      if (baseHash === "" && prev.snapshot && Object.keys(prev.snapshot).length > 0) {
        baseHash = taskCanonicalHash(prev.snapshot);
      }
    }
    let stateForHash: AnyMap = normalizeStateMap(cloneJson(version.snapshot ?? {}));
    if (prev && !checkpoint) {
      stateForHash = applyTaskChangesToMap(cloneJson(prev.snapshot ?? {}), version.changes);
    }
    version.schemaVersion = HISTORY_SCHEMA_VERSION;
    version.baseHash = baseHash;
    version.newHash = taskCanonicalHash(stateForHash);
    version.checkpoint = checkpoint;
    const jsonl = this.hasJsonlHistory("task", taskId);
    const legacy = !jsonl && existsSync(this.versionPath(taskId));
    if (jsonl || !legacy) {
      const record: HistoryRecord = {
        schemaVersion: 0,
        entityType: "task",
        entityId: taskId,
        revision: 0,
        timestamp: version.timestamp,
        author: version.author,
        source: version.source,
        sessionId: version.sessionId,
        batchId: version.batchId,
        lifecycleEventId: version.lifecycleEventId,
        baseHash: version.baseHash,
        newHash: version.newHash,
        checkpoint: version.checkpoint,
        taskChanges: copyList(version.changes),
        checkpointPayload:
          version.checkpoint && version.snapshot ? cloneJson(version.snapshot) : undefined,
      };
      await this.history.append(record);
      return;
    }
    versions[versions.length - 1] = version;
    h.versions = versions;
    mkdirSync(this.versionsDir(), { recursive: true, mode: 0o755 });
    writeJson(this.versionPath(taskId), encodeTaskVersionHistory(h));
  }

  /** TrackChanges: changed fields between two tasks (null `oldTask` = creation). */
  trackChanges(oldTask: Task | null, newTask: Task): TaskChange[] {
    return trackTaskChanges(oldTask, newTask);
  }

  /** ListRecentActivities: scans legacy task version files, newest first. */
  listRecentActivities(limit = 0, typeFilter = ""): ActivityEntry[] {
    const dir = this.versionsDir();
    if (!existsSync(dir)) return [];
    const all: ActivityEntry[] = [];
    for (const name of readdirSync(dir).sort()) {
      if (!name.startsWith("task-") || !name.endsWith(".json")) continue;
      let h: TaskVersionHistory;
      try {
        h = decodeTaskVersionHistory(JSON.parse(readFileSync(join(dir, name), "utf8")));
      } catch {
        continue;
      }
      for (const v of h.versions ?? []) {
        if (!v.changes || v.changes.length === 0) continue;
        if (typeFilter !== "" && !matchesTypeFilter(v.changes, typeFilter)) continue;
        const title = typeof v.snapshot?.title === "string" ? v.snapshot.title : "";
        all.push({
          taskId: h.taskId,
          taskTitle: title,
          version: v.version,
          timestamp: v.timestamp,
          ...(v.author ? { author: v.author } : {}),
          changes: v.changes,
        });
      }
    }
    all.sort((a, b) => timeMs(b.timestamp) - timeMs(a.timestamp));
    return limit > 0 && all.length > limit ? all.slice(0, limit) : all;
  }

  /** ApplyTaskHistoryRetention: compact an active Task JSONL stream. */
  async applyTaskHistoryRetention(
    taskId: string,
    policy: HistoryRetentionPolicy,
  ): Promise<TaskVersionHistory> {
    await this.migrateLegacyTask(taskId);
    await this.history.compact("task", taskId, policy);
    return this.getHistory(taskId);
  }

  // --- legacy migration -------------------------------------------------------------------------

  /** migrateLegacyTask: translate `task-<id>.json` into JSONL unless JSONL already exists. */
  async migrateLegacyTask(taskId: string): Promise<void> {
    if (this.hasJsonlHistory("task", taskId)) return;
    const path = this.versionPath(taskId);
    let data: string;
    try {
      data = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    let legacy: TaskVersionHistory;
    try {
      legacy = decodeTaskVersionHistory(JSON.parse(data));
    } catch (e) {
      throw new Error(`parse legacy Task history ${taskId}: ${(e as Error).message}`, { cause: e });
    }
    await this.history.migrateLegacyTask(path, taskId, legacy);
  }

  /** MigrateLegacyTaskHistory: like migrateLegacyTask but a missing file is an error. */
  async migrateLegacyTaskHistory(taskId: string): Promise<void> {
    if (this.hasJsonlHistory("task", taskId)) return;
    const path = this.versionPath(taskId);
    const legacy = decodeTaskVersionHistory(JSON.parse(readFileSync(path, "utf8")));
    await this.history.migrateLegacyTask(path, taskId, legacy);
  }

  async migrateLegacyDocHistory(docPath: string): Promise<void> {
    const current = await this.options.getDoc?.(normalizeDocPath(docPath));
    await this.migrateLegacyDocPathsWithCurrent(current ?? null, docPath);
  }

  async migrateLegacyDocPaths(...paths: string[]): Promise<void> {
    await this.migrateLegacyDocPathsWithCurrent(null, ...paths);
  }

  async migrateLegacyDocPathsWithCurrent(current: Doc | null, ...paths: string[]): Promise<void> {
    const snapshotOf = () => (current ? docToSnapshot(docStateOf(current)) : undefined);
    const stable = this.loadStableDocHistoryForAnyPath(...paths);
    if (stable.ok && stable.history?.docId && !this.hasJsonlHistory("doc", stable.history.docId)) {
      await this.history.migrateLegacyDocWithCurrent(
        this.stableDocVersionPath(stable.history.docId),
        stable.history.docId,
        firstNonEmpty(stable.history.currentPath, stable.history.docPath),
        stable.history,
        snapshotOf(),
      );
      return;
    }
    for (const path of compactDocPaths(...paths)) {
      // Stable files are authoritative when present; the path index only supplies identity and
      // is intentionally not rewritten during migration.
      const legacyPath = this.legacyDocVersionPath(path);
      let data: string;
      try {
        data = readFileSync(legacyPath, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      let legacy: DocVersionHistory;
      try {
        legacy = decodeDocVersionHistory(JSON.parse(data));
      } catch (e) {
        throw new Error(`parse legacy Doc history ${path}: ${(e as Error).message}`, { cause: e });
      }
      const docId = firstNonEmpty(legacy.docId, legacyDocId(path));
      if (this.hasJsonlHistory("doc", docId)) return;
      await this.history.migrateLegacyDocWithCurrent(legacyPath, docId, path, legacy, snapshotOf());
      return;
    }
  }

  /** PreviewLegacyCleanup: legacy files with a verified JSONL successor. */
  async previewLegacyCleanup(entityType: string, entityId: string): Promise<LegacyCleanupReport> {
    const paths: string[] = [];
    if (entityType === "task") {
      paths.push(this.versionPath(entityId));
    } else if (entityType === "doc") {
      try {
        const h = await this.getDocHistory(entityId);
        paths.push(
          this.legacyDocVersionPath(h.currentPath ?? ""),
          this.stableDocVersionPath(h.docId ?? ""),
        );
      } catch {
        // as in Go: no history, no candidates
      }
    }
    return this.history.previewLegacyCleanup(entityType, entityId, ...paths);
  }

  confirmLegacyCleanup(target: LegacyCleanupTarget, confirmed: boolean): Promise<void> {
    return this.history.confirmLegacyCleanup(target, confirmed);
  }

  // --- docs: paths and legacy files --------------------------------------------------------------

  legacyDocVersionPath(docPath: string): string {
    return join(this.versionsDir(), `doc-${docPath.replaceAll("/", "--")}.json`);
  }

  docVersionPath(docPath: string): string {
    return this.legacyDocVersionPath(docPath);
  }

  stableDocVersionPath(docId: string): string {
    return join(this.versionsDir(), `docid-${stableDocIdSlug(docId)}.json`);
  }

  private docVersionIndexPath(): string {
    return join(this.versionsDir(), "doc_history_index.json");
  }

  private loadDocVersionIndex(): { paths: Record<string, string> } {
    let data: string;
    try {
      data = readFileSync(this.docVersionIndexPath(), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { paths: {} };
      throw new Error(`read doc version index: ${(e as Error).message}`, { cause: e });
    }
    let parsed: { paths?: Record<string, string> | null };
    try {
      parsed = JSON.parse(data);
    } catch (e) {
      throw new Error(`parse doc version index: ${(e as Error).message}`, { cause: e });
    }
    return { paths: parsed?.paths ?? {} };
  }

  private indexDocHistory(docId: string, currentPath: string, previousPath: string): void {
    const idx = this.loadDocVersionIndex();
    currentPath = normalizeDocPath(currentPath);
    previousPath = normalizeDocPath(previousPath);
    if (previousPath !== "" && previousPath !== currentPath) delete idx.paths[previousPath];
    idx.paths[currentPath] = docId;
    mkdirSync(this.versionsDir(), { recursive: true, mode: 0o755 });
    writeJson(this.docVersionIndexPath(), idx);
  }

  private loadStableDocHistoryByID(docId: string): DocVersionHistory | undefined {
    let data: string;
    try {
      data = readFileSync(this.stableDocVersionPath(docId), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    let h: DocVersionHistory;
    try {
      h = decodeDocVersionHistory(JSON.parse(data));
    } catch (e) {
      throw new Error(`parse doc version history ${docId}: ${(e as Error).message}`, { cause: e });
    }
    normalizeDocHistory(h, docId, "");
    return h;
  }

  private scanStableDocHistoryForPath(...paths: string[]): {
    history?: DocVersionHistory;
    ok: boolean;
  } {
    const want = new Set(compactDocPaths(...paths));
    if (want.size === 0) return { ok: false };
    const dir = this.versionsDir();
    if (!existsSync(dir)) return { ok: false };
    let match: DocVersionHistory | undefined;
    for (const name of readdirSync(dir).sort()) {
      if (!name.startsWith("docid-") || !name.endsWith(".json")) continue;
      let h: DocVersionHistory;
      try {
        h = decodeDocVersionHistory(JSON.parse(readFileSync(join(dir, name), "utf8")));
      } catch {
        continue;
      }
      normalizeDocHistory(h, h.docId ?? "", "");
      if (docHistoryContainsPath(h, want)) {
        if (match && match.docId !== h.docId) {
          throw new Error(
            `ambiguous Doc history candidates for path "${firstNonEmpty(...paths)}"; repair stable history index before mutating`,
          );
        }
        match = h;
      }
    }
    return match ? { history: match, ok: true } : { ok: false };
  }

  private loadStableDocHistoryForAnyPath(...paths: string[]): {
    history?: DocVersionHistory;
    ok: boolean;
  } {
    const idx = this.loadDocVersionIndex();
    for (const path of compactDocPaths(...paths)) {
      const docId = idx.paths[path];
      if (docId) {
        const h = this.loadStableDocHistoryByID(docId);
        if (!h) continue;
        return { history: h, ok: true };
      }
    }
    return this.scanStableDocHistoryForPath(...paths);
  }

  private loadLegacyDocHistory(docPath: string): { history?: DocVersionHistory; ok: boolean } {
    docPath = normalizeDocPath(docPath);
    if (docPath === "") return { ok: false };
    let data: string;
    try {
      data = readFileSync(this.legacyDocVersionPath(docPath), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: false };
      throw new Error(`read doc version history ${docPath}: ${(e as Error).message}`, { cause: e });
    }
    let h: DocVersionHistory;
    try {
      h = decodeDocVersionHistory(JSON.parse(data));
    } catch (e) {
      throw new Error(`parse doc version history ${docPath}: ${(e as Error).message}`, {
        cause: e,
      });
    }
    if (!h.docId) h.docId = legacyDocId(docPath);
    normalizeDocHistory(h, h.docId, docPath);
    return { history: h, ok: true };
  }

  /** readDocJSONL: the replayed history for a path, found through the stream scan. */
  async readDocJsonl(docPath: string): Promise<{ history?: DocVersionHistory; ok: boolean }> {
    const entityId = await this.history.findEntityByPath("doc", docPath);
    if (entityId === undefined) return { ok: false };
    const result = await this.history.read("doc", entityId);
    const history = docHistoryFromRecords(docPath, result.records ?? []);
    if (result.tailTruncated) history.tailTruncated = true;
    return { history, ok: true };
  }

  // --- docs: reads ------------------------------------------------------------------------------

  /** GetDocHistory: empty (not an error) when no history exists. */
  async getDocHistory(docPath: string): Promise<DocVersionHistory> {
    docPath = normalizeDocPath(docPath);
    const jsonl = await this.readDocJsonl(docPath);
    if (jsonl.ok && jsonl.history) return jsonl.history;
    const stable = this.loadStableDocHistoryForAnyPath(docPath);
    if (stable.ok && stable.history) return stable.history;
    const legacy = this.loadLegacyDocHistory(docPath);
    if (legacy.ok && legacy.history) return legacy.history;
    return { docPath, currentPath: docPath, currentVersion: 0, versions: [] };
  }

  /** ListDocHistoryMetadata: payload-free, newest-first page. */
  async listDocHistoryMetadata(
    docPath: string,
    offset = 0,
    limit = 0,
  ): Promise<DocVersionHistoryPage> {
    docPath = normalizeDocPath(docPath);
    const entityId = await this.history.findEntityByPathMetadata("doc", docPath);
    if (entityId !== undefined) {
      const { records, tailTruncated } = await this.history.listMetadata("doc", entityId, 0, 0);
      const page = historyMetadataPage(records, offset, limit);
      page.entityType = "doc";
      page.entityId = entityId;
      page.docPath = docPath;
      page.currentPath = docPath;
      if (tailTruncated) page.tailTruncated = true;
      return page;
    }
    const history = await this.getDocHistory(docPath);
    const records = (history.versions ?? []).map((v) =>
      historyRecordFromDocVersion(history.docId ?? "", v),
    );
    const page = historyMetadataPage(records, offset, limit);
    page.entityType = "doc";
    page.entityId = history.docId ?? "";
    page.docPath = history.docPath;
    page.currentPath = history.currentPath;
    page.currentVersion = history.currentVersion;
    if (history.tailTruncated) page.tailTruncated = true;
    return page;
  }

  /** GetDocRevisionDetail: one revision, snapshot rebuilt from the nearest retained checkpoint. */
  async getDocRevisionDetail(docPath: string, revisionId: string): Promise<DocVersion> {
    docPath = normalizeDocPath(docPath);
    const entityId = await this.history.findEntityByPathMetadata("doc", docPath);
    if (entityId !== undefined) {
      const { records } = await this.history.listMetadata("doc", entityId, 0, 0);
      const physical = resolveHistoryRecordRevision(records, revisionId);
      const window = await this.history.readRecordWindow("doc", entityId, physical);
      const history = docHistoryFromRecords(docPath, window);
      const versions = history.versions ?? [];
      const version = versions[versions.length - 1];
      if (!version) throw new Error(`revision "${revisionId}" not found`);
      return version;
    }
    const history = await this.getDocHistory(docPath);
    for (const version of history.versions ?? []) {
      if (historyRevisionMatches(version.id, version.version, revisionId)) return version;
    }
    throw new Error(`revision "${revisionId}" not found`);
  }

  getDocRevision(docPath: string, revisionId: string): Promise<DocVersion> {
    return this.getDocRevisionDetail(docPath, revisionId);
  }

  /** ResolveDocState: the state a revision represents ("" = latest retained). */
  async resolveDocState(docPath: string, revisionId: string): Promise<DocState> {
    const h = await this.getDocHistory(docPath);
    return resolveDocStateFromHistory(h, revisionId);
  }

  /** GetDocRevisionDiff. */
  async getDocRevisionDiff(docPath: string, revisionId: string): Promise<DocRevisionDiff> {
    const h = await this.getDocHistory(docPath);
    const idx = findDocVersionIndex(h, revisionId);
    const versions = h.versions ?? [];
    const version = versions[idx] as DocVersion;
    const diff: DocRevisionDiff = {
      docPath: h.docPath,
      revisionId: version.id,
      version,
      checkpoint: !!version.checkpoint,
      changes: version.changes ?? null,
    };
    if (h.docId) diff.docId = h.docId;
    if (h.currentPath) diff.currentPath = h.currentPath;
    if (idx > 0) diff.previousRevisionId = (versions[idx - 1] as DocVersion).id;
    if (version.changedScopes && version.changedScopes.length > 0)
      diff.changedScopes = version.changedScopes;
    if (h.retentionGaps && h.retentionGaps.length > 0) diff.retentionGaps = h.retentionGaps;
    return diff;
  }

  /** sectionForRevision: the single section a section-scoped revision changed. */
  async sectionForRevision(docPath: string, revisionId: string): Promise<string> {
    const h = await this.getDocHistory(docPath);
    const target = goTrimSpace(revisionId);
    for (const version of h.versions ?? []) {
      if (
        target !== "" &&
        version.id !== target &&
        String(version.version) !== target &&
        `v${version.version}` !== target
      ) {
        continue;
      }
      const section = firstSectionScopeOf(version.changedScopes);
      if (section !== "") return section;
      if (target !== "") break;
    }
    throw new Error(`revision "${revisionId}" does not identify a single section`);
  }

  // --- docs: writes -----------------------------------------------------------------------------

  trackDocChanges(oldDoc: Doc | null, newDoc: Doc): DocChange[] {
    return trackDocChanges(oldDoc ? docStateOf(oldDoc) : null, docStateOf(newDoc)).changes;
  }

  /** SaveDocVersion: append a fully formed version for a path. */
  async saveDocVersion(docPath: string, input: Partial<DocVersion>): Promise<void> {
    docPath = normalizeDocPath(docPath);
    await this.migrateLegacyDocPaths(docPath);
    const h = await this.docHistoryForWrite(docPath, "");
    const version = { changes: null, snapshot: null, docPath: "", ...input } as DocVersion;
    if (!version.newHash && version.snapshot && Object.keys(version.snapshot).length > 0) {
      version.newHash = hashSnapshot(version.snapshot);
    }
    if (!version.changedScopes || version.changedScopes.length === 0) {
      const scopes = docChangeScopes(version.changes);
      if (scopes.length > 0) version.changedScopes = scopes;
    }
    await this.appendDocVersion(h, "", version);
  }

  saveDocRevision(oldDoc: Doc | null, newDoc: Doc): Promise<void> {
    return this.saveDocRevisionWithOptions(oldDoc, newDoc, {});
  }

  /**
   * SaveDocRevisionWithOptions records a document creation/update/rename revision using a stable
   * identity, with optional section attribution and actor/source/audit metadata.
   */
  async saveDocRevisionWithOptions(
    oldDoc: Doc | null,
    newDoc: Doc | null,
    opts: DocRevisionOptions,
  ): Promise<void> {
    if (!newDoc) throw new Error("new doc is required");
    const before = oldDoc ?? newDoc;
    await this.migrateLegacyDocPathsWithCurrent(before, newDoc.path, oldDoc ? oldDoc.path : "");
    const oldState = oldDoc ? docStateOf(oldDoc) : null;
    const newState = docStateOf(newDoc);
    const { changes, scopes, contentScope } = trackDocChanges(oldState, newState, {
      section: opts.section,
    });
    if (oldState && changes.length === 0) return;

    let oldPath = "";
    let baseHash = "";
    if (oldState) {
      oldPath = normalizeDocPath(oldState.path);
      baseHash = hashDoc(oldState);
    }
    const currentPath = normalizeDocPath(newState.path);
    const h = await this.docHistoryForWrite(currentPath, oldPath);
    const versions = h.versions ?? [];
    // Canonical callers establish the frontmatter ID before entering history.
    if (versions.length === 0 && newState.id !== "") h.docId = newState.id;
    if (!h.docId) h.docId = newState.id;
    if (versions.length > 0) {
      if (!oldState)
        throw new HistoryConflictError("nil old doc cannot append to existing history");
      const head = versions[versions.length - 1] as DocVersion;
      let headState: DocState;
      try {
        headState = resolveDocStateFromHistory(h, head.id);
      } catch (e) {
        throw new Error(`reconstruct Doc history head: ${(e as Error).message}`, { cause: e });
      }
      const expected = hashDoc(oldState);
      if (expected !== hashDoc(headState) && !historyHasUnverifiedLegacy(h)) {
        throw new MutationConflictError(
          "doc",
          firstNonEmpty(newState.id, h.docId, newState.path),
          expected,
          hashDoc(headState),
        );
      }
    } else {
      // A stream with no records must start with a self-contained checkpoint; the caller's
      // oldDoc hash is not a valid first-record BaseHash because there is nothing to chain from.
      baseHash = "";
    }
    const checkpoint =
      !oldState ||
      versions.length === 0 ||
      historyDeltaInefficient(changes.length > 0 ? changes : null, docToSnapshot(newState)) ||
      historyHasUnverifiedLegacy(h);
    const snapshot = docToSnapshot(newState);
    if (!checkpoint && (!contentScope.ok || contentScope.scope?.type === "section")) {
      delete snapshot.content;
    }
    const version = {
      currentPath,
      ...(oldPath !== "" && oldPath !== currentPath ? { previousPath: oldPath } : {}),
      ...(opts.actor ? { author: opts.actor, actor: opts.actor } : {}),
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.auditEventId ? { auditEventId: opts.auditEventId } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      baseHash,
      newHash: hashDoc(newState),
      checkpoint,
      changes,
      changedScopes: scopes,
      snapshot,
    } as unknown as DocVersion;
    if (oldState && !checkpoint) {
      const stateForHash = cloneDocState(oldState);
      applyDocChangesToState(stateForHash, {
        schemaVersion: 0,
        entityType: "doc",
        entityId: "",
        revision: 0,
        timestamp: "",
        docChanges: changes,
        changedScopes: scopes,
        currentPath,
      });
      version.newHash = hashSnapshot(docToSnapshot(stateForHash));
    }
    await this.appendDocVersion(h, oldPath, version);
    if (opts.retention) await this.applyDocHistoryRetention(currentPath, opts.retention);
  }

  /** appendDocVersion: validate the candidate state against the head, then persist. */
  private async appendDocVersion(
    h: DocVersionHistory,
    previousPath: string,
    input: DocVersion,
  ): Promise<void> {
    const version: DocVersion = { ...input };
    version.docId = h.docId;
    version.docPath = h.currentPath ?? "";
    if (!version.currentPath) version.currentPath = h.currentPath;
    if (!version.timestamp) version.timestamp = goNow();

    const versions = h.versions ?? [];
    let candidate: DocState;
    let baseHash = version.baseHash ?? "";
    if (versions.length === 0) {
      if (!version.checkpoint || !version.snapshot || Object.keys(version.snapshot).length === 0) {
        throw new HistoryCorruptError("first Doc history record must be a checkpoint payload");
      }
      candidate = blankDoc();
      applyDocSnapshotAndPath(candidate, version);
      if (baseHash !== "")
        throw new HistoryCorruptError("first Doc history record has a base hash");
    } else {
      const head = versions[versions.length - 1] as DocVersion;
      let headState: DocState;
      try {
        headState = resolveDocStateFromHistory(h, head.id);
      } catch (e) {
        throw new Error(`reconstruct Doc history head: ${(e as Error).message}`, { cause: e });
      }
      const headHash = hashDoc(headState);
      if (!docHashRecognized(head.newHash, headState)) {
        throw new HistoryCorruptError("Doc history head hash mismatch");
      }
      const recordedHead = firstNonEmpty(head.newHash, headHash);
      if (baseHash === "") {
        baseHash = recordedHead;
      } else if (baseHash !== recordedHead && baseHash !== headHash) {
        throw new HistoryConflictError("Doc history base hash does not match current head");
      } else {
        // Keep the on-disk chain linked to the hash the head actually records.
        baseHash = recordedHead;
      }
      if (version.checkpoint) {
        if (!version.snapshot || Object.keys(version.snapshot).length === 0) {
          throw new HistoryCorruptError("Doc checkpoint payload is required");
        }
        candidate = blankDoc();
        applyDocSnapshotAndPath(candidate, version);
      } else {
        candidate = headState;
        applyDocChangesToState(candidate, {
          schemaVersion: 0,
          entityType: "doc",
          entityId: "",
          revision: 0,
          timestamp: "",
          docChanges: version.changes ?? [],
          changedScopes: version.changedScopes,
          currentPath: version.currentPath,
        });
      }
    }
    const candidateHash = hashDoc(candidate);
    if (!docHashRecognized(version.newHash, candidate)) {
      throw new HistoryCorruptError("Doc candidate hash does not match supplied NewHash");
    }
    version.schemaVersion = HISTORY_SCHEMA_VERSION;
    version.baseHash = baseHash;
    version.newHash = candidateHash;
    if (version.checkpoint) version.snapshot = docToSnapshot(candidate);
    h.currentVersion++;
    version.id = `v${h.currentVersion}`;
    version.version = h.currentVersion;
    h.versions = [...versions, version];
    h.docPath = h.currentPath ?? "";
    const docId = h.docId ?? "";
    const jsonl = this.hasJsonlHistory("doc", docId);
    const legacy =
      !jsonl &&
      (existsSync(this.stableDocVersionPath(docId)) ||
        existsSync(this.legacyDocVersionPath(h.currentPath ?? "")));
    if (jsonl || !legacy) {
      await this.history.append({
        schemaVersion: 0,
        entityType: "doc",
        entityId: docId,
        revision: 0,
        timestamp: version.timestamp,
        author: version.author,
        actor: version.actor,
        source: version.source,
        auditEventId: version.auditEventId,
        sessionId: version.sessionId,
        batchId: version.batchId,
        baseHash: version.baseHash,
        newHash: version.newHash,
        checkpoint: version.checkpoint,
        docChanges: copyList(version.changes),
        changedScopes: copyList(version.changedScopes),
        currentPath: firstNonEmpty(version.currentPath, version.docPath),
        previousPath: version.previousPath,
        checkpointPayload:
          version.checkpoint && version.snapshot ? cloneJson(version.snapshot) : undefined,
      });
      return;
    }
    mkdirSync(this.versionsDir(), { recursive: true, mode: 0o755 });
    writeJson(this.stableDocVersionPath(docId), encodeDocVersionHistory(h));
    this.indexDocHistory(docId, h.currentPath ?? "", previousPath);
  }

  /** docHistoryForWrite: the history a write for this path appends to (or a fresh one). */
  async docHistoryForWrite(currentPath: string, previousPath: string): Promise<DocVersionHistory> {
    currentPath = normalizeDocPath(currentPath);
    previousPath = normalizeDocPath(previousPath);
    if (currentPath === "") throw new Error("doc path is required");
    const at = await this.readDocJsonl(currentPath);
    if (at.ok && at.history) {
      normalizeDocHistory(at.history, at.history.docId ?? "", currentPath);
      return at.history;
    }
    if (previousPath !== "") {
      const prev = await this.readDocJsonl(previousPath);
      if (prev.ok && prev.history) {
        normalizeDocHistory(prev.history, prev.history.docId ?? "", currentPath);
        return prev.history;
      }
    }
    const stable = this.loadStableDocHistoryForAnyPath(currentPath, previousPath);
    if (stable.ok && stable.history) {
      normalizeDocHistory(stable.history, stable.history.docId ?? "", currentPath);
      return stable.history;
    }
    for (const legacyPath of compactDocPaths(previousPath, currentPath)) {
      const legacy = this.loadLegacyDocHistory(legacyPath);
      if (legacy.ok && legacy.history) {
        normalizeDocHistory(legacy.history, legacy.history.docId ?? "", currentPath);
        return legacy.history;
      }
    }
    return {
      docId: newDocId(),
      docPath: currentPath,
      currentPath,
      currentVersion: 0,
      versions: [],
    };
  }

  /**
   * ApplyDocHistoryRetention purges old retained detail while converting the first retained
   * revision into a checkpoint so retained history stays restorable.
   */
  async applyDocHistoryRetention(
    docPath: string,
    policy: DocHistoryRetentionPolicy,
  ): Promise<DocVersionHistory> {
    const jsonl = await this.readDocJsonl(normalizeDocPath(docPath));
    if (jsonl.ok && jsonl.history) {
      await this.history.compact("doc", jsonl.history.docId ?? "", {
        maxDetailedRevisions: policy.maxVersions,
        maxDetailedAgeMs: policy.maxAgeMs,
        now: policy.now,
        reason: retentionReason(policy),
      });
      return this.getDocHistory(docPath);
    }
    const h = await this.getDocHistory(docPath);
    const versions = h.versions ?? [];
    if (versions.length === 0) return h;
    const now = policy.now ?? new Date();
    let removeBefore = 0;
    if ((policy.maxAgeMs ?? 0) > 0) {
      const cutoff = now.getTime() - (policy.maxAgeMs as number);
      versions.forEach((v, i) => {
        const ts = timeMs(v.timestamp);
        if (!Number.isNaN(ts) && ts < cutoff) removeBefore = i + 1;
      });
    }
    if (
      (policy.maxVersions ?? 0) > 0 &&
      versions.length - removeBefore > (policy.maxVersions as number)
    ) {
      const byCount = versions.length - (policy.maxVersions as number);
      if (byCount > removeBefore) removeBefore = byCount;
    }
    if (removeBefore <= 0) return h;
    if (removeBefore >= versions.length) removeBefore = versions.length - 1;
    const firstRetained = versions[removeBefore] as DocVersion;
    const firstRetainedState = resolveDocStateFromHistory(h, firstRetained.id);
    const removed = versions.slice(0, removeBefore);
    const retained = versions.slice(removeBefore).map((v) => ({ ...v }));
    const first = retained[0] as DocVersion;
    first.checkpoint = true;
    first.snapshot = docToSnapshot(firstRetainedState);
    if (!first.newHash) first.newHash = hashDoc(firstRetainedState);
    h.versions = retained;
    h.retentionGaps = [
      ...(h.retentionGaps ?? []),
      {
        type: "purged",
        reason: retentionReason(policy),
        count: removed.length,
        beforeVersion: (removed[removed.length - 1] as DocVersion).id,
        afterVersion: first.id,
        appliedAt: goNow(now),
      },
    ];
    normalizeDocHistory(h, h.docId ?? "", h.currentPath ?? "");
    mkdirSync(this.versionsDir(), { recursive: true, mode: 0o755 });
    writeJson(this.stableDocVersionPath(h.docId ?? ""), encodeDocVersionHistory(h));
    this.indexDocHistory(h.docId ?? "", h.currentPath ?? "", "");
    return h;
  }

  /** Remove a legacy file (used by tests and lifecycle rollbacks of legacy-format histories). */
  removeLegacyTaskFile(taskId: string): void {
    rmSync(this.versionPath(taskId), { force: true });
  }
}

// --- module helpers ------------------------------------------------------------------------------

function blankDoc(): DocState {
  return { id: "", path: "", title: "", description: "", content: "", tags: undefined };
}

function applyDocSnapshotAndPath(state: DocState, version: DocVersion): void {
  const snap = (version.snapshot ?? {}) as AnyMap;
  if (typeof snap.path === "string" && snap.path !== "") state.path = normalizeDocPath(snap.path);
  if (typeof snap.id === "string") state.id = snap.id;
  if (typeof snap.title === "string") state.title = snap.title;
  if (typeof snap.description === "string") state.description = snap.description;
  if (typeof snap.content === "string") state.content = snap.content;
  const tags = anyStringSlice(snap.tags);
  if (tags !== undefined) state.tags = tags;
  if (version.currentPath) state.path = normalizeDocPath(version.currentPath);
}

/** normalizeDocHistory. */
export function normalizeDocHistory(
  h: DocVersionHistory,
  docId: string,
  currentPath: string,
): void {
  if (!h.versions) h.versions = [];
  if (!h.docId) h.docId = docId;
  if (!h.docId) h.docId = legacyDocId(firstNonEmpty(currentPath, h.currentPath, h.docPath));
  if (currentPath !== "") {
    h.currentPath = currentPath;
    h.docPath = currentPath;
  } else {
    h.currentPath = firstNonEmpty(h.currentPath, h.docPath);
    h.docPath = firstNonEmpty(h.docPath, h.currentPath);
  }
  if (h.currentVersion === 0 && h.versions.length > 0) {
    h.currentVersion = (h.versions[h.versions.length - 1] as DocVersion).version;
    if (h.currentVersion === 0) h.currentVersion = h.versions.length;
  }
  for (const v of h.versions) {
    if (!v.docId) v.docId = h.docId;
    if (!v.docPath) v.docPath = firstNonEmpty(v.currentPath, h.currentPath, h.docPath);
    if (!v.currentPath) v.currentPath = v.docPath;
    if (!v.changedScopes || v.changedScopes.length === 0) {
      const scopes = docChangeScopes(v.changes);
      if (scopes.length > 0) v.changedScopes = scopes;
    }
  }
}

function docHistoryContainsPath(h: DocVersionHistory, paths: Set<string>): boolean {
  if (paths.has(normalizeDocPath(h.currentPath ?? "")) || paths.has(normalizeDocPath(h.docPath)))
    return true;
  return (h.versions ?? []).some(
    (v) =>
      paths.has(normalizeDocPath(v.currentPath ?? "")) ||
      paths.has(normalizeDocPath(v.docPath)) ||
      paths.has(normalizeDocPath(v.previousPath ?? "")),
  );
}

function matchesTypeFilter(changes: readonly TaskChange[], category: string): boolean {
  const content = [
    "title",
    "description",
    "acceptanceCriteria",
    "implementationPlan",
    "implementationNotes",
  ];
  return changes.some((c) => {
    switch (category) {
      case "status":
        return c.field === "status";
      case "assignee":
        return c.field === "assignee";
      case "content":
        return content.includes(c.field);
      default:
        return false;
    }
  });
}

// --- history metadata pages ------------------------------------------------------------------

export function historyRecordFromTaskVersion(taskId: string, v: TaskVersion): HistoryRecord {
  return {
    schemaVersion: v.schemaVersion ?? 0,
    entityType: "task",
    entityId: taskId,
    revision: v.version,
    legacyRevision: v.version,
    legacyId: v.id,
    timestamp: v.timestamp,
    author: v.author,
    source: v.source,
    sessionId: v.sessionId,
    batchId: v.batchId,
    operation: v.operation,
    tombstone: v.tombstone,
    lifecycleEventId: v.lifecycleEventId,
    baseHash: v.baseHash,
    newHash: v.newHash,
    checkpoint: v.checkpoint,
    legacyUnverified: v.legacyUnverified,
    legacyPath: v.legacyPath,
    legacyDigest: v.legacyDigest,
  };
}

export function historyRecordFromDocVersion(docId: string, v: DocVersion): HistoryRecord {
  return {
    schemaVersion: v.schemaVersion ?? 0,
    entityType: "doc",
    entityId: firstNonEmpty(docId, v.docId),
    revision: v.version,
    legacyRevision: v.version,
    legacyId: v.id,
    timestamp: v.timestamp,
    author: v.author,
    actor: v.actor,
    source: v.source,
    auditEventId: v.auditEventId,
    sessionId: v.sessionId,
    batchId: v.batchId,
    operation: v.operation,
    tombstone: v.tombstone,
    baseHash: v.baseHash,
    newHash: v.newHash,
    checkpoint: v.checkpoint,
    legacyUnverified: v.legacyUnverified,
    legacyPath: v.legacyPath,
    legacyDigest: v.legacyDigest,
    currentPath: v.currentPath,
    previousPath: v.previousPath,
  };
}

export function historyMetadataFromRecord(r: HistoryRecord): HistoryMetadata {
  const m: AnyMap = {
    entityType: r.entityType,
    entityId: r.entityId,
    revision: r.revision,
    id: firstNonEmpty(r.legacyId, `v${firstPositive(r.legacyRevision, r.revision)}`),
    timestamp: r.timestamp,
  };
  const keys = [
    "schemaVersion",
    "author",
    "actor",
    "source",
    "auditEventId",
    "sessionId",
    "batchId",
    "operation",
    "tombstone",
    "lifecycleEventId",
    "baseHash",
    "newHash",
    "prevRecordHash",
    "recordHash",
    "checkpoint",
    "legacyRevision",
    "legacyId",
    "legacy",
    "legacyUnverified",
    "legacyPath",
    "legacyDigest",
    "currentPath",
    "previousPath",
  ] as const;
  for (const key of keys) {
    const v = r[key];
    if (v !== undefined && v !== "" && v !== 0 && v !== false) m[key] = v;
  }
  if (r.retentionGaps && r.retentionGaps.length > 0) m.retentionGaps = cloneJson(r.retentionGaps);
  return m as unknown as HistoryMetadata;
}

/** historyMetadataPage: newest-first paging over metadata records. */
export function historyMetadataPage(
  records: readonly HistoryRecord[],
  offset: number,
  limit: number,
): HistoryMetadataPage {
  if (offset < 0) offset = 0;
  if (limit < 0) limit = 0;
  const items: HistoryMetadata[] = [];
  let current = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i] as HistoryRecord;
    const logical = logicalVersionOf(record);
    if (logical > current) current = logical;
    items.push(historyMetadataFromRecord(record));
  }
  if (offset > items.length) offset = items.length;
  let end = items.length;
  if (limit > 0 && offset + limit < end) end = offset + limit;
  const page: HistoryMetadataPage = {
    offset,
    limit,
    hasMore: end < items.length,
    currentVersion: current,
    items: items.slice(offset, end),
  };
  const first = records[0];
  const last = records[records.length - 1];
  if (first && last) {
    page.entityType = first.entityType;
    page.entityId = first.entityId;
    let currentPath = last.currentPath ?? "";
    const gaps: NonNullable<HistoryMetadataPage["retentionGaps"]> = [];
    for (const record of records) {
      if (record.currentPath) currentPath = record.currentPath;
      gaps.push(...(record.retentionGaps ?? []));
    }
    if (currentPath !== "") {
      page.currentPath = currentPath;
      page.docPath = currentPath;
    }
    if (gaps.length > 0) page.retentionGaps = gaps;
  }
  if (page.hasMore) page.nextOffset = end;
  return page;
}

/** resolveHistoryRecordRevision: a user-facing revision id to the physical revision number. */
export function resolveHistoryRecordRevision(
  records: readonly HistoryRecord[],
  revisionId: string,
): number {
  for (const r of records) {
    if (
      historyRevisionMatches(
        r.legacyId ?? "",
        firstPositive(r.legacyRevision, r.revision),
        revisionId,
      ) ||
      historyRevisionMatches(`v${r.revision}`, r.revision, revisionId)
    ) {
      return r.revision;
    }
  }
  throw new Error(`revision "${revisionId}" not found`);
}

export { isHistoryConflict };
