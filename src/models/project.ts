/**
 * Project Domain Model
 * Core entity for project configuration
 */

import type { TaskPriority, TaskStatus } from "./task";

export interface Project {
	name: string;
	id: string;
	createdAt: Date;
	settings: ProjectSettings;
}

export type GitTrackingMode = "git-tracked" | "git-ignored" | "none";

/**
 * Supported embedding models for semantic search
 * Now uses string type to support custom HuggingFace models
 */
export type EmbeddingModel = string;

/**
 * Semantic search configuration
 */
export interface SemanticSearchSettings {
	enabled: boolean;
	model: EmbeddingModel;
	/** Full HuggingFace model ID (e.g., "Xenova/gte-small") */
	huggingFaceId?: string;
	/** Embedding dimensions */
	dimensions?: number;
	/** Max tokens for input */
	maxTokens?: number;
}

export interface ProjectSettings {
	defaultAssignee?: string;
	defaultPriority: TaskPriority;
	defaultLabels?: string[];
	timeFormat?: "12h" | "24h";
	gitTrackingMode?: GitTrackingMode;
	statuses: TaskStatus[];
	statusColors?: Record<string, string>;
	visibleColumns?: TaskStatus[];
	/** Semantic search configuration */
	semanticSearch?: SemanticSearchSettings;
}

// Helper to create default project settings
export function createDefaultProjectSettings(overrides?: Partial<ProjectSettings>): ProjectSettings {
	return {
		defaultPriority: "medium",
		statuses: ["todo", "in-progress", "in-review", "done", "blocked", "on-hold", "urgent"],
		statusColors: {
			todo: "gray",
			"in-progress": "blue",
			"in-review": "purple",
			done: "green",
			blocked: "red",
			"on-hold": "yellow",
			urgent: "orange",
		},
		visibleColumns: ["todo", "in-progress", "blocked", "done", "in-review"],
		...overrides,
	};
}

// Helper to create a new project
export function createProject(name: string, id?: string, settingsOverrides?: Partial<ProjectSettings>): Project {
	return {
		name,
		id: id || name.toLowerCase().replace(/\s+/g, "-"),
		createdAt: new Date(),
		settings: createDefaultProjectSettings(settingsOverrides),
	};
}
