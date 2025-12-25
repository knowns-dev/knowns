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

export interface ProjectSettings {
	defaultAssignee?: string;
	defaultPriority: TaskPriority;
	statuses: TaskStatus[];
}

// Helper to create default project settings
export function createDefaultProjectSettings(): ProjectSettings {
	return {
		defaultPriority: "medium",
		statuses: ["todo", "in-progress", "in-review", "done", "blocked"],
	};
}

// Helper to create a new project
export function createProject(name: string, id?: string): Project {
	return {
		name,
		id: id || name.toLowerCase().replace(/\s+/g, "-"),
		createdAt: new Date(),
		settings: createDefaultProjectSettings(),
	};
}
