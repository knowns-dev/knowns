/**
 * Task Command
 * Handles task create, list, view, edit operations
 */

import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Task, TaskPriority, TaskStatus, TaskVersion } from "@models/index";
import { DEFAULT_STATUSES, isValidTaskPriority, isValidTaskStatus } from "@models/index";
import { FileStore } from "@storage/file-store";
import { formatDocReferences, resolveDocReferences } from "@utils/doc-links";
import { findProjectRoot } from "@utils/find-project-root";
import { buildTaskMap, transformMentionsToRefs } from "@utils/mention-refs";
import { notifyTaskUpdate } from "@utils/notify-server";
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
 * Check if moving a task to a new parent would create a circular dependency
 */
async function wouldCreateCycle(taskId: string, newParentId: string, fileStore: FileStore): Promise<boolean> {
	// Cannot be parent of self
	if (taskId === newParentId) {
		return true;
	}

	// Check if newParent is a descendant of task
	let current = newParentId;
	while (current) {
		if (current === taskId) {
			return true;
		}
		const parent = await fileStore.getTask(current);
		current = parent?.parent || "";
	}

	return false;
}

/**
 * Collect multiple values for options like --ac
 */
function collect(value: string, previous: string[]): string[] {
	return previous.concat([value]);
}

/**
 * Collect multiple numeric values for options like --check-ac
 */
function collectNumbers(value: string, previous: number[]): number[] {
	const num = Number.parseInt(value, 10);
	if (Number.isNaN(num)) {
		throw new Error(`Invalid number: ${value}`);
	}
	return previous.concat([num]);
}

/**
 * Format task for display
 */
async function formatTask(task: Task, fileStore: FileStore, plain = false): Promise<string> {
	if (plain) {
		const border = "-".repeat(50);
		const titleBorder = "=".repeat(50);
		const output: string[] = [];

		// Build task map for mention transformation
		const allTasks = await fileStore.getAllTasks();
		const taskMap = buildTaskMap(allTasks);

		// Helper to transform mentions in text
		const transformText = (text: string) => transformMentionsToRefs(text, taskMap);

		// File path
		const projectRoot = findProjectRoot();
		if (projectRoot) {
			const filename = `task-${task.id} - ${task.title.replace(/[^a-z0-9]+/gi, "-")}`;
			output.push(`File: ${projectRoot}/backlog/tasks/${filename}.md`);
			output.push("");
		}

		// Title
		output.push(`Task ${task.id} - ${task.title}`);
		output.push(titleBorder);
		output.push("");

		// Status with icon
		const statusEmoji: Record<string, string> = {
			todo: "○",
			"in-progress": "◒",
			"in-review": "◎",
			done: "◉",
			blocked: "⊗",
		};
		const emoji = statusEmoji[task.status] || "•";
		output.push(`Status: ${emoji} ${task.status.charAt(0).toUpperCase() + task.status.slice(1).replace("-", " ")}`);

		// Priority
		const priorityDisplay = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
		output.push(`Priority: ${priorityDisplay}`);

		// Assignee
		if (task.assignee) {
			output.push(`Assignee: ${task.assignee}`);
		}

		// Timestamps - format as YYYY-MM-DD HH:MM
		const formatDate = (date: Date) => {
			const year = date.getFullYear();
			const month = String(date.getMonth() + 1).padStart(2, "0");
			const day = String(date.getDate()).padStart(2, "0");
			const hours = String(date.getHours()).padStart(2, "0");
			const minutes = String(date.getMinutes()).padStart(2, "0");
			return `${year}-${month}-${day} ${hours}:${minutes}`;
		};
		output.push(`Created: ${formatDate(task.createdAt)}`);
		output.push(`Updated: ${formatDate(task.updatedAt)}`);

		// Labels
		if (task.labels.length > 0) {
			output.push(`Labels: ${task.labels.join(", ")}`);
		}

		// Parent/Subtasks
		if (task.parent) {
			output.push(`Parent: ${task.parent}`);
		}
		if (task.subtasks.length > 0) {
			output.push(`Subtasks: ${task.subtasks.join(", ")}`);
		}

		// Time tracking
		if (task.timeSpent > 0) {
			const hours = Math.floor(task.timeSpent / 3600);
			const minutes = Math.floor((task.timeSpent % 3600) / 60);
			output.push(`Time Spent: ${hours}h ${minutes}m`);
		}

		output.push("");

		// Description (with mention transformation)
		if (task.description) {
			output.push("Description:");
			output.push(border);
			output.push(transformText(task.description));
			output.push("");
		}

		// Acceptance Criteria (with mention transformation)
		if (task.acceptanceCriteria.length > 0) {
			output.push("Acceptance Criteria:");
			output.push(border);
			for (const [i, ac] of task.acceptanceCriteria.entries()) {
				const checkbox = ac.completed ? "[x]" : "[ ]";
				output.push(`- ${checkbox} #${i + 1} ${transformText(ac.text)}`);
			}
			output.push("");
		}

		// Implementation Plan (with mention transformation)
		if (task.implementationPlan) {
			output.push("Implementation Plan:");
			output.push(border);
			output.push(transformText(task.implementationPlan));
			output.push("");
		}

		// Implementation Notes (with mention transformation)
		if (task.implementationNotes) {
			output.push("Implementation Notes:");
			output.push(border);
			output.push(transformText(task.implementationNotes));
			output.push("");
		}

		// Doc References
		if (projectRoot) {
			const allContent = [task.description || "", task.implementationPlan || "", task.implementationNotes || ""].join(
				"\n",
			);

			const docRefs = resolveDocReferences(allContent, projectRoot);
			if (docRefs.length > 0) {
				output.push("Related Documentation:");
				output.push(border);
				for (const ref of docRefs) {
					output.push(`📄 ${ref.text}: ${ref.resolvedPath}`);
				}
				output.push("");
			}
		}

		return output.join("\n").trimEnd();
	}

	// Formatted output
	const output: string[] = [];

	// Header
	output.push(chalk.bold(`Task ${task.id}: ${task.title}`));
	output.push("");

	// Status and priority
	const statusColor = getStatusColor(task.status);
	const priorityColor = getPriorityColor(task.priority);
	output.push(`${chalk.gray("Status:")} ${statusColor(task.status)}`);
	output.push(`${chalk.gray("Priority:")} ${priorityColor(task.priority)}`);

	if (task.assignee) {
		output.push(`${chalk.gray("Assignee:")} ${chalk.cyan(task.assignee)}`);
	}

	if (task.labels.length > 0) {
		output.push(`${chalk.gray("Labels:")} ${task.labels.map((l) => chalk.blue(l)).join(", ")}`);
	}

	if (task.parent) {
		output.push(`${chalk.gray("Parent:")} ${chalk.yellow(task.parent)}`);
	}

	output.push("");

	// Description
	if (task.description) {
		output.push(chalk.bold("Description:"));
		output.push(task.description);
		output.push("");
	}

	// Subtasks
	if (task.subtasks.length > 0) {
		output.push(chalk.bold("Subtasks:"));
		for (const subtaskId of task.subtasks) {
			const subtask = await fileStore.getTask(subtaskId);
			if (subtask) {
				const statusIcon = getStatusIcon(subtask.status);
				const statusColor = getStatusColor(subtask.status);
				output.push(`  ${statusIcon} ${subtask.id} ${subtask.title} ${statusColor(`[${subtask.status}]`)}`);
			}
		}
		output.push("");
	}

	// Acceptance Criteria
	if (task.acceptanceCriteria.length > 0) {
		output.push(chalk.bold("Acceptance Criteria:"));
		for (const [i, ac] of task.acceptanceCriteria.entries()) {
			const checkbox = ac.completed ? chalk.green("✓") : chalk.gray("○");
			const text = ac.completed ? chalk.gray(ac.text) : ac.text;
			output.push(`  ${checkbox} ${i + 1}. ${text}`);
		}
		output.push("");
	}

	// Implementation Plan
	if (task.implementationPlan) {
		output.push(chalk.bold("Implementation Plan:"));
		output.push(task.implementationPlan);
		output.push("");
	}

	// Implementation Notes
	if (task.implementationNotes) {
		output.push(chalk.bold("Implementation Notes:"));
		output.push(task.implementationNotes);
		output.push("");
	}

	// Doc References - Parse from description, plan, and notes
	const projectRoot = findProjectRoot();
	if (projectRoot) {
		const allContent = [task.description || "", task.implementationPlan || "", task.implementationNotes || ""].join(
			"\n",
		);

		const docRefs = resolveDocReferences(allContent, projectRoot);
		if (docRefs.length > 0) {
			const formattedRefs = formatDocReferences(docRefs, { plain: false });
			output.push(formattedRefs);
			output.push("");
		}
	}

	// Timestamps
	output.push(chalk.gray(`Created: ${task.createdAt.toISOString()}`));
	output.push(chalk.gray(`Updated: ${task.updatedAt.toISOString()}`));

	return output.join("\n");
}

