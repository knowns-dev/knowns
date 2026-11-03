// Port of internal/storage/mutation_transaction.go: atomic Doc and Task mutations that write the
// canonical file and its history together, with expected-hash (optimistic concurrency) checks and
// rollback. The entity stores are reached through the ports in ports.ts.
import { createHash } from "node:crypto";
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
import type { Doc } from "../../models/doc.ts";
import { deriveTaskIdPrefix, normalizeTaskIdPrefix } from "../../models/id.ts";
import type { MemoryEntry } from "../../models/memory.ts";
import type { Task } from "../../models/task.ts";
import type { HistoryRecord, TaskVersion } from "../../models/version.ts";
import { withDocMutationLocks } from "../core/locks.ts";
import { goTrimSpace } from "../core/util.ts";
import { DocIdentityConflictError, MutationConflictError } from "./conflicts.ts";
import {
  canonicalDocHash,
  canonicalTaskHash,
  docStateOf,
  docToSnapshot,
  findMarkdownSection,
  hashDoc,
  newDocId,
  normalizeDocPath,
  replaceMarkdownSection,
  taskToSnapshot,
  trackTaskChanges,
} from "./entities.ts";
import { firstNonEmpty, goNow } from "./go-json.ts";
import { syncDirectory } from "./history-store.ts";
import {
  conflictResolverOf,
  type TaskLifecycleTransaction,
  withTaskLifecycleTransaction,
} from "./lifecycle-tx.ts";
import type { HistoryContext } from "./ports.ts";
import { HistoryConflictError, LIFECYCLE_OPERATION_DELETE } from "./records.ts";
import { explainConflict } from "./sync-provenance.ts";
import type { DocRevisionOptions } from "./version-store.ts";

/** DocMutationOptions: audit context for an atomic document mutation. */
export interface DocMutationOptions {
  actor?: string;
  source?: string;
  section?: string;
  rewriteReferences?: boolean;
  expectedHash?: string;
}

/** DocDeleteOptions: the optimistic-concurrency base and audit context for a tombstone. */
export interface DocDeleteOptions {
  expectedHash?: string;
  actor?: string;
  source?: string;
  batchId?: string;
}

// --- doc delete transaction marker ---------------------------------------------------------------

interface DocDeleteTransaction {
  schemaVersion: number;
  entityId: string;
  path: string;
  hash: string;
  actor?: string;
  source?: string;
  batchId?: string;
  timestamp: string;
}

export function docDeleteTransactionDir(root: string): string {
  return join(root, "history", "state", "doc-delete-transactions");
}

export function docDeleteTransactionPath(root: string, id: string): string {
  return join(
    docDeleteTransactionDir(root),
    `${createHash("sha256").update(id, "utf8").digest("hex")}.json`,
  );
}

