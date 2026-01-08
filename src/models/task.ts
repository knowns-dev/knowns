/**
 * Task Domain Model
 * Core entity for task management with value objects
 */

// Task status: dynamic, read from config.settings.statuses
export type TaskStatus = string;

// Priority: low, medium, high
export type TaskPriority = "low" | "medium" | "high";

// Task interface
export interface Task {
	id: string; // task-{6_char_base36} for new tasks; legacy sequential IDs still supported
	title: string;
	description?: string;
	status: TaskStatus;
	priority: TaskPriority;
	assignee?: string; // "@harry"
	labels: string[];
	parent?: string; // Parent task ID for subtasks
	subtasks: string[]; // Child task IDs
	createdAt: Date;
	updatedAt: Date;

	// Acceptance criteria
	acceptanceCriteria: AcceptanceCriterion[];

	// Time tracking
	timeSpent: number; // Total seconds
	timeEntries: TimeEntry[];

	// Notes
	implementationPlan?: string;
	implementationNotes?: string;
}

export interface AcceptanceCriterion {
	text: string;
	completed: boolean;
}

export interface TimeEntry {
	id: string;
	startedAt: Date;
	endedAt?: Date;
	duration: number; // Seconds
	note?: string;
}

// Helper functions for task creation
export function createTask(
	data: Omit<Task, "id" | "createdAt" | "updatedAt" | "subtasks" | "timeSpent" | "timeEntries">,
): Omit<Task, "id"> {
	const now = new Date();
	return {
		...data,
		subtasks: [],
		timeSpent: 0,
		timeEntries: [],
		createdAt: now,
		updatedAt: now,
	};
}

// Default statuses (fallback if config not available)
export const DEFAULT_STATUSES: TaskStatus[] = [
	"todo",
	"in-progress",
	"in-review",
	"done",
	"blocked",
	"on-hold",
	"urgent",
];

// Helper to validate task status
// Use with allowed statuses from config, or falls back to DEFAULT_STATUSES
export function isValidTaskStatus(status: string, allowedStatuses?: TaskStatus[]): status is TaskStatus {
	const validStatuses = allowedStatuses || DEFAULT_STATUSES;
	return validStatuses.includes(status);
}

// Helper to validate task priority
export function isValidTaskPriority(priority: string): priority is TaskPriority {
	return ["low", "medium", "high"].includes(priority);
}
