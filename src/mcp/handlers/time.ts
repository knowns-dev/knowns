/**
 * Time tracking MCP handlers
 * Supports multiple concurrent timers (one per task)
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileStore } from "@storage/file-store";
import { normalizeTaskId } from "@utils/normalize-id";
import { notifyTaskUpdate, notifyTimeUpdate } from "@utils/notify-server";
import { z } from "zod";
import { errorResponse, formatDuration, parseDuration, successResponse } from "../utils";

// Schemas
export const startTimeSchema = z.object({
	taskId: z.string(),
});

export const stopTimeSchema = z.object({
	taskId: z.string(),
});

export const addTimeSchema = z.object({
	taskId: z.string(),
	duration: z.string(), // e.g., "2h", "30m", "1h30m"
	note: z.string().optional(),
	date: z.string().optional(), // ISO date string
});

export const getTimeReportSchema = z.object({
	from: z.string().optional(), // YYYY-MM-DD
	to: z.string().optional(), // YYYY-MM-DD
	groupBy: z.enum(["task", "label", "status"]).optional(),
});

// Tool definitions
export const timeTools = [
	{
		name: "start_time",
		description: "Start time tracking for a task",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "Task ID to track time for" },
			},
			required: ["taskId"],
		},
	},
	{
		name: "stop_time",
		description: "Stop time tracking for a task",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "Task ID to stop tracking" },
			},
			required: ["taskId"],
		},
	},
	{
		name: "add_time",
		description: "Manually add a time entry to a task",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "Task ID" },
				duration: {
					type: "string",
					description: "Duration (e.g., '2h', '30m', '1h30m')",
				},
				note: { type: "string", description: "Optional note for this entry" },
				date: {
					type: "string",
					description: "Optional date (YYYY-MM-DD, defaults to now)",
				},
			},
			required: ["taskId", "duration"],
		},
	},
	{
		name: "get_time_report",
		description: "Get time tracking report with optional filtering and grouping",
		inputSchema: {
			type: "object",
			properties: {
				from: { type: "string", description: "Start date (YYYY-MM-DD)" },
				to: { type: "string", description: "End date (YYYY-MM-DD)" },
				groupBy: {
					type: "string",
					enum: ["task", "label", "status"],
					description: "Group results by task, label, or status",
				},
			},
		},
	},
];

// Active timer types
interface ActiveTimer {
	taskId: string;
	taskTitle?: string;
	startedAt: string;
	pausedAt: string | null;
	totalPausedMs: number;
}

interface TimeData {
	active: ActiveTimer[];
}

/**
 * Load time data from file with migration from old format
 */
async function loadTimeData(projectRoot: string): Promise<TimeData> {
	const timePath = join(projectRoot, ".knowns", "time.json");
	if (!existsSync(timePath)) {
		return { active: [] };
	}
	const content = await readFile(timePath, "utf-8");
	const data = JSON.parse(content);

	// Migrate from old format
	if (data.active && !Array.isArray(data.active)) {
		return { active: [data.active] };
	}

	if (data.active === null) {
		return { active: [] };
	}

	return data;
}

/**
 * Save time data to file
 */
async function saveTimeData(projectRoot: string, data: TimeData): Promise<void> {
	const timePath = join(projectRoot, ".knowns", "time.json");
	await writeFile(timePath, JSON.stringify(data, null, 2), "utf-8");
}

// Handlers
export async function handleStartTime(args: unknown, fileStore: FileStore) {
	const input = startTimeSchema.parse(args);
	const taskId = normalizeTaskId(input.taskId);
	const task = await fileStore.getTask(taskId);

	if (!task) {
		return errorResponse(`Task ${taskId} not found`);
	}

	// Load time data
	const data = await loadTimeData(fileStore.projectRoot);

	// Check if timer already running for this task
	const existingTimer = data.active.find((t) => t.taskId === taskId);
	if (existingTimer) {
		return errorResponse(`Timer already running for task ${taskId}`);
	}

	// Add new timer
	const newTimer: ActiveTimer = {
		taskId,
		taskTitle: task.title,
		startedAt: new Date().toISOString(),
		pausedAt: null,
		totalPausedMs: 0,
	};
	data.active.push(newTimer);
	await saveTimeData(fileStore.projectRoot, data);

	// Notify web server for real-time updates
	await notifyTaskUpdate(taskId);
	await notifyTimeUpdate(data.active);

	return successResponse({
		message: `Started tracking time for task ${taskId}`,
		startedAt: newTimer.startedAt,
		activeTimers: data.active.length,
	});
}

