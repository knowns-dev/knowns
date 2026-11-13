// Port of internal/storage/store.go: the store root, its directory layout, project initialization,
// and the lock entry points. The entity stores (tasks, docs, ...) hang off this root; they are
// ported separately and take a Store (or just `store.paths`) as their only dependency.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../../models/config.ts";
import { defaultProjectSettings } from "../../models/config.ts";
import { CURRENT_SCHEMA_VERSION } from "../../models/schema-version.ts";
import { globalRootPath } from "./global-root.ts";
import {
  decisionLifecycleLockPath,
  decisionMemoryMigrationLockPath,
  type LockOptions,
  qdrantWatermarkLockPath,
  taskLifecycleLockPath,
  withDecisionLifecycleLock,
  withDecisionMemoryMigrationLock,
  withDocMutationLocks,
  withFileLock,
  withHistoryEntityLock,
  withMemoryMutationLock,
  withMemoryMutationLocks,
  withQdrantWatermarkLock,
  withSyncLocks,
  withTaskLifecycleLock,
} from "./locks.ts";
import { inRepoProjectRoot, projectRootForKnowledgeRoot } from "./project-location.ts";
import { atomicWrite, goJsonStringify, sanitizeFileSlug, sortKeysDeep, writeJson } from "./util.ts";

/** Directory name of the machine-level semantic store under the global root. */
export const GLOBAL_SEMANTIC_STORE_DIR = "global";

/** Every path under a knowledge root, computed in one place. */
export class StorePaths {
  constructor(readonly root: string) {}
  readonly join = (...parts: string[]) => join(this.root, ...parts);

  get config() {
    return this.join("config.json");
  }
  get tasksDir() {
    return this.join("tasks");
  }
  get archiveDir() {
    return this.join("archive");
  }
  get docsDir() {
    return this.join("docs");
  }
  get versionsDir() {
    return this.join("versions");
  }
  get templatesDir() {
    return this.join("templates");
  }
  get importsDir() {
    return this.join("imports");
  }
  get searchDir() {
    return this.join(".search");
  }
  get memoryDir() {
    return this.join("memory");
  }
  get decisionsDir() {
    return this.join("decisions");
  }
  get historyDir() {
    return this.join("history");
  }
  get timeState() {
    return this.join("time.json");
  }
  get timeEntries() {
    return this.join("time-entries.json");
  }
  get workspaces() {
    return this.join("workspaces.json");
  }
  get chats() {
    return this.join("chats.json");
  }
  get semanticDb() {
    return this.join(".search", "index.db");
  }
}

/** The top-level coordinator for one project's knowledge directory. */
export class Store {
  readonly paths: StorePaths;

  /**
   * @param root        absolute knowledge root: the in-repo .knowns/ or a project folder in a store
   * @param projectRoot absolute code repository root. Independent of `root`: code paths must read
   *                    it rather than derive it from `root`, because a store-linked project keeps
   *                    its knowledge outside the repository.
   */
  constructor(
    readonly root: string,
    readonly projectRoot: string,
  ) {
    this.paths = new StorePaths(root);
  }

  /**
   * NewStore: derive the code root from the knowledge root. For an in-repo .knowns/ it is the
   * parent; for a project folder in a store clone it is the repository the machine registry maps
   * to it. The directory does not need to exist yet; call `init`.
   */
  static open(root: string): Store {
    return new Store(root, projectRootForKnowledgeRoot(root));
  }

  /** NewGlobalSemanticStore: the machine-level store (~/.knowns/global). */
  static openGlobalSemantic(): Store {
    return Store.open(globalSemanticStoreRoot());
  }

  // --- locks (same paths as the Go binary) ---------------------------------------------------

  readonly lockPaths = {
    taskLifecycle: () => taskLifecycleLockPath(this.root),
    decisionLifecycle: () => decisionLifecycleLockPath(this.root),
    decisionMemoryMigration: () => decisionMemoryMigrationLockPath(this.root),
    qdrantWatermark: () => qdrantWatermarkLockPath(this.root),
  } as const;

