/**
 * Unified Search MCP handler
 * Search tasks and docs with filters
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@models/task";
import type { FileStore } from "@storage/file-store";
import matter from "gray-matter";
import { z } from "zod";
import { successResponse } from "../utils";
import { getProjectRoot } from "./project";

// Schema
export const searchSchema = z.object({
	query: z.string(),
	type: z.enum(["all", "task", "doc"]).optional(), // Default: all
	// Task filters
	status: z.string().optional(),
	priority: z.string().optional(),
	assignee: z.string().optional(),
	label: z.string().optional(),
	// Doc filters
	tag: z.string().optional(),
	// Limit results
	limit: z.number().optional(),
});

// Tool definition
export const searchTools = [
	{
		name: "search",
		description: "Unified search across tasks and docs with filters",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				type: {
					type: "string",
					enum: ["all", "task", "doc"],
					description: "Search type (default: all)",
				},
				status: { type: "string", description: "Filter tasks by status" },
				priority: { type: "string", description: "Filter tasks by priority" },
				assignee: { type: "string", description: "Filter tasks by assignee" },
				label: { type: "string", description: "Filter tasks by label" },
				tag: { type: "string", description: "Filter docs by tag" },
				limit: { type: "number", description: "Limit results (default: 20)" },
			},
			required: ["query"],
		},
	},
];

interface DocMetadata {
	title: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
	tags?: string[];
}

interface DocResult {
	path: string;
	title: string;
	description?: string;
	tags?: string[];
	score: number;
	matchContext?: string;
}

interface TaskResult {
	id: string;
	title: string;
	status: string;
	priority: string;
	assignee?: string;
	labels: string[];
	score: number;
}

/**
 * Calculate relevance score for task search
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
	if (task.id.toLowerCase().includes(q)) {
		score += 30;
	}

	// Labels match
	if (task.labels.some((l) => l.toLowerCase().includes(q))) {
		score += 10;
	}

	// Plan and notes match
	if (task.implementationPlan?.toLowerCase().includes(q)) {
		score += 15;
	}
	if (task.implementationNotes?.toLowerCase().includes(q)) {
		score += 15;
	}

	return score;
}

/**
 * Calculate relevance score for doc search
 */
function calculateDocScore(
	title: string,
	description: string | undefined,
	content: string,
	tags: string[] | undefined,
	query: string,
): number {
	const q = query.toLowerCase();
	let score = 0;

	// Title match is most important
	const titleLower = title.toLowerCase();
	if (titleLower === q) {
		score += 100;
	} else if (titleLower.includes(q)) {
		score += 50;
	}

	// Description match
	if (description?.toLowerCase().includes(q)) {
		score += 20;
	}

	// Content match
	if (content.toLowerCase().includes(q)) {
		score += 15;
	}

	// Tags match
	if (tags?.some((t) => t.toLowerCase().includes(q))) {
		score += 10;
	}

	return score;
}

/**
 * Recursively read all .md files
 */
async function getAllMdFiles(dir: string, basePath = ""): Promise<string[]> {
	const files: string[] = [];

	if (!existsSync(dir)) {
		return files;
	}

	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

		if (entry.isDirectory()) {
			const subFiles = await getAllMdFiles(fullPath, relativePath);
			files.push(...subFiles);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(relativePath);
		}
	}

	return files;
}

/**
 * Search tasks
 */
async function searchTasks(
	fileStore: FileStore,
	query: string,
	filters: {
		status?: string;
		priority?: string;
		assignee?: string;
		label?: string;
	},
): Promise<TaskResult[]> {
	const allTasks = await fileStore.getAllTasks();
	const q = query.toLowerCase();

	return allTasks
		.filter((task) => {
			// Text search
			const text =
				`${task.title} ${task.description || ""} ${task.labels.join(" ")} ${task.id} ${task.implementationPlan || ""} ${task.implementationNotes || ""}`.toLowerCase();
			if (!text.includes(q)) {
				return false;
			}

			// Apply filters
			if (filters.status && task.status !== filters.status) {
				return false;
			}
			if (filters.priority && task.priority !== filters.priority) {
				return false;
			}
			if (filters.assignee && task.assignee !== filters.assignee) {
				return false;
			}
			if (filters.label && !task.labels.includes(filters.label)) {
				return false;
			}

			return true;
		})
		.map((task) => ({
			id: task.id,
			title: task.title,
			status: task.status,
			priority: task.priority,
			assignee: task.assignee,
			labels: task.labels,
			score: calculateTaskScore(task, query),
		}))
		.sort((a, b) => b.score - a.score);
}

/**
 * Search docs
 */
async function searchDocs(docsDir: string, query: string, tagFilter?: string): Promise<DocResult[]> {
	if (!existsSync(docsDir)) {
		return [];
	}

	const mdFiles = await getAllMdFiles(docsDir);
	const q = query.toLowerCase();
	const results: DocResult[] = [];

	for (const file of mdFiles) {
		const fileContent = await readFile(join(docsDir, file), "utf-8");
		const { data, content } = matter(fileContent);
		const metadata = data as DocMetadata;

		// Filter by tag
		if (tagFilter && !metadata.tags?.includes(tagFilter)) {
			continue;
		}

		// Search in title, description, tags, content
		const titleMatch = metadata.title?.toLowerCase().includes(q);
		const descMatch = metadata.description?.toLowerCase().includes(q);
		const tagMatch = metadata.tags?.some((t) => t.toLowerCase().includes(q));
		const contentMatch = content.toLowerCase().includes(q);

		if (titleMatch || descMatch || tagMatch || contentMatch) {
			// Extract context
			let matchContext: string | undefined;
			if (contentMatch) {
				const contentLower = content.toLowerCase();
				const matchIndex = contentLower.indexOf(q);
				if (matchIndex !== -1) {
					const start = Math.max(0, matchIndex - 40);
					const end = Math.min(content.length, matchIndex + q.length + 40);
					matchContext = `...${content.slice(start, end).replace(/\n/g, " ")}...`;
				}
			}

			results.push({
				path: file.replace(/\.md$/, ""),
				title: metadata.title || file.replace(/\.md$/, ""),
				description: metadata.description,
				tags: metadata.tags,
				score: calculateDocScore(metadata.title, metadata.description, content, metadata.tags, query),
				matchContext,
			});
		}
	}

	return results.sort((a, b) => b.score - a.score);
}

/**
 * Handle unified search
 */
export async function handleSearch(args: unknown, fileStore: FileStore) {
	const input = searchSchema.parse(args);
	const searchType = input.type || "all";
	const limit = input.limit || 20;
	const docsDir = join(getProjectRoot(), ".knowns", "docs");

	let taskResults: TaskResult[] = [];
	let docResults: DocResult[] = [];

	// Search tasks
	if (searchType === "all" || searchType === "task") {
		taskResults = await searchTasks(fileStore, input.query, {
			status: input.status,
			priority: input.priority,
			assignee: input.assignee,
			label: input.label,
		});
	}

	// Search docs
	if (searchType === "all" || searchType === "doc") {
		docResults = await searchDocs(docsDir, input.query, input.tag);
	}

	// Apply limit
	taskResults = taskResults.slice(0, limit);
	docResults = docResults.slice(0, limit);

	return successResponse({
		query: input.query,
		type: searchType,
		tasks: {
			count: taskResults.length,
			results: taskResults,
		},
		docs: {
			count: docResults.length,
			results: docResults,
		},
		totalCount: taskResults.length + docResults.length,
	});
}
