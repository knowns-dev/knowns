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

export interface ProjectSettings {
	defaultAssignee?: string;
	defaultPriority: TaskPriority;
	defaultLabels?: string[];
	timeFormat?: "12h" | "24h";
	gitTrackingMode?: GitTrackingMode;
	statuses: TaskStatus[];
	statusColors?: Record<string, string>;
	visibleColumns?: TaskStatus[];
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
