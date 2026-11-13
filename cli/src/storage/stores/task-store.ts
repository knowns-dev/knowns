// Port of internal/storage/task_store.go: tasks in .knowns/tasks/ and .knowns/archive/, deletion
// tombstones, and the byte-exact markdown renderer.
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import {
  newPrefixedTaskId,
  newTaskId,
  normalizeTaskIdPrefix,
  taskFileName,
} from "../../models/id.ts";
import type { Task, TaskTombstone } from "../../models/task.ts";
import type { Store } from "../core/store.ts";
import {
  atomicWrite,
  extractAC,
  extractSection,
  goJsonStringify,
  goTrimSpace,
  renderAC,
  renderSection,
  splitFrontmatter,
  taskFileMatches,
} from "../core/util.ts";
import { canonicalTaskHash } from "../history/entities.ts";
import {
  asInt,
  asStr,
  asStrField,
  asStrList,
  formatIso,
  goTimeJson,
  isNotFound,
  isNumericString,
  isZeroTime,
  parseIso,
  parseYamlMap,
  readDirSorted,
  readOptionalTime,
  readTime,
  yamlScalar,
} from "./internal.ts";

const MAX_TASK_ID_GENERATION_ATTEMPTS = 10;

/** parseTaskContent: a task file's markdown into a Task (without archived/canonicalHash). */
export function parseTaskContent(content: string): Task {
  const { yaml, body } = splitFrontmatter(content);
  if (yaml === "") throw new Error("missing YAML frontmatter");
  let fm: Record<string, unknown>;
  try {
    fm = parseYamlMap(yaml);
  } catch (e) {
    throw new Error(`parse frontmatter: ${(e as Error).message}`);
  }
  const labels = asStrList(fm.labels);
  const fulfills = asStrList(fm.fulfills);
  const task: Task = {
    id: asStrField(fm, yaml, "id"),
    title: asStrField(fm, yaml, "title"),
    status: asStr(fm.status),
    priority: asStr(fm.priority),
    labels: labels.length === 0 ? null : labels,
    timeSpent: asInt(fm.timeSpent),
    archived: false,
    createdAt: readTime(asStr(fm.createdAt)),
    updatedAt: readTime(asStr(fm.updatedAt)),
    acceptanceCriteria: null,
  };
  const assignee = asStr(fm.assignee);
  if (assignee !== "") task.assignee = assignee;
  const parent = asStr(fm.parent);
  if (parent !== "") task.parent = parent;
  const spec = asStr(fm.spec);
  if (spec !== "") task.spec = spec;
  if (fulfills.length > 0) task.fulfills = fulfills;
  if (fm.order !== undefined && fm.order !== null) task.order = asInt(fm.order);
  const description = extractSection(body, "DESCRIPTION");
  if (description !== "") task.description = description;
  const plan = extractSection(body, "PLAN");
  if (plan !== "") task.implementationPlan = plan;
  const notes = extractSection(body, "NOTES");
  if (notes !== "") task.implementationNotes = notes;
  const ac = extractAC(body);
  task.acceptanceCriteria = ac.length === 0 ? null : ac;
  const completedAt = readOptionalTime(asStr(fm.completedAt), "completedAt");
  if (completedAt !== undefined) task.completedAt = completedAt;
  const archivedAt = readOptionalTime(asStr(fm.archivedAt), "archivedAt");
  if (archivedAt !== undefined) task.archivedAt = archivedAt;
  return task;
}

/** renderTask: the canonical markdown for a task. */
export function renderTask(task: Task): string {
  let b = "---\n";
  b += isNumericString(task.id) ? `id: '${task.id}'\n` : `id: ${task.id}\n`;
  b += `title: ${yamlScalar(task.title)}\n`;
  b += `status: ${task.status}\n`;
  b += `priority: ${task.priority}\n`;
  const labels = task.labels ?? [];
  if (labels.length === 0) b += "labels: []\n";
  else b += `labels:\n${labels.map((l) => `  - ${l}\n`).join("")}`;
  b += `createdAt: '${formatIso(task.createdAt)}'\n`;
  b += `updatedAt: '${formatIso(task.updatedAt)}'\n`;
  if (task.completedAt !== undefined) b += `completedAt: '${formatIso(task.completedAt)}'\n`;
  if (task.archivedAt !== undefined) b += `archivedAt: '${formatIso(task.archivedAt)}'\n`;
  b += `timeSpent: ${task.timeSpent}\n`;
  if (task.assignee) b += `assignee: ${yamlScalar(task.assignee)}\n`;
  if (task.parent) b += `parent: ${task.parent}\n`;
  if (task.spec) b += `spec: ${task.spec}\n`;
  if (task.fulfills && task.fulfills.length > 0) {
    b += `fulfills:\n${task.fulfills.map((f) => `  - ${f}\n`).join("")}`;
  }
  if (task.order !== undefined) b += `order: ${task.order}\n`;
  b += "---\n";

  b += `# ${task.title}\n\n`;
  b += "## Description\n\n";
  b += renderSection("DESCRIPTION", task.description ?? "");
  b += "\n\n";
  b += "## Acceptance Criteria\n";
  b += "<!-- AC:BEGIN -->\n";
  const criteria = task.acceptanceCriteria ?? [];
  if (criteria.length > 0) b += `${renderAC(criteria)}\n`;
  b += "<!-- AC:END -->\n";
  if (task.implementationPlan) {
    b += `\n## Implementation Plan\n\n${renderSection("PLAN", task.implementationPlan)}\n`;
  }
  if (task.implementationNotes) {
    b += `\n## Implementation Notes\n\n${renderSection("NOTES", task.implementationNotes)}\n`;
  }
  b += "\n";
  return b;
}

