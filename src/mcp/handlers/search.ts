/**
 * Unified Search MCP handler
 * Search tasks and docs with filters
 * Supports hybrid semantic search when enabled
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EmbeddingModel, SemanticSearchSettings } from "@models/project";
import type { Task } from "@models/task";
import { chunkDocument, chunkTask } from "@search/chunker";
import { EmbeddingService } from "@search/embedding";
import { HybridSearchEngine, type SearchMode, type SearchResult } from "@search/engine";
import { SearchIndexStore } from "@search/store";
import type { FileStore } from "@storage/file-store";
import matter from "gray-matter";
import { z } from "zod";
import { errorResponse, successResponse } from "../utils";
import { getProjectRoot } from "./project";

// Schema
export const searchSchema = z.object({
	query: z.string(),
	type: z.enum(["all", "task", "doc"]).optional(), // Default: all
	mode: z.enum(["hybrid", "semantic", "keyword"]).optional(), // Default: hybrid
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

export const reindexSearchSchema = z.object({});

// Tool definition
export const searchTools = [
	{
		name: "search",
		description: "Unified search across tasks and docs with filters. Supports hybrid semantic search when enabled.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				type: {
					type: "string",
					enum: ["all", "task", "doc"],
					description: "Search type (default: all)",
				},
				mode: {
					type: "string",
					enum: ["hybrid", "semantic", "keyword"],
					description: "Search mode: hybrid (semantic + keyword), semantic only, or keyword only (default: hybrid)",
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
	{
		name: "reindex_search",
		description:
			"Rebuild the semantic search index from all tasks and docs. Use when index is out of sync or after enabling semantic search.",
		inputSchema: {
			type: "object",
			properties: {},
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
 * Get semantic search settings from project config
 */
async function getSemanticSearchSettings(projectRoot: string): Promise<SemanticSearchSettings | null> {
	try {
		const configPath = join(projectRoot, ".knowns", "config.json");
		if (!existsSync(configPath)) {
			return null;
		}

		const content = await readFile(configPath, "utf-8");
		const config = JSON.parse(content);
		return config.settings?.semanticSearch || null;
	} catch {
		return null;
	}
}

/**
 * Perform hybrid/semantic search using HybridSearchEngine
 * Auto-rebuilds index if missing (for clone/gitignore scenarios)
 */
async function performHybridSearch(
	query: string,
	projectRoot: string,
	model: EmbeddingModel,
	searchMode: SearchMode,
	searchType: "all" | "task" | "doc",
	limit: number,
): Promise<{ taskResults: SearchResult[]; docResults: SearchResult[]; warning?: string }> {
	const embeddingService = new EmbeddingService({ model });
	const store = new SearchIndexStore(projectRoot, model);
	let warning: string | undefined;

	// Check if model is downloaded
	if (!embeddingService.isModelDownloaded()) {
		throw new Error(
			"Embedding model not downloaded. Run 'knowns search --reindex' or 'mcp__knowns__reindex_search' to set up.",
		);
	}

	// Load model
	await embeddingService.loadModel();

	// Check if index exists - auto-rebuild if missing
	let db = await store.getDatabase();

	if (!db) {
		// Auto-rebuild the index
		warning = "Search index was missing and has been auto-rebuilt";
		const { rebuildIndex } = await import("../../commands/search");
		await rebuildIndex(projectRoot, model);

		// Reload the store after rebuild
		db = await store.getDatabase();
		if (!db) {
			throw new Error("Failed to rebuild search index");
		}
	}

	const engine = new HybridSearchEngine(embeddingService, db);

	let taskResults: SearchResult[] = [];
	let docResults: SearchResult[] = [];

	// Search based on type
	if (searchType === "all" || searchType === "task") {
		taskResults = await engine.search(query, {
			mode: searchMode,
			limit,
			type: "task",
		});
	}

	if (searchType === "all" || searchType === "doc") {
		docResults = await engine.search(query, {
			mode: searchMode,
			limit,
			type: "doc",
		});
	}

	// Dispose embedding service
	embeddingService.dispose();

	return { taskResults, docResults, warning };
}

/**
 * Handle unified search
 */
