/**
 * Search Command
 * Search tasks and docs by query with filters
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@models/index";
import { FileStore } from "@storage/file-store";
import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";
import matter from "gray-matter";

interface DocMetadata {
	title: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
	tags?: string[];
}

interface DocResult {
	filename: string;
	metadata: DocMetadata;
	content: string;
	score: number;
}

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
 * Calculate relevance score for task search results
 */
function calculateTaskScore(task: Task, query: string): number {
	const q = query.toLowerCase();
	let score = 0;

	// Title match is most important
	const titleLower = task.title.toLowerCase();
	if (titleLower === q) {
		score += 100;
	} else if (titleLower.includes(q)) {
		score += 50;
	}

	// Description match
	if (task.description?.toLowerCase().includes(q)) {
		score += 20;
	}

	// ID match
	if (task.id.includes(q)) {
		score += 30;
	}

	// Labels match
	if (task.labels.some((l) => l.toLowerCase().includes(q))) {
		score += 10;
	}

	return score;
}

/**
 * Calculate relevance score for doc search results
 */
function calculateDocScore(doc: DocResult, query: string): number {
	const q = query.toLowerCase();
	let score = 0;

	// Title match is most important
	const titleLower = doc.metadata.title.toLowerCase();
	if (titleLower === q) {
		score += 100;
	} else if (titleLower.includes(q)) {
		score += 50;
	}

	// Description match
	if (doc.metadata.description?.toLowerCase().includes(q)) {
		score += 20;
	}

	// Content match
	if (doc.content.toLowerCase().includes(q)) {
		score += 15;
	}

	// Tags match
	if (doc.metadata.tags?.some((t) => t.toLowerCase().includes(q))) {
		score += 10;
	}

	return score;
}

/**
 * Search documentation files
 */
async function searchDocs(query: string, projectRoot: string): Promise<DocResult[]> {
	const docsDir = join(projectRoot, ".knowns", "docs");

	if (!existsSync(docsDir)) {
		return [];
	}

	try {
		const files = await readdir(docsDir);
		const mdFiles = files.filter((f) => f.endsWith(".md"));
		const results: DocResult[] = [];

		for (const file of mdFiles) {
			const content = await readFile(join(docsDir, file), "utf-8");
			const { data, content: docContent } = matter(content);
			const metadata = data as DocMetadata;

			const doc: DocResult = {
				filename: file,
				metadata,
				content: docContent,
				score: 0,
			};

			// Calculate score
			doc.score = calculateDocScore(doc, query);

			// Check if matches query
			const q = query.toLowerCase();
			const text =
				`${metadata.title} ${metadata.description || ""} ${metadata.tags?.join(" ") || ""} ${docContent}`.toLowerCase();

			if (text.includes(q)) {
				results.push(doc);
			}
		}

		return results.sort((a, b) => b.score - a.score);
	} catch (_error) {
		return [];
	}
}

/**
 * knowns search
 */
