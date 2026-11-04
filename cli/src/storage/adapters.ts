// Wiring: the history ports (history/ports.ts) over the real entity stores (stores/), and the
// factory that builds the whole wired storage from a Store.
//
// Layering: core <- history <- stores <- adapters. history never imports stores and stores take
// their canonical task/doc hashes straight from history/entities.ts, so there is one hash path.
// rewriteDocPath defaults to the reference extractor (domain/references); the reconciler is injected.
import { rewriteDocPath as rewriteDocPathDefault } from "../domain/references/rewrite.ts";
import type { MemoryEntry } from "../models/memory.ts";
import type { TimeEntry } from "../models/time.ts";
import { withTaskLifecycleLock } from "./core/locks.ts";
import type { Store } from "./core/store.ts";
import {
  canonicalMemoryHash,
  type DocStorePort,
  type HistoryContext,
  HistoryStore,
  type HistoryStoreOptions,
  type MemoryStorePort,
  type TaskStorePort,
  type TimeStorePort,
  VersionStore,
} from "./history/index.ts";
import {
  ConfigStore,
  DecisionStore,
  DocStore,
  MemoryStore,
  TaskStore,
  TemplateStore,
  TimeStore,
  WorkspaceStore,
} from "./stores/index.ts";

/** TaskStore as the history task port. archiveUnlocked/unarchiveUnlocked are real store methods. */
export function adaptTasks(tasks: TaskStore): TaskStorePort {
  return tasks;
}

/** DocStore as the history doc port (list/get/create/update/rename/delete and rollback writers). */
export function adaptDocs(docs: DocStore): DocStorePort {
  return docs;
}

/** MemoryStore as the history memory port: in-place writes, the canonical hash, per-id locks. */
export function adaptMemory(
  memory: MemoryStore,
  store: Pick<Store, "withMemoryLocks">,
): MemoryStorePort {
  return {
    list: (layer) => memory.list(layer ?? ""),
    getInLayer: (id, layer) => memory.getInLayer(id, layer),
    writeExisting: (next: MemoryEntry, current: MemoryEntry, touch: boolean) =>
      memory.writeExisting(next, current, touch),
    canonicalHash: (entry: MemoryEntry) => canonicalMemoryHash(entry),
    withLocks: (ids, fn) => store.withMemoryLocks(ids, fn),
  };
}

/** TimeStore as the history time port; writeEntriesFile rewrites the whole entries file. */
export function adaptTime(time: TimeStore): TimeStorePort {
  return {
    getState: () => time.getState(),
    saveStateUnlocked: (state) => time.saveStateUnlocked(state),
    getAllEntries: () => time.getAllEntries(),
    saveAllEntriesUnlocked: (entries: Record<string, TimeEntry[]>) =>
      time.saveAllEntriesUnlocked(entries),
    getActiveTimer: (taskId) => time.getActiveTimer(taskId),
    writeEntriesFile: (entries: Record<string, TimeEntry[]>) =>
      time.saveAllEntriesUnlocked(entries),
  };
}

export interface CreateStorageOptions {
  /** Root of machine-level memories (default ~/.knowns). */
  globalRoot?: string;
  /**
   * references.RewriteDocPath. Defaults to domain/references `rewriteDocPath`; inject another
   * only to observe or fail a rename in tests.
   */
  rewriteDocPath?: HistoryContext["rewriteDocPath"];
  /** Failure-injection seams for the history store (tests). */
  historyOptions?: HistoryStoreOptions;
  /** Test seam passed through to the history context. */
  renameReferencePreflight?: () => void;
}

/** The wired storage for one project: entity stores, version store and the history context. */
export interface Storage {
  store: Store;
  config: ConfigStore;
  tasks: TaskStore;
  docs: DocStore;
  memory: MemoryStore;
  time: TimeStore;
  decisions: DecisionStore;
  templates: TemplateStore;
  workspaces: WorkspaceStore;
  history: HistoryStore;
  versions: VersionStore;
  /** Pass to createTaskWithHistory, mutateDocWithHistory, withTaskLifecycleTransaction, ... */
  ctx: HistoryContext;
}

/** Build the wired storage from a Store. */
export function createStorage(store: Store, opts: CreateStorageOptions = {}): Storage {
  const config = new ConfigStore(store.root, store.projectRoot);
  const tasks = new TaskStore(store);
  const docs = new DocStore(store);
  const memory = new MemoryStore(store, opts.globalRoot);
  const time = new TimeStore(store);
  const decisions = new DecisionStore(store);
  const templates = new TemplateStore(store);
  const workspaces = new WorkspaceStore(store);
  const lock = <T>(fn: () => Promise<T>) => withTaskLifecycleLock(store.root, fn);
  const history = new HistoryStore(store.root, opts.historyOptions);
  const versions = new VersionStore(store.root, {
    historyStore: history,
    withTaskLifecycleLock: lock,
    getDoc: (path) => docs.get(path),
  });
  const ctx: HistoryContext = {
    root: store.root,
    versions,
    docs: adaptDocs(docs),
    tasks: adaptTasks(tasks),
    memory: adaptMemory(memory, store),
    time: adaptTime(time),
    withTaskLifecycleLock: lock,
    rewriteDocPath: opts.rewriteDocPath ?? rewriteDocPathDefault,
    loadProject: () => config.load(),
    renameReferencePreflight: opts.renameReferencePreflight,
  };
  return {
    store,
    config,
    tasks,
    docs,
    memory,
    time,
    decisions,
    templates,
    workspaces,
    history,
    versions,
    ctx,
  };
}
