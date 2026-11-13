// Port of internal/search/index.go: IndexService chunks, embeds and stores vectors for tasks,
// docs, memories and decisions, skipping unchanged sources by content hash. It writes to any
// WritableVectorStore: the legacy SQLite index (atomic Task commits under the lifecycle lock) or
// the in-memory stage the Qdrant generation builder drains into a new collection.

import { decisionCurrentForDefaultRetrieval } from "../../models/decision.ts";
import type { MemoryEntry } from "../../models/memory.ts";
import { memoryCurrentForDefaultRetrieval } from "../../models/memory.ts";
import type { Task } from "../../models/task.ts";
import { chunkDecision, chunkDocument, chunkMemory, chunkTask } from "../../search/chunker.ts";
import { contentHash, decisionContentForHash, taskContentForHash } from "../../search/hash.ts";
import type { TaskVectorMutation, WritableVectorStore } from "../../search/sqlite-store.ts";
import type { Chunk, EmbedderProvider } from "../../search/types.ts";
import type { Storage } from "../../storage/adapters.ts";
import { globalSemanticStoreRoot } from "../../storage/core/store.ts";
import { withTaskLifecycleTransaction } from "../../storage/history/lifecycle-tx.ts";

export type ReindexProgress = (phase: string, current: number, total: number) => void;

function embedBatchSize(total: number): number {
  const DEFAULT = 16;
  if (total <= 0) return DEFAULT;
  let batch = DEFAULT;
  const raw = process.env.KNOWNS_EMBED_BATCH_SIZE;
  if (raw !== undefined && raw !== "" && /^[+-]?\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed > 0) batch = parsed;
  }
  return Math.min(batch, total);
}

/** Embeds in batches; a failed batch falls back to one by one and a failed chunk is skipped. */
export async function embedChunks(embedder: EmbedderProvider, chunks: Chunk[]): Promise<Chunk[]> {
  if (chunks.length === 0) return chunks;
  const batch = embedBatchSize(chunks.length);
  const texts = chunks.map((c) => c.content);
  for (let start = 0; start < chunks.length; start += batch) {
    const end = Math.min(start + batch, chunks.length);
    let vecs: Float32Array[] | undefined;
    try {
      vecs = await embedder.embedDocumentBatch(texts.slice(start, end));
    } catch {
      vecs = undefined;
    }
    if (!vecs || vecs.length !== end - start) {
      for (let i = start; i < end; i++) {
        try {
          (chunks[i] as Chunk).embedding = await embedder.embedDocument(
            (chunks[i] as Chunk).content,
          );
        } catch {
          // skip failed chunks
        }
      }
      continue;
    }
    for (let i = start; i < end; i++) (chunks[i] as Chunk).embedding = vecs[i - start];
  }
  return chunks;
}

function allTasksForIndex(storage: Storage): Task[] {
  const byId = new Map<string, Task>();
  for (const t of storage.tasks.listArchived()) byId.set(t.id, t);
  for (const t of storage.tasks.listActive()) byId.set(t.id, t);
  return [...byId.values()];
}

export class IndexService {
  constructor(
    private readonly storage: Storage,
    private readonly embedder: EmbedderProvider,
    private readonly vec: WritableVectorStore,
  ) {}

  private maxTokens(): number {
    const cfg = this.embedder.modelConfig();
    return cfg.maxTokens > 0 ? cfg.maxTokens : 512;
  }

  private tx<T>(
    fn: (tx: Parameters<Parameters<typeof withTaskLifecycleTransaction>[1]>[0]) => Promise<T> | T,
  ) {
    return withTaskLifecycleTransaction(this.storage.ctx, fn);
  }

  private async embedTask(task: Task): Promise<Chunk[]> {
    return embedChunks(
      this.embedder,
      chunkTask(task, this.maxTokens(), this.embedder.getTokenizer()).chunks,
    );
  }

  private async embedAndStore(chunks: Chunk[]): Promise<void> {
    this.vec.addChunks(await embedChunks(this.embedder, chunks));
  }

  private memoryEntries(): MemoryEntry[] {
    const mem = this.storage.memory;
    const list =
      this.storage.store.root === globalSemanticStoreRoot()
        ? mem.listGlobalOnly()
        : mem.listLocal();
    return list.filter(memoryCurrentForDefaultRetrieval);
  }

  private memoryEntry(id: string): MemoryEntry {
    const mem = this.storage.memory;
    if (this.storage.store.root === globalSemanticStoreRoot()) return mem.getInLayer(id, "global");
    try {
      return mem.getInLayer(id, "project");
    } catch {
      return mem.getInLayer(id, "global");
    }
  }

