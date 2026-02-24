/**
 * Semantic Search Types
 * Interfaces for embedding service and chunking
 */

import type { Task } from "@models/task";

/**
 * Supported embedding models (string type for flexibility with custom models)
 */
export type EmbeddingModel = string;

/**
 * Model configuration
 */
export interface ModelConfig {
	name: string;
	dimensions: number;
	maxTokens: number;
	huggingFaceId: string;
}

/**
 * Built-in models with their configurations
 */
export const EMBEDDING_MODELS: Record<string, ModelConfig> = {
	"gte-small": {
		name: "gte-small",
		dimensions: 384,
		maxTokens: 512,
		huggingFaceId: "Xenova/gte-small",
	},
	"all-MiniLM-L6-v2": {
		name: "all-MiniLM-L6-v2",
		dimensions: 384,
		maxTokens: 256,
		huggingFaceId: "Xenova/all-MiniLM-L6-v2",
	},
	"gte-base": {
		name: "gte-base",
		dimensions: 768,
		maxTokens: 512,
		huggingFaceId: "Xenova/gte-base",
	},
	"bge-small-en-v1.5": {
		name: "bge-small-en-v1.5",
		dimensions: 384,
		maxTokens: 512,
		huggingFaceId: "Xenova/bge-small-en-v1.5",
	},
	"bge-base-en-v1.5": {
		name: "bge-base-en-v1.5",
		dimensions: 768,
		maxTokens: 512,
		huggingFaceId: "Xenova/bge-base-en-v1.5",
	},
	"e5-small-v2": {
		name: "e5-small-v2",
		dimensions: 384,
		maxTokens: 512,
		huggingFaceId: "Xenova/e5-small-v2",
	},
};

/**
 * Embedding configuration stored in project config
 */
export interface EmbeddingConfig {
	enabled: boolean;
	model: EmbeddingModel;
	modelPath: string; // e.g., "~/.knowns/models/gte-small"
}

/**
 * Base chunk interface
 */
export interface BaseChunk {
	id: string;
	content: string;
	embedding?: number[];
	tokenCount: number;
}

/**
 * Document chunk - split by headings
 */
export interface DocChunk extends BaseChunk {
	type: "doc";
	docPath: string; // e.g., "guides/setup"
	section: string; // e.g., "## Installation"
	metadata: {
		headingLevel: number; // 1 for #, 2 for ##, 3 for ###
		parentSection?: string;
		position: number; // Order in document
	};
}

/**
 * Task chunk - split by fields
 */
export interface TaskChunk extends BaseChunk {
	type: "task";
	taskId: string;
	field: "description" | "ac" | "plan" | "notes";
	metadata: {
		status: string;
		priority: string;
		labels: string[];
	};
}

/**
 * Union type for all chunks
 */
export type Chunk = DocChunk | TaskChunk;

/**
 * Document metadata for chunking
 */
export interface DocMetadata {
	path: string;
	title: string;
	description?: string;
	tags?: string[];
}

/**
 * Heading extracted from markdown
 */
export interface MarkdownHeading {
	level: number;
	title: string;
	content: string;
	startIndex: number;
	endIndex: number;
}

/**
 * Result of chunking a document
 */
export interface ChunkResult {
	chunks: Chunk[];
	totalTokens: number;
}

/**
 * Embedding result
 */
export interface EmbeddingResult {
	embedding: number[];
	tokenCount: number;
}

/**
 * Task fields that can be chunked
 */
export type TaskChunkableField = "description" | "ac" | "plan" | "notes";

/**
 * Get task field content for chunking
 */
export function getTaskFieldContent(task: Task, field: TaskChunkableField): string | null {
	switch (field) {
		case "description":
			// Combine title + description for context
			return task.description ? `${task.title}\n\n${task.description}` : task.title;
		case "ac":
			if (!task.acceptanceCriteria || task.acceptanceCriteria.length === 0) return null;
			return task.acceptanceCriteria.map((ac) => `- ${ac.completed ? "[x]" : "[ ]"} ${ac.text}`).join("\n");
		case "plan":
			return task.implementationPlan || null;
		case "notes":
			return task.implementationNotes || null;
	}
}
