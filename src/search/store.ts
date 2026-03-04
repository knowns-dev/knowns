/**
 * SQLite-based Search Index Store
 * Uses better-sqlite3 + sqlite-vec for native vector search
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Chunk, DocChunk, EmbeddingModel, TaskChunk } from "./types";
import { EMBEDDING_MODELS } from "./types";

/**
 * Version info stored in metadata table
 */
export interface IndexVersion {
	model: EmbeddingModel;
	modelVersion: string;
	dimensions: number;
	indexedAt: string;
	itemCount: number;
	chunkCount: number;
}

/**
 * Search result with score
 */
export interface SearchResult {
	chunk: Chunk;
	score: number;
}

/**
 * SQLite Search Index Store with native vector search
 */
export class SearchStore {
	private db: Database.Database;
	private model: EmbeddingModel;
	private dimensions: number;
	private dbPath: string;

	constructor(projectRoot: string, model: EmbeddingModel = "gte-small") {
		this.model = model;
		this.dimensions = EMBEDDING_MODELS[model]?.dimensions || 384;
		this.dbPath = join(projectRoot, ".knowns", ".search", "index.db");

		// Ensure directory exists
		const dir = dirname(this.dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Open database
		this.db = new Database(this.dbPath);
		this.db.pragma("journal_mode = WAL");

		// Load sqlite-vec extension
		sqliteVec.load(this.db);

		// Initialize schema
		this.initSchema();
	}

	/**
	 * Initialize database schema with vec0 virtual table
	 */
	private initSchema(): void {
		// Metadata table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS metadata (
				key TEXT PRIMARY KEY,
				value TEXT
			);
		`);

		// Chunks metadata table with vec_rowid to link with vec_chunks
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS chunks (
				id TEXT PRIMARY KEY,
				vec_rowid INTEGER,
				type TEXT NOT NULL,
				content TEXT NOT NULL,
				token_count INTEGER NOT NULL,
				doc_path TEXT,
				section TEXT,
				heading_level INTEGER,
				parent_section TEXT,
				position INTEGER,
				task_id TEXT,
				field TEXT,
				status TEXT,
				priority TEXT,
				labels TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(type);
			CREATE INDEX IF NOT EXISTS idx_chunks_doc_path ON chunks(doc_path);
			CREATE INDEX IF NOT EXISTS idx_chunks_task_id ON chunks(task_id);
			CREATE INDEX IF NOT EXISTS idx_chunks_vec_rowid ON chunks(vec_rowid);
		`);