/**
 * Get color function for status
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
 * Get color function for priority
 */
function getPriorityColor(priority: TaskPriority) {
	switch (priority) {
		case "high":
			return chalk.red;
		case "medium":
			return chalk.yellow;
		case "low":
			return chalk.gray;
	}
}

/**
 * Get status icon for tree view
 */
function getStatusIcon(status: TaskStatus): string {
	switch (status) {
		case "done":
			return "✓";
		case "in-progress":
			return "◐";
		case "in-review":
			return "◔";
		case "blocked":
			return "✗";
		default:
			return "○";
	}
}

/**
 * Calculate subtask progress
 */
async function getSubtaskProgress(task: Task, fileStore: FileStore): Promise<string> {
	if (task.subtasks.length === 0) return "";

	let completed = 0;
	for (const subtaskId of task.subtasks) {
		const subtask = await fileStore.getTask(subtaskId);
		if (subtask && subtask.status === "done") {
			completed++;
		}
	}

	return ` (${completed}/${task.subtasks.length})`;
}

/**
 * Format task tree for hierarchical display
 */
async function formatTaskTree(tasks: Task[], fileStore: FileStore, plain = false): Promise<string> {
	// Build tree structure - only show top-level tasks
	const topLevelTasks = tasks.filter((t) => !t.parent);

	if (topLevelTasks.length === 0) {
		return chalk.gray("No tasks found");
	}

	const output: string[] = [];

	if (!plain) {
		output.push(chalk.bold("📋 Tasks"));
	}

	for (let i = 0; i < topLevelTasks.length; i++) {
		const isLast = i === topLevelTasks.length - 1;
		await formatTaskNode(topLevelTasks[i], fileStore, "", isLast, output, plain);
	}

	return output.join("\n");
}

/**
 * Recursively format task node and its children
 */
async function formatTaskNode(
	task: Task,
	fileStore: FileStore,
	prefix: string,
	isLast: boolean,
	output: string[],
	plain: boolean,
): Promise<void> {
	const connector = isLast ? "└── " : "├── ";
	const extension = isLast ? "    " : "│   ";

	const statusIcon = getStatusIcon(task.status);
	const progress = await getSubtaskProgress(task, fileStore);

	if (plain) {
		// Plain format: depth,id,status,title,progress
		const depth = task.id.split(".").length - 1;
		output.push(`${depth},${task.id},${task.status},"${task.title}",${progress}`);
	} else {
		const statusColor = getStatusColor(task.status);
		const line = `${prefix}${connector}#${task.id} ${task.title} ${statusColor(`[${task.status}]`)} ${statusIcon}${progress}`;
		output.push(line);
	}

	// Render children
	if (task.subtasks.length > 0) {
		for (let i = 0; i < task.subtasks.length; i++) {
			const subtaskId = task.subtasks[i];
			const subtask = await fileStore.getTask(subtaskId);
			if (subtask) {
				const isLastChild = i === task.subtasks.length - 1;
				await formatTaskNode(subtask, fileStore, prefix + extension, isLastChild, output, plain);
			}
		}
	}
}

