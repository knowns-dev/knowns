/**
 * File Store
 * Main storage class that handles .knowns/ folder
 */

import { randomInt } from "node:crypto";
import { mkdir, readdir, rename, unlink } from "node:fs/promises";
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
	private archivePath: string; // .knowns/archive/
	private projectPath: string; // .knowns/config.json
	private timeEntriesPath: string; // .knowns/time-entries.json
	private versionStore: VersionStore;

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
		this.basePath = join(projectRoot, ".knowns");
		this.tasksPath = join(this.basePath, "tasks");
		this.archivePath = join(this.basePath, "archive");
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
	 * Skipped files due to parse errors (for graceful degradation)
	 */
	private skippedFiles: Array<{ file: string; error: string }> = [];

	/**
	 * Get list of skipped files from last load
	 */
	getSkippedFiles(): Array<{ file: string; error: string }> {
		return this.skippedFiles;
	}

	/**
	 * Clear skipped files list
	 */
	clearSkippedFiles(): void {
		this.skippedFiles = [];
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

			// Reset skipped files
			this.skippedFiles = [];

			// First pass: load all tasks without subtasks
			const tasksMap = new Map<string, Task>();
			for (const taskFile of taskFiles) {
				try {
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
					} else {
						// Task parsed but no ID found
						this.skippedFiles.push({
							file: taskFile,
							error: "Missing task ID in frontmatter",
						});
					}
				} catch (parseError) {
					// Skip corrupted file gracefully
					this.skippedFiles.push({
						file: taskFile,
						error: parseError instanceof Error ? parseError.message : String(parseError),
					});
				}
			}

			// Log warning if files were skipped
			if (this.skippedFiles.length > 0) {
				console.warn(
					`⚠ Skipped ${this.skippedFiles.length} corrupted task file(s). Run "knowns task validate <id>" or "knowns task repair <id>" to fix.`,
				);
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

		// Check if title is changing - need to delete old file
		const oldFileName = updates.title && updates.title !== task.title ? await this.findTaskFile(id) : null;

		const updatedTask: Task = {
			...task,
			...updates,
			id, // Ensure ID doesn't change
			updatedAt: new Date(),
		};

		// Record version before saving
		await this.versionStore.recordVersion(id, task, updatedTask, author);

		// Delete old file if title changed (before saving new file)
		if (oldFileName) {
			const oldFilePath = join(this.tasksPath, oldFileName);
			await unlink(oldFilePath);
		}

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
	 * Archive task - move to archive folder
	 */
	async archiveTask(id: string): Promise<Task> {
		const task = await this.getTask(id);
		if (!task) {
			throw new Error(`Task ${id} not found`);
		}

		const fileName = await this.findTaskFile(id);
		if (!fileName) {
			throw new Error(`Task file for ${id} not found`);
		}

		// Create archive directory if not exists
		await mkdir(this.archivePath, { recursive: true });

		const oldPath = join(this.tasksPath, fileName);
		const newPath = join(this.archivePath, fileName);

		// Move file to archive
		await rename(oldPath, newPath);

		return task;
	}

	/**
	 * Unarchive task - restore from archive folder
	 */
	async unarchiveTask(id: string): Promise<Task | null> {
		try {
			const files = await readdir(this.archivePath);
			const taskFile = files.find((f) => f.startsWith(`task-${id} -`));

			if (!taskFile) {
				throw new Error(`Archived task ${id} not found`);
			}

			const archiveFilePath = join(this.archivePath, taskFile);
			const tasksFilePath = join(this.tasksPath, taskFile);

			// Move file back to tasks
			await rename(archiveFilePath, tasksFilePath);

			// Return the restored task
			return await this.getTask(id);
		} catch (error) {
			console.error(`Failed to unarchive task ${id}:`, error);
			throw error;
		}
	}

	/**
	 * Batch archive tasks - archive all done tasks older than specified duration
	 * @param olderThanMs - Duration in milliseconds (tasks done before now - olderThanMs will be archived)
	 * @returns Array of archived tasks
	 */
	async batchArchiveTasks(olderThanMs: number): Promise<Task[]> {
		const allTasks = await this.getAllTasks();
		const now = Date.now();
		const cutoffTime = now - olderThanMs;

		// Filter tasks that are done and updated before cutoff time
		const tasksToArchive = allTasks.filter(
			(task) => task.status === "done" && new Date(task.updatedAt).getTime() < cutoffTime,
		);

		const archivedTasks: Task[] = [];

		for (const task of tasksToArchive) {
			try {
				await this.archiveTask(task.id);
				archivedTasks.push(task);
			} catch (error) {
				console.error(`Failed to archive task ${task.id}:`, error);
			}
		}

		return archivedTasks;
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
	 * Warns if multiple files with same ID are found (indicates a bug)
	 */
	private async findTaskFile(id: string): Promise<string | null> {
		try {
			const files = await readdir(this.tasksPath);
			const matchingFiles = files.filter((f) => f.startsWith(`task-${id} -`));

			if (matchingFiles.length > 1) {
				console.warn(
					`Warning: Found ${matchingFiles.length} files for task-${id}. ` +
						`This may cause data inconsistency. Files: ${matchingFiles.join(", ")}`,
				);
			}

			return matchingFiles[0] || null;
		} catch (_error) {
			return null;
		}
	}

	/**
	 * Generate a unique task ID (task-{6_char_base36}) with collision retries
	 */
	private async generateTaskId(parentId?: string): Promise<string> {
		const tasks = await this.getAllTasks();
		const existingIds = new Set(tasks.map((t) => t.id));

		const maxAttempts = 10;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const candidate = this.generateRandomTaskId();
			if (!existingIds.has(candidate)) {
				return candidate;
			}
		}

		throw new Error("Failed to generate unique task ID after 10 attempts");
	}

	/**
	 * Create a 6-character base36 task ID
	 */
	private generateRandomTaskId(): string {
		const max = 36 ** 6; // 6-char base36 space
		const value = randomInt(0, max); // upper bound exclusive
		return value.toString(36).padStart(6, "0");
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
