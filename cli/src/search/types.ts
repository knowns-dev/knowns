// Port of internal/search/types.go plus the option and interface types the engine shares.
import type { Task, TaskLifecycleState } from "../models/task.ts";

export type SearchMode = "keyword" | "semantic" | "hybrid";

/** Incremented when chunking or embedding logic changes; an index built with another value is stale. */
export const CHUNK_VERSION = 5;

export type ChunkType = "doc" | "task" | "memory" | "decision" | "code";

/** A piece of a task or document prepared for embedding. Optional fields are Go's omitempty. */
export interface Chunk {
  id: string;
  type: ChunkType | "";
  content: string;
  tokenCount: number;
  embedding?: Float32Array;
  docPath?: string;
  section?: string;
  headingLevel?: number;
  headerPath?: string;
  position?: number;
  taskId?: string;
  field?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  memoryId?: string;
  memoryLayer?: string;
  memoryStore?: string;
  decisionId?: string;
  name?: string;
  signature?: string;
  visibility?: string;
  detail?: string;
}

export interface ChunkResult {
  chunks: Chunk[];
  totalTokens: number;
}

export type ScoredChunk = Chunk & { score: number };

export interface VectorSearchOpts {
  topK: number;
  /** Minimum cosine similarity (0-1). */
  threshold: number;
  chunkType: ChunkType | "";
}

export interface EmbeddingModelConfig {
  name: string;
  dimensions: number;
  maxTokens: number;
  huggingFaceId?: string;
  queryPrefix?: string;
  docPrefix?: string;
}

export interface Tokenizer {
  encode(text: string, maxLength: number): { inputIds: number[] };
}

/** Embedding backend (Ollama and any OpenAI-compatible endpoint). */
export interface EmbedderProvider {
  embed(text: string): Promise<Float32Array>;
  embedDocument(text: string): Promise<Float32Array>;
  embedQuery(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  embedDocumentBatch(texts: string[]): Promise<Float32Array[]>;
  embedQueryBatch(texts: string[]): Promise<Float32Array[]>;
  dimensions(): number;
  modelConfig(): EmbeddingModelConfig;
  getTokenizer(): Tokenizer | undefined;
  close(): void;
}

/**
 * The slice of Go's VectorStore the read path needs. Search keeps Go's shape: it never rejects, it
 * returns no hits and records the failure for `lastSearchError`, which the engine classifies.
 */
export interface VectorStore {
  search(queryVec: Float32Array, opts: VectorSearchOpts): Promise<ScoredChunk[]>;
  count(): number;
  needsRebuild(model: string): boolean;
  stats(): { chunkCount: number; model: string; indexedAt: string | undefined };
  model(): string;
  close(): Promise<void> | void;
  lastSearchError?(): Error | undefined;
}

/** Task lifecycle visibility, resolved from the search purpose (engine.go taskVisibility). */
export type TaskVisibility = "active-and-done" | "active-only" | "active-done-archived";

export type SearchPurpose = "human-search" | "ai-retrieval";

export interface SearchOptions {
  query: string;
  /** "all", "task", "doc", "memory", "decision". */
  type?: string;
  /** "keyword", "semantic", "hybrid". */
  mode?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  label?: string;
  tag?: string;
  limit?: number;
  includeHistorical?: boolean;
  purpose?: SearchPurpose;
  /** Resolved visibility and the task snapshot taken at the query boundary (set by the engine). */
  taskVisibility?: TaskVisibility;
  taskSnapshot?: ReadonlyMap<string, Task>;
}

export type { TaskLifecycleState };