  /** WithTaskLifecycleTransaction: serialize a lifecycle mutation across processes. */
  withTaskLifecycleLock<T>(fn: () => T | Promise<T>, opts?: LockOptions) {
    return withTaskLifecycleLock(this.root, fn, opts);
  }

  withDecisionLifecycleLock<T>(fn: () => T | Promise<T>, opts?: LockOptions) {
    return withDecisionLifecycleLock(this.root, fn, opts);
  }

  /** WithDecisionMemoryMigrationLock. */
  withDecisionMemoryMigrationLock<T>(fn: () => T | Promise<T>, opts?: LockOptions) {
    return withDecisionMemoryMigrationLock(this.root, fn, opts);
  }

  withQdrantWatermarkLock<T>(fn: () => T | Promise<T>, opts?: LockOptions) {
    return withQdrantWatermarkLock(this.root, fn, opts);
  }

  /** Memory mutations use the machine-level root so global memories serialize across projects. */
  withMemoryLock<T>(id: string, fn: () => T | Promise<T>, opts?: LockOptions) {
    return withMemoryMutationLock(id, fn, { ...opts, lockRoot: globalRootPath() });
  }

  withMemoryLocks<T>(ids: readonly string[], fn: () => T | Promise<T>, opts?: LockOptions) {
    return withMemoryMutationLocks(ids, fn, { ...opts, lockRoot: globalRootPath() });
  }

  withHistoryLock<T>(
    entityType: "task" | "doc",
    entityId: string,
    fn: () => T | Promise<T>,
    opts?: LockOptions,
  ) {
    return withHistoryEntityLock(this.root, entityType, entityId, fn, opts);
  }

  withDocMutationLocks<T>(paths: readonly string[], fn: () => T | Promise<T>, opts?: LockOptions) {
    return withDocMutationLocks(this.root, paths, fn, opts);
  }

  /** WithSyncLocks: see locks.withSyncLocks. */
  withSyncLocks<T>(relPaths: readonly string[], fn: () => T | Promise<T>, opts?: LockOptions) {
    return withSyncLocks(this.root, relPaths, fn, opts);
  }

  /** Any other lock file (reconciler manifests and the like) by absolute path. */
  withLockFile<T>(path: string, fn: () => T | Promise<T>, opts?: LockOptions) {
    return withFileLock(path, fn, opts);
  }

  // --- init ----------------------------------------------------------------------------------

  /**
   * Init: create the .knowns/ directory structure for a new project, then any of config.json,
   * time.json, time-entries.json, workspaces.json, chats.json that does not exist yet. Existing
   * files are never touched.
   */
  init(name: string): void {
    for (const dir of [
      this.root,
      this.paths.tasksDir,
      this.paths.docsDir,
      this.paths.archiveDir,
      this.paths.versionsDir,
      this.paths.templatesDir,
      this.paths.importsDir,
      this.paths.searchDir,
      this.paths.memoryDir,
      this.paths.decisionsDir,
    ]) {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
    }

    if (!existsSync(this.paths.config)) this.initDefaultConfig(name);
    if (!existsSync(this.paths.timeState)) writeJson(this.paths.timeState, { active: [] });
    if (!existsSync(this.paths.timeEntries)) writeJson(this.paths.timeEntries, {});
    if (!existsSync(this.paths.workspaces)) writeJson(this.paths.workspaces, []);
    if (!existsSync(this.paths.chats)) writeJson(this.paths.chats, []);
  }

  /** ConfigStore.initDefault: a minimal default config.json in the canonical (sorted keys) form. */
  private initDefaultConfig(name: string): void {
    const project: Project = {
      name: name === "" ? "knowns" : name,
      id: sanitizeFileSlug(name === "" ? "knowns" : name),
      createdAt: new Date().toISOString(),
      settings: defaultProjectSettings(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };
    atomicWrite(this.paths.config, `${goJsonStringify(sortKeysDeep(project))}\n`);
  }
}

/** GlobalSemanticStoreRoot: ~/.knowns/global. */
export function globalSemanticStoreRoot(): string {
  return join(globalRootPath(), GLOBAL_SEMANTIC_STORE_DIR);
}

export { globalRootPath, inRepoProjectRoot };