/**
 * Format task list for display
 */
function formatTaskList(tasks: Task[], plain = false): string {
	if (plain) {
		// Group tasks by status
		const statusGroups: Record<string, Task[]> = {
			todo: [],
			"in-progress": [],
			"in-review": [],
			blocked: [],
			done: [],
		};

		for (const task of tasks) {
			if (statusGroups[task.status]) {
				statusGroups[task.status].push(task);
			}
		}

		// Priority sort order
		const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };

		// Sort each group by priority (high -> medium -> low)
		for (const status in statusGroups) {
			statusGroups[status].sort((a, b) => {
				const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
				if (priorityDiff !== 0) return priorityDiff;
				// Secondary sort by id
				return a.id.localeCompare(b.id, undefined, { numeric: true });
			});
		}

		const output: string[] = [];

		// Status display names
		const statusNames: Record<string, string> = {
			todo: "To Do",
			"in-progress": "In Progress",
			"in-review": "In Review",
			blocked: "Blocked",
			done: "Done",
		};

		// Output each status group (skip empty groups)
		for (const status of ["todo", "in-progress", "in-review", "blocked", "done"]) {
			const group = statusGroups[status];
			if (group.length === 0) continue;

			output.push(`${statusNames[status]}:`);
			for (const task of group) {
				const priority = task.priority.toUpperCase();
				output.push(`  [${priority}] ${task.id} - ${task.title}`);
			}
			if (status !== "done") {
				output.push(""); // Empty line between groups (except after Done)
			}
		}

		return output.join("\n").trimEnd();
	}

	// Formatted output
	if (tasks.length === 0) {
		return chalk.gray("No tasks found");
	}

	const output: string[] = [];

	for (const task of tasks) {
		const statusColor = getStatusColor(task.status);
		const priorityColor = getPriorityColor(task.priority);

		const parts = [
			chalk.bold(task.id),
			statusColor(task.status.padEnd(12)),
			priorityColor(task.priority.padEnd(6)),
			task.title,
		];

		if (task.assignee) {
			parts.push(chalk.cyan(`(${task.assignee})`));
		}

		output.push(parts.join(" "));
	}

	return output.join("\n");
}

// ============================================================================
// SUBCOMMANDS
// ============================================================================

/**
 * knowns task create
 */
const createCommand = new Command("create")
	.description("Create a new task")
	.argument("<title>", "Task title")
	.option("-d, --description <text>", "Task description")
	.option("--ac <criterion>", "Acceptance criterion (can be used multiple times)", collect, [])
	.option("-l, --labels <labels>", "Comma-separated labels")
	.option("-a, --assignee <name>", "Assignee (@username)")
	.option("--priority <level>", "Priority: low, medium, high", "medium")
	.option("-s, --status <status>", "Status", "todo")
	.option("--parent <id>", "Parent task ID for subtasks")
	.action(
		async (
			title: string,
			options: {
				description?: string;
				ac: string[];
				labels?: string;
				assignee?: string;
				priority: string;
				status: string;
				parent?: string;
			},
		) => {
			try {
				const fileStore = getFileStore();

				// Get project config for validation
				const project = await fileStore.getProject();
				const allowedStatuses = project?.settings.statuses || DEFAULT_STATUSES;

				// Validate status
				if (!isValidTaskStatus(options.status, allowedStatuses)) {
					console.error(chalk.red(`✗ Invalid status: ${options.status}`));
					console.error(chalk.gray(`  Valid statuses: ${allowedStatuses.join(", ")}`));
					process.exit(1);
				}

				// Validate priority
				if (!isValidTaskPriority(options.priority)) {
					console.error(chalk.red(`✗ Invalid priority: ${options.priority}`));
					console.error(chalk.gray("  Valid priorities: low, medium, high"));
					process.exit(1);
				}

				// Parse labels
				const labels = options.labels ? options.labels.split(",").map((l) => l.trim()) : [];

				// Build acceptance criteria
				const acceptanceCriteria = options.ac.map((text) => ({
					text,
					completed: false,
				}));

				// Create task
				const task = await fileStore.createTask({
					title,
					description: options.description,
					status: options.status as TaskStatus,
					priority: options.priority as TaskPriority,
					assignee: options.assignee,
					labels,
					parent: options.parent,
					acceptanceCriteria,
					subtasks: [],
					timeSpent: 0,
					timeEntries: [],
				});

				// Notify web server for real-time updates
				await notifyTaskUpdate(task.id);

				console.log(chalk.green(`✓ Created task-${task.id}: ${task.title}`));

				if (options.parent) {
					console.log(chalk.gray(`  Subtask of: ${options.parent}`));
				}
			} catch (error) {
				console.error(chalk.red("✗ Failed to create task"));
				if (error instanceof Error) {
					console.error(chalk.red(`  ${error.message}`));
				}
				process.exit(1);
			}
		},
	);

/**
 * knowns task list
 */
