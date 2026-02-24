/**
 * Search Index Store
 * Persists Orama search index to .knowns/search-index/
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Chunk, DocChunk, EmbeddingModel, TaskChunk } from "./types";
import { EMBEDDING_MODELS } from "./types";

// Orama types (dynamic import)
type OramaDB = Awaited<ReturnType<typeof import("@orama/orama")["create"]>>;

/**
 * Version info stored in version.json
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
 * Stored chunk format (without embedding for index.json)
 */
interface StoredChunkMeta {
	id: string;
	type: "doc" | "task";
	// Doc-specific
	docPath?: string;
	section?: string;
	headingLevel?: number;
	parentSection?: string;
	position?: number;
	// Task-specific
	taskId?: string;
	field?: string;
	status?: string;
	priority?: string;
	labels?: string[];
	// Common
	content: string;
	tokenCount: number;
}

/**
 * Search Index Store
 */
export class SearchIndexStore {
	private projectRoot: string;
	private indexPath: string;
	private db: OramaDB | null = null;
	private model: EmbeddingModel;
	private dimensions: number;

	constructor(projectRoot: string, model: EmbeddingModel = "gte-small") {
		this.projectRoot = projectRoot;
		this.indexPath = join(projectRoot, ".knowns", "search-index");
		this.model = model;
		this.dimensions = EMBEDDING_MODELS[model].dimensions;
	}

	/**
	 * Get paths for index files
	 */
	private getPaths() {
		return {
			dir: this.indexPath,
			version: join(this.indexPath, "version.json"),
			index: join(this.indexPath, "index.json"),
			embeddings: join(this.indexPath, "embeddings.bin"),
		};
	}

	/**
	 * Check if index exists
	 */
	indexExists(): boolean {
		const paths = this.getPaths();
		return existsSync(paths.version) && existsSync(paths.index);
	}

	/**
	 * Get current index version
	 */
	async getVersion(): Promise<IndexVersion | null> {
		const paths = this.getPaths();
		if (!existsSync(paths.version)) {
			return null;
		}

		try {
			const content = await readFile(paths.version, "utf-8");
			return JSON.parse(content);
		} catch {
			return null;
		}
	}

	/**
	 * Check if index needs rebuild (model changed)
	 */
	async needsRebuild(): Promise<boolean> {
		const version = await this.getVersion();
		if (!version) return true;

		// Rebuild if model changed
		if (version.model !== this.model) return true;

		// Rebuild if dimensions mismatch
		if (version.dimensions !== this.dimensions) return true;

		return false;
	}

	/**
	 * Initialize the Orama database
	 */
	async initDatabase(): Promise<OramaDB> {
		const { create } = await import("@orama/orama");

		this.db = await create({
			schema: {
				id: "string",
				type: "string", // "doc" | "task"
				content: "string",
				// Doc fields
				docPath: "string",
				section: "string",
				// Task fields
				taskId: "string",
				field: "string",
				status: "string",
				priority: "string",
				labels: "string[]",
				// Vector
				embedding: `vector[${this.dimensions}]`,
			},
		});

		return this.db;
	}

	/**
	 * Get or create database
	 */
	async getDatabase(): Promise<OramaDB> {
		if (this.db) return this.db;

		// Try to load from disk
		if (this.indexExists() && !(await this.needsRebuild())) {
			await this.load();
			if (this.db) return this.db;
		}

		// Create new database
		return this.initDatabase();
	}

	/**
	 * Add chunks to index
	 */
	async addChunks(chunks: Chunk[]): Promise<void> {
		const db = await this.getDatabase();
		const { insert } = await import("@orama/orama");

		let skippedCount = 0;
		for (const chunk of chunks) {
			if (!chunk.embedding) {
				skippedCount++;
				continue;
			}

			if (chunk.type === "doc") {
				const docChunk = chunk as DocChunk;
				await insert(db, {
					id: chunk.id,
					type: "doc",
					content: chunk.content,
					docPath: docChunk.docPath,
					section: docChunk.section,
					taskId: "",
					field: "",
					status: "",
					priority: "",
					labels: [],
					embedding: chunk.embedding,
				});
			} else {
				const taskChunk = chunk as TaskChunk;
				await insert(db, {
					id: chunk.id,
					type: "task",
					content: chunk.content,
					docPath: "",
					section: "",
					taskId: taskChunk.taskId,
					field: taskChunk.field,
					status: taskChunk.metadata.status,
					priority: taskChunk.metadata.priority,
					labels: taskChunk.metadata.labels,
					embedding: chunk.embedding,
				});
			}
		}
	}

	/**
	 * Remove chunks by ID prefix
	 */
	async removeChunks(idPrefix: string): Promise<void> {
		const db = await this.getDatabase();
		const { remove, search } = await import("@orama/orama");

		// Find all chunks with matching prefix
		const results = await search(db, {
			term: "",
			limit: 10000,
		});

		for (const hit of results.hits) {
			const doc = hit.document as { id: string };
			if (doc.id.startsWith(idPrefix)) {
				await remove(db, doc.id);
			}
		}
	}

