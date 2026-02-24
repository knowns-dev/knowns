/**
 * Search Module
 * Semantic search with embedding service and chunking
 */

// Types
export type {
	BaseChunk,
	Chunk,
	ChunkResult,
	DocChunk,
	DocMetadata,
	EmbeddingConfig,
	EmbeddingModel,
	EmbeddingResult,
	MarkdownHeading,
	ModelConfig,
	TaskChunk,
	TaskChunkableField,
} from "./types";

export { EMBEDDING_MODELS, getTaskFieldContent } from "./types";

// Chunking utilities
export {
	chunkDocument,
	chunkTask,
	estimateTokens,
	extractHeadings,
	getTaskSearchableContent,
} from "./chunker";

// Embedding service
export type { ModelStatus, ExtendedEmbeddingConfig } from "./embedding";
export { createEmbeddingService, EmbeddingService } from "./embedding";

// Index storage
export type { IndexVersion } from "./store";
export { createSearchIndexStore, SearchIndexStore } from "./store";

// Hybrid search engine
export type { SearchMode, SearchOptions, SearchResult, SearchResponse } from "./engine";
export { createHybridSearchEngine, HybridSearchEngine } from "./engine";

// Index service (incremental updates)
export type { IndexServiceConfig } from "./index-service";
export { IndexService, getIndexService, clearIndexServiceCache } from "./index-service";