		// Vector table using sqlite-vec (auto rowid)
		this.db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
				embedding float[${this.dimensions}]
			);
		`);

		// Set initial metadata if not exists
		const version = this.getVersion();
		if (!version) {
			this.setMetadata("model", this.model);
			this.setMetadata("dimensions", String(this.dimensions));
			this.setMetadata("modelVersion", "1.0.0");
		}
	}

	/**
	 * Set metadata value
	 */
	private setMetadata(key: string, value: string): void {
		this.db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(key, value);
	}

	/**
	 * Get metadata value
	 */
	private getMetadata(key: string): string | null {
		const row = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
		return row?.value ?? null;
	}

	/**
	 * Get current index version
	 */
	getVersion(): IndexVersion | null {
		const model = this.getMetadata("model");
		if (!model) return null;

		const count = this.db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number };

		return {
			model: model as EmbeddingModel,
			modelVersion: this.getMetadata("modelVersion") || "1.0.0",
			dimensions: Number.parseInt(this.getMetadata("dimensions") || "384", 10),
			indexedAt: this.getMetadata("indexedAt") || new Date().toISOString(),
			itemCount: this.countUniqueItems(),
			chunkCount: count.count,
		};
	}

	/**
	 * Check if index exists and has data
	 */
	indexExists(): boolean {
		const count = this.db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number };
		return count.count > 0;
	}

	/**
	 * Check if rebuild needed (model changed)
	 */
	needsRebuild(): boolean {
		const storedModel = this.getMetadata("model");
		if (!storedModel) return false;
		return storedModel !== this.model;
	}

	/**
	 * Serialize embedding to binary buffer for sqlite-vec
	 */
	private serializeEmbedding(embedding: number[]): Buffer {
		const float32 = new Float32Array(embedding);
		return Buffer.from(float32.buffer);
	}

	/**
	 * Deserialize embedding from binary
	 */
	private deserializeEmbedding(buffer: Buffer): number[] {
		const float32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
		return Array.from(float32);
	}

	/**
	 * Add chunks to index
	 */
	addChunks(chunks: Chunk[]): void {
		// Delete existing chunk by id first (for update)
		const getVecRowid = this.db.prepare("SELECT vec_rowid FROM chunks WHERE id = ?");
		const deleteVec = this.db.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
		const deleteChunk = this.db.prepare("DELETE FROM chunks WHERE id = ?");

		const insertVec = this.db.prepare("INSERT INTO vec_chunks (embedding) VALUES (?)");

		const insertChunk = this.db.prepare(`
			INSERT INTO chunks
			(id, vec_rowid, type, content, token_count, doc_path, section, heading_level, parent_section, position,
			 task_id, field, status, priority, labels)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const insertMany = this.db.transaction((chunks: Chunk[]) => {
			for (const chunk of chunks) {
				if (!chunk.embedding) continue;

				// Delete existing if any
				const existing = getVecRowid.get(chunk.id) as { vec_rowid: number } | undefined;
				if (existing?.vec_rowid) {
					deleteVec.run(existing.vec_rowid);
				}
				deleteChunk.run(chunk.id);

				const embeddingBlob = this.serializeEmbedding(chunk.embedding);

				// Insert vector first to get auto rowid
				const vecResult = insertVec.run(embeddingBlob);
				const vecRowid = vecResult.lastInsertRowid;

				// Then insert chunk with vec_rowid reference
				if (chunk.type === "doc") {
					const docChunk = chunk as DocChunk;
					insertChunk.run(
						chunk.id,
						vecRowid,
						"doc",
						chunk.content,
						chunk.tokenCount,
						docChunk.docPath,
						docChunk.section,
						docChunk.metadata.headingLevel,
						docChunk.metadata.parentSection || null,
						docChunk.metadata.position,
						null,
						null,
						null,
						null,
						null,
					);
				} else {
					const taskChunk = chunk as TaskChunk;
					insertChunk.run(
						chunk.id,
						vecRowid,
						"task",
						chunk.content,
						chunk.tokenCount,
						null,
						null,
						null,
						null,
						null,
						taskChunk.taskId,
						taskChunk.field,
						taskChunk.metadata.status,
						taskChunk.metadata.priority,
						JSON.stringify(taskChunk.metadata.labels),
					);
				}
			}
		});

		insertMany(chunks);

		// Update metadata
		this.setMetadata("indexedAt", new Date().toISOString());
	}

	/**
	 * Remove chunks by ID prefix
	 */
	removeChunks(idPrefix: string): void {
		// Remove from both tables - delete vec_chunks first using vec_rowid from chunks
		const rowids = this.db
			.prepare("SELECT vec_rowid FROM chunks WHERE id LIKE ? AND vec_rowid IS NOT NULL")
			.all(`${idPrefix}%`) as Array<{ vec_rowid: number }>;
		for (const { vec_rowid } of rowids) {
			this.db.prepare("DELETE FROM vec_chunks WHERE rowid = ?").run(vec_rowid);
		}
		this.db.prepare("DELETE FROM chunks WHERE id LIKE ?").run(`${idPrefix}%`);
	}

	/**
	 * Search for similar chunks using sqlite-vec native vector search
	 * SECURITY FIX: Use parameterized queries to prevent SQL injection
	 */
	search(
		queryEmbedding: number[],
		options: {
			type?: "doc" | "task" | "all";
			limit?: number;
			minScore?: number;
		} = {},
	): SearchResult[] {
		const { type = "all", limit = 20, minScore = 0.3 } = options;

		const embeddingBlob = this.serializeEmbedding(queryEmbedding);

		// Use sqlite-vec MATCH for vector search with k constraint
		// vec_chunks returns distance (lower = more similar), we convert to score
		// Note: sqlite-vec requires k = ? in WHERE clause for KNN queries
		const k = limit * 2;

		let sql = `
			SELECT
				v.rowid as vec_rowid,
				v.distance,
				c.*
			FROM vec_chunks v
			JOIN chunks c ON c.vec_rowid = v.rowid
			WHERE v.embedding MATCH ? AND k = ${k}
		`;

		const params: unknown[] = [embeddingBlob];

		if (type !== "all") {
			sql += " AND c.type = ?";
			params.push(type);
		}

		sql += `
			ORDER BY v.distance
		`;

		const rows = this.db.prepare(sql).all(...params) as Array<{
			vec_rowid: number;
			distance: number;
			id: string;
			type: string;
			content: string;
			token_count: number;
			doc_path: string | null;
			section: string | null;
			heading_level: number | null;
			parent_section: string | null;
			position: number | null;
			task_id: string | null;
			field: string | null;
			status: string | null;
			priority: string | null;
			labels: string | null;
		}>;

		const results: SearchResult[] = [];

		for (const row of rows) {
			// Convert distance to similarity score (1 - distance for cosine)
			// sqlite-vec uses L2 distance by default, normalize to 0-1 score
			const score = 1 / (1 + row.distance);

			if (score >= minScore) {
				const chunk = this.rowToChunk(row);
				results.push({ chunk, score });
			}
		}

		return results.slice(0, limit);
	}

	/**
	 * Convert database row to Chunk object
	 */
	private rowToChunk(row: {
		id: string;
		type: string;
		content: string;
		token_count: number;
		doc_path: string | null;
		section: string | null;
		heading_level: number | null;
		parent_section: string | null;
		position: number | null;
		task_id: string | null;
		field: string | null;
		status: string | null;
		priority: string | null;
		labels: string | null;
	}): Chunk {
		if (row.type === "doc") {
			return {
				id: row.id,
				type: "doc",
				docPath: row.doc_path || "",
				section: row.section || "",
				content: row.content,
				tokenCount: row.token_count,
				metadata: {
					headingLevel: row.heading_level || 1,
					parentSection: row.parent_section || undefined,
					position: row.position || 0,
				},
			} as DocChunk;
		}

		return {
			id: row.id,
			type: "task",
			taskId: row.task_id || "",
			field: (row.field || "description") as TaskChunk["field"],
			content: row.content,
			tokenCount: row.token_count,
			metadata: {
				status: row.status || "todo",
				priority: row.priority || "medium",
				labels: row.labels ? JSON.parse(row.labels) : [],
			},
		} as TaskChunk;
	}

	/**
	 * Get all chunks (for keyword search fallback)
	 * SECURITY FIX: Use parameterized queries to prevent SQL injection
	 */
	getAllChunks(type?: "doc" | "task"): Chunk[] {
		let sql = "SELECT * FROM chunks";
		const params: unknown[] = [];

		if (type) {
			sql += " WHERE type = ?";
			params.push(type);
		}

		const rows = this.db.prepare(sql).all(...params) as Array<{
			id: string;
			type: string;
			content: string;
			token_count: number;
			doc_path: string | null;
			section: string | null;
			heading_level: number | null;
			parent_section: string | null;
			position: number | null;
			task_id: string | null;
			field: string | null;
			status: string | null;
			priority: string | null;
			labels: string | null;
		}>;

		return rows.map((row) => this.rowToChunk(row));
	}

	/**
	 * Count chunks
	 * SECURITY FIX: Use parameterized queries to prevent SQL injection
	 */
	count(type?: "doc" | "task"): number {
		let sql = "SELECT COUNT(*) as count FROM chunks";
		const params: unknown[] = [];

		if (type) {
			sql += " WHERE type = ?";
			params.push(type);
		}
		const result = this.db.prepare(sql).get(...params) as { count: number };
		return result.count;
	}

	/**
	 * Count unique items (docs + tasks)
	 */
	private countUniqueItems(): number {
		const docCount = this.db
			.prepare("SELECT COUNT(DISTINCT doc_path) as count FROM chunks WHERE type = 'doc'")
			.get() as { count: number };
		const taskCount = this.db
			.prepare("SELECT COUNT(DISTINCT task_id) as count FROM chunks WHERE type = 'task'")
			.get() as { count: number };
		return docCount.count + taskCount.count;
	}

	/**
	 * Clear the index
	 */
	clear(): void {
		this.db.exec("DELETE FROM chunks");
		this.db.exec("DELETE FROM vec_chunks");
		this.db.exec("DELETE FROM metadata");
	}

	/**
	 * Close the database connection
	 */
	close(): void {
		this.db.close();
	}

	/**
	 * Get database path
	 */
	getDbPath(): string {
		return this.dbPath;
	}
}

/**
 * Create SQLite search store
 */
export function createSearchStore(projectRoot: string, model?: EmbeddingModel): SearchStore {
	return new SearchStore(projectRoot, model);
}
