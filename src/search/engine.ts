/**
 * Hybrid Search Engine
 * Combines semantic (vector), fuzzy (tolerance), and keyword (exact) search
 */

import type { EmbeddingService } from "./embedding";
import type { SearchIndexStore } from "./store";
import type { Chunk, DocChunk, EmbeddingModel, TaskChunk } from "./types";
import { EMBEDDING_MODELS } from "./types";

// Orama types (dynamic import)
type OramaDB = Awaited<ReturnType<typeof import("@orama/orama")["create"]>>;

/**
 * Search mode
 */
export type SearchMode = "hybrid" | "semantic" | "fuzzy" | "keyword";

/**
 * Search options
 */
export interface SearchOptions {
	/** Maximum number of results to return */
	limit?: number;
	/** Search mode (default: hybrid) */
	mode?: SearchMode;
	/** Filter by content type */
	type?: "doc" | "task" | "all";
	/** Filter tasks by status */
	status?: string;
	/** Filter tasks by priority */
	priority?: string;
	/** Filter tasks by labels */
	labels?: string[];
	/** Minimum similarity threshold for semantic search (0-1) */
	similarity?: number;
	/** Tolerance for fuzzy matching (Levenshtein distance) */
	tolerance?: number;
	/** Weight for semantic results (0-1, default: 0.6) */
	semanticWeight?: number;
	/** Weight for keyword results (0-1, default: 0.4) */
	keywordWeight?: number;
}

/**
 * Search result item
 */
export interface SearchResult {
	/** Unique ID of the chunk */
	id: string;
	/** Content type */
	type: "doc" | "task";
	/** Relevance score (0-1) */
	score: number;
	/** Content text */
	content: string;
	/** Document path (for docs) */
	docPath?: string;
	/** Section heading (for docs) */
	section?: string;
	/** Task ID (for tasks) */
	taskId?: string;
	/** Task field (for tasks) */
	field?: string;
	/** Task status (for tasks) */
	status?: string;
	/** Task priority (for tasks) */
	priority?: string;
	/** Task labels (for tasks) */
	labels?: string[];
	/** How this result was found */
	matchedBy: ("semantic" | "fuzzy" | "keyword")[];
}

/**
 * Search response
 */
export interface SearchResponse {
	/** Search results */
	results: SearchResult[];
	/** Total number of matches */
	count: number;
	/** Search latency in milliseconds */
	elapsed: number;
	/** Search mode used */
	mode: SearchMode;
}

/**
 * Internal scored result for merging
 */
interface ScoredResult {
	id: string;
	semanticScore: number;
	keywordScore: number;
	fuzzyScore: number;
	matchedBy: ("semantic" | "fuzzy" | "keyword")[];
	document: Record<string, unknown>;
}

/**
 * Hybrid Search Engine
 */
export class HybridSearchEngine {
	private store: SearchIndexStore;
	private embeddingService: EmbeddingService;
	private model: EmbeddingModel;
	private dimensions: number;

	constructor(store: SearchIndexStore, embeddingService: EmbeddingService, model: EmbeddingModel = "gte-small") {
		this.store = store;
		this.embeddingService = embeddingService;
		this.model = model;
		this.dimensions = EMBEDDING_MODELS[model].dimensions;
	}

	/**
	 * Perform hybrid search combining semantic, fuzzy, and keyword matching
	 */
	async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
		const startTime = performance.now();

		const {
			limit = 20,
			mode = "hybrid",
			type = "all",
			status,
			priority,
			labels,
			similarity = 0.5,
			tolerance = 1,
			semanticWeight = 0.6,
			keywordWeight = 0.4,
		} = options;

		const db = this.store.getDb();
		if (!db) {
			// Fallback: no index available
			return {
				results: [],
				count: 0,
				elapsed: performance.now() - startTime,
				mode,
			};
		}

		// Build where clause for filtering
		const where = this.buildWhereClause(type, status, priority, labels);

		let results: SearchResult[];

		switch (mode) {
			case "semantic":
				results = await this.semanticSearch(db, query, limit, similarity, where);
				break;
			case "fuzzy":
				results = await this.fuzzySearch(db, query, limit, tolerance, where);
				break;
			case "keyword":
				results = await this.keywordSearch(db, query, limit, where);
				break;
			default:
				results = await this.hybridSearch(
					db,
					query,
					limit,
					similarity,
					tolerance,
					semanticWeight,
					keywordWeight,
					where,
				);
				break;
		}

		const elapsed = performance.now() - startTime;

