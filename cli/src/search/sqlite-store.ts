// Port of internal/search/sqlite_vecstore.go: the legacy per-project
// `.search/index.db` the Go binary builds with `search --reindex` and the in-process indexer.
// Same schema, same metadata keys, same content-hash table, so a 0.34.x binary reads what this
// writes, and the `sqlite` vector backend (and the legacy fallback of a Qdrant project with no
// pointer yet) searches it.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CHUNK_VERSION,
  type Chunk,
  type ScoredChunk,
  type VectorSearchOpts,
  type VectorStore,
} from "./types.ts";

/** CosineSimilarity (cosine.go): float64 accumulation over float32 inputs. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export interface TaskVectorMutation {
  taskId: string;
  chunks?: Chunk[];
  hash?: string;
  delete?: boolean;
  expectedHash?: string;
  checkHash?: boolean;
}

/** The slice of Go's VectorStore the index writers use. */
export interface WritableVectorStore {
  model(): string;
  clear(): void;
  addChunks(chunks: Chunk[]): void;
  removeByPrefix(prefix: string): void;
  save(): void;
  count(): number;
  needsRebuild(model: string): boolean;
  getContentHash(sourceId: string): string;
  setContentHash(sourceId: string, hash: string): void;
  deleteContentHash(sourceId: string): void;
  listContentHashes(): Map<string, string>;
  close(): void;
  /** SQLite only: Task rows are committed separately under the lifecycle lock. */
  saveNonTaskSources?(): void;
  applyTaskMutations?(mutations: TaskVectorMutation[]): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    token_count     INTEGER DEFAULT 0,
    embedding       BLOB,

    doc_path        TEXT,
    section         TEXT,
    heading_level   INTEGER,
    header_path     TEXT,
    position        INTEGER,

	    task_id         TEXT,
	    field           TEXT,
	    status          TEXT,
	    priority        TEXT,
	    labels          TEXT,

	    memory_id       TEXT,
	    memory_layer    TEXT,
	    memory_store    TEXT,
	    decision_id     TEXT,

	    name            TEXT,
	    signature       TEXT,
	    visibility      TEXT,
	    detail          TEXT
);

