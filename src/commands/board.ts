/**
 * Board Command
 * Display Kanban board with task columns
 */

import type { Task, TaskStatus } from "@models/task";
import { FileStore } from "@storage/file-store";
import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";

/**
 * Get FileStore instance for current project
 */
function getFileStore(): FileStore {
	const projectRoot = findProjectRoot();
	if (!projectRoot) {
		console.error(chalk.red("✗ Not a knowns project"));
		console.error(chalk.gray('  Run "knowns init" to initialize'));
		process.exit(1);
	}
	return new FileStore(projectRoot);
}

/**
 * Format time spent in human-readable format
 */
function formatTimeSpent(seconds: number): string {
	if (seconds === 0) return "";
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) {
		return `${hours}h${minutes}m`;
	}
	return `${minutes}m`;
}

/**
 * Truncate text to max length with ellipsis
 */
function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength - 1)}…`;
}

/**
 * Get status color
 */
function getStatusColor(status: TaskStatus) {
	switch (status) {
		case "done":
			return chalk.green;
		case "in-progress":
			return chalk.yellow;
		case "in-review":
			return chalk.cyan;
		case "blocked":
			return chalk.red;
		default:
			return chalk.gray;
	}
}

/**
 * Print board in plain text format (AI-friendly)
 */
function printPlainBoard(columns: Record<TaskStatus, Task[]>): void {
	const statuses: TaskStatus[] = ["todo", "in-progress", "in-review", "done"];

	for (const status of statuses) {
		console.log(`[${status}]`);
		for (const task of columns[status]) {
			// Remove @ prefix if already present in assignee
			const assignee = task.assignee
				? task.assignee.startsWith("@")
					? task.assignee
					: `@${task.assignee}`
				: "unassigned";
			const timeSpent = formatTimeSpent(task.timeSpent);
			const time = timeSpent ? ` ${timeSpent}` : "";
			console.log(`  ${task.id}: ${task.title} ${assignee}${time}`);
		}
		console.log();
	}
}

/**
 * Print board with colored columns and ASCII borders
 */
function printColoredBoard(columns: Record<TaskStatus, Task[]>): void {
	const statuses: TaskStatus[] = ["todo", "in-progress", "in-review", "done"];
	const colWidth = 22;

	// Column headers
	const headers: Record<TaskStatus, string> = {
		todo: "TO DO",
		"in-progress": "IN PROGRESS",
		"in-review": "IN REVIEW",
		done: "DONE",
		blocked: "BLOCKED",
	};

	// Print top border
	const topBorder = statuses.map(() => "─".repeat(colWidth)).join("┬");
	console.log(`┌${topBorder}┐`);

	// Print headers
	const headerRow = statuses
		.map((status) => {
			const header = headers[status];
			const color = getStatusColor(status);
			const padding = Math.floor((colWidth - header.length) / 2);
			const leftPad = " ".repeat(padding);
			const rightPad = " ".repeat(colWidth - header.length - padding);
			return color.bold(`${leftPad}${header}${rightPad}`);
		})
		.join("│");
	console.log(`│${headerRow}│`);

	// Print separator
	const separator = statuses.map(() => "─".repeat(colWidth)).join("┼");
	console.log(`├${separator}┤`);

	// Find max rows needed
	const maxRows = Math.max(...statuses.map((s) => columns[s].length), 1);

	// Print task rows
	for (let i = 0; i < maxRows; i++) {
		const row = statuses
			.map((status) => {
				const task = columns[status][i];
				if (!task) {
					return " ".repeat(colWidth);
				}

				// Format task card
				const id = chalk.gray(`#${task.id}`);
				const titleMaxLen = colWidth - 4; // Account for #id and spacing
				const title = truncate(task.title, titleMaxLen);

				// First line: ID and title
				const firstLine = `${id} ${title}`.padEnd(colWidth);

				return firstLine;
			})
			.join("│");
		console.log(`│${row}│`);

		// Print second line with assignee and time if task exists
		const hasSecondLine = statuses.some((status) => {
			const task = columns[status][i];
			return task && (task.assignee || task.timeSpent > 0);
		});

		if (hasSecondLine) {
			const secondRow = statuses
				.map((status) => {
					const task = columns[status][i];
					if (!task) {
						return " ".repeat(colWidth);
					}

					const parts: string[] = [];
					if (task.assignee) {
						parts.push(chalk.cyan(task.assignee));
					}
					if (task.timeSpent > 0) {
						parts.push(chalk.gray(formatTimeSpent(task.timeSpent)));
					}

					const line = parts.join(" ");
					return `  ${truncate(line, colWidth - 2)}`.padEnd(colWidth);
				})
				.join("│");
			console.log(`│${secondRow}│`);
		}

		// Add spacing between cards (except last row)
		if (i < maxRows - 1) {
			const spacer = statuses.map(() => " ".repeat(colWidth)).join("│");
			console.log(`│${spacer}│`);
		}
	}

	// Print bottom border
	const bottomBorder = statuses.map(() => "─".repeat(colWidth)).join("┴");
	console.log(`└${bottomBorder}┘`);

	// Print legend/help text
	console.log();
	console.log(chalk.gray("← → Navigate columns  ↑ ↓ Navigate tasks  Enter: View  q: Quit"));
	console.log(chalk.gray("(Interactive navigation coming soon)"));
}

/**
 * knowns board
 */
export const boardCommand = new Command("board")
	.description("Display Kanban board")
	.option("--plain", "Plain text output for AI")
	.option("--status <status>", "Filter by status")
	.option("--assignee <name>", "Filter by assignee")
	.action(
		async (options: {
			plain?: boolean;
			status?: string;
			assignee?: string;
		}) => {
			try {
				const fileStore = getFileStore();
				let tasks = await fileStore.getAllTasks();

				// Filter only top-level tasks (no parent)
				tasks = tasks.filter((t) => !t.parent);

				// Apply filters
				if (options.status) {
					tasks = tasks.filter((t) => t.status === options.status);
				}

				if (options.assignee) {
					tasks = tasks.filter((t) => t.assignee === options.assignee);
				}

				// Group tasks by status
				const columns: Record<TaskStatus, Task[]> = {
					todo: [],
					"in-progress": [],
					"in-review": [],
					done: [],
					blocked: [],
				};

				for (const task of tasks) {
					columns[task.status].push(task);
				}

				// Display board
				if (options.plain) {
					printPlainBoard(columns);
				} else {
					printColoredBoard(columns);
				}
			} catch (error) {
				console.error(chalk.red("✗ Failed to display board"));
				if (error instanceof Error) {
					console.error(chalk.red(`  ${error.message}`));
				}
				process.exit(1);
			}
		},
	);
