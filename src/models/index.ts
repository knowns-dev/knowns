/**
 * Data Models
 * Core types and interfaces
 */

// Task exports
export type { Task, AcceptanceCriterion, TimeEntry, TaskStatus, TaskPriority } from "./task";
export { DEFAULT_STATUSES, createTask, isValidTaskStatus, isValidTaskPriority } from "./task";

// Project exports
export type { Project, ProjectSettings } from "./project";
export { createProject, createDefaultProjectSettings } from "./project";

// Version exports
export type { TaskVersion, TaskVersionHistory, TaskChange } from "./version";
export {
	createVersion,
	createVersionHistory,
	createTaskDiff,
	applyVersionSnapshot,
	TRACKED_FIELDS,
} from "./version";
