/**
 * Unit Tests for Task Domain Model
 */
import { beforeEach, describe, expect, test } from "vitest";
import {
	type AcceptanceCriterion,
	type Task,
	type TaskPriority,
	type TaskStatus,
	type TimeEntry,
	createTask,
	isValidTaskPriority,
	isValidTaskStatus,
} from "./task";

describe("Task Entity", () => {
	describe("createTask", () => {
		test("creates a task with required fields", () => {
			const task = createTask({
				title: "Test Task",
				status: "todo",
				priority: "medium",
				labels: [],
				acceptanceCriteria: [],
			});

			expect(task.title).toBe("Test Task");
			expect(task.status).toBe("todo");
			expect(task.priority).toBe("medium");
			expect(task.labels).toEqual([]);
			expect(task.acceptanceCriteria).toEqual([]);
		});

		test("initializes subtasks as empty array", () => {
			const task = createTask({
				title: "Test Task",
				status: "todo",
				priority: "medium",
				labels: [],
				acceptanceCriteria: [],
			});

			expect(task.subtasks).toEqual([]);
		});

		test("initializes time tracking fields", () => {
			const task = createTask({
				title: "Test Task",
				status: "todo",
				priority: "medium",
				labels: [],
				acceptanceCriteria: [],
			});

			expect(task.timeSpent).toBe(0);
			expect(task.timeEntries).toEqual([]);
		});

		test("sets createdAt and updatedAt to current time", () => {
			const before = new Date();
			const task = createTask({
				title: "Test Task",
				status: "todo",
				priority: "medium",
				labels: [],
				acceptanceCriteria: [],
			});
			const after = new Date();

			expect(task.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
			expect(task.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
			expect(task.updatedAt.getTime()).toBe(task.createdAt.getTime());
		});

		test("preserves optional fields when provided", () => {
			const task = createTask({
				title: "Test Task",
				description: "A detailed description",
				status: "in-progress",
				priority: "high",
				assignee: "@developer",
				labels: ["bug", "urgent"],
				parent: "1",
				acceptanceCriteria: [{ text: "First criterion", completed: false }],
				implementationPlan: "Step 1: Do something",
				implementationNotes: "Notes here",
			});

			expect(task.description).toBe("A detailed description");
			expect(task.assignee).toBe("@developer");
			expect(task.labels).toEqual(["bug", "urgent"]);
			expect(task.parent).toBe("1");
			expect(task.acceptanceCriteria).toHaveLength(1);
			expect(task.implementationPlan).toBe("Step 1: Do something");
			expect(task.implementationNotes).toBe("Notes here");
		});

		test("creates task with all status values", () => {
			const statuses: TaskStatus[] = ["todo", "in-progress", "in-review", "done", "blocked"];

			for (const status of statuses) {
				const task = createTask({
					title: "Test Task",
					status,
					priority: "medium",
					labels: [],
					acceptanceCriteria: [],
				});
				expect(task.status).toBe(status);
			}
		});

		test("creates task with all priority values", () => {
			const priorities: TaskPriority[] = ["low", "medium", "high"];

			for (const priority of priorities) {
				const task = createTask({
					title: "Test Task",
					status: "todo",
					priority,
					labels: [],
					acceptanceCriteria: [],
				});
				expect(task.priority).toBe(priority);
			}
		});
	});

	describe("Acceptance Criteria", () => {
		test("creates task with multiple acceptance criteria", () => {
			const criteria: AcceptanceCriterion[] = [
				{ text: "First criterion", completed: false },
				{ text: "Second criterion", completed: true },
				{ text: "Third criterion", completed: false },
			];

			const task = createTask({
				title: "Test Task",
				status: "todo",
				priority: "medium",
				labels: [],
				acceptanceCriteria: criteria,
			});

			expect(task.acceptanceCriteria).toHaveLength(3);
			expect(task.acceptanceCriteria[0].text).toBe("First criterion");
			expect(task.acceptanceCriteria[0].completed).toBe(false);
			expect(task.acceptanceCriteria[1].completed).toBe(true);
		});
	});

	describe("Time Entries", () => {
		test("TimeEntry structure is correct", () => {
			const entry: TimeEntry = {
				id: "entry-1",
				startedAt: new Date("2025-01-01T10:00:00"),
				endedAt: new Date("2025-01-01T11:00:00"),
				duration: 3600,
				note: "Working on feature",
			};

			expect(entry.id).toBe("entry-1");
			expect(entry.startedAt.toISOString()).toContain("2025-01-01");
			expect(entry.duration).toBe(3600);
			expect(entry.note).toBe("Working on feature");
		});

		test("TimeEntry without endedAt represents active tracking", () => {
			const entry: TimeEntry = {
				id: "entry-2",
				startedAt: new Date(),
				duration: 0,
			};

			expect(entry.endedAt).toBeUndefined();
			expect(entry.note).toBeUndefined();
		});
	});
});

describe("Status Value Object", () => {
	describe("isValidTaskStatus", () => {
		test("returns true for valid statuses", () => {
			expect(isValidTaskStatus("todo")).toBe(true);
			expect(isValidTaskStatus("in-progress")).toBe(true);
			expect(isValidTaskStatus("in-review")).toBe(true);
			expect(isValidTaskStatus("done")).toBe(true);
			expect(isValidTaskStatus("blocked")).toBe(true);
		});

		test("returns false for invalid statuses", () => {
			expect(isValidTaskStatus("invalid")).toBe(false);
			expect(isValidTaskStatus("")).toBe(false);
			expect(isValidTaskStatus("TODO")).toBe(false);
			expect(isValidTaskStatus("To Do")).toBe(false);
			expect(isValidTaskStatus("in_progress")).toBe(false);
		});

		test("returns false for null-ish values", () => {
			expect(isValidTaskStatus(null as unknown as string)).toBe(false);
			expect(isValidTaskStatus(undefined as unknown as string)).toBe(false);
		});
	});
});

describe("Priority Value Object", () => {
	describe("isValidTaskPriority", () => {
		test("returns true for valid priorities", () => {
			expect(isValidTaskPriority("low")).toBe(true);
			expect(isValidTaskPriority("medium")).toBe(true);
			expect(isValidTaskPriority("high")).toBe(true);
		});

		test("returns false for invalid priorities", () => {
			expect(isValidTaskPriority("invalid")).toBe(false);
			expect(isValidTaskPriority("")).toBe(false);
			expect(isValidTaskPriority("LOW")).toBe(false);
			expect(isValidTaskPriority("Medium")).toBe(false);
			expect(isValidTaskPriority("critical")).toBe(false);
			expect(isValidTaskPriority("urgent")).toBe(false);
		});

		test("returns false for null-ish values", () => {
			expect(isValidTaskPriority(null as unknown as string)).toBe(false);
			expect(isValidTaskPriority(undefined as unknown as string)).toBe(false);
		});
	});
});