CREATE TABLE IF NOT EXISTS content_hashes (
    source_id TEXT PRIMARY KEY,
    hash      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(type);
CREATE INDEX IF NOT EXISTS idx_chunks_doc_path ON chunks(doc_path);
CREATE INDEX IF NOT EXISTS idx_chunks_task_id ON chunks(task_id);
CREATE TABLE IF NOT EXISTS code_file_hashes (
    file_path    TEXT PRIMARY KEY,
    file_hash    TEXT NOT NULL,
    chunk_hashes TEXT NOT NULL DEFAULT '{}',
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const nullStr = (s: string | undefined): string | null => (s ? s : null);
const nullInt = (n: number | undefined): number | null => (n ? n : null);

/** time.Now().Format(time.RFC3339) in local time. */
function rfc3339Local(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const zone =
    off === 0
      ? "Z"
      : `${off > 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${zone}`;
}

interface Row {
  id: string;
  type: string;
  content: string | null;
  token_count: number | null;
  embedding: Uint8Array | null;
  doc_path: string | null;
  section: string | null;
  heading_level: number | null;
  header_path: string | null;
  position: number | null;
  task_id: string | null;
  field: string | null;
  status: string | null;
  priority: string | null;
  labels: string | null;
  memory_id: string | null;
  memory_layer: string | null;
  memory_store: string | null;
  decision_id: string | null;
  name: string | null;
  signature: string | null;
  visibility: string | null;
  detail: string | null;
}

export class SQLiteVectorStore implements WritableVectorStore, VectorStore {
  private db: Database | undefined;
  private chunks: Chunk[] = [];

  constructor(
    private readonly dir: string,
    private readonly modelName: string,
    private readonly dimensions: number,
  ) {}

  dbPath(): string {
    return join(this.dir, "index.db");
  }

  load(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o755 });
    let db: Database;
    try {
      db = new Database(this.dbPath(), { create: true });
      db.run("PRAGMA journal_mode=WAL");
      db.run("PRAGMA busy_timeout=5000");
    } catch (err) {
      throw new Error(`sqlite vecstore: open: ${(err as Error).message}`);
    }
    this.db = db;
    try {
      this.createSchema();
    } catch (err) {
      db.close();
      this.db = undefined;
      throw new Error(`sqlite vecstore: schema: ${(err as Error).message}`);
    }
    try {
      this.loadIntoMemory();
    } catch (err) {
      db.close();
      this.db = undefined;
      throw new Error(`sqlite vecstore: load: ${(err as Error).message}`);
    }
  }

  private conn(): Database {
    if (!this.db) throw new Error("sqlite vecstore: not loaded");
    return this.db;
  }

  private createSchema(): void {
    const db = this.conn();
    const hasCol = (col: string): number =>
      (
        db.query("SELECT COUNT(*) AS n FROM pragma_table_info('chunks') WHERE name=?").get(col) as {
          n: number;
        }
      ).n;
    const tableCols = (
      db.query("SELECT COUNT(*) AS n FROM pragma_table_info('chunks')").get() as { n: number }
    ).n;
    if (tableCols > 0 && hasCol("embedding") === 0) db.run("DROP TABLE IF EXISTS chunks");
    if (hasCol("header_path") === 0 && hasCol("parent_section") > 0)
      db.run("DROP TABLE IF EXISTS chunks");
    for (const col of ["memory_id", "memory_layer", "memory_store", "decision_id"]) {
      if (tableCols > 0 && hasCol(col) === 0) {
        try {
          db.run(`ALTER TABLE chunks ADD COLUMN ${col} TEXT`);
        } catch {
          // the CREATE TABLE below handles a missing table
        }
      }
    }
    db.exec(SCHEMA);
    db.run(`UPDATE chunks
		   SET memory_id = substr(id, 8, instr(substr(id, 8), ':') - 1)
		 WHERE type = 'memory'
		   AND (memory_id IS NULL OR memory_id = '')
		   AND id LIKE 'memory:%:%'`);
    db.exec("DROP TABLE IF EXISTS code_symbols; DROP TABLE IF EXISTS code_edges;");
    for (const col of ["name", "signature", "visibility", "detail"]) {
      if (hasCol(col) === 0) {
        try {
          db.run(`ALTER TABLE chunks ADD COLUMN ${col} TEXT`);
        } catch {
          // ignore
        }
      }
    }
  }

  private loadIntoMemory(): void {
    const rows = this.conn()
      .query(
        `SELECT id, type, content, token_count, embedding,
		       doc_path, section, heading_level, header_path, position,
		       task_id, field, status, priority, labels,
		       COALESCE(memory_id, '') AS memory_id, COALESCE(memory_layer, '') AS memory_layer,
		       COALESCE(memory_store, '') AS memory_store, COALESCE(decision_id, '') AS decision_id,
		       COALESCE(name, '') AS name, COALESCE(signature, '') AS signature,
		       COALESCE(visibility, '') AS visibility, COALESCE(detail, '') AS detail
		FROM chunks`,
      )
      .all() as Row[];
    this.chunks = rows.map((r) => {
      const c: Chunk = {
        id: r.id,
        type: r.type as Chunk["type"],
        content: r.content ?? "",
        tokenCount: r.token_count ?? 0,
      };
      if (r.embedding && r.embedding.byteLength > 0) {
        const copy = new Uint8Array(r.embedding);
        c.embedding = new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
      }
      const set = <K extends keyof Chunk>(k: K, v: Chunk[K] | null | undefined | "" | 0) => {
        if (v) c[k] = v as Chunk[K];
      };
      set("docPath", r.doc_path);
      set("section", r.section);
      set("headingLevel", r.heading_level);
      set("headerPath", r.header_path);
      set("position", r.position);
      set("taskId", r.task_id);
      set("field", r.field);
      set("status", r.status);
      set("priority", r.priority);
      set("memoryId", r.memory_id);
      set("memoryLayer", r.memory_layer);
      set("memoryStore", r.memory_store);
      set("decisionId", r.decision_id);
      set("name", r.name);
      set("signature", r.signature);
      set("visibility", r.visibility);
      set("detail", r.detail);
      if (r.labels) {
        try {
          c.labels = JSON.parse(r.labels) as string[];
        } catch {
          // ignore
        }
      }
      return c;
    });
  }

  private insertChunk(chunk: Chunk): void {
    const emb = chunk.embedding;
    if (
      (emb?.length ?? 0) !== this.dimensions &&
      (chunk.type !== "code" || (emb?.length ?? 0) !== 0)
    ) {
      throw new Error(
        `sqlite vecstore: chunk "${chunk.id}" embedding dimensions = ${emb?.length ?? 0}, want ${this.dimensions}`,
      );
    }
    const blob =
      emb && emb.length === this.dimensions
        ? new Uint8Array(emb.buffer, emb.byteOffset, emb.byteLength)
        : null;
    this.conn()
      .query(
        `INSERT OR REPLACE INTO chunks (id, type, content, token_count, embedding,
		    doc_path, section, heading_level, header_path, position,
		    task_id, field, status, priority, labels,
		    memory_id, memory_layer, memory_store, decision_id,
		    name, signature, visibility, detail)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chunk.id,
        chunk.type,
        chunk.content,
        chunk.tokenCount,
        blob,
        nullStr(chunk.docPath),
        nullStr(chunk.section),
        nullInt(chunk.headingLevel),
        nullStr(chunk.headerPath),
        nullInt(chunk.position),
        nullStr(chunk.taskId),
        nullStr(chunk.field),
        nullStr(chunk.status),
        nullStr(chunk.priority),
        chunk.labels && chunk.labels.length > 0 ? JSON.stringify(chunk.labels) : null,
        nullStr(chunk.memoryId),
        nullStr(chunk.memoryLayer),
        nullStr(chunk.memoryStore),
        nullStr(chunk.decisionId),
        nullStr(chunk.name),
        nullStr(chunk.signature),
        nullStr(chunk.visibility),
        nullStr(chunk.detail),
      );
  }

  private writeMetadata(chunkCount: number): void {
    const meta: [string, string][] = [
      ["model", this.modelName],
      ["dimensions", String(this.dimensions)],
      ["indexedAt", rfc3339Local()],
      ["chunkCount", String(chunkCount)],
      ["chunkVersion", String(CHUNK_VERSION)],
    ];
    const q = this.conn().query("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)");
    for (const [k, v] of meta) q.run(k, v);
  }

  private tx(fn: () => void): void {
    const db = this.conn();
    db.run("BEGIN");
    try {
      fn();
      db.run("COMMIT");
    } catch (err) {
      try {
        db.run("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }
  }

  save(): void {
    this.tx(() => {
      this.conn().run("DELETE FROM chunks");
      for (const c of this.chunks) this.insertChunk(c);
      this.writeMetadata(this.chunks.length);
    });
  }

  saveNonTaskSources(): void {
    this.tx(() => {
      this.conn().run("DELETE FROM chunks WHERE type <> 'task'");
      for (const c of this.chunks) if (c.type !== "task") this.insertChunk(c);
      const n = (this.conn().query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
      this.writeMetadata(n);
    });
  }

  applyTaskMutations(mutations: TaskVectorMutation[]): void {
    if (mutations.length > 0) {
      this.tx(() => {
        const db = this.conn();
        for (const m of mutations) {
          if (m.checkHash) {
            const row = db
              .query("SELECT hash FROM content_hashes WHERE source_id = ?")
              .get(`task:${m.taskId}`) as { hash: string } | null;
            if ((row?.hash ?? "") !== (m.expectedHash ?? "")) {
              throw new Error(
                `sqlite vecstore: Task "${m.taskId}" content hash changed during atomic commit`,
              );
            }
          }
          db.query("DELETE FROM chunks WHERE task_id = ?").run(m.taskId);
          const sourceId = `task:${m.taskId}`;
          if (m.delete) {
            db.query("DELETE FROM content_hashes WHERE source_id = ?").run(sourceId);
            continue;
          }
          for (const c of m.chunks ?? []) this.insertChunk(c);
          db.query("INSERT OR REPLACE INTO content_hashes (source_id, hash) VALUES (?, ?)").run(
            sourceId,
            m.hash ?? "",
          );
        }
        const n = (db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
        this.writeMetadata(n);
      });
    }
    this.loadIntoMemory();
  }

  clear(): void {
    this.chunks = [];
    if (this.db) {
      this.db.run("DELETE FROM chunks");
      this.db.run("DELETE FROM metadata");
      this.db.run("DELETE FROM content_hashes");
    }
  }

  addChunks(chunks: Chunk[]): void {
    const existing = new Set(this.chunks.map((c) => c.id));
    for (const c of chunks) {
      if (
        (c.embedding?.length ?? 0) !== this.dimensions &&
        (c.type !== "code" || (c.embedding?.length ?? 0) !== 0)
      ) {
        continue;
      }
      if (existing.has(c.id)) continue;
      this.chunks.push(c);
    }
  }

  removeByPrefix(prefix: string): void {
    this.chunks = this.chunks.filter((c) => !c.id.startsWith(prefix));
  }

  /**
   * Search: brute-force cosine over the loaded chunks (sqlite_vecstore.go Search). Go keeps every
   * vector in one flat slice and a row without an embedding keeps offset 0, so it is scored
   * against the first stored vector; that is reproduced here. Chunks added in memory after load
   * are scored against their own embedding.
   */
  async search(queryVec: Float32Array, optsIn: VectorSearchOpts): Promise<ScoredChunk[]> {
    if (queryVec.length !== this.dimensions || this.chunks.length === 0) return [];
    const topK = optsIn.topK > 0 ? optsIn.topK : 20;
    const threshold = optsIn.threshold > 0 ? optsIn.threshold : 0.3;
    const first = this.chunks.find((c) => (c.embedding?.length ?? 0) > 0)?.embedding;
    const candidates: { chunk: Chunk; score: number }[] = [];
    for (const chunk of this.chunks) {
      if (optsIn.chunkType !== "" && chunk.type !== optsIn.chunkType) continue;
      let vec = chunk.embedding && chunk.embedding.length > 0 ? chunk.embedding : first;
      if (!vec || vec.length < this.dimensions) continue;
      if (vec.length > this.dimensions) vec = vec.subarray(0, this.dimensions);
      const sim = cosineSimilarity(queryVec, vec);
      if (sim >= threshold) candidates.push({ chunk, score: sim });
    }
    // Go's sort.Slice is an insertion sort up to 12 elements (stable); beyond that ties are
    // unspecified there, and stable here.
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, topK).map(({ chunk, score }) => {
      const { embedding: _e, visibility: _v, detail: _d, ...rest } = chunk;
      return { ...rest, score };
    });
  }

  count(): number {
    return this.chunks.length;
  }

  needsRebuild(model: string): boolean {
    if (!this.db) return true;
    const stored = this.db.query("SELECT value FROM metadata WHERE key = 'model'").get() as {
      value: string;
    } | null;
    if (!stored || stored.value !== model) return true;
    const version = this.db
      .query("SELECT value FROM metadata WHERE key = 'chunkVersion'")
      .get() as {
      value: string;
    } | null;
    if (!version) return true;
    return version.value !== String(CHUNK_VERSION);
  }

  /** Stats of an index.db without keeping it open. */
  stats(): { chunkCount: number; model: string; indexedAt: string } {
    const read = (db: Database) => {
      const rows = db
        .query("SELECT key, value FROM metadata WHERE key IN ('model', 'indexedAt', 'chunkCount')")
        .all() as { key: string; value: string }[];
      let model = "";
      let indexedAt = "";
      let chunkCount = 0;
      for (const r of rows) {
        if (r.key === "model") model = r.value;
        else if (r.key === "indexedAt") indexedAt = r.value;
        else if (r.key === "chunkCount") chunkCount = Number.parseInt(r.value, 10) || 0;
      }
      return { chunkCount, model, indexedAt };
    };
    if (this.db) return read(this.db);
    try {
      const db = new Database(this.dbPath(), { readonly: true });
      try {
        return read(db);
      } finally {
        db.close();
      }
    } catch {
      return { chunkCount: 0, model: "", indexedAt: "" };
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }

  model(): string {
    return this.modelName;
  }

  getContentHash(sourceId: string): string {
    if (!this.db) return "";
    const row = this.db
      .query("SELECT hash FROM content_hashes WHERE source_id = ?")
      .get(sourceId) as {
      hash: string;
    } | null;
    return row?.hash ?? "";
  }

  setContentHash(sourceId: string, hash: string): void {
    this.db
      ?.query("INSERT OR REPLACE INTO content_hashes (source_id, hash) VALUES (?, ?)")
      .run(sourceId, hash);
  }

  deleteContentHash(sourceId: string): void {
    this.db?.query("DELETE FROM content_hashes WHERE source_id = ?").run(sourceId);
  }

  listContentHashes(): Map<string, string> {
    const out = new Map<string, string>();
    if (!this.db) return out;
    for (const r of this.db.query("SELECT source_id, hash FROM content_hashes").all() as {
      source_id: string;
      hash: string;
    }[]) {
      out.set(r.source_id, r.hash);
    }
    return out;
  }
}
