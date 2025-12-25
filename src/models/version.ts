/**
 * Version Domain Model
 * Tracks changes to tasks over time
 */

import type { Task } from "./task";

/**
 * Represents a single field change in a task
 */
export interface TaskChange {
	field: keyof Task;
	oldValue: unknown;
	newValue: unknown;
}

/**
 * Represents a version/snapshot of a task at a point in time
 */
export interface TaskVersion {
	id: string; // Version ID (e.g., "v1", "v2")
	taskId: string;
	version: number;
	timestamp: Date;
	author?: string; // Who made the change
	changes: TaskChange[];
	snapshot: Partial<Task>; // Full task state at this version
}

/**
 * Version history for a task
 */
export interface TaskVersionHistory {
	taskId: string;
	currentVersion: number;
	versions: TaskVersion[];
}

/**
 * Tracked fields for versioning
 */
export const TRACKED_FIELDS: (keyof Task)[] = [
	"title",
	"description",
	"status",
	"priority",
	"assignee",
	"labels",
	"acceptanceCriteria",
	"implementationPlan",
	"implementationNotes",
];

/**
 * Create a diff between two task states
 */
export function createTaskDiff(oldTask: Partial<Task>, newTask: Partial<Task>): TaskChange[] {
	const changes: TaskChange[] = [];

	for (const field of TRACKED_FIELDS) {
		const oldValue = oldTask[field];
		const newValue = newTask[field];

		if (!isEqual(oldValue, newValue)) {
			changes.push({
				field,
				oldValue,
				newValue,
			});
		}
	}

	return changes;
}

/**
 * Deep equality check for task field values
 */
function isEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return a === b;
	if (a === undefined || b === undefined) return a === b;

	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((item, index) => isEqual(item, b[index]));
	}

	if (typeof a === "object" && typeof b === "object") {
		const aKeys = Object.keys(a as object);
		const bKeys = Object.keys(b as object);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every((key) => isEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
	}

	return false;
}

/**
 * Create a new version entry
 */
export function createVersion(
	taskId: string,
	versionNumber: number,
	changes: TaskChange[],
	snapshot: Partial<Task>,
	author?: string,
): TaskVersion {
	return {
		id: `v${versionNumber}`,
		taskId,
		version: versionNumber,
		timestamp: new Date(),
		author,
		changes,
		snapshot,
	};
}

/**
 * Create initial version history for a new task
 */
export function createVersionHistory(taskId: string): TaskVersionHistory {
	return {
		taskId,
		currentVersion: 0,
		versions: [],
	};
}

/**
 * Apply a version snapshot to restore a task
 * Note: Only tracked fields from the snapshot are applied
 */
export function applyVersionSnapshot(currentTask: Task, snapshot: Partial<Task>): Task {
	const restored: Task = {
		...currentTask,
		updatedAt: new Date(),
	};

	// Apply all tracked fields from snapshot, including undefined values
	for (const field of TRACKED_FIELDS) {
		if (field in snapshot) {
			(restored as Record<string, unknown>)[field] = snapshot[field];
		} else {
			// Field not in snapshot means it was undefined at that version
			(restored as Record<string, unknown>)[field] = undefined;
		}
	}

	// Preserve system fields
	restored.id = currentTask.id;
	restored.createdAt = currentTask.createdAt;
	restored.subtasks = currentTask.subtasks;
	restored.timeSpent = currentTask.timeSpent;
	restored.timeEntries = currentTask.timeEntries;

	return restored;
}
