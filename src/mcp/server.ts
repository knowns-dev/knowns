#!/usr/bin/env bun

/**
 * MCP Server for Knowns Task Management
 * Exposes task CRUD operations and search via Model Context Protocol
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Task, TaskPriority, TaskStatus } from "@models/task";
import { FileStore } from "@storage/file-store";
import { extractDocPaths, resolveDocReferences } from "@utils/doc-links";
import matter from "gray-matter";
import { z } from "zod";

// Initialize FileStore
const fileStore = new FileStore(process.cwd());

// Helper function to parse duration strings
function parseDuration(durationStr: string): number {
	let totalSeconds = 0;

	// Match hours
	const hoursMatch = durationStr.match(/(\d+)h/);
	if (hoursMatch) {
		totalSeconds += Number.parseInt(hoursMatch[1]) * 3600;
	}

	// Match minutes
	const minutesMatch = durationStr.match(/(\d+)m/);
	if (minutesMatch) {
		totalSeconds += Number.parseInt(minutesMatch[1]) * 60;
	}

	// Match seconds
	const secondsMatch = durationStr.match(/(\d+)s/);
	if (secondsMatch) {
		totalSeconds += Number.parseInt(secondsMatch[1]);
	}

	// If no units found, assume minutes
	if (totalSeconds === 0 && /^\d+$/.test(durationStr)) {
		totalSeconds = Number.parseInt(durationStr) * 60;
	}

	return totalSeconds;
}

// Helper function to format duration
function formatDuration(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;

	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (secs > 0) parts.push(`${secs}s`);

	return parts.length > 0 ? parts.join(" ") : "0s";
}

// Helper function to fetch linked documentation
async function fetchLinkedDocs(task: Task): Promise<Array<{ path: string; title: string; content: string }>> {
	const projectRoot = process.cwd();
	const docsDir = join(projectRoot, ".knowns", "docs");

	// Combine all task content to search for doc references
	const allContent = [task.description || "", task.implementationPlan || "", task.implementationNotes || ""].join("\n");

	// Resolve doc references
	const docRefs = resolveDocReferences(allContent, projectRoot);
	const linkedDocs: Array<{ path: string; title: string; content: string }> = [];

	for (const ref of docRefs) {
		if (!ref.exists) continue;

		try {
			// Extract filename from resolved path (@.knowns/docs/filename.md)
			const filename = ref.resolvedPath.replace("@.knowns/docs/", "");
			const filepath = join(docsDir, filename);

			const fileContent = await readFile(filepath, "utf-8");
			const { data, content } = matter(fileContent);

			linkedDocs.push({
				path: ref.resolvedPath,
				title: data.title || ref.text,
				content: content.trim(),
			});
		} catch (_error) {}
	}

	return linkedDocs;
}

// Tool input schemas
const createTaskSchema = z.object({
	title: z.string(),
	description: z.string().optional(),
	status: z.enum(["todo", "in-progress", "in-review", "done", "blocked"]).optional(),
	priority: z.enum(["low", "medium", "high"]).optional(),
	assignee: z.string().optional(),
	labels: z.array(z.string()).optional(),
	parent: z.string().optional(),
});

const getTaskSchema = z.object({
	taskId: z.string(),
});

const updateTaskSchema = z.object({
	taskId: z.string(),
	title: z.string().optional(),
	description: z.string().optional(),
	status: z.enum(["todo", "in-progress", "in-review", "done", "blocked"]).optional(),
	priority: z.enum(["low", "medium", "high"]).optional(),
	assignee: z.string().optional(),
	labels: z.array(z.string()).optional(),
});

const listTasksSchema = z.object({
	status: z.string().optional(),
	priority: z.string().optional(),
	assignee: z.string().optional(),
	label: z.string().optional(),
});

const searchTasksSchema = z.object({
	query: z.string(),
});

const startTimeSchema = z.object({
	taskId: z.string(),
});

const stopTimeSchema = z.object({
	taskId: z.string(),
});

const addTimeSchema = z.object({
	taskId: z.string(),
	duration: z.string(), // e.g., "2h", "30m", "1h30m"
	note: z.string().optional(),
	date: z.string().optional(), // ISO date string
});

const getTimeReportSchema = z.object({
	from: z.string().optional(), // YYYY-MM-DD
	to: z.string().optional(), // YYYY-MM-DD
	groupBy: z.enum(["task", "label", "status"]).optional(),
});

// Initialize MCP Server
const server = new Server(
	{
		name: "knowns-mcp-server",
		version: "1.0.0",
	},
	{
		capabilities: {
			tools: {},
			resources: {},
		},
	},
);

// Tool definitions
const tools: Tool[] = [
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
	{
		name: "get_board",
		description: "Get current board state with tasks grouped by status",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
];

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
	return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;

	try {
		switch (name) {
			case "create_task": {
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

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
									task: {
										id: task.id,
										title: task.title,
										status: task.status,
										priority: task.priority,
									},
								},
								null,
								2,
							),
						},
					],
				};
			}

			case "get_task": {
				const input = getTaskSchema.parse(args);
				const task = await fileStore.getTask(input.taskId);

				if (!task) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: false,
										error: `Task ${input.taskId} not found`,
									},
									null,
									2,
								),
							},
						],
					};
				}

				// Fetch linked documentation
				const linkedDocs = await fetchLinkedDocs(task);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
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
								},
								null,
								2,
							),
						},
					],
				};
			}

			case "update_task": {
				const input = updateTaskSchema.parse(args);
				const updates: Partial<Task> = {};

				if (input.title) updates.title = input.title;
				if (input.description) updates.description = input.description;
				if (input.status) updates.status = input.status as TaskStatus;
				if (input.priority) updates.priority = input.priority as TaskPriority;
				if (input.assignee) updates.assignee = input.assignee;
				if (input.labels) updates.labels = input.labels;

				const task = await fileStore.updateTask(input.taskId, updates);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
									task: {
										id: task.id,
										title: task.title,
										status: task.status,
										priority: task.priority,
									},
								},
								null,
								2,
							),
						},
					],
				};
			}

			case "list_tasks": {
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
					tasks = tasks.filter((t) => t.labels.includes(input.label));
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
									count: tasks.length,
									tasks: tasks.map((t) => ({
										id: t.id,
										title: t.title,
										status: t.status,
										priority: t.priority,
										assignee: t.assignee,
										labels: t.labels,
									})),
								},
								null,
								2,
							),
						},
					],
				};
			}

			case "search_tasks": {
				const input = searchTasksSchema.parse(args);
				const tasks = await fileStore.getAllTasks();
				const query = input.query.toLowerCase();

				const results = tasks.filter(
					(t) =>
						t.title.toLowerCase().includes(query) ||
						t.description?.toLowerCase().includes(query) ||
						t.labels.some((l) => l.toLowerCase().includes(query)),
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
									count: results.length,
									tasks: results.map((t) => ({
										id: t.id,
										title: t.title,
										status: t.status,
										priority: t.priority,
									})),
								},
								null,
								2,
							),
						},
					],
				};
			}

			case "start_time": {
				const input = startTimeSchema.parse(args);
				const task = await fileStore.getTask(input.taskId);

				if (!task) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									success: false,
									error: `Task ${input.taskId} not found`,
								}),
							},
						],
					};
				}

				// Check if already tracking
				const activeEntry = task.timeEntries.find((e) => !e.endedAt);
				if (activeEntry) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									success: false,
									error: "Time tracking already active for this task",
								}),
							},
						],
					};
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

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Started tracking time for task ${input.taskId}`,
								startedAt: newEntry.startedAt,
							}),
						},
					],
				};
			}

			case "stop_time": {
				const input = stopTimeSchema.parse(args);
				const task = await fileStore.getTask(input.taskId);

				if (!task) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									success: false,
									error: `Task ${input.taskId} not found`,
								}),
							},
						],
					};
				}

				// Find active entry
				const activeIndex = task.timeEntries.findIndex((e) => !e.endedAt);
				if (activeIndex === -1) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									success: false,
									error: "No active time tracking for this task",
								}),
							},
						],
					};
				}

				const endTime = new Date();
				const startTime = task.timeEntries[activeIndex].startedAt;
				const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);

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

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Stopped tracking time for task ${input.taskId}`,
								duration: formatDuration(duration),
								totalTime: formatDuration(newTimeSpent),
							}),
						},
					],
				};
			}

			case "add_time": {
				const input = addTimeSchema.parse(args);
				const task = await fileStore.getTask(input.taskId);

				if (!task) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									success: false,
									error: `Task ${input.taskId} not found`,
								}),
							},
						],
					};
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

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: `Added ${formatDuration(duration)} to task ${input.taskId}`,
								totalTime: formatDuration(newTimeSpent),
							}),
						},
					],
				};
			}

			case "get_time_report": {
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

				// Group by if requested
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

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										groupBy: "label",
										data: Object.entries(grouped).map(([label, seconds]) => ({
											label,
											time: formatDuration(seconds),
											seconds,
										})),
										totalSeconds: Object.values(grouped).reduce((a, b) => a + b, 0),
									},
									null,
									2,
								),
							},
						],
					};
				}

				if (input.groupBy === "status") {
					const grouped: Record<string, number> = {};
					for (const data of taskTimeData) {
						grouped[data.status] = (grouped[data.status] || 0) + data.totalSeconds;
					}

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										groupBy: "status",
										data: Object.entries(grouped).map(([status, seconds]) => ({
											status,
											time: formatDuration(seconds),
											seconds,
										})),
										totalSeconds: Object.values(grouped).reduce((a, b) => a + b, 0),
									},
									null,
									2,
								),
							},
						],
					};
				}

				// Default: group by task
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
									groupBy: "task",
									data: taskTimeData.map((data) => ({
										taskId: data.taskId,
										title: data.title,
										status: data.status,
										time: formatDuration(data.totalSeconds),
										seconds: data.totalSeconds,
									})),
									totalSeconds: taskTimeData.reduce((sum, data) => sum + data.totalSeconds, 0),
								},
								null,
								2,
							),
						},
					],
				};
			}

			case "get_board": {
				const tasks = await fileStore.getAllTasks();

				// Group tasks by status
				const board: Record<string, Task[]> = {
					todo: [],
					"in-progress": [],
					"in-review": [],
					done: [],
					blocked: [],
				};

				for (const task of tasks) {
					if (board[task.status]) {
						board[task.status].push(task);
					}
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
									board: {
										todo: board.todo.map((t) => ({
											id: t.id,
											title: t.title,
											priority: t.priority,
											assignee: t.assignee,
											labels: t.labels,
										})),
										"in-progress": board["in-progress"].map((t) => ({
											id: t.id,
											title: t.title,
											priority: t.priority,
											assignee: t.assignee,
											labels: t.labels,
										})),
										"in-review": board["in-review"].map((t) => ({
											id: t.id,
											title: t.title,
											priority: t.priority,
											assignee: t.assignee,
											labels: t.labels,
										})),
										done: board.done.map((t) => ({
											id: t.id,
											title: t.title,
											priority: t.priority,
											assignee: t.assignee,
											labels: t.labels,
										})),
										blocked: board.blocked.map((t) => ({
											id: t.id,
											title: t.title,
											priority: t.priority,
											assignee: t.assignee,
											labels: t.labels,
										})),
									},
									totalTasks: tasks.length,
								},
								null,
								2,
							),
						},
					],
				};
			}

			default:
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: false,
								error: `Unknown tool: ${name}`,
							}),
						},
					],
				};
		}
	} catch (error) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							success: false,
							error: error instanceof Error ? error.message : String(error),
						},
						null,
						2,
					),
				},
			],
		};
	}
});

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
	const tasks = await fileStore.getAllTasks();

	return {
		resources: tasks.map((task) => ({
			uri: `knowns://task/${task.id}`,
			name: task.title,
			mimeType: "application/json",
			description: `Task #${task.id}: ${task.title}`,
		})),
	};
});

// Read resource content
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
	const uri = request.params.uri;
	const match = uri.match(/^knowns:\/\/task\/(.+)$/);

	if (!match) {
		throw new Error(`Invalid resource URI: ${uri}`);
	}

	const taskId = match[1];
	const task = await fileStore.getTask(taskId);

	if (!task) {
		throw new Error(`Task ${taskId} not found`);
	}

	return {
		contents: [
			{
				uri,
				mimeType: "application/json",
				text: JSON.stringify(task, null, 2),
			},
		],
	};
});

// Start the server
async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("Knowns MCP Server running on stdio");
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