const listCommand = new Command("list")
	.description("List all tasks")
	.option("--status <status>", "Filter by status")
	.option("--assignee <name>", "Filter by assignee")
	.option("-l, --labels <labels>", "Filter by labels (comma-separated)")
	.option("--priority <level>", "Filter by priority")
	.option("--tree", "Display tasks as tree hierarchy")
	.option("--plain", "Plain text output for AI")
	.action(
		async (options: {
			status?: string;
			assignee?: string;
			labels?: string;
			priority?: string;
			tree?: boolean;
			plain?: boolean;
		}) => {
			try {
				const fileStore = getFileStore();
				let tasks = await fileStore.getAllTasks();

				// Apply filters
				if (options.status) {
					tasks = tasks.filter((t) => t.status === options.status);
				}

				if (options.assignee) {
					tasks = tasks.filter((t) => t.assignee === options.assignee);
				}

				if (options.priority) {
					tasks = tasks.filter((t) => t.priority === options.priority);
				}

				if (options.labels) {
					const filterLabels = options.labels.split(",").map((l) => l.trim());
					tasks = tasks.filter((t) => filterLabels.some((label) => t.labels.includes(label)));
				}

				// Display tree view or list view
				if (options.tree) {
					console.log(await formatTaskTree(tasks, fileStore, options.plain));
				} else {
					console.log(formatTaskList(tasks, options.plain));
				}
			} catch (error) {
				console.error(chalk.red("✗ Failed to list tasks"));
				if (error instanceof Error) {
					console.error(chalk.red(`  ${error.message}`));
				}
				process.exit(1);
			}
		},
	);

/**
 * knowns task <id>
 */