export async function handleSearch(args: unknown, fileStore: FileStore) {
	const input = searchSchema.parse(args);
	const searchType = input.type || "all";
	const searchMode = input.mode || "hybrid";
	const limit = input.limit || 20;
	const projectRoot = getProjectRoot();
	const docsDir = join(projectRoot, ".knowns", "docs");

	// Check if semantic search is enabled
	const settings = await getSemanticSearchSettings(projectRoot);
	const useHybrid = settings?.enabled === true && settings.model && searchMode !== "keyword";

	let taskResults: TaskResult[] = [];
	let docResults: DocResult[] = [];

	let searchWarning: string | undefined;

	if (useHybrid && settings?.model) {
		// Use hybrid/semantic search
		try {
			const hybridMode: SearchMode = searchMode === "semantic" ? "semantic" : "hybrid";
			const {
				taskResults: hybridTasks,
				docResults: hybridDocs,
				warning,
			} = await performHybridSearch(input.query, projectRoot, settings.model, hybridMode, searchType, limit);

			searchWarning = warning;

			// Convert SearchResult to TaskResult/DocResult format
			taskResults = hybridTasks.map((r) => ({
				id: r.id,
				title: r.title,
				status: r.metadata?.status || "unknown",
				priority: r.metadata?.priority || "medium",
				assignee: r.metadata?.assignee,
				labels: r.metadata?.labels || [],
				score: r.score,
			}));

			docResults = hybridDocs.map((r) => ({
				path: r.path || r.id,
				title: r.title,
				description: r.snippet,
				tags: r.metadata?.tags,
				score: r.score,
				matchContext: r.snippet,
			}));

			// Apply task filters (semantic search doesn't filter, so we do it here)
			if (input.status) {
				taskResults = taskResults.filter((t) => t.status === input.status);
			}
			if (input.priority) {
				taskResults = taskResults.filter((t) => t.priority === input.priority);
			}
			if (input.assignee) {
				taskResults = taskResults.filter((t) => t.assignee === input.assignee);
			}
			if (input.label) {
				taskResults = taskResults.filter((t) => t.labels.includes(input.label as string));
			}

			// Apply doc tag filter
			if (input.tag) {
				docResults = docResults.filter((d) => d.tags?.includes(input.tag as string));
			}
		} catch (error) {
			// Fall back to keyword search on error
			searchWarning = `Hybrid search failed, using keyword search: ${error instanceof Error ? error.message : String(error)}`;

			if (searchType === "all" || searchType === "task") {
				taskResults = await searchTasks(fileStore, input.query, {
					status: input.status,
					priority: input.priority,
					assignee: input.assignee,
					label: input.label,
				});
			}

			if (searchType === "all" || searchType === "doc") {
				docResults = await searchDocs(docsDir, input.query, input.tag);
			}
		}
	} else {
		// Use keyword search
		if (searchType === "all" || searchType === "task") {
			taskResults = await searchTasks(fileStore, input.query, {
				status: input.status,
				priority: input.priority,
				assignee: input.assignee,
				label: input.label,
			});
		}

		if (searchType === "all" || searchType === "doc") {
			docResults = await searchDocs(docsDir, input.query, input.tag);
		}
	}

	// Apply limit
	taskResults = taskResults.slice(0, limit);
	docResults = docResults.slice(0, limit);

	return successResponse({
		query: input.query,
		type: searchType,
		mode: useHybrid ? searchMode : "keyword",
		...(searchWarning && { warning: searchWarning }),
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

/**
 * Handle reindex search
 */
export async function handleReindexSearch(args: unknown, fileStore: FileStore) {
	reindexSearchSchema.parse(args);
	const projectRoot = getProjectRoot();

	// Check if semantic search is enabled
	const settings = await getSemanticSearchSettings(projectRoot);
	if (!settings?.enabled || !settings.model) {
		return errorResponse(
			"Semantic search is not enabled. Enable it with: knowns config set semanticSearch.enabled true",
		);
	}

	try {
		const { rebuildIndex } = await import("../../commands/search");
		await rebuildIndex(projectRoot, settings.model);

		return successResponse({
			message: "Search index rebuilt successfully",
			model: settings.model,
		});
	} catch (error) {
		return errorResponse(`Failed to rebuild index: ${error instanceof Error ? error.message : String(error)}`);
	}
}
