/**
 * File Store
 * Main storage class that handles .knowns/ folder
 */

import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Project, ProjectSettings, Task, TaskVersion } from "@models/index";
import { applyVersionSnapshot, createProject } from "@models/index";
import { file, write } from "../utils/bun-compat";
import { parseTaskMarkdown, serializeTaskMarkdown } from "./markdown";
import { VersionStore } from "./version-store";

export class FileStore {
	public readonly projectRoot: string;
	private basePath: string; // .knowns/
	private tasksPath: string; // .knowns/tasks/
	private projectPath: string; // .knowns/config.json
	private timeEntriesPath: string; // .knowns/time-entries.json
	private versionStore: VersionStore;

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
		this.basePath = join(projectRoot, ".knowns");
		this.tasksPath = join(this.basePath, "tasks");
		this.projectPath = join(this.basePath, "config.json");
		this.timeEntriesPath = join(this.basePath, "time-entries.json");
		this.versionStore = new VersionStore(projectRoot);
	}

	/**
	 * Load time entries for all tasks
	 */
	private async loadTimeEntries(): Promise<Record<string, Task["timeEntries"]>> {
		try {
			const f = file(this.timeEntriesPath);
			if (await f.exists()) {
				const content = await f.text();
				return JSON.parse(content);
			}
		} catch {
			// Ignore errors, return empty
		}
		return {};
	}

	/**
	 * Save time entries for all tasks
	 */
	private async saveTimeEntries(entries: Record<string, Task["timeEntries"]>): Promise<void> {
		await write(this.timeEntriesPath, JSON.stringify(entries, null, 2));
	}

	/**
	 * Initialize project structure
	 */
	async initProject(name: string, settings?: Partial<ProjectSettings>): Promise<Project> {
		// Create directories
		await mkdir(this.basePath, { recursive: true });
		await mkdir(this.tasksPath, { recursive: true });

		// Initialize version store
		await this.versionStore.init();

		// Create project config
		const project = createProject(name, undefined, settings);
		await this.saveProject(project);

		return project;
	}

	/**
	 * Get project configuration
	 */
	async getProject(): Promise<Project | null> {
		try {
			const f = file(this.projectPath);
			if (!(await f.exists())) {
				return null;
			}

			const content = await f.text();
			const data = JSON.parse(content);
			return {
				...data,
				createdAt: new Date(data.createdAt),
			};
		} catch (error) {
			console.error("Failed to load project:", error);
			return null;
		}
	}

	/**
	 * Save project configuration
	 */
	private async saveProject(project: Project): Promise<void> {
		await write(this.projectPath, JSON.stringify(project, null, 2));
	}

	/**
	 * Create a new task
	 */
	async createTask(taskData: Omit<Task, "id" | "createdAt" | "updatedAt">): Promise<Task> {
		// Generate task ID
		const id = await this.generateTaskId(taskData.parent);

		const now = new Date();
		const task: Task = {
			...taskData,
			id,
			labels: taskData.labels || [],
			subtasks: taskData.subtasks || [],
			acceptanceCriteria: taskData.acceptanceCriteria || [],
			timeSpent: taskData.timeSpent ?? 0,
			timeEntries: taskData.timeEntries || [],
			createdAt: now,
			updatedAt: now,
		};

		// Save task file
		await this.saveTask(task);

		// Update parent if this is a subtask
		if (task.parent) {
			await this.addSubtask(task.parent, id);
		}

		return task;
	}

	/**
	 * Get task by ID
	 */
	async getTask(id: string): Promise<Task | null> {
		try {
			const fileName = await this.findTaskFile(id);
			if (!fileName) {
				return null;
			}

			const filePath = join(this.tasksPath, fileName);
			const f = file(filePath);
			const content = await f.text();

			const taskData = parseTaskMarkdown(content);

			// Load subtasks
			const subtasks = await this.getSubtasks(id);

			// Load time entries
			const allTimeEntries = await this.loadTimeEntries();
			const timeEntries = (allTimeEntries[id] || []).map((e) => ({
				...e,
				startedAt: new Date(e.startedAt),
				endedAt: e.endedAt ? new Date(e.endedAt) : undefined,
			}));

			return {
				...taskData,
				id,
				subtasks: subtasks.map((t) => t.id),
				timeEntries,
			} as Task;
		} catch (error) {
			console.error(`Failed to load task ${id}:`, error);
			return null;
		}
	}

	/**
	 * Get all tasks
	 */
	async getAllTasks(): Promise<Task[]> {
		try {
			const files = await readdir(this.tasksPath);
			const taskFiles = files.filter((f) => f.startsWith("task-") && f.endsWith(".md"));

			// Load time entries once for all tasks
			const allTimeEntries = await this.loadTimeEntries();

			// First pass: load all tasks without subtasks
			const tasksMap = new Map<string, Task>();
			for (const taskFile of taskFiles) {
				const filePath = join(this.tasksPath, taskFile);
				const content = await file(filePath).text();
				const taskData = parseTaskMarkdown(content);
				if (taskData.id) {
					// Load time entries for this task
					const timeEntries = (allTimeEntries[taskData.id] || []).map((e) => ({
						...e,
						startedAt: new Date(e.startedAt),
						endedAt: e.endedAt ? new Date(e.endedAt) : undefined,
					}));

					tasksMap.set(taskData.id, {
						...taskData,
						subtasks: [],
						timeEntries,
					} as Task);
				}
			}

			// Second pass: build subtasks arrays
			for (const task of tasksMap.values()) {
				const subtasks: string[] = [];
				for (const otherTask of tasksMap.values()) {
					if (otherTask.parent === task.id) {
						subtasks.push(otherTask.id);
					}
				}
				task.subtasks = subtasks;
			}

			return Array.from(tasksMap.values());
		} catch (error) {
			console.error("Failed to load tasks:", error);
			return [];
		}
	}

	/**
	 * Update task
	 */
	async updateTask(id: string, updates: Partial<Task>, author?: string): Promise<Task> {
		const task = await this.getTask(id);
		if (!task) {
			throw new Error(`Task ${id} not found`);
		}

		// Handle parent change
		const oldParent = task.parent;
		const newParent = updates.parent;

		// If parent changed, update parent-child relationships
		if (oldParent !== newParent) {
			// Remove from old parent's subtasks
			if (oldParent) {
				await this.removeSubtask(oldParent, id);
			}

			// Add to new parent's subtasks
			if (newParent) {
				await this.addSubtask(newParent, id);
			}
		}

		const updatedTask: Task = {
			...task,
			...updates,
			id, // Ensure ID doesn't change
			updatedAt: new Date(),
		};

		// Record version before saving
		await this.versionStore.recordVersion(id, task, updatedTask, author);

		await this.saveTask(updatedTask);

		// Save time entries if they were updated
		if (updates.timeEntries !== undefined) {
			const allTimeEntries = await this.loadTimeEntries();
			allTimeEntries[id] = updates.timeEntries;
			await this.saveTimeEntries(allTimeEntries);
		}

		return updatedTask;
	}

	/**
	 * Delete task
	 */
	async deleteTask(id: string): Promise<void> {
		const fileName = await this.findTaskFile(id);
		if (!fileName) {
			throw new Error(`Task ${id} not found`);
		}

		const filePath = join(this.tasksPath, fileName);
		await unlink(filePath);
	}

	/**
	 * Save task to file
	 */
	private async saveTask(task: Task): Promise<void> {
		const content = serializeTaskMarkdown(task);
		const fileName = this.getTaskFileName(task);
		const filePath = join(this.tasksPath, fileName);
		await write(filePath, content);
	}

	/**
	 * Generate task file name
	 */
	private getTaskFileName(task: Task): string {
		const sanitizedTitle = task.title.replace(/[^a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "-");
		return `task-${task.id} - ${sanitizedTitle}.md`;
	}

	/**
	 * Find task file by ID
	 */
	private async findTaskFile(id: string): Promise<string | null> {
		try {
			const files = await readdir(this.tasksPath);
			return files.find((f) => f.startsWith(`task-${id} -`)) || null;
		} catch (_error) {
			return null;
		}
	}

	/**
	 * Generate next task ID
	 */
	private async generateTaskId(parentId?: string): Promise<string> {
		const tasks = await this.getAllTasks();

		if (parentId) {
			// Generate subtask ID (e.g., 7.1, 7.1.1)
			const siblings = tasks.filter((t) => t.parent === parentId);
			const maxSubId =
				siblings.length > 0 ? Math.max(...siblings.map((t) => Number.parseInt(t.id.split(".").pop() || "0"))) : 0;
			return `${parentId}.${maxSubId + 1}`;
		}

		// Generate top-level task ID
		const topLevelTasks = tasks.filter((t) => !t.parent);
		const maxId =
			topLevelTasks.length > 0 ? Math.max(...topLevelTasks.map((t) => Number.parseInt(t.id.split(".")[0] || "0"))) : 0;
		return `${maxId + 1}`;
	}

	/**
	 * Get subtasks of a task
	 */
	private async getSubtasks(parentId: string): Promise<Task[]> {
		const allTasks = await this.getAllTasks();
		return allTasks.filter((t) => t.parent === parentId);
	}

	/**
	 * Add subtask to parent
	 */
	private async addSubtask(parentId: string, subtaskId: string): Promise<void> {
		const parent = await this.getTask(parentId);
		if (!parent) {
			throw new Error(`Parent task ${parentId} not found`);
		}

		if (!parent.subtasks.includes(subtaskId)) {
			parent.subtasks.push(subtaskId);
			await this.saveTask(parent);
		}
	}

	/**
	 * Remove subtask from parent
	 */
	private async removeSubtask(parentId: string, subtaskId: string): Promise<void> {
		const parent = await this.getTask(parentId);
		if (!parent) {
			throw new Error(`Parent task ${parentId} not found`);
		}

		const index = parent.subtasks.indexOf(subtaskId);
		if (index > -1) {
			parent.subtasks.splice(index, 1);
			await this.saveTask(parent);
		}
	}

	// ==================== Version History Methods ====================

	/**
	 * Get version history for a task
	 */
	async getTaskVersionHistory(taskId: string): Promise<TaskVersion[]> {
		return this.versionStore.getVersions(taskId);
	}

	/**
	 * Get a specific version of a task
	 */
	async getTaskVersion(taskId: string, versionNumber: number): Promise<TaskVersion | null> {
		return this.versionStore.getVersion(taskId, versionNumber);
	}

	/**
	 * Get the current version number for a task
	 */
	async getTaskCurrentVersion(taskId: string): Promise<number> {
		return this.versionStore.getCurrentVersion(taskId);
	}

	/**
	 * Rollback a task to a previous version
	 */
	async rollbackTask(taskId: string, versionNumber: number, author?: string): Promise<Task> {
		const task = await this.getTask(taskId);
		if (!task) {
			throw new Error(`Task ${taskId} not found`);
		}

		const snapshot = await this.versionStore.getSnapshotAt(taskId, versionNumber);
		if (!snapshot) {
			throw new Error(`Version ${versionNumber} not found for task ${taskId}`);
		}

		// Apply snapshot to current task
		const restoredTask = applyVersionSnapshot(task, snapshot);

		// Record this rollback as a new version
		await this.versionStore.recordVersion(taskId, task, restoredTask, author || "rollback");

		// Save the restored task
		await this.saveTask(restoredTask);

		return restoredTask;
	}
}
