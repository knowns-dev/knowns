/**
 * Task management MCP handlers
 */

import type { Task, TaskPriority, TaskStatus } from "@models/task";
import type { FileStore } from "@storage/file-store";
import { notifyTaskUpdate } from "@utils/notify-server";
import { z } from "zod";
import { errorResponse, fetchLinkedDocs, successResponse } from "../utils";

// Schemas
export const createTaskSchema = z.object({
	title: z.string(),
	description: z.string().optional(),
	status: z.enum(["todo", "in-progress", "in-review", "done", "blocked"]).optional(),
	priority: z.enum(["low", "medium", "high"]).optional(),
	assignee: z.string().optional(),
	labels: z.array(z.string()).optional(),
	parent: z.string().optional(),
});

export const getTaskSchema = z.object({
	taskId: z.string(),
});

export const updateTaskSchema = z.object({
	taskId: z.string(),
	title: z.string().optional(),
	description: z.string().optional(),
	status: z.enum(["todo", "in-progress", "in-review", "done", "blocked"]).optional(),
	priority: z.enum(["low", "medium", "high"]).optional(),
	assignee: z.string().optional(),
	labels: z.array(z.string()).optional(),
});

export const listTasksSchema = z.object({
	status: z.string().optional(),
	priority: z.string().optional(),
	assignee: z.string().optional(),
	label: z.string().optional(),
});

export const searchTasksSchema = z.object({
	query: z.string(),
});

// Tool definitions
export const taskTools = [
	{
		name: "create_task",
		description: "Create a new task with title and optional description, status, priority, labels, and assignee",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string", description: "Task title" },
				description: { type: "string", description: "Task description" },
				status: {
					type: "string",
					enum: ["todo", "in-progress", "in-review", "done", "blocked"],
					description: "Task status",
				},
				priority: {
					type: "string",
					enum: ["low", "medium", "high"],
					description: "Task priority",
				},
				assignee: { type: "string", description: "Task assignee" },
				labels: {
					type: "array",
					items: { type: "string" },
					description: "Task labels",
				},
				parent: { type: "string", description: "Parent task ID for subtasks" },
			},
			required: ["title"],
		},
	},
	{
		name: "get_task",
		description: "Get a task by ID",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "Task ID to retrieve" },
			},
			required: ["taskId"],
		},
	},
	{
		name: "update_task",
		description: "Update task fields",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "Task ID to update" },
				title: { type: "string", description: "New title" },
				description: { type: "string", description: "New description" },
				status: {
					type: "string",
					enum: ["todo", "in-progress", "in-review", "done", "blocked"],
					description: "New status",
				},
				priority: {
					type: "string",
					enum: ["low", "medium", "high"],
					description: "New priority",
				},
				assignee: { type: "string", description: "New assignee" },
				labels: {
					type: "array",
					items: { type: "string" },
					description: "New labels",
				},
			},
			required: ["taskId"],
		},
	},
	{
		name: "list_tasks",
		description: "List tasks with optional filters",
		inputSchema: {
			type: "object",
			properties: {
				status: { type: "string", description: "Filter by status" },
				priority: { type: "string", description: "Filter by priority" },
				assignee: { type: "string", description: "Filter by assignee" },
				label: { type: "string", description: "Filter by label" },
			},
		},
	},
	{
		name: "search_tasks",
		description: "Search tasks by query string",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
			},
			required: ["query"],
		},
	},
];

// Handlers
export async function handleCreateTask(args: unknown, fileStore: FileStore) {
	const input = createTaskSchema.parse(args);
	const task = await fileStore.createTask({
		title: input.title,
		description: input.description,
		status: (input.status as TaskStatus) || "todo",
		priority: (input.priority as TaskPriority) || "medium",
		assignee: input.assignee,
		labels: input.labels || [],
		parent: input.parent,
		subtasks: [],
		acceptanceCriteria: [],
		timeSpent: 0,
		timeEntries: [],
	});

	// Notify web server for real-time updates
	await notifyTaskUpdate(task.id);

	return successResponse({
		task: {
			id: task.id,
			title: task.title,
			status: task.status,
			priority: task.priority,
		},
	});
}

export async function handleGetTask(args: unknown, fileStore: FileStore) {
	const input = getTaskSchema.parse(args);
	const task = await fileStore.getTask(input.taskId);

	if (!task) {
		return errorResponse(`Task ${input.taskId} not found`);
	}

	// Fetch linked documentation
	const linkedDocs = await fetchLinkedDocs(task);

	return successResponse({
		task: {
			id: task.id,
			title: task.title,
			description: task.description,
			status: task.status,
			priority: task.priority,
			assignee: task.assignee,
			labels: task.labels,
			acceptanceCriteria: task.acceptanceCriteria,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt,
			linkedDocumentation: linkedDocs,
		},
	});
}

export async function handleUpdateTask(args: unknown, fileStore: FileStore) {
	const input = updateTaskSchema.parse(args);
	const updates: Partial<Task> = {};

	if (input.title) updates.title = input.title;
	if (input.description) updates.description = input.description;
	if (input.status) updates.status = input.status as TaskStatus;
	if (input.priority) updates.priority = input.priority as TaskPriority;
	if (input.assignee) updates.assignee = input.assignee;
	if (input.labels) updates.labels = input.labels;

	const task = await fileStore.updateTask(input.taskId, updates);

	// Notify web server for real-time updates
	await notifyTaskUpdate(task.id);

	return successResponse({
		task: {
			id: task.id,
			title: task.title,
			status: task.status,
			priority: task.priority,
		},
	});
}

export async function handleListTasks(args: unknown, fileStore: FileStore) {
	const input = listTasksSchema.parse(args);
	let tasks = await fileStore.getAllTasks();

	// Apply filters
	if (input.status) {
		tasks = tasks.filter((t) => t.status === input.status);
	}
	if (input.priority) {
		tasks = tasks.filter((t) => t.priority === input.priority);
	}
	if (input.assignee) {
		tasks = tasks.filter((t) => t.assignee === input.assignee);
	}
	if (input.label) {
		tasks = tasks.filter((t) => t.labels.includes(input.label as string));
	}

	return successResponse({
		count: tasks.length,
		tasks: tasks.map((t) => ({
			id: t.id,
			title: t.title,
			status: t.status,
			priority: t.priority,
			assignee: t.assignee,
			labels: t.labels,
		})),
	});
}

export async function handleSearchTasks(args: unknown, fileStore: FileStore) {
	const input = searchTasksSchema.parse(args);
	const tasks = await fileStore.getAllTasks();
	const query = input.query.toLowerCase();

	const results = tasks.filter(
		(t) =>
			t.title.toLowerCase().includes(query) ||
			t.description?.toLowerCase().includes(query) ||
			t.labels.some((l) => l.toLowerCase().includes(query)),
	);

	return successResponse({
		count: results.length,
		tasks: results.map((t) => ({
			id: t.id,
			title: t.title,
			status: t.status,
			priority: t.priority,
		})),
	});
}