  /** Reindex: re-indexes everything, skipping unchanged sources via content hashes. */
  async reindex(progress?: ReindexProgress): Promise<void> {
    const vec = this.vec;
    const storage = this.storage;
    if (vec.needsRebuild(vec.model())) {
      try {
        await this.tx(() => vec.clear());
      } catch (err) {
        throw new Error(`clear vecstore: ${(err as Error).message}`);
      }
    }
    const tasks = allTasksForIndex(storage);
    const allDocs = storage.docs.list();
    const decisions = storage.decisions.list();
    const docs = allDocs.filter((d) => !d.isImported);
    const importedDocs = allDocs.filter((d) => d.isImported);
    const currentIds = new Set<string>();
    const candidates = new Map<string, { hash: string; chunks: Chunk[]; unchanged: boolean }>();
    const maxTokens = this.maxTokens();
    const tok = this.embedder.getTokenizer();

    for (const [i, task] of tasks.entries()) {
      progress?.("tasks", i + 1, tasks.length);
      const hash = contentHash(taskContentForHash(task));
      if (vec.getContentHash(`task:${task.id}`) === hash) {
        candidates.set(task.id, { hash, chunks: [], unchanged: true });
        continue;
      }
      try {
        candidates.set(task.id, { hash, chunks: await this.embedTask(task), unchanged: false });
      } catch {
        // non-fatal
      }
    }

    const indexDocs = async (list: typeof docs, phase: string) => {
      for (const [i, doc] of list.entries()) {
        progress?.(phase, i + 1, list.length);
        const sourceId = `doc:${doc.path}`;
        currentIds.add(sourceId);
        let full: ReturnType<Storage["docs"]["get"]>;
        try {
          full = storage.docs.get(doc.path);
        } catch {
          continue;
        }
        const hash = contentHash(`${full.title}\n${full.description ?? ""}\n${full.content ?? ""}`);
        if (vec.getContentHash(sourceId) === hash) continue;
        vec.removeByPrefix(`doc:${doc.path}:`);
        await this.embedAndStore(
          chunkDocument(
            full.content ?? "",
            full.path,
            full.title,
            full.description ?? "",
            maxTokens,
            tok,
          ).chunks,
        );
        vec.setContentHash(sourceId, hash);
      }
    };
    await indexDocs(docs, "docs");
    await indexDocs(importedDocs, "imports");

    let memories: MemoryEntry[] = [];
    try {
      memories = this.memoryEntries();
    } catch {
      memories = [];
    }
    for (const [i, entry] of memories.entries()) {
      progress?.("memories", i + 1, memories.length);
      const sourceId = `memory:${entry.id}`;
      currentIds.add(sourceId);
      const hash = contentHash(`${entry.title}\n${entry.category}\n${entry.content}`);
      if (vec.getContentHash(sourceId) === hash) continue;
      vec.removeByPrefix(`memory:${entry.id}:`);
      await this.embedAndStore(chunkMemory(entry, maxTokens, tok).chunks);
      vec.setContentHash(sourceId, hash);
    }

    for (const [i, decision] of decisions.entries()) {
      progress?.("decisions", i + 1, decisions.length);
      const sourceId = `decision:${decision.id}`;
      if (!decisionCurrentForDefaultRetrieval(decision)) {
        vec.removeByPrefix(`decision:${decision.id}:`);
        continue;
      }
      currentIds.add(sourceId);
      const hash = contentHash(decisionContentForHash(decision));
      if (vec.getContentHash(sourceId) === hash) continue;
      vec.removeByPrefix(`decision:${decision.id}:`);
      await this.embedAndStore(chunkDecision(decision, maxTokens, tok).chunks);
      vec.setContentHash(sourceId, hash);
    }

    await this.tx(async (tx) => {
      const atomic = vec.applyTaskMutations !== undefined && vec.saveNonTaskSources !== undefined;
      const mutations = new Map<string, TaskVectorMutation>();
      const deleteTaskSource = (taskId: string, expectedHash: string, checkHash: boolean) => {
        if (atomic) {
          mutations.set(taskId, { taskId, delete: true, expectedHash, checkHash });
          return;
        }
        vec.removeByPrefix(`task:${taskId}:`);
        vec.deleteContentHash(`task:${taskId}`);
      };
      const finalMap = new Map<string, Task>();
      for (const t of await tx.listArchivedTasks()) finalMap.set(t.id, t);
      for (const t of await tx.listActiveTasks()) finalMap.set(t.id, t);
      const finalById = new Map<string, Task>();
      for (const task of finalMap.values()) {
        if (await tx.isIdReserved(task.id)) continue;
        finalById.set(task.id, task);
        currentIds.add(`task:${task.id}`);
      }
      for (const [taskId, candidate] of candidates) {
        const sourceId = `task:${taskId}`;
        const canonical = finalById.get(taskId);
        if (!canonical) {
          deleteTaskSource(taskId, "", false);
          continue;
        }
        const finalHash = contentHash(taskContentForHash(canonical));
        if (finalHash !== candidate.hash) {
          const live = vec.getContentHash(sourceId);
          if (live !== finalHash) deleteTaskSource(taskId, live, true);
          continue;
        }
        const live = vec.getContentHash(sourceId);
        if (live === candidate.hash) continue;
        if (candidate.unchanged) {
          deleteTaskSource(taskId, live, true);
          continue;
        }
        if (atomic) {
          mutations.set(taskId, {
            taskId,
            chunks: candidate.chunks,
            hash: candidate.hash,
            expectedHash: live,
            checkHash: true,
          });
          continue;
        }
        vec.removeByPrefix(`${sourceId}:`);
        vec.addChunks(candidate.chunks);
        vec.setContentHash(sourceId, candidate.hash);
      }
      for (const id of vec.listContentHashes().keys()) {
        if (currentIds.has(id)) continue;
        if (atomic && id.startsWith("task:")) {
          deleteTaskSource(id.slice("task:".length), "", false);
          continue;
        }
        vec.removeByPrefix(`${id}:`);
        vec.deleteContentHash(id);
      }
      if (atomic) {
        (vec.saveNonTaskSources as () => void)();
        const list = [...mutations.values()].sort((a, b) =>
          a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0,
        );
        (vec.applyTaskMutations as (m: TaskVectorMutation[]) => void)(list);
        return;
      }
      vec.save();
    });
  }

