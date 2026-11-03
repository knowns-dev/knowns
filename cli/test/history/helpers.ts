// Shared test helpers for the history layer: temp projects, in-memory entity stores behind the
// ports, and the Go binary (KNOWNS_GO_BIN, or built from ./cmd/knowns when Go is installed).
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Doc } from "../../src/models/doc.ts";
import type { MemoryEntry } from "../../src/models/memory.ts";
import type { Task, TaskTombstone } from "../../src/models/task.ts";
import { withTaskLifecycleLock } from "../../src/storage/core/locks.ts";
import { Store } from "../../src/storage/core/store.ts";
import {
  type DocStorePort,
  goNow,
  type HistoryContext,
  HistoryStore,
  type MemoryStorePort,
  type TaskStorePort,
  VersionStore,
} from "../../src/storage/history/index.ts";
import { fixtureRoot } from "../helpers/fixtures.ts";

const REPO = resolve(import.meta.dir, "..", "..", "..");

export function tempDir(prefix = "knowns-history-"): string {
  // Resolved, so Go (whose cwd is always the real path) and TypeScript agree on absolute paths.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

/** A fresh initialized project; returns the knowledge root (`<dir>/.knowns`). */
export function newProject(): { dir: string; root: string } {
  const dir = tempDir();
  const root = join(dir, ".knowns");
  Store.open(root).init("History Test");
  return { dir, root };
}

/** Copy a golden fixture project into a temp dir. */
export function copyFixture(name: string): { dir: string; root: string; home: string } {
  const dir = tempDir(`knowns-history-${name}-`);
  const project = join(dir, "project");
  cpSync(fixtureRoot(name), project, { recursive: true });
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return { dir: project, root: join(project, ".knowns"), home };
}

// --- Go binary ------------------------------------------------------------------------------------

let goBin: string | undefined | null = null;

/** The Go binary: KNOWNS_GO_BIN, else built once from ./cmd/knowns, else undefined. */
export function goBinary(): string | undefined {
  if (goBin !== null) return goBin;
  const env = process.env.KNOWNS_GO_BIN;
  if (env && existsSync(env)) {
    goBin = env;
    return goBin;
  }
  const out = join(
    tmpdir(),
    "knowns-ts-history-go",
    process.platform === "win32" ? "knowns.exe" : "knowns",
  );
  mkdirSync(join(tmpdir(), "knowns-ts-history-go"), { recursive: true });
  const res = Bun.spawnSync(["go", "build", "-o", out, "./cmd/knowns"], {
    cwd: REPO,
    stderr: "pipe",
  });
  goBin = res.exitCode === 0 ? out : undefined;
  return goBin;
}

export const hasGo = (): boolean => goBinary() !== undefined;

export interface GoResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the Go binary in a project with an isolated HOME. */
export function runGo(cwd: string, home: string, args: string[]): GoResult {
  const bin = goBinary();
  if (!bin) throw new Error("go binary unavailable");
  const res = Bun.spawnSync([bin, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      NO_COLOR: "1",
      NO_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

export function jsonlLines(root: string, kind: "tasks" | "docs", id: string): string[] {
  return readFileSync(join(root, "history", kind, `${id}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean);
}

export function listFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

// --- fake entity stores -----------------------------------------------------------------------------

export function makeDoc(path: string, content: string, extra: Partial<Doc> = {}): Doc {
  const now = goNow();
  return { path, title: path, content, createdAt: now, updatedAt: now, ...extra };
}

export function makeTask(id: string, extra: Partial<Task> = {}): Task {
  const now = goNow();
  return {
    id,
    title: `Task ${id}`,
    status: "todo",
    priority: "medium",
    labels: null,
    createdAt: now,
    updatedAt: now,
    archived: false,
    acceptanceCriteria: null,
    timeSpent: 0,
    ...extra,
  };
}

export class FakeDocs implements DocStorePort {
  readonly docs = new Map<string, Doc>();
  failNextUpdate: Error | undefined;

  list() {
    return [...this.docs.values()].map((d) => ({ ...d }));
  }
  get(path: string) {
    const d = this.docs.get(path);
    if (!d) throw new Error(`doc "${path}" not found`);
    return { ...d };
  }
  create(doc: Doc) {
    if (this.docs.has(doc.path)) throw new Error(`doc "${doc.path}" already exists`);
    this.docs.set(doc.path, { ...doc });
  }
  update(doc: Doc) {
    if (this.failNextUpdate) {
      const e = this.failNextUpdate;
      this.failNextUpdate = undefined;
      throw e;
    }
    if (!this.docs.has(doc.path)) throw new Error(`doc "${doc.path}" not found`);
    this.docs.set(doc.path, { ...doc });
  }
  rename(oldPath: string, doc: Doc) {
    if (!this.docs.has(oldPath)) throw new Error(`doc "${oldPath}" not found`);
    this.docs.delete(oldPath);
    this.docs.set(doc.path, { ...doc });
  }
  delete(path: string) {
    if (!this.docs.delete(path)) throw new Error(`doc "${path}" not found`);
  }
  validateStableId(id: string, path: string) {
    for (const d of this.docs.values()) {
      if (id && d.id === id && d.path !== path) throw new Error(`duplicate stable doc ID "${id}"`);
    }
  }
  writeExact(doc: Doc) {
    this.docs.set(doc.path, { ...doc });
  }
  writeRaw() {}
  renameExact(fromPath: string, doc: Doc) {
    this.docs.delete(fromPath);
    this.docs.set(doc.path, { ...doc });
  }
  renameRaw(fromPath: string, toPath: string) {
    const d = this.docs.get(fromPath);
    if (d) {
      this.docs.delete(fromPath);
      this.docs.set(toPath, { ...d, path: toPath });
    }
  }
}

export class FakeTasks implements TaskStorePort {
  readonly tasks = new Map<string, Task>();
  readonly tombstones = new Map<string, TaskTombstone>();
  constructor(private readonly root: string) {}
  get(id: string) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`task "${id}" not found`);
    return { ...t };
  }
  listAll() {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }
  listActive() {
    return this.listAll().filter((t) => !t.archived);
  }
  listArchived() {
    return this.listAll().filter((t) => t.archived);
  }
  canonicalPath(id: string) {
    this.get(id);
    return join(this.root, "tasks", `${id}.md`);
  }
  createUnlocked(task: Task) {
    if (this.tasks.has(task.id)) throw new Error(`task "${task.id}" already exists`);
    this.tasks.set(task.id, { ...task });
  }
  updateUnlocked(task: Task) {
    this.tasks.set(task.id, { ...task });
  }
  patchLifecycleUnlocked(task: Task) {
    this.updateUnlocked(task);
  }
  archiveUnlocked(id: string) {
    this.tasks.set(id, { ...this.get(id), archived: true });
  }
  unarchiveUnlocked(id: string) {
    this.tasks.set(id, { ...this.get(id), archived: false });
  }
  deleteAllUnlocked(id: string) {
    return this.tasks.delete(id) ? 1 : 0;
  }
  saveTombstoneUnlocked(t: TaskTombstone) {
    this.tombstones.set(t.id, t);
  }
  getTombstone(id: string) {
    const t = this.tombstones.get(id);
    if (!t) throw new Error(`task tombstone "${id}" not found`);
    return t;
  }
  isIdReserved(id: string) {
    return this.tombstones.has(id);
  }
  allocateTaskIdUnlocked(prefix: string) {
    return `${prefix || "TSK"}-${String(this.tasks.size + 1).padStart(6, "0")}`;
  }
}

export class FakeMemory implements MemoryStorePort {
  readonly entries = new Map<string, MemoryEntry>();
  list() {
    return [...this.entries.values()].map((m) => ({ ...m }));
  }
  getInLayer(id: string, layer: string) {
    const m = this.entries.get(`${id}\0${layer}`);
    if (!m) throw new Error(`memory "${id}" not found`);
    return { ...m };
  }
  writeExisting(next: MemoryEntry) {
    this.entries.set(`${next.id}\0${next.layer}`, { ...next });
  }
  canonicalHash(entry: MemoryEntry) {
    return JSON.stringify([entry.id, entry.layer, entry.content]);
  }
  async withLocks<T>(_ids: readonly string[], fn: () => T | Promise<T>) {
    return fn();
  }
}

/** `@doc/old` -> `@doc/new`, a stand-in for references.RewriteDocPath. */
export function fakeRewrite(content: string, oldPath: string, newPath: string): string {
  if (oldPath === newPath) return content;
  return content.replaceAll(`@doc/${oldPath}`, `@doc/${newPath}`);
}

export function makeContext(
  root: string,
  historyOptions?: ConstructorParameters<typeof HistoryStore>[1],
): Omit<HistoryContext, "docs" | "tasks" | "memory"> & {
  docs: FakeDocs;
  tasks: FakeTasks;
  memory: FakeMemory;
} {
  const docs = new FakeDocs();
  const tasks = new FakeTasks(root);
  const memory = new FakeMemory();
  const versions = new VersionStore(root, {
    historyStore: historyOptions ? new HistoryStore(root, historyOptions) : undefined,
    withTaskLifecycleLock: (fn) => withTaskLifecycleLock(root, fn),
    getDoc: (path) => docs.docs.get(path),
  });
  return {
    root,
    versions,
    docs,
    tasks,
    memory,
    withTaskLifecycleLock: (fn) => withTaskLifecycleLock(root, fn),
    rewriteDocPath: fakeRewrite,
    loadProject: () => ({ name: "History Test" }),
  };
}
