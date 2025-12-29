/**
 * Time tracking MCP handlers
 */

import type { FileStore } from "@storage/file-store";
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

// Handlers
export async function handleStartTime(args: unknown, fileStore: FileStore) {
	const input = startTimeSchema.parse(args);
	const task = await fileStore.getTask(input.taskId);

	if (!task) {
		return errorResponse(`Task ${input.taskId} not found`);
	}

	// Check if already tracking
	const activeEntry = task.timeEntries.find((e) => !e.endedAt);
	if (activeEntry) {
		return errorResponse("Time tracking already active for this task");
	}

	// Create new time entry
	const newEntry = {
		id: `entry-${Date.now()}`,
		startedAt: new Date(),
		duration: 0,
		note: "Started via MCP",
	};

	await fileStore.updateTask(input.taskId, {
		timeEntries: [...task.timeEntries, newEntry],
	});

	// Notify web server for real-time updates
	await notifyTaskUpdate(input.taskId);
	await notifyTimeUpdate({
		taskId: input.taskId,
		taskTitle: task.title,
		startedAt: newEntry.startedAt.toISOString(),
		pausedAt: null,
		totalPausedMs: 0,
	});

	return successResponse({
		message: `Started tracking time for task ${input.taskId}`,
		startedAt: newEntry.startedAt,
	});
}

export async function handleStopTime(args: unknown, fileStore: FileStore) {
	const input = stopTimeSchema.parse(args);
	const task = await fileStore.getTask(input.taskId);

	if (!task) {
		return errorResponse(`Task ${input.taskId} not found`);
	}

	// Find active entry
	const activeIndex = task.timeEntries.findIndex((e) => !e.endedAt);
	if (activeIndex === -1) {
		return errorResponse("No active time tracking for this task");
	}

	const endTime = new Date();
	const startTime = task.timeEntries[activeIndex].startedAt;
	const duration = Math.floor((endTime.getTime() - new Date(startTime).getTime()) / 1000);

	const updatedEntries = [...task.timeEntries];
	updatedEntries[activeIndex] = {
		...updatedEntries[activeIndex],
		endedAt: endTime,
		duration,
	};

	const newTimeSpent = task.timeSpent + duration;

	await fileStore.updateTask(input.taskId, {
		timeEntries: updatedEntries,
		timeSpent: newTimeSpent,
	});

	// Notify web server for real-time updates
	await notifyTaskUpdate(input.taskId);
	await notifyTimeUpdate(null); // Clear active timer

	return successResponse({
		message: `Stopped tracking time for task ${input.taskId}`,
		duration: formatDuration(duration),
		totalTime: formatDuration(newTimeSpent),
	});
}

export async function handleAddTime(args: unknown, fileStore: FileStore) {
	const input = addTimeSchema.parse(args);
	const task = await fileStore.getTask(input.taskId);

	if (!task) {
		return errorResponse(`Task ${input.taskId} not found`);
	}

	const duration = parseDuration(input.duration);
	const startDate = input.date ? new Date(input.date) : new Date();

	const newEntry = {
		id: `entry-${Date.now()}`,
		startedAt: startDate,
		endedAt: new Date(startDate.getTime() + duration * 1000),
		duration,
		note: input.note || "Added via MCP",
	};

	const newTimeSpent = task.timeSpent + duration;

	await fileStore.updateTask(input.taskId, {
		timeEntries: [...task.timeEntries, newEntry],
		timeSpent: newTimeSpent,
	});

	// Notify web server for real-time updates
	await notifyTaskUpdate(input.taskId);

	return successResponse({
		message: `Added ${formatDuration(duration)} to task ${input.taskId}`,
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