const viewCommand = new Command("view")
	.description("View task details")
	.argument("<id>", "Task ID")
	.option("--plain", "Plain text output for AI")
	.action(async (id: string, options: { plain?: boolean }) => {
		try {
			const fileStore = getFileStore();
			const task = await fileStore.getTask(id);

			if (!task) {
				console.error(chalk.red(`✗ Task ${id} not found`));
				process.exit(1);
			}

			console.log(await formatTask(task, fileStore, options.plain));
		} catch (error) {
			console.error(chalk.red("✗ Failed to view task"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

/**
 * knowns task edit
 */
const editCommand = new Command("edit")
	.description("Edit task properties")
	.argument("<id>", "Task ID")
	.option("-t, --title <text>", "New title")
	.option("-d, --description <text>", "New description")
	.option("-s, --status <status>", "New status")
	.option("--priority <level>", "New priority")
	.option("-l, --labels <labels>", "Comma-separated labels")
	.option("-a, --assignee <name>", "Assignee")
	.option("--parent <id>", "Move task to new parent (use 'none' to remove parent)")
	.option("--ac <text>", "Add new acceptance criterion (can be used multiple times)", collect, [])
	.option(
		"--check-ac <index>",
		"Check acceptance criterion by index (1-based, can be used multiple times)",
		collectNumbers,
		[],
	)
	.option(
		"--uncheck-ac <index>",
		"Uncheck acceptance criterion by index (1-based, can be used multiple times)",
		collectNumbers,
		[],
	)
	.option(
		"--remove-ac <index>",
		"Remove acceptance criterion by index (1-based, can be used multiple times)",
		collectNumbers,
		[],
	)
	.option("--plan <text>", "Implementation plan")
	.option("--notes <text>", "Implementation notes (replaces existing)")
	.option("--append-notes <text>", "Append to implementation notes")
	.action(
		async (
			id: string,
			options: {
				title?: string;
				description?: string;
				status?: string;
				priority?: string;
				labels?: string;
				assignee?: string;
				parent?: string;
				ac: string[];
				checkAc: number[];
				uncheckAc: number[];
				removeAc: number[];
				plan?: string;
				notes?: string;
				appendNotes?: string;
			},
		) => {
			try {
				const fileStore = getFileStore();
				const task = await fileStore.getTask(id);

				if (!task) {
					console.error(chalk.red(`✗ Task ${id} not found`));
					process.exit(1);
				}

				// Get project config for validation
				const project = await fileStore.getProject();
				const allowedStatuses = project?.settings.statuses || DEFAULT_STATUSES;

				const updates: Partial<Task> = {};

				// Update title
				if (options.title) {
					updates.title = options.title;
				}

				// Update description
				if (options.description) {
					updates.description = options.description;
				}

				// Update status
				if (options.status) {
					if (!isValidTaskStatus(options.status, allowedStatuses)) {
						console.error(chalk.red(`✗ Invalid status: ${options.status}`));
						console.error(chalk.gray(`  Valid statuses: ${allowedStatuses.join(", ")}`));
						process.exit(1);
					}
					updates.status = options.status as TaskStatus;
				}

				// Update priority
				if (options.priority) {
					if (!isValidTaskPriority(options.priority)) {
						console.error(chalk.red(`✗ Invalid priority: ${options.priority}`));
						console.error(chalk.gray("  Valid priorities: low, medium, high"));
						process.exit(1);
					}
					updates.priority = options.priority as TaskPriority;
				}

				// Update labels
				if (options.labels) {
					updates.labels = options.labels.split(",").map((l) => l.trim());
				}

				// Update assignee
				if (options.assignee) {
					updates.assignee = options.assignee;
				}

				// Handle parent change
				if (options.parent !== undefined) {
					if (options.parent.toLowerCase() === "none") {
						// Remove parent
						updates.parent = undefined;
					} else {
						// Validate new parent exists
						const newParent = await fileStore.getTask(options.parent);
						if (!newParent) {
							console.error(chalk.red(`✗ Parent task ${options.parent} not found`));
							process.exit(1);
						}

						// Check for circular dependency
						if (await wouldCreateCycle(id, options.parent, fileStore)) {
							console.error(chalk.red("✗ Cannot set parent: would create circular dependency"));
							console.error(chalk.gray("  A task cannot be its own ancestor or descendant"));
							process.exit(1);
						}

						updates.parent = options.parent;
					}
				}

				// Handle acceptance criteria operations
				if (
					options.ac.length > 0 ||
					options.checkAc.length > 0 ||
					options.uncheckAc.length > 0 ||
					options.removeAc.length > 0
				) {
					const criteria = [...task.acceptanceCriteria];

					// 1. Add new ACs
					for (const text of options.ac) {
						criteria.push({ text, completed: false });
					}

					// 2. Check ACs (validate indices first)
					for (const index of options.checkAc) {
						const idx = index - 1;
						if (idx >= 0 && idx < criteria.length) {
							criteria[idx] = { ...criteria[idx], completed: true };
						} else {
							console.error(chalk.red(`✗ Invalid AC index: ${index}`));
							process.exit(1);
						}
					}

					// 3. Uncheck ACs
					for (const index of options.uncheckAc) {
						const idx = index - 1;
						if (idx >= 0 && idx < criteria.length) {
							criteria[idx] = { ...criteria[idx], completed: false };
						} else {
							console.error(chalk.red(`✗ Invalid AC index: ${index}`));
							process.exit(1);
						}
					}

					// 4. Remove ACs (process in reverse order to avoid index shifting issues)
					const sortedRemoveIndices = [...options.removeAc].sort((a, b) => b - a);
					for (const index of sortedRemoveIndices) {
						const idx = index - 1;
						if (idx >= 0 && idx < criteria.length) {
							criteria.splice(idx, 1);
						} else {
							console.error(chalk.red(`✗ Invalid AC index: ${index}`));
							process.exit(1);
						}
					}

					updates.acceptanceCriteria = criteria;
				}

				// Update implementation plan
				if (options.plan) {
					updates.implementationPlan = options.plan;
				}

				// Update implementation notes
				if (options.notes) {
					updates.implementationNotes = options.notes;
				}

				// Append to implementation notes
				if (options.appendNotes) {
					const existingNotes = task.implementationNotes || "";
					const separator = existingNotes ? "\n\n" : "";
					updates.implementationNotes = existingNotes + separator + options.appendNotes;
				}

				// Apply updates
				await fileStore.updateTask(id, updates);

				// Notify web server for real-time updates
				await notifyTaskUpdate(id);

				console.log(chalk.green(`✓ Updated task-${id}`));

				// Show what changed
				const changes: string[] = [];
				if (options.title) changes.push(`title → ${options.title}`);
				if (options.status) changes.push(`status → ${options.status}`);
				if (options.priority) changes.push(`priority → ${options.priority}`);
				if (options.assignee) changes.push(`assignee → ${options.assignee}`);
				if (options.parent !== undefined) {
					if (options.parent.toLowerCase() === "none") {
						changes.push("parent removed");
					} else {
						changes.push(`parent → ${options.parent}`);
					}
				}
				if (options.ac.length > 0) changes.push(`added ${options.ac.length} AC(s)`);
				if (options.checkAc.length > 0) changes.push(`checked AC #${options.checkAc.join(", #")}`);
				if (options.uncheckAc.length > 0) changes.push(`unchecked AC #${options.uncheckAc.join(", #")}`);
				if (options.removeAc.length > 0) changes.push(`removed AC #${options.removeAc.join(", #")}`);
				if (options.plan) changes.push("updated implementation plan");
				if (options.notes) changes.push("updated implementation notes");
				if (options.appendNotes) changes.push("appended to implementation notes");

				if (changes.length > 0) {
					console.log(chalk.gray(`  ${changes.join(", ")}`));
				}
			} catch (error) {
				console.error(chalk.red("✗ Failed to edit task"));
				if (error instanceof Error) {
					console.error(chalk.red(`  ${error.message}`));
				}
				process.exit(1);
			}
		},
	);

/**
 * knowns task archive
 */
const archiveCommand = new Command("archive")
	.description("Archive a task")
	.argument("<id>", "Task ID")
	.action(async (id: string) => {
		try {
			const projectRoot = findProjectRoot();
			if (!projectRoot) {
				console.error(chalk.red("✗ Not a knowns project"));
				console.error(chalk.gray('  Run "knowns init" to initialize'));
				process.exit(1);
			}

			const fileStore = getFileStore();
			const task = await fileStore.getTask(id);

			if (!task) {
				console.error(chalk.red(`✗ Task ${id} not found`));
				process.exit(1);
			}

			// Create archive directory
			const archiveDir = join(projectRoot, ".knowns", "archive");
			await mkdir(archiveDir, { recursive: true });

			// Find and move task file
			const tasksPath = join(projectRoot, ".knowns", "tasks");
			const files = await readdir(tasksPath);
			const taskFile = files.find((f) => f.startsWith(`task-${id} -`));

			if (!taskFile) {
				console.error(chalk.red(`✗ Task file for ${id} not found`));
				process.exit(1);
			}

			const oldPath = join(tasksPath, taskFile);
			const newPath = join(archiveDir, taskFile);

			// Copy file to archive
			const content = await Bun.file(oldPath).text();
			await Bun.write(newPath, content);

			// Delete original file
			await unlink(oldPath);

			console.log(chalk.green(`✓ Archived task-${id}: ${task.title}`));
		} catch (error) {
			console.error(chalk.red("✗ Failed to archive task"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

/**
 * knowns task unarchive
 */
const unarchiveCommand = new Command("unarchive")
	.description("Restore archived task")
	.argument("<id>", "Task ID")
	.action(async (id: string) => {
		try {
			const projectRoot = findProjectRoot();
			if (!projectRoot) {
				console.error(chalk.red("✗ Not a knowns project"));
				console.error(chalk.gray('  Run "knowns init" to initialize'));
				process.exit(1);
			}

			const archiveDir = join(projectRoot, ".knowns", "archive");
			const tasksPath = join(projectRoot, ".knowns", "tasks");

			// Find archived task file
			const files = await readdir(archiveDir);
			const taskFile = files.find((f) => f.startsWith(`task-${id} -`));

			if (!taskFile) {
				console.error(chalk.red(`✗ Archived task ${id} not found`));
				process.exit(1);
			}

			const archivePath = join(archiveDir, taskFile);
			const tasksFilePath = join(tasksPath, taskFile);

			// Copy file back to tasks
			const content = await Bun.file(archivePath).text();
			await Bun.write(tasksFilePath, content);

			// Delete from archive
			await unlink(archivePath);

			console.log(chalk.green(`✓ Restored task-${id}`));
		} catch (error) {
			console.error(chalk.red("✗ Failed to restore task"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

/**
 * knowns task history
 */
const historyCommand = new Command("history")
	.description("View task change history")
	.argument("<id>", "Task ID")
	.option("--plain", "Plain text output for AI")
	.option("--limit <n>", "Limit number of entries", Number.parseInt)
	.action(async (id: string, options: { plain?: boolean; limit?: number }) => {
		try {
			const fileStore = getFileStore();
			const task = await fileStore.getTask(id);

			if (!task) {
				console.error(chalk.red(`✗ Task ${id} not found`));
				process.exit(1);
			}

			let versions = await fileStore.getTaskVersionHistory(id);

			// Sort by version number (newest first)
			versions = versions.sort((a, b) => b.version - a.version);

			// Apply limit
			if (options.limit && options.limit > 0) {
				versions = versions.slice(0, options.limit);
			}

			if (versions.length === 0) {
				if (options.plain) {
					console.log("no_history: true");
					console.log(`task_id: ${id}`);
					console.log(`task_title: ${task.title}`);
				} else {
					console.log(chalk.gray(`No history found for task-${id}`));
					console.log(chalk.gray("History is recorded when task properties are modified."));
				}
				return;
			}

			console.log(formatVersionHistory(id, task.title, versions, options.plain));
		} catch (error) {
			console.error(chalk.red("✗ Failed to get task history"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

/**
 * Format version history for display
 */
function formatVersionHistory(taskId: string, taskTitle: string, versions: TaskVersion[], plain = false): string {
	if (plain) {
		// Plain text format for AI
		const lines: string[] = [];
		lines.push(`task_id: ${taskId}`);
		lines.push(`task_title: ${taskTitle}`);
		lines.push(`version_count: ${versions.length}`);
		lines.push("");

		for (const version of versions) {
			lines.push(`--- Version ${version.version} ---`);
			lines.push(`id: ${version.id}`);
			lines.push(`timestamp: ${version.timestamp.toISOString()}`);
			if (version.author) {
				lines.push(`author: ${version.author}`);
			}
			lines.push(`changes_count: ${version.changes.length}`);

			for (const change of version.changes) {
				const oldVal = formatValuePlain(change.oldValue);
				const newVal = formatValuePlain(change.newValue);
				lines.push(`change: ${change.field} | ${oldVal} -> ${newVal}`);
			}
			lines.push("");
		}

		return lines.join("\n");
	}

	// Formatted output with colors
	const output: string[] = [];

	output.push(chalk.bold(`📜 History for Task ${taskId}: ${taskTitle}`));
	output.push(chalk.gray(`${versions.length} version(s)`));
	output.push("");

	for (const version of versions) {
		// Version header
		const dateStr = version.timestamp.toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});

		const author = version.author ? chalk.cyan(` by ${version.author}`) : "";
		output.push(chalk.bold.yellow(`v${version.version}`) + chalk.gray(` • ${dateStr}`) + author);

		// Changes
		for (const change of version.changes) {
			const fieldName = formatFieldName(change.field);
			const oldVal = formatValue(change.oldValue);
			const newVal = formatValue(change.newValue);

			output.push(`  ${chalk.gray("•")} ${fieldName}: ${chalk.red(oldVal)} → ${chalk.green(newVal)}`);
		}

		output.push("");
	}

	return output.join("\n");
}

/**
 * Format field name for display
 */
function formatFieldName(field: string): string {
	const names: Record<string, string> = {
		title: "Title",
		description: "Description",
		status: "Status",
		priority: "Priority",
		assignee: "Assignee",
		labels: "Labels",
		acceptanceCriteria: "Acceptance Criteria",
		implementationPlan: "Implementation Plan",
		implementationNotes: "Implementation Notes",
	};
	return names[field] || field;
}

/**
 * Format value for colored display
 */
function formatValue(value: unknown): string {
	if (value === undefined || value === null) {
		return "(empty)";
	}

	if (Array.isArray(value)) {
		if (value.length === 0) return "(empty)";

		// Handle acceptance criteria
		if (value[0] && typeof value[0] === "object" && "text" in value[0]) {
			return `${value.length} item(s)`;
		}

		return value.join(", ");
	}

	if (typeof value === "string") {
		// Truncate long strings
		if (value.length > 50) {
			return `${value.substring(0, 47)}...`;
		}
		return value;
	}

	return String(value);
}

/**
 * Format value for plain text output
 */
function formatValuePlain(value: unknown): string {
	if (value === undefined || value === null) {
		return "(empty)";
	}

	if (Array.isArray(value)) {
		if (value.length === 0) return "(empty)";

		// Handle acceptance criteria
		if (value[0] && typeof value[0] === "object" && "text" in value[0]) {
			return `[${value.length} items]`;
		}

		return `[${value.join(", ")}]`;
	}

	if (typeof value === "string") {
		// Escape newlines
		return value.replace(/\n/g, "\\n");
	}

	return String(value);
}

/**
 * knowns task diff
 */
const diffCommand = new Command("diff")
	.description("Compare task versions")
	.argument("<id>", "Task ID")
	.option("-v, --ver <n>", "Compare current with specific version", Number.parseInt)
	.option("--from <v>", "Start version for comparison", Number.parseInt)
	.option("--to <v>", "End version for comparison", Number.parseInt)
	.option("--plain", "Plain text output for AI")
	.action(async (id: string, options: { ver?: number; from?: number; to?: number; plain?: boolean }) => {
		try {
			const fileStore = getFileStore();
			const task = await fileStore.getTask(id);

			if (!task) {
				console.error(chalk.red(`✗ Task ${id} not found`));
				process.exit(1);
			}

			const versions = await fileStore.getTaskVersionHistory(id);

			if (versions.length === 0) {
				if (options.plain) {
					console.log("no_versions: true");
					console.log(`task_id: ${id}`);
				} else {
					console.log(chalk.gray(`No version history found for task-${id}`));
				}
				return;
			}

			// Sort versions by number
			const sortedVersions = [...versions].sort((a, b) => a.version - b.version);
			const currentVersion = sortedVersions[sortedVersions.length - 1].version;

			let fromVersion: number;
			let toVersion: number;

			if (options.from !== undefined && options.to !== undefined) {
				// Compare specific range
				fromVersion = options.from;
				toVersion = options.to;
			} else if (options.ver !== undefined) {
				// Compare current with specific version
				fromVersion = options.ver;
				toVersion = currentVersion;
			} else {
				// Default: compare previous with current
				fromVersion = Math.max(1, currentVersion - 1);
				toVersion = currentVersion;
			}

			// Validate versions exist
			const fromVersionData = sortedVersions.find((v) => v.version === fromVersion);
			const toVersionData = sortedVersions.find((v) => v.version === toVersion);

			if (!fromVersionData) {
				console.error(chalk.red(`✗ Version ${fromVersion} not found`));
				process.exit(1);
			}

			if (!toVersionData) {
				console.error(chalk.red(`✗ Version ${toVersion} not found`));
				process.exit(1);
			}

			// Get snapshots and compute diff
			const fromSnapshot = fromVersionData.snapshot;
			const toSnapshot = toVersionData.snapshot;

			console.log(formatDiff(id, task.title, fromVersion, toVersion, fromSnapshot, toSnapshot, options.plain));
		} catch (error) {
			console.error(chalk.red("✗ Failed to show diff"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

/**
 * Format diff output
 */
function formatDiff(
	taskId: string,
	taskTitle: string,
	fromVersion: number,
	toVersion: number,
	fromSnapshot: Partial<Task>,
	toSnapshot: Partial<Task>,
	plain = false,
): string {
	const fields = [
		"title",
		"description",
		"status",
		"priority",
		"assignee",
		"labels",
		"acceptanceCriteria",
		"implementationPlan",
		"implementationNotes",
	] as const;

	type DiffField = (typeof fields)[number];

	interface FieldDiff {
		field: DiffField;
		from: unknown;
		to: unknown;
		changed: boolean;
	}

	const diffs: FieldDiff[] = [];

	for (const field of fields) {
		const fromVal = fromSnapshot[field];
		const toVal = toSnapshot[field];
		const changed = !deepEqual(fromVal, toVal);

		diffs.push({
			field,
			from: fromVal,
			to: toVal,
			changed,
		});
	}

	const changedDiffs = diffs.filter((d) => d.changed);

	if (plain) {
		const lines: string[] = [];
		lines.push(`task_id: ${taskId}`);
		lines.push(`task_title: ${taskTitle}`);
		lines.push(`from_version: v${fromVersion}`);
		lines.push(`to_version: v${toVersion}`);
		lines.push(`changes_count: ${changedDiffs.length}`);
		lines.push("");

		if (changedDiffs.length === 0) {
			lines.push("no_changes: true");
		} else {
			for (const diff of changedDiffs) {
				lines.push(`--- ${diff.field} ---`);
				lines.push(`from: ${formatValuePlain(diff.from)}`);
				lines.push(`to: ${formatValuePlain(diff.to)}`);
				lines.push("");
			}
		}

		return lines.join("\n");
	}

	// Formatted output
	const output: string[] = [];

	output.push(chalk.bold(`🔍 Diff for Task ${taskId}: ${taskTitle}`));
	output.push(
		chalk.gray("Comparing ") + chalk.yellow(`v${fromVersion}`) + chalk.gray(" → ") + chalk.green(`v${toVersion}`),
	);
	output.push("");

	if (changedDiffs.length === 0) {
		output.push(chalk.gray("No changes between these versions"));
		return output.join("\n");
	}

	output.push(chalk.bold(`${changedDiffs.length} field(s) changed:`));
	output.push("");

	for (const diff of changedDiffs) {
		const fieldName = formatFieldName(diff.field);
		output.push(chalk.bold.cyan(`${fieldName}:`));

		// Format based on field type
		if (diff.field === "acceptanceCriteria") {
			output.push(formatACDiff(diff.from as unknown[], diff.to as unknown[]));
		} else if (typeof diff.from === "string" || typeof diff.to === "string") {
			// Multiline text comparison
			const fromStr = (diff.from as string) || "(empty)";
			const toStr = (diff.to as string) || "(empty)";

			if (fromStr.includes("\n") || toStr.includes("\n")) {
				output.push(chalk.red(`  - ${fromStr.split("\n").join("\n  - ")}`));
				output.push(chalk.green(`  + ${toStr.split("\n").join("\n  + ")}`));
			} else {
				output.push(chalk.red(`  - ${fromStr}`));
				output.push(chalk.green(`  + ${toStr}`));
			}
		} else if (Array.isArray(diff.from) || Array.isArray(diff.to)) {
			const fromArr = (diff.from as string[]) || [];
			const toArr = (diff.to as string[]) || [];
			output.push(chalk.red(`  - [${fromArr.join(", ")}]`));
			output.push(chalk.green(`  + [${toArr.join(", ")}]`));
		} else {
			output.push(chalk.red(`  - ${formatValue(diff.from)}`));
			output.push(chalk.green(`  + ${formatValue(diff.to)}`));
		}

		output.push("");
	}

	return output.join("\n");
}

/**
 * Format acceptance criteria diff
 */
function formatACDiff(from: unknown[], to: unknown[]): string {
	const output: string[] = [];

	interface AC {
		text: string;
		completed: boolean;
	}

	const fromAC = (from || []) as AC[];
	const toAC = (to || []) as AC[];

	// Find added, removed, and changed items
	const fromTexts = new Map(fromAC.map((ac) => [ac.text, ac]));
	const toTexts = new Map(toAC.map((ac) => [ac.text, ac]));

	// Removed items
	for (const [text, ac] of fromTexts) {
		if (!toTexts.has(text)) {
			const checkbox = ac.completed ? "[x]" : "[ ]";
			output.push(chalk.red(`  - ${checkbox} ${text}`));
		}
	}

	// Added items
	for (const [text, ac] of toTexts) {
		if (!fromTexts.has(text)) {
			const checkbox = ac.completed ? "[x]" : "[ ]";
			output.push(chalk.green(`  + ${checkbox} ${text}`));
		}
	}

	// Changed items (completion status changed)
	for (const [text, toAc] of toTexts) {
		const fromAc = fromTexts.get(text);
		if (fromAc && fromAc.completed !== toAc.completed) {
			const fromCheckbox = fromAc.completed ? "[x]" : "[ ]";
			const toCheckbox = toAc.completed ? "[x]" : "[ ]";
			output.push(chalk.yellow(`  ~ ${fromCheckbox} → ${toCheckbox} ${text}`));
		}
	}

	return output.join("\n") || chalk.gray("  (no changes)");
}

/**
 * Deep equality check
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return a === b;
	if (a === undefined || b === undefined) return a === b;

	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((item, index) => deepEqual(item, b[index]));
	}

	if (typeof a === "object" && typeof b === "object") {
		const aKeys = Object.keys(a as object);
		const bKeys = Object.keys(b as object);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
	}

	return false;
}

/**
 * knowns task restore
 */
const restoreCommand = new Command("restore")
	.description("Restore task to a previous version")
	.argument("<id>", "Task ID")
	.requiredOption("-v, --ver <n>", "Version to restore to", Number.parseInt)
	.option("-y, --yes", "Skip confirmation")
	.option("--dry-run", "Preview changes without applying")
	.action(async (id: string, options: { ver: number; yes?: boolean; dryRun?: boolean }) => {
		try {
			const fileStore = getFileStore();
			const task = await fileStore.getTask(id);

			if (!task) {
				console.error(chalk.red(`✗ Task ${id} not found`));
				process.exit(1);
			}

			const versions = await fileStore.getTaskVersionHistory(id);

			if (versions.length === 0) {
				console.error(chalk.red(`✗ No version history found for task-${id}`));
				process.exit(1);
			}

			// Find the target version
			const targetVersion = versions.find((v) => v.version === options.ver);

			if (!targetVersion) {
				console.error(chalk.red(`✗ Version ${options.ver} not found`));
				console.error(chalk.gray(`  Available versions: ${versions.map((v) => v.version).join(", ")}`));
				process.exit(1);
			}

			// Get current version for comparison
			const sortedVersions = [...versions].sort((a, b) => a.version - b.version);
			const currentVersion = sortedVersions[sortedVersions.length - 1];

			// Show what will change
			console.log(chalk.bold(`🔄 Restore Task ${id}: ${task.title}`));
			console.log(
				chalk.gray("Restoring from ") +
					chalk.green(`v${currentVersion.version}`) +
					chalk.gray(" → ") +
					chalk.yellow(`v${options.ver}`),
			);
			console.log("");

			// Calculate diff
			const currentSnapshot = currentVersion.snapshot;
			const targetSnapshot = targetVersion.snapshot;

			const fields = [
				"title",
				"description",
				"status",
				"priority",
				"assignee",
				"labels",
				"acceptanceCriteria",
				"implementationPlan",
				"implementationNotes",
			] as const;

			const changes: Array<{ field: string; from: unknown; to: unknown }> = [];

			for (const field of fields) {
				const currentVal = currentSnapshot[field];
				const targetVal = targetSnapshot[field];

				if (!deepEqual(currentVal, targetVal)) {
					changes.push({
						field,
						from: currentVal,
						to: targetVal,
					});
				}
			}

			if (changes.length === 0) {
				console.log(chalk.gray("No changes to restore - task is already at this state"));
				return;
			}

			console.log(chalk.bold(`${changes.length} field(s) will be restored:`));
			console.log("");

			for (const change of changes) {
				const fieldName = formatFieldName(change.field);
				console.log(chalk.cyan(`${fieldName}:`));
				console.log(chalk.red(`  - ${formatValue(change.from)}`));
				console.log(chalk.green(`  + ${formatValue(change.to)}`));
				console.log("");
			}

			// Dry run mode - don't apply changes
			if (options.dryRun) {
				console.log(chalk.yellow("⚠ Dry run mode - no changes applied"));
				return;
			}

			// Confirmation
			if (!options.yes) {
				console.log(chalk.yellow("⚠ This will modify the task. Use --yes to confirm."));
				return;
			}

			// Apply the restore
			const _restored = await fileStore.rollbackTask(id, options.ver);

			console.log(chalk.green(`✓ Restored task-${id} to version ${options.ver}`));
			console.log(chalk.gray(`  New version created: v${await fileStore.getTaskCurrentVersion(id)}`));
		} catch (error) {
			console.error(chalk.red("✗ Failed to restore task"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

// ============================================================================
// MAIN TASK COMMAND
// ============================================================================

export const taskCommand = new Command("task").description("Manage tasks");

// Add subcommands
taskCommand.addCommand(createCommand);
taskCommand.addCommand(listCommand);
taskCommand.addCommand(viewCommand);
taskCommand.addCommand(editCommand);
taskCommand.addCommand(archiveCommand);
taskCommand.addCommand(unarchiveCommand);
taskCommand.addCommand(historyCommand);
taskCommand.addCommand(diffCommand);
taskCommand.addCommand(restoreCommand);
