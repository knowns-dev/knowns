/**
 * Board management MCP handlers
 */

import type { Task } from "@models/task";
import type { FileStore } from "@storage/file-store";
import { successResponse } from "../utils";

// Tool definitions
export const boardTools = [
	{
		name: "get_board",
		description: "Get current board state with tasks grouped by status",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
];

// Handlers
export async function handleGetBoard(fileStore: FileStore) {
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

	const mapTask = (t: Task) => ({
		id: t.id,
		title: t.title,
		priority: t.priority,
		assignee: t.assignee,
		labels: t.labels,
	});

	return successResponse({
		board: {
			todo: board.todo.map(mapTask),
			"in-progress": board["in-progress"].map(mapTask),
			"in-review": board["in-review"].map(mapTask),
			done: board.done.map(mapTask),
			blocked: board.blocked.map(mapTask),
		},
		totalTasks: tasks.length,
	});
}