function writeDocDeleteTransaction(root: string, m: DocDeleteTransaction): void {
  const dir = docDeleteTransactionDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = join(dir, `.doc-delete-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(m));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, docDeleteTransactionPath(root, m.entityId));
  } finally {
    rmSync(tmp, { force: true });
  }
  syncDirectory(dir);
}

export function removeDocDeleteTransaction(root: string, id: string): void {
  const p = docDeleteTransactionPath(root, id);
  rmSync(p, { force: true });
  syncDirectory(dirname(p));
}

/** A store that prunes empty directories leaves nothing to fsync; that is not a failure. */
function syncDirectoryIfPresent(dir: string): void {
  try {
    syncDirectory(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** combineMutationRollbackError. */
export function combineMutationRollbackError(primary: unknown, rollback: unknown): Error {
  const p = primary instanceof Error ? primary : new Error(String(primary));
  if (rollback === undefined || rollback === null) return p;
  const r = rollback instanceof Error ? rollback : new Error(String(rollback));
  return new Error(`${p.message}; rollback failed: ${r.message}`, { cause: p });
}

function cloneDocExact(doc: Doc): Doc {
  const copy: Doc = { ...doc };
  delete copy.canonicalHash;
  if (doc.tags) copy.tags = [...doc.tags];
  return copy;
}

function cloneTask(task: Task): Task {
  const copy: Task = { ...task };
  if (task.labels) copy.labels = [...task.labels];
  if (task.fulfills) copy.fulfills = [...task.fulfills];
  if (task.subtasks) copy.subtasks = [...task.subtasks];
  if (task.acceptanceCriteria)
    copy.acceptanceCriteria = task.acceptanceCriteria.map((a) => ({ ...a }));
  if (task.timeEntries) copy.timeEntries = task.timeEntries.map((e) => ({ ...e }));
  if (task.activeTimer) copy.activeTimer = { ...task.activeTimer };
  return copy;
}

function cloneMemory(memory: MemoryEntry): MemoryEntry {
  return JSON.parse(JSON.stringify(memory)) as MemoryEntry;
}

const ID_COMPARE = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function exists<T>(fn: () => T | Promise<T>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

// --- delete ------------------------------------------------------------------------------------

/**
 * DeleteDocWithExpectedHash removes a document only when its fresh canonical hash matches the
 * caller's expected base and the durable history head, leaving a restorable tombstone. A stale
 * conflict whose current state arrived through store sync is explained (FR-12, FR-13).
 */
export async function deleteDocWithExpectedHash(
  ctx: HistoryContext,
  path: string,
  opts: DocDeleteOptions = {},
): Promise<void> {
  try {
    await deleteDocInner(ctx, path, opts);
  } catch (err) {
    throw await explainConflict(conflictResolverOf(ctx), err);
  }
}

async function deleteDocInner(
  ctx: HistoryContext,
  path: string,
  opts: DocDeleteOptions,
): Promise<void> {
  const canonicalPath = normalizeDocPath(path);
  if (canonicalPath === "") throw new Error("document delete: path is required");
  const pre = await ctx.docs.get(canonicalPath);
  if (goTrimSpace(pre.id ?? "") === "")
    throw new Error("document delete: stable doc ID is required");
  const history = ctx.versions.historyStore();
  await history.withEntityLock("doc", `__lifecycle__:${pre.id}`, () =>
    withDocMutationLocks(ctx.root, [canonicalPath], async () => {
      const expected = goTrimSpace(opts.expectedHash ?? "");
      if (expected === "") throw new Error("document delete: expected canonical hash is required");
      const current = await ctx.docs.get(canonicalPath);
      if (goTrimSpace(current.id ?? "") === "")
        throw new Error("document delete: stable doc ID is required");
      if (current.id !== pre.id) {
        throw new MutationConflictError(
          "doc",
          pre.id as string,
          `stable ID ${pre.id}`,
          `stable ID ${current.id}`,
        );
      }
      const currentHash = canonicalDocHash(current);
      if (expected !== currentHash) {
        throw new MutationConflictError(
          "doc",
          firstNonEmpty(current.id, current.path),
          expected,
          currentHash,
        );
      }
      let stream: Awaited<ReturnType<typeof history.read>>;
      try {
        stream = await history.read("doc", current.id as string);
      } catch (e) {
        throw new Error(`document delete: read history: ${(e as Error).message}`, { cause: e });
      }
      const records = stream.records ?? [];
      if (records.length === 0)
        throw new Error("document delete: durable history head is required");
      const head = records[records.length - 1] as HistoryRecord;
      if (head.tombstone || head.operation === LIFECYCLE_OPERATION_DELETE) {
        throw new Error(
          "document delete: document is already tombstoned; restore reconciliation is required",
        );
      }
      if ((head.newHash ?? "") !== currentHash) {
        throw new MutationConflictError(
          "doc",
          current.id as string,
          head.newHash ?? "",
          currentHash,
        );
      }
      const canonicalHistoryPath = `docs/${normalizeDocPath(current.path)}.md`;
      const canonicalDir = dirname(join(ctx.root, ...canonicalHistoryPath.split("/")));
      const actor = goTrimSpace(opts.actor ?? "") || "system";
      const source = goTrimSpace(opts.source ?? "") || "delete";
      const marker: DocDeleteTransaction = {
        schemaVersion: 1,
        entityId: current.id as string,
        path: canonicalHistoryPath,
        hash: currentHash,
        ...(actor ? { actor } : {}),
        ...(source ? { source } : {}),
        ...(opts.batchId ? { batchId: opts.batchId } : {}),
        timestamp: goNow(),
      };
      try {
        writeDocDeleteTransaction(ctx.root, marker);
      } catch (e) {
        throw new Error(`document delete: persist transaction marker: ${(e as Error).message}`, {
          cause: e,
        });
      }
      try {
        await ctx.docs.delete(canonicalPath);
      } catch (e) {
        try {
          removeDocDeleteTransaction(ctx.root, current.id as string);
        } catch {
          // best effort
        }
        throw e;
      }
      syncDirectoryIfPresent(canonicalDir);
      // The tombstone checkpoint is the full canonical state, never a display snapshot (decision
      // a-briefly-missing-file-is-not-a-deletion).
      try {
        await history.append({
          schemaVersion: 0,
          entityType: "doc",
          entityId: current.id as string,
          revision: 0,
          timestamp: goNow(),
          operation: "delete",
          tombstone: true,
          baseHash: currentHash,
          newHash: currentHash,
          checkpoint: true,
          checkpointPayload: docToSnapshot(docStateOf(current)),
          currentPath: canonicalHistoryPath,
          previousPath: canonicalHistoryPath,
          actor,
          source,
          batchId: opts.batchId,
        });
      } catch (err) {
        let rollbackErr: unknown;
        try {
          await ctx.docs.writeExact(current);
          syncDirectoryIfPresent(canonicalDir);
          removeDocDeleteTransaction(ctx.root, current.id as string);
        } catch (e) {
          rollbackErr = e;
        }
        throw combineMutationRollbackError(err, rollbackErr);
      }
      removeDocDeleteTransaction(ctx.root, current.id as string);
    }),
  );
}

// --- task create -------------------------------------------------------------------------------

/**
 * CreateTaskWithHistory creates a Task and its initial history record under one lifecycle lock. A
 * failed history append removes the newly created Task. An empty task.id is allocated from the
 * project's default ID prefix (or `prefix`, a one-off override).
 */
export async function createTaskWithHistory(
  ctx: HistoryContext,
  task: Task,
  version: Partial<TaskVersion> = {},
  prefix = "",
): Promise<void> {
  if (!task) throw new Error("create task with history: task is required");
  // Reject a malformed prefix before taking the lifecycle lock; the message is user-facing.
  const explicitPrefix = normalizeTaskIdPrefix(prefix);
  await withTaskLifecycleTransaction(ctx, async (tx) => {
    let allocated = false;
    if (task.id === "") {
      let effective = explicitPrefix;
      if (effective === "") {
        if (!ctx.loadProject)
          throw new Error("resolve default task ID prefix: project config is unavailable");
        let project: Awaited<ReturnType<NonNullable<HistoryContext["loadProject"]>>>;
        try {
          project = await ctx.loadProject();
        } catch (e) {
          throw new Error(`resolve default task ID prefix: ${(e as Error).message}`, { cause: e });
        }
        effective = project.settings?.defaultTaskIdPrefix ?? "";
        // Every new task gets a prefix; existing unprefixed IDs are left alone.
        if (effective === "") effective = deriveTaskIdPrefix(project.name);
      }
      task.id = await ctx.tasks.allocateTaskIdUnlocked(effective);
      allocated = true;
    }
    try {
      await tx.createTask(task);
    } catch (e) {
      if (allocated) task.id = "";
      throw e;
    }
    const v: Partial<TaskVersion> = { ...version };
    // A caller-supplied snapshot predates the ID, so recompute it whenever this call allocated.
    if (allocated || !v.snapshot || Object.keys(v.snapshot).length === 0)
      v.snapshot = taskToSnapshot(task);
    if (!v.changes || v.changes.length === 0) v.changes = trackTaskChanges(null, task);
    try {
      await ctx.versions.saveVersionUnlocked(task.id, v);
    } catch (err) {
      try {
        await tx.deleteTask(task.id);
      } catch (rollbackErr) {
        throw new Error(
          `${(err as Error).message}; rollback Task create: ${(rollbackErr as Error).message}`,
          {
            cause: err,
          },
        );
      }
      throw err;
    }
  });
}

// --- doc mutate --------------------------------------------------------------------------------

/**
 * MutateDocWithHistory atomically creates, updates, or renames a canonical document and appends
 * its history. `oldDoc` must be the caller's observed state for updates and renames; it is
 * re-read under the path lock. A stale-hash conflict whose current state arrived through store
 * sync is explained (FR-12, FR-13).
 */
export async function mutateDocWithHistory(
  ctx: HistoryContext,
  oldDoc: Doc | null,
  newDoc: Doc | null,
  opts: DocMutationOptions = {},
): Promise<void> {
  try {
    await mutateDocInner(ctx, oldDoc, newDoc, opts);
  } catch (err) {
    throw await explainConflict(conflictResolverOf(ctx), err);
  }
}

async function mutateDocInner(
  ctx: HistoryContext,
  oldDoc: Doc | null,
  newDoc: Doc | null,
  opts: DocMutationOptions,
): Promise<void> {
  if (!newDoc || goTrimSpace(newDoc.path) === "") {
    throw new Error("document mutation: new document path is required");
  }
  const newPath = normalizeDocPath(newDoc.path);
  let oldPath = "";
  if (oldDoc) {
    oldPath = normalizeDocPath(oldDoc.path);
    if (oldPath === "") throw new Error("document mutation: old document path is required");
  }
  newDoc.path = newPath;
  const paths = [newPath];
  if (oldPath !== "") paths.push(oldPath);
  if (oldDoc && oldPath !== newPath)
    return mutateRenamedDocWithReferences(ctx, oldDoc, newDoc, opts);

  await withDocMutationLocks(ctx.root, paths, async () => {
    if (!oldDoc) {
      if (await exists(() => ctx.docs.get(newPath)))
        throw new Error(`document "${newPath}" already exists`);
      if (goTrimSpace(newDoc.id ?? "") === "") newDoc.id = newDocId();
      await ctx.docs.validateStableId(newDoc.id as string, newPath);
      await ctx.docs.create(newDoc);
      try {
        await ctx.versions.saveDocRevisionWithOptions(null, newDoc, {
          actor: opts.actor,
          source: opts.source,
        });
      } catch (err) {
        try {
          await ctx.docs.delete(newPath);
        } catch (rollbackErr) {
          throw new Error(
            `${(err as Error).message}; rollback Doc create: ${(rollbackErr as Error).message}`,
            {
              cause: err,
            },
          );
        }
        throw err;
      }
      newDoc.canonicalHash = canonicalDocHash(newDoc);
      return;
    }

    let current: Doc;
    try {
      current = await ctx.docs.get(oldPath);
    } catch {
      throw new HistoryConflictError("document changed or was deleted");
    }
    await ctx.docs.validateStableId(firstNonEmpty(current.id, newDoc.id), oldPath);
    let expected = goTrimSpace(opts.expectedHash ?? "");
    if (expected === "") expected = hashDoc(docStateOf(oldDoc));
    const currentHash = hashDoc(docStateOf(current));
    if (expected !== currentHash) {
      throw new MutationConflictError(
        "doc",
        firstNonEmpty(current.id, newDoc.id, oldPath),
        expected,
        currentHash,
      );
    }
    if (!newDoc.id) newDoc.id = current.id;
    if (current.id && newDoc.id !== current.id)
      throw new DocIdentityConflictError(current.id, newDoc.id as string);
    if (!newDoc.id) {
      const history = await ctx.versions.docHistoryForWrite(oldPath, "");
      if (history) newDoc.id = history.docId;
    }
    if (!newDoc.id) newDoc.id = newDocId();
    if (newDoc.id !== current.id) await ctx.docs.validateStableId(newDoc.id as string, newPath);
    if (oldPath !== newPath && (await exists(() => ctx.docs.get(newPath)))) {
      throw new HistoryConflictError("document target already exists");
    }

    const oldCanonical: Doc = { ...current };
    const candidate: Doc = { ...newDoc };
    await ctx.docs.update(candidate);
    try {
      await ctx.versions.saveDocRevisionWithOptions(oldCanonical, candidate, {
        actor: opts.actor,
        source: opts.source,
        section: opts.section,
      });
    } catch (err) {
      let rollbackErr: unknown;
      try {
        await ctx.docs.writeExact(oldCanonical);
      } catch (e) {
        rollbackErr = e;
      }
      throw combineMutationRollbackError(err, rollbackErr);
    }
    newDoc.canonicalHash = canonicalDocHash(candidate);
  });
}

interface DocRewrite {
  before: Doc;
  after: Doc;
  updated: boolean;
  history: boolean;
}
interface TaskRewrite {
  before: Task;
  after: Task;
  eventId: string;
  updated: boolean;
  history: boolean;
}
interface MemoryRewrite {
  before: MemoryEntry;
  after: MemoryEntry;
  committedHash: string;
  updated: boolean;
}

async function docRawBytes(ctx: HistoryContext, path: string): Promise<Buffer | undefined> {
  try {
    return readFileSync(join(ctx.root, "docs", ...`${path}.md`.split("/")));
  } catch {
    return undefined;
  }
}

/**
 * mutateRenamedDocWithReferences composes the rename, reference rewrites, and every affected
 * Task/Doc history append under one deterministic lock order: global rename lock -> sorted Doc
 * locks -> Task lifecycle lock -> sorted Memory locks. The preflight snapshot is only an
 * observation: every affected canonical entity is re-read after all locks are held.
 */
async function mutateRenamedDocWithReferences(
  ctx: HistoryContext,
  oldDoc: Doc,
  newDoc: Doc,
  opts: DocMutationOptions,
): Promise<void> {
  // captureDocReferenceState
  const docs: Doc[] = [];
  const docRaw = new Map<string, Buffer>();
  for (const doc of await ctx.docs.list()) {
    if (doc && !doc.isImported) {
      const full = cloneDocExact(await ctx.docs.get(doc.path));
      docs.push(full);
      const raw = await docRawBytes(ctx, full.path);
      if (raw) docRaw.set(full.path, Buffer.from(raw));
    }
  }
  const tasks = (await ctx.tasks.listAll()).filter(Boolean).map(cloneTask);
  const memories = ctx.memory ? (await ctx.memory.list("")).filter(Boolean).map(cloneMemory) : [];

  const docPlan: DocRewrite[] = [];
  const taskPlan: TaskRewrite[] = [];
  const memoryPlan: MemoryEntry[] = [];
  const paths = [oldDoc.path, newDoc.path];
  for (const original of docs) {
    if (original.path === oldDoc.path || original.path === newDoc.path) continue;
    const after = cloneDocExact(original);
    after.content = ctx.rewriteDocPath(after.content ?? "", oldDoc.path, newDoc.path);
    if (after.content === (original.content ?? "")) continue;
    after.updatedAt = goNow();
    docPlan.push({ before: original, after, updated: false, history: false });
    paths.push(original.path);
  }
  for (const original of tasks) {
    const after = cloneTask(original);
    let changed = false;
    if (after.spec === oldDoc.path) {
      after.spec = newDoc.path;
      changed = true;
    }
    const rewrite = (value: string | undefined, assign: (v: string) => void) => {
      const rewritten = ctx.rewriteDocPath(value ?? "", oldDoc.path, newDoc.path);
      if (rewritten === (value ?? "")) return;
      changed = true;
      assign(rewritten);
    };
    rewrite(after.description, (v) => (after.description = v));
    rewrite(after.implementationPlan, (v) => (after.implementationPlan = v));
    rewrite(after.implementationNotes, (v) => (after.implementationNotes = v));
    if (!changed) continue;
    after.updatedAt = goNow();
    const nanos = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
    taskPlan.push({
      before: original,
      after,
      eventId: `doc-rename-${nanos}-${original.id}`,
      updated: false,
      history: false,
    });
  }
  for (const original of memories) {
    const after = cloneMemory(original);
    after.content = ctx.rewriteDocPath(after.content ?? "", oldDoc.path, newDoc.path);
    if (after.content === original.content) continue;
    after.updatedAt = goNow();
    memoryPlan.push(after);
  }
  docPlan.sort((a, b) => ID_COMPARE(a.before.path, b.before.path));
  taskPlan.sort((a, b) => ID_COMPARE(a.before.id, b.before.id));
  memoryPlan.sort((a, b) => ID_COMPARE(`${a.id}\0${a.layer}`, `${b.id}\0${b.layer}`));
  const memoryIds = memoryPlan.map((m) => m.id);
  ctx.renameReferencePreflight?.();

  const history = ctx.versions.historyStore();
  await history.withEntityLock("doc", "rename-references", () =>
    withDocMutationLocks(ctx.root, paths, () =>
      withTaskLifecycleTransaction(ctx, async (tx: TaskLifecycleTransaction) => {
        let current: Doc;
        try {
          current = await ctx.docs.get(oldDoc.path);
        } catch {
          throw new MutationConflictError(
            "doc",
            firstNonEmpty(oldDoc.id, oldDoc.path),
            hashDoc(docStateOf(oldDoc)),
            "",
          );
        }
        let expected = goTrimSpace(opts.expectedHash ?? "");
        if (expected === "") expected = hashDoc(docStateOf(oldDoc));
        const currentHash = canonicalDocHash(current);
        if (currentHash !== expected) {
          throw new MutationConflictError(
            "doc",
            firstNonEmpty(current.id, oldDoc.id, oldDoc.path),
            expected,
            currentHash,
          );
        }
        await ctx.docs.validateStableId(firstNonEmpty(current.id, newDoc.id), oldDoc.path);
        const candidate: Doc = { ...newDoc };
        if (!candidate.id) candidate.id = current.id;
        if (current.id && candidate.id !== current.id)
          throw new DocIdentityConflictError(current.id, candidate.id as string);
        if (!candidate.id) candidate.id = newDocId();
        if (await exists(() => ctx.docs.get(candidate.path))) {
          throw new HistoryConflictError("document target already exists");
        }

        for (const rewrite of docPlan) {
          const fresh = await ctx.docs.get(rewrite.before.path);
          const got = canonicalDocHash(fresh);
          const want = canonicalDocHash(rewrite.before);
          if (got !== want)
            throw new MutationConflictError("doc", firstNonEmpty(fresh.id, fresh.path), want, got);
        }
        for (const rewrite of taskPlan) {
          const fresh = await tx.getTask(rewrite.before.id);
          const got = canonicalTaskHash(fresh);
          const want = canonicalTaskHash(rewrite.before);
          if (got !== want) throw new MutationConflictError("task", fresh.id, want, got);
        }

        const committedDocs: DocRewrite[] = [];
        const committedTasks: TaskRewrite[] = [];
        const committedMemories: MemoryRewrite[] = [];
        let primaryHistory = false;

        const rollbackDocHistory = async (doc: Doc | null) => {
          if (
            !doc ||
            goTrimSpace(doc.id ?? "") === "" ||
            !ctx.versions.hasJsonlHistory("doc", doc.id as string)
          )
            return;
          await history.removeLast("doc", doc.id as string);
        };

        const rollback = async (cause: unknown): Promise<Error> => {
          const errors: Error[] = [];
          const attempt = async (fn: () => Promise<unknown> | unknown) => {
            try {
              await fn();
            } catch (e) {
              errors.push(e instanceof Error ? e : new Error(String(e)));
            }
          };
          for (let i = committedMemories.length - 1; i >= 0; i--) {
            const entry = committedMemories[i] as MemoryRewrite;
            let currentMemory: MemoryEntry | undefined;
            try {
              currentMemory = await ctx.memory?.getInLayer(entry.before.id, entry.before.layer);
            } catch {
              currentMemory = undefined;
            }
            if (!currentMemory || !ctx.memory) continue;
            if (ctx.memory.canonicalHash(currentMemory) !== entry.committedHash) {
              errors.push(
                new Error(`memory "${entry.before.id}" changed after rename; rollback skipped`),
              );
              continue;
            }
            const copy = cloneMemory(entry.before);
            await attempt(() =>
              ctx.memory?.writeExisting(copy, currentMemory as MemoryEntry, false),
            );
          }
          for (let i = committedTasks.length - 1; i >= 0; i--) {
            const entry = committedTasks[i] as TaskRewrite;
            if (entry.history)
              await attempt(() => tx.rollbackTaskLifecycleVersion(entry.before.id, entry.eventId));
            if (entry.updated) await attempt(() => tx.updateTask(entry.before));
          }
          for (let i = committedDocs.length - 1; i >= 0; i--) {
            const entry = committedDocs[i] as DocRewrite;
            if (entry.history) await attempt(() => rollbackDocHistory(entry.after));
            if (entry.updated) {
              const raw = docRaw.get(entry.before.path);
              await attempt(() =>
                raw ? ctx.docs.writeRaw(entry.before.path, raw) : ctx.docs.writeExact(entry.before),
              );
            }
          }
          if (primaryHistory) await attempt(() => rollbackDocHistory(candidate));
          const rawOld = docRaw.get(current.path);
          await attempt(() =>
            rawOld
              ? ctx.docs.renameRaw(candidate.path, current.path, rawOld)
              : ctx.docs.renameExact(candidate.path, current),
          );
          const combined =
            errors.length === 0 ? undefined : new Error(errors.map((e) => e.message).join("\n"));
          return combineMutationRollbackError(cause, combined);
        };

        await ctx.docs.rename(current.path, candidate);
        for (const planned of docPlan) {
          const rewrite = { ...planned };
          try {
            await ctx.docs.update(rewrite.after);
          } catch (e) {
            throw await rollback(e);
          }
          rewrite.updated = true;
          committedDocs.push(rewrite);
          try {
            await ctx.versions.saveDocRevisionWithOptions(rewrite.before, rewrite.after, {
              actor: opts.actor,
              source: opts.source,
            });
          } catch (e) {
            throw await rollback(e);
          }
          rewrite.history = true;
          committedDocs[committedDocs.length - 1] = rewrite;
        }
        for (const planned of taskPlan) {
          const rewrite = { ...planned };
          committedTasks.push(rewrite);
          try {
            await tx.updateTask(rewrite.after);
          } catch (e) {
            throw await rollback(e);
          }
          rewrite.updated = true;
          committedTasks[committedTasks.length - 1] = rewrite;
          try {
            await tx.saveTaskVersion(
              rewrite.before,
              rewrite.after,
              opts.actor ?? "",
              goNow(),
              rewrite.eventId,
            );
          } catch (e) {
            throw await rollback(e);
          }
          rewrite.history = true;
          committedTasks[committedTasks.length - 1] = rewrite;
        }
        const run = async () => {
          for (const original of memoryPlan) {
            let currentMemory: MemoryEntry;
            try {
              currentMemory = await (
                ctx.memory as NonNullable<HistoryContext["memory"]>
              ).getInLayer(original.id, original.layer);
            } catch (e) {
              throw await rollback(e);
            }
            // Re-read under the per-memory lock and apply only the reference rewrite, so
            // unrelated concurrent edits survive.
            const rewritten = cloneMemory(currentMemory);
            rewritten.content = ctx.rewriteDocPath(
              currentMemory.content ?? "",
              oldDoc.path,
              newDoc.path,
            );
            if (rewritten.content === currentMemory.content) continue;
            rewritten.updatedAt = goNow();
            const committed: MemoryRewrite = {
              before: cloneMemory(currentMemory),
              after: cloneMemory(rewritten),
              committedHash: "",
              updated: false,
            };
            committedMemories.push(committed);
            try {
              await (ctx.memory as NonNullable<HistoryContext["memory"]>).writeExisting(
                rewritten,
                currentMemory,
                false,
              );
            } catch (e) {
              throw await rollback(e);
            }
            committed.updated = true;
            committed.committedHash = (
              ctx.memory as NonNullable<HistoryContext["memory"]>
            ).canonicalHash(rewritten);
          }
          try {
            await ctx.versions.saveDocRevisionWithOptions(current, candidate, {
              actor: opts.actor,
              source: opts.source,
              section: opts.section,
            });
          } catch (e) {
            throw await rollback(e);
          }
          primaryHistory = true;
          newDoc.canonicalHash = canonicalDocHash(candidate);
        };
        if (ctx.memory) await ctx.memory.withLocks(memoryIds, run);
        else await run();
      }),
    ),
  );
}

// --- restore -----------------------------------------------------------------------------------

/**
 * RestoreDocSection restores one section from a retained revision and records a normal follow-up
 * revision. The current document path is not changed.
 */
export async function restoreDocSection(
  ctx: HistoryContext,
  path: string,
  revisionId: string,
  section: string,
  opts: DocRevisionOptions = {},
): Promise<Doc> {
  const current = await ctx.docs.get(path);
  if (goTrimSpace(section) === "")
    section = await ctx.versions.sectionForRevision(path, revisionId);
  const historical = await ctx.versions.resolveDocState(path, revisionId);
  const historicalSection = findMarkdownSection(historical.content, section);
  if (!historicalSection)
    throw new Error(`section "${section}" not found in revision ${revisionId}`);
  const restoredContent = replaceMarkdownSection(
    current.content ?? "",
    section,
    historicalSection.text,
  );
  if (!restoredContent.replaced) throw new Error(`section "${section}" not found in current doc`);
  const oldDoc: Doc = { ...current };
  const restored: Doc = { ...current, content: restoredContent.content, updatedAt: goNow() };
  await mutateDocWithHistory(ctx, oldDoc, restored, {
    actor: opts.actor || "restore",
    source: opts.source || "restore",
    section: firstNonEmpty(opts.section, section),
    expectedHash: opts.expectedHash,
  });
  return restored;
}

/**
 * RestoreDoc restores content and metadata from a retained revision while keeping the current
 * path stable. It records a normal follow-up revision.
 */
export async function restoreDoc(
  ctx: HistoryContext,
  path: string,
  revisionId: string,
  opts: DocRevisionOptions = {},
): Promise<Doc> {
  const current = await ctx.docs.get(path);
  const historical = await ctx.versions.resolveDocState(path, revisionId);
  const oldDoc: Doc = { ...current };
  const restored: Doc = {
    ...current,
    title: historical.title,
    description: historical.description === "" ? undefined : historical.description,
    tags: historical.tags && historical.tags.length > 0 ? [...historical.tags] : undefined,
    content: historical.content,
    updatedAt: goNow(),
  };
  await mutateDocWithHistory(ctx, oldDoc, restored, {
    actor: opts.actor || "restore",
    source: opts.source || "restore",
    expectedHash: opts.expectedHash,
  });
  return restored;
}
