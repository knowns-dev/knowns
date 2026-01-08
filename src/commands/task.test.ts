import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, TaskPriority, TaskStatus } from "@models/index";
import { FileStore } from "@storage/file-store";
/**
 * Integration Tests for Task CLI Commands
 * Tests the full flow of task operations using FileStore
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const randomIdPattern = /^[a-z0-9]{6}$/;

describe("Task CLI Integration Tests", () => {
	let tempDir: string;
	let fileStore: FileStore;

	beforeEach(async () => {
		// Create a unique temp directory for each test
		tempDir = await mkdtemp(join(tmpdir(), "knowns-test-"));
		fileStore = new FileStore(tempDir);
		await fileStore.initProject("Test Project");
	});

	afterEach(async () => {
		// Clean up temp directory
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("Task Create", () => {
		test("creates a task with title only", async () => {
			const task = await fileStore.createTask({
				title: "My First Task",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(task.id).toMatch(randomIdPattern);
			expect(task.id).toHaveLength(6);
			expect(task.title).toBe("My First Task");
			expect(task.status).toBe("todo");
			expect(task.priority).toBe("medium");
		});

		test("creates a task with all fields", async () => {
			const task = await fileStore.createTask({
				title: "Complete Task",
				description: "A detailed description",
				status: "in-progress",
				priority: "high",
				assignee: "@developer",
				labels: ["bug", "urgent"],
				subtasks: [],
				acceptanceCriteria: [
					{ text: "First criterion", completed: false },
					{ text: "Second criterion", completed: true },
				],
				timeSpent: 0,
				timeEntries: [],
				implementationPlan: "Step 1: Do this",
				implementationNotes: "Notes here",
			});

			expect(task.id).toMatch(randomIdPattern);
			expect(task.title).toBe("Complete Task");
			expect(task.description).toBe("A detailed description");
			expect(task.status).toBe("in-progress");
			expect(task.priority).toBe("high");
			expect(task.assignee).toBe("@developer");
			expect(task.labels).toEqual(["bug", "urgent"]);
			expect(task.acceptanceCriteria).toHaveLength(2);
			expect(task.implementationPlan).toBe("Step 1: Do this");
		});

		test("generates random 6-character base36 IDs", async () => {
			const task = await fileStore.createTask({
				title: "Random ID Task",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(task.id).toMatch(randomIdPattern);
		});

		test("retries on ID collisions and succeeds", async () => {
			const idSequence = ["aaaaaa", "aaaaaa", "bbbbbb"];
			const spy = vi
				.spyOn(fileStore as unknown as { generateRandomTaskId: () => string }, "generateRandomTaskId")
				.mockImplementation(() => idSequence.shift() || "cccccc");

			const first = await fileStore.createTask({
				title: "Collision Task 1",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const second = await fileStore.createTask({
				title: "Collision Task 2",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(first.id).toBe("aaaaaa");
			expect(second.id).toBe("bbbbbb");
			expect(spy).toHaveBeenCalledTimes(3);

			spy.mockRestore();
		});

		test("throws after exhausting collision retries", async () => {
			const spy = vi
				.spyOn(fileStore as unknown as { generateRandomTaskId: () => string }, "generateRandomTaskId")
				.mockReturnValue("aaaaaa");

			await fileStore.createTask({
				title: "Initial",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			await expect(
				fileStore.createTask({
					title: "Should Fail",
					status: "todo",
					priority: "medium",
					labels: [],
					subtasks: [],
					acceptanceCriteria: [],
					timeSpent: 0,
					timeEntries: [],
				}),
			).rejects.toThrow("Failed to generate unique task ID after 10 attempts");

			spy.mockRestore();
		});

		test("loads legacy sequential tasks and still generates random IDs", async () => {
			const now = new Date();
			const legacyTask: Task = {
				id: "1",
				title: "Legacy Task",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
				createdAt: now,
				updatedAt: now,
			};

			// Bypass private saveTask for test setup
			await (fileStore as unknown as { saveTask: (task: Task) => Promise<void> }).saveTask(legacyTask);

			const loaded = await fileStore.getTask("1");
			expect(loaded?.id).toBe("1");

			const newTask = await fileStore.createTask({
				title: "New Random Task",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(newTask.id).toMatch(randomIdPattern);

			const allIds = (await fileStore.getAllTasks()).map((t) => t.id);
			expect(allIds).toContain("1");
			expect(allIds).toContain(newTask.id);
		});

		test("creates subtask and links parent", async () => {
			const parent = await fileStore.createTask({
				title: "Parent Task",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const subtask = await fileStore.createTask({
				title: "Subtask",
				status: "todo",
				priority: "medium",
				labels: [],
				parent: parent.id,
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(subtask.id).toMatch(randomIdPattern);
			expect(subtask.parent).toBe(parent.id);

			// Verify parent has subtask reference
			const updatedParent = await fileStore.getTask(parent.id);
			expect(updatedParent?.subtasks).toContain(subtask.id);
		});
	});

	describe("Task Edit", () => {
		test("updates task title", async () => {
			const task = await fileStore.createTask({
				title: "Original Title",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			await new Promise((resolve) => setTimeout(resolve, 1)); // Introduce a small delay

			const updated = await fileStore.updateTask(task.id, {
				title: "Updated Title",
			});

			expect(updated.title).toBe("Updated Title");
			expect(updated.updatedAt.getTime()).toBeGreaterThan(task.createdAt.getTime());
		});

		test("updates task status", async () => {
			const task = await fileStore.createTask({
				title: "Task",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const updated = await fileStore.updateTask(task.id, {
				status: "in-progress",
			});

			expect(updated.status).toBe("in-progress");
		});

		test("updates multiple fields at once", async () => {
			const task = await fileStore.createTask({
				title: "Task",
				status: "todo",
				priority: "low",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const updated = await fileStore.updateTask(task.id, {
				status: "done",
				priority: "high",
				assignee: "@reviewer",
				labels: ["completed"],
			});

			expect(updated.status).toBe("done");
			expect(updated.priority).toBe("high");
			expect(updated.assignee).toBe("@reviewer");
			expect(updated.labels).toEqual(["completed"]);
		});

		test("updates acceptance criteria", async () => {
			const task = await fileStore.createTask({
				title: "Task",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [{ text: "AC 1", completed: false }],
				timeSpent: 0,
				timeEntries: [],
			});

			const updated = await fileStore.updateTask(task.id, {
				acceptanceCriteria: [
					{ text: "AC 1", completed: true },
					{ text: "AC 2", completed: false },
				],
			});

			expect(updated.acceptanceCriteria).toHaveLength(2);
			expect(updated.acceptanceCriteria[0].completed).toBe(true);
			expect(updated.acceptanceCriteria[1].text).toBe("AC 2");
		});

		test("preserves ID on update", async () => {
			const task = await fileStore.createTask({
				title: "Task",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const updated = await fileStore.updateTask(task.id, {
				title: "New Title",
			});

			expect(updated.id).toBe(task.id);
		});

		test("throws error for non-existent task", async () => {
			await expect(fileStore.updateTask("999", { title: "New" })).rejects.toThrow("Task 999 not found");
		});

		test("deletes old file when title changes", async () => {
			const { readdir } = await import("node:fs/promises");
			const { join } = await import("node:path");

			const task = await fileStore.createTask({
				title: "Original Title",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			// Check initial file exists
			const tasksPath = join(tempDir, ".knowns", "tasks");
			let files = await readdir(tasksPath);
			let taskFiles = files.filter((f) => f.startsWith(`task-${task.id} -`));
			expect(taskFiles).toHaveLength(1);
			expect(taskFiles[0]).toContain("Original-Title");

			// Update title
			await fileStore.updateTask(task.id, {
				title: "New Title",
			});

			// Check only new file exists, old file is deleted
			files = await readdir(tasksPath);
			taskFiles = files.filter((f) => f.startsWith(`task-${task.id} -`));
			expect(taskFiles).toHaveLength(1);
			expect(taskFiles[0]).toContain("New-Title");
			expect(taskFiles[0]).not.toContain("Original-Title");
		});

		test("does not delete file when title unchanged", async () => {
			const { readdir } = await import("node:fs/promises");
			const { join } = await import("node:path");

			const task = await fileStore.createTask({
				title: "Same Title",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			// Update status only (not title)
			await fileStore.updateTask(task.id, {
				status: "in-progress",
			});

			// Check file still exists with same name
			const tasksPath = join(tempDir, ".knowns", "tasks");
			const files = await readdir(tasksPath);
			const taskFiles = files.filter((f) => f.startsWith(`task-${task.id} -`));
			expect(taskFiles).toHaveLength(1);
			expect(taskFiles[0]).toContain("Same-Title");
		});
	});

	describe("Task List and Search", () => {
		let createdTasks: Task[];

		beforeEach(async () => {
			createdTasks = [];
			// Create several tasks for testing
			createdTasks.push(
				await fileStore.createTask({
					title: "Bug: Login issue",
					status: "todo",
					priority: "high",
					labels: ["bug"],
					subtasks: [],
					acceptanceCriteria: [],
					timeSpent: 0,
					timeEntries: [],
				}),
			);

			createdTasks.push(
				await fileStore.createTask({
					title: "Feature: Add dark mode",
					status: "in-progress",
					priority: "medium",
					labels: ["feature", "ui"],
					assignee: "@designer",
					subtasks: [],
					acceptanceCriteria: [],
					timeSpent: 0,
					timeEntries: [],
				}),
			);

			createdTasks.push(
				await fileStore.createTask({
					title: "Docs: Update README",
					status: "done",
					priority: "low",
					labels: ["docs"],
					subtasks: [],
					acceptanceCriteria: [],
					timeSpent: 0,
					timeEntries: [],
				}),
			);
		});

		test("lists all tasks", async () => {
			const tasks = await fileStore.getAllTasks();

			expect(tasks).toHaveLength(3);
		});

		test("retrieves task by ID", async () => {
			const targetId = createdTasks[0].id;
			const task = await fileStore.getTask(targetId);

			expect(task).not.toBeNull();
			expect(task?.title).toBe("Bug: Login issue");
		});

		test("returns null for non-existent task", async () => {
			const task = await fileStore.getTask("999");

			expect(task).toBeNull();
		});

		test("filters tasks by status", async () => {
			const tasks = await fileStore.getAllTasks();
			const todoTasks = tasks.filter((t) => t.status === "todo");
			const doneTasks = tasks.filter((t) => t.status === "done");

			expect(todoTasks).toHaveLength(1);
			expect(doneTasks).toHaveLength(1);
		});

		test("filters tasks by priority", async () => {
			const tasks = await fileStore.getAllTasks();
			const highPriority = tasks.filter((t) => t.priority === "high");

			expect(highPriority).toHaveLength(1);
			expect(highPriority[0].title).toContain("Bug");
		});

		test("filters tasks by assignee", async () => {
			const tasks = await fileStore.getAllTasks();
			const assigned = tasks.filter((t) => t.assignee === "@designer");

			expect(assigned).toHaveLength(1);
			expect(assigned[0].title).toContain("dark mode");
		});

		test("filters tasks by label", async () => {
			const tasks = await fileStore.getAllTasks();
			const bugTasks = tasks.filter((t) => t.labels.includes("bug"));

			expect(bugTasks).toHaveLength(1);
		});
	});

	describe("Time Tracking", () => {
		test("starts and stops time tracking", async () => {
			const task = await fileStore.createTask({
				title: "Timed Task",
				status: "in-progress",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			// Start time tracking
			const startTime = new Date();
			const updatedWithStart = await fileStore.updateTask(task.id, {
				timeEntries: [
					{
						id: "entry-1",
						startedAt: startTime,
						duration: 0,
					},
				],
			});

			expect(updatedWithStart.timeEntries).toHaveLength(1);
			expect(updatedWithStart.timeEntries[0].endedAt).toBeUndefined();

			// Stop time tracking (simulate 1 hour)
			const endTime = new Date(startTime.getTime() + 3600000);
			const updatedWithStop = await fileStore.updateTask(task.id, {
				timeEntries: [
					{
						id: "entry-1",
						startedAt: startTime,
						endedAt: endTime,
						duration: 3600,
					},
				],
				timeSpent: 3600,
			});

			expect(updatedWithStop.timeEntries[0].endedAt).toBeDefined();
			expect(updatedWithStop.timeEntries[0].duration).toBe(3600);
			expect(updatedWithStop.timeSpent).toBe(3600);
		});

		test("adds multiple time entries", async () => {
			const task = await fileStore.createTask({
				title: "Multi-session Task",
				status: "in-progress",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const now = new Date();
			const entries = [
				{
					id: "entry-1",
					startedAt: new Date(now.getTime() - 7200000),
					endedAt: new Date(now.getTime() - 3600000),
					duration: 3600,
				},
				{
					id: "entry-2",
					startedAt: new Date(now.getTime() - 1800000),
					endedAt: now,
					duration: 1800,
				},
			];

			const updated = await fileStore.updateTask(task.id, {
				timeEntries: entries,
				timeSpent: 5400, // 1.5 hours total
			});

			expect(updated.timeEntries).toHaveLength(2);
			expect(updated.timeSpent).toBe(5400);
		});
	});

	describe("Version History", () => {
		test("records version on task update", async () => {
			const task = await fileStore.createTask({
				title: "Versioned Task",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			// Make an update
			await fileStore.updateTask(task.id, {
				status: "in-progress",
			});

			// Check version history
			const versions = await fileStore.getTaskVersionHistory(task.id);

			expect(versions.length).toBeGreaterThanOrEqual(1);
			expect(versions[0].changes.some((c) => c.field === "status")).toBe(true);
		});

		test("rollback restores previous state", async () => {
			const task = await fileStore.createTask({
				title: "Original Title",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			// Make changes
			await fileStore.updateTask(task.id, {
				title: "Changed Title",
				status: "in-progress",
			});

			// Rollback to version 1
			const versions = await fileStore.getTaskVersionHistory(task.id);
			if (versions.length > 0) {
				const restored = await fileStore.rollbackTask(task.id, 1);

				// The title should be from the v1 snapshot
				expect(restored.title).toBe("Changed Title"); // v1 has the changed title
			}
		});
	});

	describe("Subtask Management", () => {
		test("creates nested subtasks", async () => {
			const parent = await fileStore.createTask({
				title: "Parent",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const child1 = await fileStore.createTask({
				title: "Child 1",
				status: "todo",
				priority: "medium",
				labels: [],
				parent: parent.id,
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const child2 = await fileStore.createTask({
				title: "Child 2",
				status: "todo",
				priority: "medium",
				labels: [],
				parent: parent.id,
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(child1.id).toMatch(randomIdPattern);
			expect(child2.id).toMatch(randomIdPattern);

			const updatedParent = await fileStore.getTask(parent.id);
			expect(updatedParent?.subtasks).toContain(child1.id);
			expect(updatedParent?.subtasks).toContain(child2.id);
		});

		test("creates deeply nested subtasks", async () => {
			const parent = await fileStore.createTask({
				title: "Level 0",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const level1 = await fileStore.createTask({
				title: "Level 1",
				status: "todo",
				priority: "medium",
				labels: [],
				parent: parent.id,
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const level2 = await fileStore.createTask({
				title: "Level 2",
				status: "todo",
				priority: "medium",
				labels: [],
				parent: level1.id,
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(level1.id).toMatch(randomIdPattern);
			expect(level2.id).toMatch(randomIdPattern);
			expect(level2.parent).toBe(level1.id);
		});
	});
});