  async indexTask(taskId: string): Promise<void> {
    const task = this.storage.tasks.get(taskId);
    const hash = contentHash(taskContentForHash(task));
    const chunks = await this.embedTask(task);
    const vec = this.vec;
    await this.tx(async (tx) => {
      const atomic = vec.applyTaskMutations !== undefined;
      const apply = (m: TaskVectorMutation[]) =>
        (vec.applyTaskMutations as (m: TaskVectorMutation[]) => void)(m);
      let canonical: Task | undefined;
      let canonicalErr: Error | undefined;
      try {
        canonical = await tx.getTask(taskId);
      } catch (err) {
        canonicalErr = err as Error;
      }
      const reserved = await tx.isIdReserved(taskId);
      const sourceId = `task:${taskId}`;
      if (canonicalErr || reserved || !canonical) {
        if (atomic) apply([{ taskId, delete: true }]);
        else {
          vec.removeByPrefix(`${sourceId}:`);
          vec.deleteContentHash(sourceId);
          vec.save();
        }
        if (reserved) return;
        throw new Error(
          `revalidate Task "${taskId}" before index commit: ${canonicalErr?.message}`,
        );
      }
      const finalHash = contentHash(taskContentForHash(canonical));
      if (finalHash !== hash) {
        const live = vec.getContentHash(sourceId);
        if (live === finalHash) {
          if (atomic) apply([]);
          return;
        }
        if (atomic) apply([{ taskId, delete: true, expectedHash: live, checkHash: true }]);
        else {
          vec.removeByPrefix(`${sourceId}:`);
          vec.deleteContentHash(sourceId);
          vec.save();
        }
        throw new Error(`Task "${taskId}" changed during semantic indexing; retry`);
      }
      if (atomic) {
        apply([
          { taskId, chunks, hash, expectedHash: vec.getContentHash(sourceId), checkHash: true },
        ]);
        return;
      }
      vec.removeByPrefix(`${sourceId}:`);
      vec.addChunks(chunks);
      vec.setContentHash(sourceId, hash);
      vec.save();
    });
  }

  async indexDoc(docPath: string): Promise<void> {
    this.vec.removeByPrefix(`doc:${docPath}:`);
    const doc = this.storage.docs.get(docPath);
    await this.embedAndStore(
      chunkDocument(
        doc.content ?? "",
        doc.path,
        doc.title,
        doc.description ?? "",
        this.maxTokens(),
        this.embedder.getTokenizer(),
      ).chunks,
    );
    this.vec.save();
  }

  async removeTask(taskId: string): Promise<void> {
    await this.tx(() => {
      if (this.vec.applyTaskMutations) {
        this.vec.applyTaskMutations([{ taskId, delete: true }]);
        return;
      }
      this.vec.removeByPrefix(`task:${taskId}:`);
      this.vec.deleteContentHash(`task:${taskId}`);
      this.vec.save();
    });
  }

  removeDoc(docPath: string): void {
    this.vec.removeByPrefix(`doc:${docPath}:`);
    this.vec.save();
  }

  async indexMemory(memoryId: string): Promise<void> {
    this.vec.removeByPrefix(`memory:${memoryId}:`);
    const entry = this.memoryEntry(memoryId);
    if (!memoryCurrentForDefaultRetrieval(entry)) {
      this.vec.save();
      return;
    }
    await this.embedAndStore(
      chunkMemory(entry, this.maxTokens(), this.embedder.getTokenizer()).chunks,
    );
    this.vec.save();
  }

  removeMemory(memoryId: string): void {
    this.vec.removeByPrefix(`memory:${memoryId}:`);
    this.vec.save();
  }

  async indexDecision(decisionId: string): Promise<void> {
    this.vec.removeByPrefix(`decision:${decisionId}:`);
    const decision = this.storage.decisions.get(decisionId);
    if (!decisionCurrentForDefaultRetrieval(decision)) {
      this.vec.save();
      return;
    }
    await this.embedAndStore(
      chunkDecision(decision, this.maxTokens(), this.embedder.getTokenizer()).chunks,
    );
    this.vec.save();
  }

  removeDecision(decisionId: string): void {
    this.vec.removeByPrefix(`decision:${decisionId}:`);
    this.vec.save();
  }
}