export const searchCommand = new Command("search")
	.description("Search tasks and documentation by query")
	.argument("<query>", "Search query")
	.option("--type <type>", "Search type: task, doc, or all (default: all)")
	.option("--status <status>", "Filter tasks by status")
	.option("-l, --label <label>", "Filter tasks by label")
	.option("--assignee <name>", "Filter tasks by assignee")
	.option("--priority <level>", "Filter tasks by priority")
	.option("--plain", "Plain text output for AI")
	.action(
		async (
			query: string,
			options: {
				type?: string;
				status?: string;
				label?: string;
				assignee?: string;
				priority?: string;
				plain?: boolean;
			},
		) => {
			try {
				const projectRoot = findProjectRoot();
				if (!projectRoot) {
					console.error(chalk.red("✗ Not a knowns project"));
					console.error(chalk.gray('  Run "knowns init" to initialize'));
					process.exit(1);
				}

				const searchType = options.type || "all";
				const q = query.toLowerCase();

				let taskResults: Task[] = [];
				let docResults: DocResult[] = [];

				// Search tasks
				if (searchType === "task" || searchType === "all") {
					const fileStore = getFileStore();
					const allTasks = await fileStore.getAllTasks();

					taskResults = allTasks
						.filter((task) => {
							// Text search in title, description, labels, id
							const text = `${task.title} ${task.description || ""} ${task.labels.join(" ")} ${task.id}`.toLowerCase();
							if (!text.includes(q)) {
								return false;
							}

							// Apply filters
							if (options.status && task.status !== options.status) {
								return false;
							}
							if (options.label && !task.labels.includes(options.label)) {
								return false;
							}
							if (options.assignee && task.assignee !== options.assignee) {
								return false;
							}
							if (options.priority && task.priority !== options.priority) {
								return false;
							}

							return true;
						})
						.map((task) => ({
							task,
							score: calculateTaskScore(task, query),
						}))
						.sort((a, b) => b.score - a.score)
						.map(({ task }) => task);
				}

				// Search docs
				if (searchType === "doc" || searchType === "all") {
					docResults = await searchDocs(query, projectRoot);
				}

				// Output results
				if (options.plain) {
					// Plain format - nested by type and status/path
					if (taskResults.length === 0 && docResults.length === 0) {
						console.log("No results found");
					} else {
						// Group tasks by status
						if (taskResults.length > 0) {
							console.log("Tasks:");
							const statusGroups: Record<string, Task[]> = {};
							const statusOrder = ["todo", "in-progress", "in-review", "blocked", "done"];
							const statusNames: Record<string, string> = {
								todo: "To Do",
								"in-progress": "In Progress",
								"in-review": "In Review",
								blocked: "Blocked",
								done: "Done",
							};

							for (const task of taskResults) {
								if (!statusGroups[task.status]) {
									statusGroups[task.status] = [];
								}
								statusGroups[task.status].push(task);
							}

							// Sort by priority within each group
							const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
							for (const status of statusOrder) {
								const tasks = statusGroups[status];
								if (!tasks || tasks.length === 0) continue;

								tasks.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

								console.log(`  ${statusNames[status]}:`);
								for (const task of tasks) {
									console.log(`    [${task.priority.toUpperCase()}] ${task.id} - ${task.title}`);
								}
							}
						}

						// Group docs by path
						if (docResults.length > 0) {
							if (taskResults.length > 0) console.log("");
							console.log("Docs:");

							const pathGroups: Record<string, DocResult[]> = {};
							for (const doc of docResults) {
								const parts = doc.filename.split("/");
								const folder = parts.length > 1 ? `${parts.slice(0, -1).join("/")}/` : "(root)";
								if (!pathGroups[folder]) {
									pathGroups[folder] = [];
								}
								pathGroups[folder].push(doc);
							}

							const sortedPaths = Object.keys(pathGroups).sort((a, b) => {
								if (a === "(root)") return -1;
								if (b === "(root)") return 1;
								return a.localeCompare(b);
							});

							for (const path of sortedPaths) {
								console.log(`  ${path}:`);
								for (const doc of pathGroups[path]) {
									const filename = doc.filename.split("/").pop() || doc.filename;
									console.log(`    ${filename} - ${doc.metadata.title}`);
								}
							}
						}
					}
				} else {
					const totalResults = taskResults.length + docResults.length;

					if (totalResults === 0) {
						console.log(chalk.yellow(`No results found for "${query}"`));
						return;
					}

					console.log(chalk.bold(`\n🔍 Found ${totalResults} result(s) for "${query}":\n`));

					// Display tasks
					if (taskResults.length > 0) {
						console.log(chalk.bold("📋 Tasks:\n"));
						for (const task of taskResults) {
							const statusColor = getStatusColor(task.status);
							const priorityColor = getPriorityColor(task.priority);

							const parts = [
								chalk.gray(`#${task.id}`),
								task.title,
								statusColor(`[${task.status}]`),
								priorityColor(`[${task.priority}]`),
							];

							if (task.assignee) {
								parts.push(chalk.cyan(`(${task.assignee})`));
							}

							console.log(`  ${parts.join(" ")}`);
						}
						console.log();
					}

					// Display docs
					if (docResults.length > 0) {
						console.log(chalk.bold("📚 Documentation:\n"));
						for (const doc of docResults) {
							console.log(`  ${chalk.cyan(doc.metadata.title)}`);
							if (doc.metadata.description) {
								console.log(chalk.gray(`    ${doc.metadata.description}`));
							}
							console.log(chalk.gray(`    File: ${doc.filename}`));
							if (doc.metadata.tags && doc.metadata.tags.length > 0) {
								console.log(chalk.gray(`    Tags: ${doc.metadata.tags.join(", ")}`));
							}
							console.log();
						}
					}
				}
			} catch (error) {
				console.error(chalk.red("✗ Search failed"));
				if (error instanceof Error) {
					console.error(chalk.red(`  ${error.message}`));
				}
				process.exit(1);
			}
		},
	);

/**
 * Get color function for status
 */
function getStatusColor(status: string) {
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
function getPriorityColor(priority: string) {
	switch (priority) {
		case "high":
			return chalk.red;
		case "medium":
			return chalk.yellow;
		case "low":
			return chalk.gray;
		default:
			return chalk.gray;
	}
}
