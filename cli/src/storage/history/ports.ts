// Narrow ports onto the entity stores. The history layer composes mutations across Docs, Tasks,
// Memory and Time, but must not depend on how those stores are implemented (they are ported
// separately, and may be synchronous or asynchronous). Every method may return its value or a
// promise of it; "not found" is a thrown error, exactly like the Go `error` return.

import type { Doc } from "../../models/doc.ts";
import type { MemoryEntry } from "../../models/memory.ts";
import type { Task, TaskTombstone } from "../../models/task.ts";
import type { TimeEntry, TimeState } from "../../models/time.ts";
import type { VersionStore } from "./version-store.ts";

export type Maybe<T> = T | Promise<T>;

export interface DocStorePort {
  list(): Maybe<Doc[]>;
  get(path: string): Maybe<Doc>;
  create(doc: Doc): Maybe<void>;
  update(doc: Doc): Maybe<void>;
  rename(oldPath: string, doc: Doc): Maybe<void>;
  delete(path: string): Maybe<void>;
  validateStableId(id: string, path: string): Maybe<void>;
  /** Rollback writers: restore a doc file exactly (no timestamp refresh, no validation). */
  writeExact(doc: Doc): Maybe<void>;
  writeRaw(path: string, data: Uint8Array | string): Maybe<void>;
  /** Move the doc currently at `fromPath` back to `doc.path`, writing `doc` exactly. */
  renameExact(fromPath: string, doc: Doc): Maybe<void>;
  renameRaw(fromPath: string, toPath: string, data: Uint8Array | string): Maybe<void>;
}

export interface TaskStorePort {
  get(id: string): Maybe<Task>;
  listAll(): Maybe<Task[]>;
  listActive(): Maybe<Task[]>;
  listArchived(): Maybe<Task[]>;
  canonicalPath(id: string): Maybe<string>;
  createUnlocked(task: Task): Maybe<void>;
  updateUnlocked(task: Task): Maybe<void>;
  patchLifecycleUnlocked(task: Task): Maybe<void>;
  archiveUnlocked(id: string): Maybe<void>;
  unarchiveUnlocked(id: string): Maybe<void>;
  /** Removes the Task and its files; returns how many were removed. */
  deleteAllUnlocked(id: string): Maybe<number>;
  saveTombstoneUnlocked(tombstone: TaskTombstone): Maybe<void>;
  getTombstone(id: string): Maybe<TaskTombstone>;
  isIdReserved(id: string): Maybe<boolean>;
  allocateTaskIdUnlocked(prefix: string): Maybe<string>;
}

export interface MemoryStorePort {
  list(layer?: string): Maybe<MemoryEntry[]>;
  getInLayer(id: string, layer: string): Maybe<MemoryEntry>;
  /** writeExisting(next, current, false): replace an entry in place. */
  writeExisting(next: MemoryEntry, current: MemoryEntry, touch: boolean): Maybe<void>;
  canonicalHash(entry: MemoryEntry): string;
  withLocks<T>(ids: readonly string[], fn: () => T | Promise<T>): Promise<T>;
}

export interface TimeStorePort {
  getState(): Maybe<TimeState>;
  saveStateUnlocked(state: TimeState): Maybe<void>;
  getAllEntries(): Maybe<Record<string, TimeEntry[]>>;
  saveAllEntriesUnlocked(entries: Record<string, TimeEntry[]>): Maybe<void>;
  getActiveTimer(taskId: string): Maybe<unknown | undefined>;
  /** Writes the full entries file (task time data removal). */
  writeEntriesFile(entries: Record<string, TimeEntry[]>): Maybe<void>;
}

/** What the mutation and lifecycle code needs from a Store. */
export interface HistoryContext {
  /** Knowledge root (`.knowns/`). */
  root: string;
  versions: VersionStore;
  docs: DocStorePort;
  tasks: TaskStorePort;
  memory?: MemoryStorePort;
  time?: TimeStorePort;
  /** Serializes task lifecycle transactions across processes (tasks.lock). */
  withTaskLifecycleLock<T>(fn: () => Promise<T>): Promise<T>;
  /** references.RewriteDocPath, which depends on the reference extractor. */
  rewriteDocPath(content: string, oldPath: string, newPath: string): string;
  /** Project config for default task ID prefix resolution. */
  loadProject?(): Maybe<{ name: string; settings?: { defaultTaskIdPrefix?: string } }>;
  /** Test seam: runs after the rename plan is captured, before locks are taken. */
  renameReferencePreflight?: () => void;
}