function patchScalar(lines: string[], key: string, value: string, remove: boolean): string[] {
  const prefix = `${key}:`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith(" ") || line.startsWith("\t") || !line.startsWith(prefix)) continue;
    if (remove) return [...lines.slice(0, i), ...lines.slice(i + 1)];
    const out = [...lines];
    out[i] = `${prefix} ${value}`;
    return out;
  }
  return remove ? lines : [...lines, `${prefix} ${value}`];
}

function sameClean(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

export class TaskStore {
  readonly root: string;

  constructor(private readonly store: Pick<Store, "root" | "withTaskLifecycleLock">) {
    this.root = store.root;
  }

  tasksDir(): string {
    return join(this.root, "tasks");
  }
  archiveDir(): string {
    return join(this.root, "archive");
  }
  tombstonesDir(): string {
    return join(this.root, "tombstones", "tasks");
  }

  // --- reads -----------------------------------------------------------------------------------

  listActive(): Task[] {
    return this.listDir(this.tasksDir());
  }

  listArchived(): Task[] {
    return this.listDir(this.archiveDir());
  }

  /** ListAll: active and archived; an active copy wins and tombstoned archived IDs are skipped. */
  listAll(): Task[] {
    const byId = new Map<string, Task>();
    for (const task of this.listArchived()) {
      if (this.isIdReserved(task.id)) continue;
      byId.set(task.id, task);
    }
    for (const task of this.listActive()) byId.set(task.id, task);
    const all = [...byId.values()];
    for (const task of all) delete task.subtasks;
    for (const task of all) {
      if (!task.parent) continue;
      const parent = byId.get(task.parent);
      if (parent) parent.subtasks = [...(parent.subtasks ?? []), task.id];
    }
    return all;
  }

  private listDir(dir: string): Task[] {
    const names = readDirSorted(dir)
      .filter((e) => !e.isDirectory() && e.name.endsWith(".md"))
      .map((e) => e.name);
    const byId = new Map<string, Task>();
    const pathById = new Map<string, string>();
    for (const name of names) {
      const path = join(dir, name);
      let task: Task;
      try {
        task = this.parseFile(path);
      } catch {
        continue;
      }
      const existing = byId.get(task.id);
      if (existing) {
        // Keep the latest updatedAt and remove the stale duplicate file.
        if ((parseIso(task.updatedAt)?.ms ?? 0) > (parseIso(existing.updatedAt)?.ms ?? 0)) {
          rmSync(pathById.get(task.id) as string, { force: true });
          byId.set(task.id, task);
          pathById.set(task.id, path);
        } else {
          rmSync(path, { force: true });
        }
      } else {
        byId.set(task.id, task);
        pathById.set(task.id, path);
      }
    }
    const tasks = [...byId.values()];
    for (const t of tasks) {
      if (!t.parent) continue;
      const parent = byId.get(t.parent);
      if (parent) parent.subtasks = [...(parent.subtasks ?? []), t.id];
    }
    return tasks;
  }

  get(id: string): Task {
    return this.parseFile(this.findFile(id));
  }

  /** CanonicalPath: the exact managed file selected by the same lookup as `get`. */
  canonicalPath(id: string): string {
    return this.findFile(id);
  }

  findFile(id: string): string {
    for (const dir of [this.tasksDir(), this.archiveDir()]) {
      const p = this.scanForId(dir, id);
      if (p !== undefined) return p;
    }
    throw new Error(`task "${id}" not found`);
  }

  private scanForId(dir: string, id: string): string | undefined {
    for (const e of readDirSorted(dir)) {
      if (e.isDirectory()) continue;
      if (taskFileMatches(e.name, id)) return join(dir, e.name);
    }
    return undefined;
  }

  // --- writes ----------------------------------------------------------------------------------

  private withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.store.withTaskLifecycleLock(fn);
  }

  create(task: Task): Promise<void> {
    return this.withLock(() => this.createUnlocked(task));
  }

  /** CreateGenerated: allocate a collision-safe ID (empty prefix = legacy format) and write. */
  createGenerated(task: Task, prefix = ""): Promise<void> {
    if (task.id !== "")
      return Promise.reject(new Error("generated task must not already have an ID"));
    return this.withLock(() => {
      task.id = this.allocateTaskIdUnlocked(prefix);
      try {
        this.createUnlocked(task);
      } catch (e) {
        task.id = "";
        throw e;
      }
    });
  }

  allocateTaskIdUnlocked(prefix: string, generate?: () => string): string {
    const normalized = normalizeTaskIdPrefix(prefix);
    const gen =
      generate ?? (() => (normalized === "" ? newTaskId() : newPrefixedTaskId(normalized)));
    for (let i = 0; i < MAX_TASK_ID_GENERATION_ATTEMPTS; i++) {
      const candidate = gen();
      if (this.scanForAny(candidate)) continue;
      if (this.isIdReserved(candidate)) continue;
      return candidate;
    }
    throw new Error(
      `could not allocate a unique ${normalized === "" ? "legacy" : normalized} task ID after ${MAX_TASK_ID_GENERATION_ATTEMPTS} attempts`,
    );
  }

  private scanForAny(id: string): boolean {
    try {
      this.findFile(id);
      return true;
    } catch {
      return false;
    }
  }

  createUnlocked(task: Task): void {
    if (!task) throw new Error("task is required");
    if (task.id === "") throw new Error("task ID is required");
    if (this.scanForAny(task.id)) throw new Error(`task ID "${task.id}" already exists`);
    if (this.isIdReserved(task.id)) {
      throw new Error(`task ID "${task.id}" is reserved by a deletion tombstone`);
    }
    mkdirSync(this.tasksDir(), { recursive: true, mode: 0o755 });
    this.writeFile(join(this.tasksDir(), taskFileName(task.id)), task);
  }

  /** Update: write to the existing path (the file is never renamed on title changes). */
  update(task: Task): Promise<void> {
    return this.withLock(() => this.updateUnlocked(task));
  }

  updateUnlocked(task: Task): void {
    let old: string;
    try {
      old = this.findFile(task.id);
    } catch {
      this.createUnlocked(task);
      return;
    }
    this.writeFile(old, task);
  }

  delete(id: string): Promise<void> {
    return this.withLock(() => rmSync(this.findFile(id)));
  }

  /** deleteAllUnlocked: every active or archived file that resolves to the ID. */
  deleteAllUnlocked(id: string): number {
    this.tombstonePath(id);
    let removed = 0;
    for (const dir of [this.tasksDir(), this.archiveDir()]) {
      for (const entry of readDirSorted(dir)) {
        if (entry.isDirectory() || !taskFileMatches(entry.name, id)) continue;
        rmSync(join(dir, entry.name), { force: true });
        removed++;
      }
    }
    return removed;
  }

  archive(id: string): Promise<void> {
    return this.withLock(() => this.archiveUnlocked(id));
  }

  /** archiveUnlocked: move a task file from tasks/ to archive/; the caller holds the lifecycle lock. */
  archiveUnlocked(id: string): void {
    const src = this.scanForId(this.tasksDir(), id);
    if (src === undefined) throw new Error(`archive: task "${id}" not found in ${this.tasksDir()}`);
    mkdirSync(this.archiveDir(), { recursive: true, mode: 0o755 });
    if (this.scanForId(this.archiveDir(), id) !== undefined) {
      throw new Error(`archive: task "${id}" already exists in archive`);
    }
    renameSync(src, join(this.archiveDir(), basename(src)));
  }

  unarchive(id: string): Promise<void> {
    return this.withLock(() => this.unarchiveUnlocked(id));
  }

  /** unarchiveUnlocked: move a task file from archive/ back to tasks/; the caller holds the lock. */
  unarchiveUnlocked(id: string): void {
    const src = this.scanForId(this.archiveDir(), id);
    if (src === undefined) {
      throw new Error(`unarchive: task "${id}" not found in ${this.archiveDir()}`);
    }
    mkdirSync(this.tasksDir(), { recursive: true, mode: 0o755 });
    if (this.scanForId(this.tasksDir(), id) !== undefined) {
      throw new Error(`unarchive: task "${id}" already exists in active storage`);
    }
    renameSync(src, join(this.tasksDir(), basename(src)));
  }

  // --- tombstones ------------------------------------------------------------------------------

  saveTombstone(tombstone: TaskTombstone): Promise<void> {
    return this.withLock(() => this.saveTombstoneUnlocked(tombstone));
  }

  saveTombstoneUnlocked(tombstone: TaskTombstone): void {
    if (!tombstone) throw new Error("task tombstone is required");
    const path = this.tombstonePath(tombstone.id);
    if (isZeroTime(tombstone.deletedAt)) throw new Error("task tombstone deletedAt is required");
    if (goTrimSpace(tombstone.reason) === "") throw new Error("task tombstone reason is required");
    mkdirSync(this.tombstonesDir(), { recursive: true, mode: 0o755 });
    const out: Record<string, unknown> = {
      id: tombstone.id,
      deletedAt: goTimeJson(tombstone.deletedAt),
    };
    if (tombstone.actor) out.actor = tombstone.actor;
    out.reason = tombstone.reason;
    const data = `${goJsonStringify(out)}\n`;
    // Exclusive create: write a temp file then link, so a concurrent writer cannot be clobbered.
    const tmp = join(dirname(path), `.tombstone-${crypto.randomUUID().slice(0, 8)}`);
    writeFileSync(tmp, data, { mode: 0o644 });
    try {
      linkSync(tmp, path);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`persist task tombstone "${tombstone.id}": ${(e as Error).message}`);
      }
    } finally {
      rmSync(tmp, { force: true });
    }
    const existing = this.getTombstone(tombstone.id);
    const same =
      existing.id === tombstone.id &&
      parseIso(existing.deletedAt)?.ms === parseIso(tombstone.deletedAt)?.ms &&
      (existing.actor ?? "") === (tombstone.actor ?? "") &&
      existing.reason === tombstone.reason;
    if (!same) {
      throw new Error(
        `task tombstone "${tombstone.id}" already exists with different audit metadata`,
      );
    }
  }

  getTombstone(id: string): TaskTombstone {
    const path = this.tombstonePath(id);
    let data: string;
    try {
      data = readFileSync(path, "utf8");
    } catch (e) {
      if (isNotFound(e)) throw new Error(`task tombstone "${id}" not found`);
      throw new Error(`read task tombstone "${id}": ${(e as Error).message}`);
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(data) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`parse task tombstone "${id}": ${(e as Error).message}`);
    }
    const tombstone: TaskTombstone = {
      id: asStr(raw.id),
      deletedAt: goTimeJson(asStr(raw.deletedAt)),
      reason: asStr(raw.reason),
    };
    if (raw.actor) tombstone.actor = asStr(raw.actor);
    if (tombstone.id !== id) {
      throw new Error(`task tombstone identity mismatch: got "${tombstone.id}", want "${id}"`);
    }
    return tombstone;
  }

  isIdReserved(id: string): boolean {
    return existsSync(this.tombstonePath(id));
  }

  private tombstonePath(id: string): string {
    if (
      id === "" ||
      id === "." ||
      id === ".." ||
      basename(id) !== id ||
      /[/\\]/.test(id) ||
      id.includes("\0")
    ) {
      throw new Error(`invalid task ID "${id}"`);
    }
    return join(this.tombstonesDir(), `${id}.json`);
  }

  // --- file level ------------------------------------------------------------------------------

  parseFile(path: string): Task {
    let data: string;
    try {
      data = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(`parseFile ${path}: ${(e as Error).message}`);
    }
    const task = parseTaskContent(data);
    task.archived = sameClean(dirname(path), this.archiveDir());
    task.canonicalHash = canonicalTaskHash(task);
    return task;
  }

  private writeFile(path: string, task: Task): void {
    atomicWrite(path, renderTask(task));
  }

  /**
   * patchLifecycleUnlocked: change only the lifecycle frontmatter keys (status, updatedAt,
   * completedAt, archivedAt) and preserve every unknown key and the body byte for byte.
   */
  patchLifecycleUnlocked(task: Task): void {
    const path = this.findFile(task.id);
    const content = readFileSync(path, "utf8");
    const { yaml, body } = splitFrontmatter(content);
    if (yaml === "") throw new Error(`patch Task "${task.id}" lifecycle: missing YAML frontmatter`);
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    let lines = yaml.replaceAll("\r\n", "\n").split("\n");
    lines = patchScalar(lines, "status", task.status, false);
    lines = patchScalar(lines, "updatedAt", `'${formatIso(task.updatedAt)}'`, false);
    lines =
      task.completedAt === undefined
        ? patchScalar(lines, "completedAt", "", true)
        : patchScalar(lines, "completedAt", `'${formatIso(task.completedAt)}'`, false);
    lines =
      task.archivedAt === undefined
        ? patchScalar(lines, "archivedAt", "", true)
        : patchScalar(lines, "archivedAt", `'${formatIso(task.archivedAt)}'`, false);
    const patched = `---${newline}${lines.join(newline)}${newline}---${newline}${body}`;
    try {
      parseTaskContent(patched);
    } catch (e) {
      throw new Error(`validate Task "${task.id}" lifecycle patch: ${(e as Error).message}`);
    }
    atomicWrite(path, patched);
  }
}
