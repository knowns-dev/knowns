/**
 * Version Store
 * Handles version history storage for tasks
 */

import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Task, TaskChange, TaskVersion, TaskVersionHistory } from "@models/index";
import { TRACKED_FIELDS, createTaskDiff, createVersion, createVersionHistory } from "@models/index";
import { file, write } from "../utils/bun-compat";

export class VersionStore {
	private versionsPath: string; // .knowns/versions/

	constructor(projectRoot: string) {
		this.versionsPath = join(projectRoot, ".knowns", "versions");
	}

	/**
	 * Initialize version storage
	 */
	async init(): Promise<void> {
		await mkdir(this.versionsPath, { recursive: true });
	}

	/**
	 * Get version history file path for a task
	 */
	private getVersionFilePath(taskId: string): string {
		return join(this.versionsPath, `task-${taskId}.json`);
	}

	/**
	 * Load version history for a task
	 */
	async getVersionHistory(taskId: string): Promise<TaskVersionHistory> {
		try {
			const filePath = this.getVersionFilePath(taskId);
			const f = file(filePath);

			if (await f.exists()) {
				const content = await f.text();
				const data = JSON.parse(content);
				// Parse dates in versions
				return {
					...data,
					versions: data.versions.map((v: TaskVersion) => ({
						...v,
						timestamp: new Date(v.timestamp),
					})),
				};
			}
		} catch {
			// File doesn't exist or is invalid, return empty history
		}

		return createVersionHistory(taskId);
	}

	/**
	 * Save version history for a task
	 */
	private async saveVersionHistory(history: TaskVersionHistory): Promise<void> {
		const filePath = this.getVersionFilePath(history.taskId);
		await write(filePath, JSON.stringify(history, null, 2));
	}

	/**
	 * Create a new version when a task is updated
	 */
	async recordVersion(
		taskId: string,
		oldTask: Partial<Task>,
		newTask: Partial<Task>,
		author?: string,
	): Promise<TaskVersion | null> {
		// Calculate diff
		const changes = createTaskDiff(oldTask, newTask);

		// Only create version if there are actual changes
		if (changes.length === 0) {
			return null;
		}

		// Load existing history
		const history = await this.getVersionHistory(taskId);

		// Create snapshot of tracked fields
		const snapshot: Partial<Task> = {};
		for (const field of TRACKED_FIELDS) {
			if (newTask[field] !== undefined) {
				(snapshot as Record<string, unknown>)[field] = newTask[field];
			}
		}

		// Create new version
		const version = createVersion(taskId, history.currentVersion + 1, changes, snapshot, author);

		// Update history
		history.versions.push(version);
		history.currentVersion = version.version;

		// Save
		await this.saveVersionHistory(history);

		return version;
	}

	/**
	 * Get a specific version
	 */
	async getVersion(taskId: string, versionNumber: number): Promise<TaskVersion | null> {
		const history = await this.getVersionHistory(taskId);
		return history.versions.find((v) => v.version === versionNumber) || null;
	}

	/**
	 * Get all versions for a task
	 */
	async getVersions(taskId: string): Promise<TaskVersion[]> {
		const history = await this.getVersionHistory(taskId);
		return history.versions;
	}

	/**
	 * Get the latest version number
	 */
	async getCurrentVersion(taskId: string): Promise<number> {
		const history = await this.getVersionHistory(taskId);
		return history.currentVersion;
	}

	/**
	 * Get changes between two versions
	 */
	async getChangesBetween(taskId: string, fromVersion: number, toVersion: number): Promise<TaskChange[]> {
		const history = await this.getVersionHistory(taskId);

		const allChanges: TaskChange[] = [];
		for (const version of history.versions) {
			if (version.version > fromVersion && version.version <= toVersion) {
				allChanges.push(...version.changes);
			}
		}

		return allChanges;
	}

	/**
	 * Get snapshot at a specific version
	 */
	async getSnapshotAt(taskId: string, versionNumber: number): Promise<Partial<Task> | null> {
		const version = await this.getVersion(taskId, versionNumber);
		return version?.snapshot || null;
	}

	/**
	 * Delete version history for a task
	 */
	async deleteVersionHistory(taskId: string): Promise<void> {
		const filePath = this.getVersionFilePath(taskId);
		try {
			const f = file(filePath);
			if (await f.exists()) {
				await unlink(filePath);
			}
		} catch {
			// Ignore errors
		}
	}
}