export async function handleStopTime(args: unknown, fileStore: FileStore) {
	const input = stopTimeSchema.parse(args);
	const taskId = normalizeTaskId(input.taskId);
	const task = await fileStore.getTask(taskId);

	if (!task) {
		return errorResponse(`Task ${taskId} not found`);
	}

	// Load time data
	const data = await loadTimeData(fileStore.projectRoot);

	// Find timer for this task
	const timerIndex = data.active.findIndex((t) => t.taskId === taskId);
	if (timerIndex === -1) {
		return errorResponse(`No active timer for task ${taskId}`);
	}

	const timer = data.active[timerIndex];
	const { startedAt, pausedAt, totalPausedMs } = timer;

	// Calculate duration
	const endTime = pausedAt ? new Date(pausedAt) : new Date();
	const elapsed = endTime.getTime() - new Date(startedAt).getTime() - totalPausedMs;
	const duration = Math.floor(elapsed / 1000);

	// Save time entry to task
	const newEntry = {
		id: `te-${Date.now()}-${taskId}`,
		startedAt: new Date(startedAt),
		endedAt: endTime,
		duration,
	};

	const newTimeSpent = task.timeSpent + duration;

	await fileStore.updateTask(taskId, {
		timeEntries: [...task.timeEntries, newEntry],
		timeSpent: newTimeSpent,
	});

	// Remove timer from active list
	data.active.splice(timerIndex, 1);
	await saveTimeData(fileStore.projectRoot, data);

	// Notify web server for real-time updates
	await notifyTaskUpdate(taskId);
	await notifyTimeUpdate(data.active.length > 0 ? data.active : null);

	return successResponse({
		message: `Stopped tracking time for task ${taskId}`,
		duration: formatDuration(duration),
		totalTime: formatDuration(newTimeSpent),
		activeTimers: data.active.length,
	});
}

export async function handleAddTime(args: unknown, fileStore: FileStore) {
	const input = addTimeSchema.parse(args);
	const taskId = normalizeTaskId(input.taskId);
	const task = await fileStore.getTask(taskId);

	if (!task) {
		return errorResponse(`Task ${taskId} not found`);
	}

	const duration = parseDuration(input.duration);
	const startDate = input.date ? new Date(input.date) : new Date();

	const newEntry = {
		id: `te-${Date.now()}`,
		startedAt: startDate,
		endedAt: new Date(startDate.getTime() + duration * 1000),
		duration,
		note: input.note || "Added via MCP",
	};

	const newTimeSpent = task.timeSpent + duration;

	await fileStore.updateTask(taskId, {
		timeEntries: [...task.timeEntries, newEntry],
		timeSpent: newTimeSpent,
	});

	// Notify web server for real-time updates
	await notifyTaskUpdate(taskId);

	return successResponse({
		message: `Added ${formatDuration(duration)} to task ${taskId}`,
		totalTime: formatDuration(newTimeSpent),
	});
}

export async function handleGetTimeReport(args: unknown, fileStore: FileStore) {
	const input = getTimeReportSchema.parse(args);
	const tasks = await fileStore.getAllTasks();

	// Filter by date range if provided
	let fromDate: Date | undefined;
	let toDate: Date | undefined;
	if (input.from) fromDate = new Date(input.from);
	if (input.to) toDate = new Date(input.to);

	// Calculate time per task
	const taskTimeData = tasks
		.map((task) => {
			let totalSeconds = 0;

			for (const entry of task.timeEntries) {
				if (entry.endedAt) {
					const entryDate = new Date(entry.startedAt);
					if (fromDate && entryDate < fromDate) continue;
					if (toDate && entryDate > toDate) continue;
					totalSeconds += entry.duration;
				}
			}

			return {
				taskId: task.id,
				title: task.title,
				status: task.status,
				labels: task.labels,
				totalSeconds,
			};
		})
		.filter((data) => data.totalSeconds > 0);

	// Group by label
	if (input.groupBy === "label") {
		const grouped: Record<string, number> = {};
		for (const data of taskTimeData) {
			for (const label of data.labels) {
				grouped[label] = (grouped[label] || 0) + data.totalSeconds;
			}
			if (data.labels.length === 0) {
				grouped["(no label)"] = (grouped["(no label)"] || 0) + data.totalSeconds;
			}
		}

		return successResponse({
			groupBy: "label",
			data: Object.entries(grouped).map(([label, seconds]) => ({
				label,
				time: formatDuration(seconds),
				seconds,
			})),
			totalSeconds: Object.values(grouped).reduce((a, b) => a + b, 0),
		});
	}

	// Group by status
	if (input.groupBy === "status") {
		const grouped: Record<string, number> = {};
		for (const data of taskTimeData) {
			grouped[data.status] = (grouped[data.status] || 0) + data.totalSeconds;
		}

		return successResponse({
			groupBy: "status",
			data: Object.entries(grouped).map(([status, seconds]) => ({
				status,
				time: formatDuration(seconds),
				seconds,
			})),
			totalSeconds: Object.values(grouped).reduce((a, b) => a + b, 0),
		});
	}

	// Default: group by task
	return successResponse({
		groupBy: "task",
		data: taskTimeData.map((data) => ({
			taskId: data.taskId,
			title: data.title,
			status: data.status,
			time: formatDuration(data.totalSeconds),
			seconds: data.totalSeconds,
		})),
		totalSeconds: taskTimeData.reduce((sum, data) => sum + data.totalSeconds, 0),
	});
}
