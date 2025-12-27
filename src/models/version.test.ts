/**
 * Unit Tests for Version Domain Model
 */
import { describe, expect, test } from "vitest";
import type { Task } from "./task";
import {
	TRACKED_FIELDS,
	type TaskChange,
	type TaskVersion,
	type TaskVersionHistory,
	applyVersionSnapshot,
	createTaskDiff,
	createVersion,
	createVersionHistory,
} from "./version";

describe("Version Model", () => {
	describe("createTaskDiff", () => {
		test("detects title change", () => {
			const oldTask: Partial<Task> = { title: "Old Title" };
			const newTask: Partial<Task> = { title: "New Title" };

			const changes = createTaskDiff(oldTask, newTask);

			expect(changes).toHaveLength(1);
			expect(changes[0].field).toBe("title");
			expect(changes[0].oldValue).toBe("Old Title");
			expect(changes[0].newValue).toBe("New Title");
		});

		test("detects status change", () => {
			const oldTask: Partial<Task> = { status: "todo" };
			const newTask: Partial<Task> = { status: "in-progress" };

			const changes = createTaskDiff(oldTask, newTask);

			expect(changes).toHaveLength(1);
			expect(changes[0].field).toBe("status");
		});

		test("detects priority change", () => {
			const oldTask: Partial<Task> = { priority: "low" };
			const newTask: Partial<Task> = { priority: "high" };

			const changes = createTaskDiff(oldTask, newTask);

			expect(changes).toHaveLength(1);
			expect(changes[0].field).toBe("priority");
		});

		test("detects description change", () => {
			const oldTask: Partial<Task> = { description: "Old description" };
			const newTask: Partial<Task> = { description: "New description" };

			const changes = createTaskDiff(oldTask, newTask);

			expect(changes).toHaveLength(1);
			expect(changes[0].field).toBe("description");
		});

		test("detects assignee change", () => {
			const oldTask: Partial<Task> = { assignee: "@old-user" };
			const newTask: Partial<Task> = { assignee: "@new-user" };

			const changes = createTaskDiff(oldTask, newTask);

			expect(changes).toHaveLength(1);
			expect(changes[0].field).toBe("assignee");
		});

		test("detects labels array change", () => {
			const oldTask: Partial<Task> = { labels: ["bug"] };
			const newTask: Partial<Task> = { labels: ["bug", "urgent"] };

			const changes = createTaskDiff(oldTask, newTask);

			expect(changes).toHaveLength(1);
			expect(changes[0].field).toBe("labels");
		});

		test("detects acceptance criteria change", () => {
			const oldTask: Partial<Task> = {
				acceptanceCriteria: [{ text: "AC 1", completed: false }],
			};
			const newTask: Partial<Task> = {
				acceptanceCriteria: [{ text: "AC 1", completed: true }],
			};

			const changes = createTaskDiff(oldTask, newTask);

			expect(changes).toHaveLength(1);
			expect(changes[0].field).toBe("acceptanceCriteria");
		});

		test("returns empty array when no changes", () => {
			const task: Partial<Task> = {
				title: "Same Title",
				status: "todo",
				priority: "medium",
			};

			const changes = createTaskDiff(task, task);

			expect(changes).toHaveLength(0);
		});

		test("detects multiple changes", () => {
			const oldTask: Partial<Task> = {
				title: "Old Title",
				status: "todo",
				priority: "low",
			};
			const newTask: Partial<Task> = {
				title: "New Title",
				status: "done",
				priority: "high",
			};

			const changes = createTaskDiff(oldTask, newTask);

			expect(changes).toHaveLength(3);
			expect(changes.map((c) => c.field)).toContain("title");
			expect(changes.map((c) => c.field)).toContain("status");
			expect(changes.map((c) => c.field)).toContain("priority");
		});

		test("handles undefined to defined value", () => {
			const oldTask: Partial<Task> = {};
			const newTask: Partial<Task> = { description: "New description" };

			const changes = createTaskDiff(oldTask, newTask);

			expect(changes).toHaveLength(1);
			expect(changes[0].oldValue).toBeUndefined();
			expect(changes[0].newValue).toBe("New description");
		});

		test("handles defined to undefined value", () => {
			const oldTask: Partial<Task> = { description: "Old description" };
			const newTask: Partial<Task> = { description: undefined };

			const changes = createTaskDiff(oldTask, newTask);

			expect(changes).toHaveLength(1);
			expect(changes[0].oldValue).toBe("Old description");
			expect(changes[0].newValue).toBeUndefined();
		});
	});

	describe("createVersion", () => {
		test("creates version with correct structure", () => {
			const changes: TaskChange[] = [{ field: "title", oldValue: "Old", newValue: "New" }];
			const snapshot: Partial<Task> = { title: "New" };

			const version = createVersion("1", 1, changes, snapshot, "@author");

			expect(version.id).toBe("v1");
			expect(version.taskId).toBe("1");
			expect(version.version).toBe(1);
			expect(version.author).toBe("@author");
			expect(version.changes).toEqual(changes);
			expect(version.snapshot).toEqual(snapshot);
			expect(version.timestamp).toBeInstanceOf(Date);
		});

		test("creates version without author", () => {
			const version = createVersion("1", 2, [], {});

			expect(version.author).toBeUndefined();
		});

		test("increments version ID correctly", () => {
			const v1 = createVersion("1", 1, [], {});
			const v2 = createVersion("1", 2, [], {});
			const v10 = createVersion("1", 10, [], {});

			expect(v1.id).toBe("v1");
			expect(v2.id).toBe("v2");
			expect(v10.id).toBe("v10");
		});
	});

	describe("createVersionHistory", () => {
		test("creates empty history for new task", () => {
			const history = createVersionHistory("42");

			expect(history.taskId).toBe("42");
			expect(history.currentVersion).toBe(0);
			expect(history.versions).toEqual([]);
		});
	});

	describe("applyVersionSnapshot", () => {
		test("applies snapshot to current task", () => {
			const currentTask: Task = {
				id: "1",
				title: "Current Title",
				status: "in-progress",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 100,
				timeEntries: [],
				createdAt: new Date("2025-01-01"),
				updatedAt: new Date("2025-01-02"),
			};

			const snapshot: Partial<Task> = {
				title: "Old Title",
				status: "todo",
			};

			const restored = applyVersionSnapshot(currentTask, snapshot);

			expect(restored.title).toBe("Old Title");
			expect(restored.status).toBe("todo");
			// Preserved fields
			expect(restored.id).toBe("1");
			expect(restored.createdAt).toEqual(new Date("2025-01-01"));
			// Updated timestamp
			expect(restored.updatedAt.getTime()).toBeGreaterThan(currentTask.updatedAt.getTime());
		});

		test("preserves ID even if snapshot has different ID", () => {
			const currentTask: Task = {
				id: "1",
				title: "Title",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			const snapshot: Partial<Task> = {
				id: "999", // Different ID
				title: "Snapshot Title",
			};

			const restored = applyVersionSnapshot(currentTask, snapshot);

			expect(restored.id).toBe("1"); // Original ID preserved
		});

		test("preserves createdAt even if snapshot has different date", () => {
			const originalDate = new Date("2025-01-01");
			const currentTask: Task = {
				id: "1",
				title: "Title",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
				createdAt: originalDate,
				updatedAt: new Date(),
			};

			const snapshot: Partial<Task> = {
				createdAt: new Date("2024-01-01"), // Different date
			};

			const restored = applyVersionSnapshot(currentTask, snapshot);

			expect(restored.createdAt).toEqual(originalDate);
		});
	});

	describe("TRACKED_FIELDS", () => {
		test("includes essential fields", () => {
			expect(TRACKED_FIELDS).toContain("title");
			expect(TRACKED_FIELDS).toContain("description");
			expect(TRACKED_FIELDS).toContain("status");
			expect(TRACKED_FIELDS).toContain("priority");
			expect(TRACKED_FIELDS).toContain("assignee");
			expect(TRACKED_FIELDS).toContain("labels");
			expect(TRACKED_FIELDS).toContain("acceptanceCriteria");
		});

		test("includes plan and notes fields", () => {
			expect(TRACKED_FIELDS).toContain("implementationPlan");
			expect(TRACKED_FIELDS).toContain("implementationNotes");
		});

		test("does not include system fields", () => {
			expect(TRACKED_FIELDS).not.toContain("id");
			expect(TRACKED_FIELDS).not.toContain("createdAt");
			expect(TRACKED_FIELDS).not.toContain("updatedAt");
			expect(TRACKED_FIELDS).not.toContain("subtasks");
			expect(TRACKED_FIELDS).not.toContain("timeEntries");
		});
	});
});