	/**
	 * Save index to disk
	 */
	async save(chunks: Chunk[]): Promise<void> {
		const paths = this.getPaths();

		// Ensure directory exists
		if (!existsSync(paths.dir)) {
			await mkdir(paths.dir, { recursive: true });
		}

		// Save version info
		const version: IndexVersion = {
			model: this.model,
			modelVersion: "1.0.0",
			dimensions: this.dimensions,
			indexedAt: new Date().toISOString(),
			itemCount: this.countUniqueItems(chunks),
			chunkCount: chunks.length,
		};
		await writeFile(paths.version, JSON.stringify(version, null, 2));

		// Save chunk metadata (without embeddings for readability)
		const chunkMeta: StoredChunkMeta[] = chunks.map((chunk) => {
			if (chunk.type === "doc") {
				const docChunk = chunk as DocChunk;
				return {
					id: chunk.id,
					type: "doc" as const,
					docPath: docChunk.docPath,
					section: docChunk.section,
					headingLevel: docChunk.metadata.headingLevel,
					parentSection: docChunk.metadata.parentSection,
					position: docChunk.metadata.position,
					content: chunk.content,
					tokenCount: chunk.tokenCount,
				};
			}
			const taskChunk = chunk as TaskChunk;
			return {
				id: chunk.id,
				type: "task" as const,
				taskId: taskChunk.taskId,
				field: taskChunk.field,
				status: taskChunk.metadata.status,
				priority: taskChunk.metadata.priority,
				labels: taskChunk.metadata.labels,
				content: chunk.content,
				tokenCount: chunk.tokenCount,
			};
		});
		await writeFile(paths.index, JSON.stringify(chunkMeta, null, 2));

		// Save embeddings as binary
		const embeddings = chunks
			.filter((c): c is Chunk & { embedding: number[] } => Boolean(c.embedding))
			.map((c) => ({
				id: c.id,
				embedding: c.embedding,
			}));
		await writeFile(paths.embeddings, JSON.stringify(embeddings));
	}

	/**
	 * Load index from disk
	 */
	async load(): Promise<void> {
		const paths = this.getPaths();

		if (!this.indexExists()) {
			throw new Error("Index does not exist");
		}

		// Check if rebuild needed
		if (await this.needsRebuild()) {
			throw new Error("Index needs rebuild - model changed");
		}

		// Initialize fresh database
		await this.initDatabase();

		// Load chunk metadata
		const indexContent = await readFile(paths.index, "utf-8");
		const chunkMeta: StoredChunkMeta[] = JSON.parse(indexContent);

		// Load embeddings
		const embeddingsContent = await readFile(paths.embeddings, "utf-8");
		const embeddings: Array<{ id: string; embedding: number[] }> = JSON.parse(embeddingsContent);
		const embeddingMap = new Map(embeddings.map((e) => [e.id, e.embedding]));

		// Reconstruct chunks and add to database
		let chunksWithEmbeddings = 0;
		let chunksWithoutEmbeddings = 0;
		const chunks: Chunk[] = chunkMeta.map((meta) => {
			const embedding = embeddingMap.get(meta.id);
			if (embedding) {
				chunksWithEmbeddings++;
			} else {
				chunksWithoutEmbeddings++;
			}

			if (meta.type === "doc") {
				return {
					id: meta.id,
					type: "doc",
					docPath: meta.docPath || "",
					section: meta.section || "",
					content: meta.content,
					tokenCount: meta.tokenCount,
					embedding,
					metadata: {
						headingLevel: meta.headingLevel || 1,
						parentSection: meta.parentSection,
						position: meta.position || 0,
					},
				} as DocChunk;
			}

			return {
				id: meta.id,
				type: "task",
				taskId: meta.taskId || "",
				field: (meta.field || "description") as TaskChunk["field"],
				content: meta.content,
				tokenCount: meta.tokenCount,
				embedding,
				metadata: {
					status: meta.status || "todo",
					priority: meta.priority || "medium",
					labels: meta.labels || [],
				},
			} as TaskChunk;
		});

		// Debug output
		if (chunksWithoutEmbeddings > 0) {
			console.warn(
				`Warning: ${chunksWithoutEmbeddings} chunks missing embeddings, ${chunksWithEmbeddings} have embeddings`,
			);
		}

		await this.addChunks(chunks);
	}

	/**
	 * Clear the index
	 */
	async clear(): Promise<void> {
		const paths = this.getPaths();

		if (existsSync(paths.version)) await unlink(paths.version);
		if (existsSync(paths.index)) await unlink(paths.index);
		if (existsSync(paths.embeddings)) await unlink(paths.embeddings);

		this.db = null;
	}

	/**
	 * Count unique items (docs + tasks)
	 */
	private countUniqueItems(chunks: Chunk[]): number {
		const docPaths = new Set<string>();
		const taskIds = new Set<string>();

		for (const chunk of chunks) {
			if (chunk.type === "doc") {
				docPaths.add((chunk as DocChunk).docPath);
			} else {
				taskIds.add((chunk as TaskChunk).taskId);
			}
		}

		return docPaths.size + taskIds.size;
	}

	/**
	 * Get the Orama database instance (for direct queries)
	 */
	getDb(): OramaDB | null {
		return this.db;
	}
}

/**
 * Create search index store
 */
export function createSearchIndexStore(projectRoot: string, model?: EmbeddingModel): SearchIndexStore {
	return new SearchIndexStore(projectRoot, model);
}