		return {
			results,
			count: results.length,
			elapsed,
			mode,
		};
	}

	/**
	 * Semantic search using vector similarity
	 * Note: Orama's searchVector with where clause has issues, so we filter results manually
	 */
	private async semanticSearch(
		db: OramaDB,
		query: string,
		limit: number,
		similarity: number,
		where?: Record<string, unknown>,
	): Promise<SearchResult[]> {
		const { searchVector } = await import("@orama/orama");

		// Generate query embedding
		const { embedding } = await this.embeddingService.embed(query);

		// Fetch more results since we'll filter manually
		const fetchLimit = where ? limit * 5 : limit;

		const searchResults = await searchVector(db, {
			mode: "vector",
			vector: {
				value: embedding,
				property: "embedding",
			},
			similarity,
			limit: fetchLimit,
			// Note: where clause doesn't work properly with searchVector, filter manually
			includeVectors: false,
		});

		let results = searchResults.hits.map((hit) => this.mapToSearchResult(hit.document, hit.score, ["semantic"]));

		// Apply type filter manually if specified
		if (where) {
			const typeFilter = this.extractTypeFilter(where);
			if (typeFilter) {
				results = results.filter((r) => r.type === typeFilter);
			}
		}

		return results.slice(0, limit);
	}

	/**
	 * Extract type filter from where clause
	 */
	private extractTypeFilter(where: Record<string, unknown>): "doc" | "task" | null {
		// Handle direct type filter: { type: { eq: "doc" } }
		if (where.type && typeof where.type === "object") {
			const typeObj = where.type as Record<string, unknown>;
			if (typeObj.eq === "doc" || typeObj.eq === "task") {
				return typeObj.eq as "doc" | "task";
			}
		}

		// Handle AND conditions: { and: [{ type: { eq: "doc" } }, ...] }
		if (where.and && Array.isArray(where.and)) {
			for (const condition of where.and) {
				const typeFilter = this.extractTypeFilter(condition as Record<string, unknown>);
				if (typeFilter) return typeFilter;
			}
		}

		return null;
	}

	/**
	 * Fuzzy search using Levenshtein distance tolerance
	 */
	private async fuzzySearch(
		db: OramaDB,
		query: string,
		limit: number,
		tolerance: number,
		where?: Record<string, unknown>,
	): Promise<SearchResult[]> {
		const { search } = await import("@orama/orama");

		const searchResults = await search(db, {
			term: query,
			tolerance,
			properties: ["content"],
			limit,
			where,
		});

		return searchResults.hits.map((hit) => this.mapToSearchResult(hit.document, hit.score, ["fuzzy"]));
	}

	/**
	 * Keyword search for exact matches
	 */
	private async keywordSearch(
		db: OramaDB,
		query: string,
		limit: number,
		where?: Record<string, unknown>,
	): Promise<SearchResult[]> {
		const { search } = await import("@orama/orama");

		const searchResults = await search(db, {
			term: query,
			exact: true,
			properties: ["content"],
			limit,
			where,
		});

		return searchResults.hits.map((hit) => this.mapToSearchResult(hit.document, hit.score, ["keyword"]));
	}

	/**
	 * Hybrid search combining all three methods with weighted scoring
	 */
	private async hybridSearch(
		db: OramaDB,
		query: string,
		limit: number,
		similarity: number,
		tolerance: number,
		semanticWeight: number,
		keywordWeight: number,
		where?: Record<string, unknown>,
	): Promise<SearchResult[]> {
		const { search, searchVector } = await import("@orama/orama");

		// Extract type filter for manual filtering (Orama searchVector where clause has issues)
		const typeFilter = where ? this.extractTypeFilter(where) : null;

		// Run all searches in parallel
		const [semanticResults, fuzzyResults, keywordResults] = await Promise.all([
			// Semantic search (without where clause - filter manually)
			(async () => {
				try {
					const { embedding } = await this.embeddingService.embed(query);
					const results = await searchVector(db, {
						mode: "vector",
						vector: {
							value: embedding,
							property: "embedding",
						},
						similarity,
						limit: limit * 5, // Get more since we filter manually
						// Note: where clause doesn't work with searchVector, filter manually below
						includeVectors: false,
					});

					// Manual type filtering for semantic results
					if (typeFilter) {
						return {
							...results,
							hits: results.hits.filter((h) => (h.document as { type: string }).type === typeFilter),
						};
					}
					return results;
				} catch {
					return { hits: [] };
				}
			})(),

			// Fuzzy search
			search(db, {
				term: query,
				tolerance,
				properties: ["content"],
				limit: limit * 2,
				where,
			}),

			// Keyword/exact search
			search(db, {
				term: query,
				exact: true,
				properties: ["content"],
				limit: limit * 2,
				where,
			}),
		]);

		// Merge and score results
		const mergedResults = this.mergeResults(
			semanticResults.hits,
			fuzzyResults.hits,
			keywordResults.hits,
			semanticWeight,
			keywordWeight,
		);

		// Sort by combined score and limit
		return mergedResults.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/**
	 * Merge results from different search methods with weighted scoring
	 */
	private mergeResults(
		semanticHits: Array<{ document: Record<string, unknown>; score: number }>,
		fuzzyHits: Array<{ document: Record<string, unknown>; score: number }>,
		keywordHits: Array<{ document: Record<string, unknown>; score: number }>,
		semanticWeight: number,
		keywordWeight: number,
	): SearchResult[] {
		const resultMap = new Map<string, ScoredResult>();

		// Normalize scores to 0-1 range
		const normalizeScore = (score: number, maxScore: number): number => {
			if (maxScore === 0) return 0;
			return Math.min(1, score / maxScore);
		};

		// Find max scores for normalization
		const maxSemantic = Math.max(...semanticHits.map((h) => h.score), 1);
		const maxFuzzy = Math.max(...fuzzyHits.map((h) => h.score), 1);
		const maxKeyword = Math.max(...keywordHits.map((h) => h.score), 1);

		// Process semantic results
		for (const hit of semanticHits) {
			const id = hit.document.id as string;
			const existing = resultMap.get(id);
			if (existing) {
				existing.semanticScore = normalizeScore(hit.score, maxSemantic);
				existing.matchedBy.push("semantic");
			} else {
				resultMap.set(id, {
					id,
					semanticScore: normalizeScore(hit.score, maxSemantic),
					keywordScore: 0,
					fuzzyScore: 0,
					matchedBy: ["semantic"],
					document: hit.document,
				});
			}
		}

		// Process fuzzy results
		for (const hit of fuzzyHits) {
			const id = hit.document.id as string;
			const existing = resultMap.get(id);
			if (existing) {
				existing.fuzzyScore = normalizeScore(hit.score, maxFuzzy);
				if (!existing.matchedBy.includes("fuzzy")) {
					existing.matchedBy.push("fuzzy");
				}
			} else {
				resultMap.set(id, {
					id,
					semanticScore: 0,
					keywordScore: 0,
					fuzzyScore: normalizeScore(hit.score, maxFuzzy),
					matchedBy: ["fuzzy"],
					document: hit.document,
				});
			}
		}

		// Process keyword results (exact matches get a boost)
		for (const hit of keywordHits) {
			const id = hit.document.id as string;
			const existing = resultMap.get(id);
			if (existing) {
				existing.keywordScore = normalizeScore(hit.score, maxKeyword);
				if (!existing.matchedBy.includes("keyword")) {
					existing.matchedBy.push("keyword");
				}
			} else {
				resultMap.set(id, {
					id,
					semanticScore: 0,
					keywordScore: normalizeScore(hit.score, maxKeyword),
					fuzzyScore: 0,
					matchedBy: ["keyword"],
					document: hit.document,
				});
			}
		}

		// Calculate combined scores
		// Formula: (semantic * semanticWeight) + (keyword * keywordWeight) + (fuzzy * fuzzyWeight)
		// Where fuzzyWeight = (1 - semanticWeight - keywordWeight) or minimum 0.1
		const fuzzyWeight = Math.max(0.1, 1 - semanticWeight - keywordWeight);

		return Array.from(resultMap.values()).map((result) => {
			// Boost score if matched by multiple methods
			const matchBonus = result.matchedBy.length > 1 ? 1.1 : 1.0;

			const combinedScore =
				(result.semanticScore * semanticWeight +
					result.keywordScore * keywordWeight +
					result.fuzzyScore * fuzzyWeight) *
				matchBonus;

			return this.mapToSearchResult(result.document, Math.min(1, combinedScore), result.matchedBy);
		});
	}

	/**
	 * Build Orama where clause for filtering
	 */
	private buildWhereClause(
		type: "doc" | "task" | "all",
		status?: string,
		priority?: string,
		labels?: string[],
	): Record<string, unknown> | undefined {
		const conditions: Array<Record<string, unknown>> = [];

		if (type !== "all") {
			conditions.push({ type: { eq: type } });
		}

		if (status) {
			conditions.push({ status: { eq: status } });
		}

		if (priority) {
			conditions.push({ priority: { eq: priority } });
		}

		if (labels && labels.length > 0) {
			conditions.push({ labels: { containsAll: labels } });
		}

		if (conditions.length === 0) {
			return undefined;
		}

		if (conditions.length === 1) {
			return conditions[0];
		}

		return { and: conditions };
	}

	/**
	 * Map Orama document to SearchResult
	 */
	private mapToSearchResult(
		doc: Record<string, unknown>,
		score: number,
		matchedBy: ("semantic" | "fuzzy" | "keyword")[],
	): SearchResult {
		const type = doc.type as "doc" | "task";

		const result: SearchResult = {
			id: doc.id as string,
			type,
			score,
			content: doc.content as string,
			matchedBy,
		};

		if (type === "doc") {
			result.docPath = doc.docPath as string;
			result.section = doc.section as string;
		} else {
			result.taskId = doc.taskId as string;
			result.field = doc.field as string;
			result.status = doc.status as string;
			result.priority = doc.priority as string;
			result.labels = doc.labels as string[];
		}

		return result;
	}

	/**
	 * Get the embedding service
	 */
	getEmbeddingService(): EmbeddingService {
		return this.embeddingService;
	}

	/**
	 * Get the search index store
	 */
	getStore(): SearchIndexStore {
		return this.store;
	}
}

/**
 * Create hybrid search engine
 */
export function createHybridSearchEngine(
	store: SearchIndexStore,
	embeddingService: EmbeddingService,
	model?: EmbeddingModel,
): HybridSearchEngine {
	return new HybridSearchEngine(store, embeddingService, model);
}
