/**
 * Search Command
 * Search tasks and docs by query with filters
 * Supports hybrid semantic search when enabled
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@models/index";
import type { EmbeddingModel, SemanticSearchSettings } from "@models/project";
import { chunkDocument, chunkTask } from "@search/chunker";
import { EmbeddingService } from "@search/embedding";
import { HybridSearchEngine, type SearchMode, type SearchResult } from "@search/engine";
import { SearchIndexStore } from "@search/store";
import type { Chunk } from "@search/types";
import { FileStore } from "@storage/file-store";
import { findProjectRoot } from "@utils/find-project-root";
import { ProgressBar } from "@utils/progress-bar";
import chalk from "chalk";
import { Command } from "commander";
import matter from "gray-matter";
import { listAllDocs } from "../import";

interface DocMetadata {
	title: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
	tags?: string[];
}

/**
 * Recursively get all .md files from a directory
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
 * Search documentation files (legacy keyword search)
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
 * Build full search index from all tasks and docs
 */
export async function rebuildIndex(
	projectRoot: string,
	model: EmbeddingModel,
	onProgress?: (message: string) => void,
	settings?: SemanticSearchSettings,
): Promise<void> {
	const fileStore = new FileStore(projectRoot);
	const embeddingService = new EmbeddingService({
		model,
		huggingFaceId: settings?.huggingFaceId,
		dimensions: settings?.dimensions,
		maxTokens: settings?.maxTokens,
	});
	const store = new SearchIndexStore(projectRoot, model);

	// Load embedding model
	const needsDownload = !embeddingService.isModelDownloaded();
	if (needsDownload) {
		onProgress?.("Downloading embedding model...");
		const progressBar = new ProgressBar({
			width: 25,
			prefix: chalk.cyan("  "),
			showEta: true,
		});
		await embeddingService.loadModel((progress) => {
			if (progress > 0 && progress < 100) {
				progressBar.update(progress);
			}
		});
		progressBar.complete(`Model downloaded: ${model}`);
	} else {
		onProgress?.("Loading embedding model...");
		await embeddingService.loadModel();
	}

	// Clear existing index
	await store.clear();

	// Initialize database
	await store.initDatabase();

	// Collect all chunks with embeddings for saving later
	const allEmbeddedChunks: Chunk[] = [];

	// Get all tasks
	const tasks = await fileStore.getAllTasks();
	let taskChunksCount = 0;

	if (tasks.length > 0) {
		onProgress?.(`Indexing ${tasks.length} tasks...`);
		const taskProgress = new ProgressBar({
			width: 25,
			prefix: chalk.cyan("  Tasks"),
			showEta: false,
		});

		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i];
			if (!task) continue;
			const chunkResult = chunkTask(task, model);
			const embeddedChunks = await embeddingService.embedChunks(chunkResult.chunks);
			await store.addChunks(embeddedChunks);
			allEmbeddedChunks.push(...embeddedChunks);
			taskChunksCount += embeddedChunks.length;

			taskProgress.update(((i + 1) / tasks.length) * 100);
		}
		taskProgress.complete(`${tasks.length} tasks indexed (${taskChunksCount} chunks)`);
	}

	// Get all docs (local + imports)
	let docChunksCount = 0;
	const allDocs = await listAllDocs(projectRoot);

	if (allDocs.length > 0) {
		const localCount = allDocs.filter((d) => !d.isImported).length;
		const importedCount = allDocs.filter((d) => d.isImported).length;
		onProgress?.(`Indexing ${allDocs.length} docs (${localCount} local, ${importedCount} imported)...`);
		const docProgress = new ProgressBar({
			width: 25,
			prefix: chalk.cyan("  Docs "),
			showEta: false,
		});

		for (let i = 0; i < allDocs.length; i++) {
			const doc = allDocs[i];
			if (!doc) continue;
			const content = await readFile(doc.fullPath, "utf-8");
			const { data, content: docContent } = matter(content);
			const metadata = data as DocMetadata;
			// Use ref as docPath to include import prefix (e.g., "knowns/patterns/auth")
			const docPath = doc.ref;

			const chunkResult = chunkDocument(
				docContent,
				{
					path: docPath,
					title: metadata.title || doc.name,
					description: metadata.description,
					tags: metadata.tags,
				},
				model,
			);

			const embeddedChunks = await embeddingService.embedChunks(chunkResult.chunks);
			await store.addChunks(embeddedChunks);
			allEmbeddedChunks.push(...embeddedChunks);
			docChunksCount += embeddedChunks.length;

			docProgress.update(((i + 1) / allDocs.length) * 100);
		}
		docProgress.complete(`${allDocs.length} docs indexed (${docChunksCount} chunks)`);
	}

	// Save index with the chunks we collected (which have embeddings)
	onProgress?.("Saving index...");
	await store.save(allEmbeddedChunks);

	onProgress?.(`Index rebuilt: ${tasks.length} tasks (${taskChunksCount} chunks), ${docChunksCount} doc chunks`);

	// Cleanup
	embeddingService.dispose();
}

/**
 * Show semantic search status
 */
async function showStatus(projectRoot: string): Promise<void> {
	const settings = await getSemanticSearchSettings(projectRoot);

	if (!settings || !settings.enabled) {
		console.log(chalk.yellow("Semantic search: disabled"));
		console.log(chalk.gray('  Enable with "knowns init" or manually in .knowns/config.json'));
		return;
	}

	console.log(chalk.green("Semantic search: enabled"));
	console.log(chalk.gray(`  Model: ${settings.model}`));
	if (settings.huggingFaceId) {
		console.log(chalk.gray(`  HuggingFace: ${settings.huggingFaceId}`));
	}

	// Check model status
	const embeddingService = new EmbeddingService({
		model: settings.model,
		huggingFaceId: settings.huggingFaceId,
		dimensions: settings.dimensions,
		maxTokens: settings.maxTokens,
	});
	const modelStatus = await embeddingService.getModelStatus();

	if (modelStatus.downloaded) {
		console.log(chalk.green(`  Model downloaded: ${modelStatus.path}`));
		if (modelStatus.sizeBytes) {
			const sizeMB = (modelStatus.sizeBytes / (1024 * 1024)).toFixed(1);
			console.log(chalk.gray(`  Model size: ${sizeMB} MB`));
		}
		if (!modelStatus.valid) {
			console.log(chalk.yellow(`  Model validation: ${modelStatus.error || "invalid"}`));
		}
	} else {
		console.log(chalk.yellow("  Model not downloaded"));
		console.log(chalk.gray('  Run "knowns search --reindex" to download and build index'));
	}

	// Check index status
	const store = new SearchIndexStore(projectRoot, settings.model);
	const version = await store.getVersion();

	if (version) {
		console.log(chalk.green(`  Index: ${version.itemCount} items, ${version.chunkCount} chunks`));
		console.log(chalk.gray(`  Last indexed: ${new Date(version.indexedAt).toLocaleString()}`));
	} else {
		console.log(chalk.yellow("  Index not built"));
		console.log(chalk.gray('  Run "knowns search --reindex" to build index'));
	}
}

/**
 * knowns search
 */
export const searchCommand = new Command("search")
	.description("Search tasks and documentation by query")
	.argument("[query]", "Search query")
	.option("--type <type>", "Search type: task, doc, or all (default: all)")
	.option("--status <status>", "Filter tasks by status")
	.option("-l, --label <label>", "Filter tasks by label")
	.option("--assignee <name>", "Filter tasks by assignee")
	.option("--priority <level>", "Filter tasks by priority")
	.option("--keyword", "Force keyword-only search (disable semantic)")
	.option("--reindex", "Rebuild the search index")
	.option("--setup", "Download model and setup semantic search")
	.option("--status-check", "Show semantic search status")
	.option("--plain", "Plain text output for AI")
	.action(
		async (
			query: string | undefined,
			options: {
				type?: string;
				status?: string;
				label?: string;
				assignee?: string;
				priority?: string;
				keyword?: boolean;
				reindex?: boolean;
				setup?: boolean;
				statusCheck?: boolean;
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

				// Handle --status-check
				if (options.statusCheck) {
					await showStatus(projectRoot);
					return;
				}

				// Handle --reindex or --setup
				if (options.reindex || options.setup) {
					const settings = await getSemanticSearchSettings(projectRoot);

					if (!settings || !settings.enabled) {
						console.error(chalk.red("✗ Semantic search is not enabled"));
						console.error(chalk.gray("  Enable in .knowns/config.json: settings.semanticSearch.enabled = true"));
						process.exit(1);
					}

					console.log(chalk.cyan("Rebuilding search index..."));
					await rebuildIndex(
						projectRoot,
						settings.model,
						(message) => {
							console.log(chalk.gray(`  ${message}`));
						},
						settings,
					);
					console.log(chalk.green("✓ Index rebuilt successfully"));
					return;
				}

				// Require query for search
				if (!query) {
					console.error(chalk.red("✗ Search query is required"));
					console.error(chalk.gray("  Usage: knowns search <query>"));
					console.error(chalk.gray("  Or use: knowns search --status-check"));
					process.exit(1);
				}

				const searchType = options.type || "all";
				const settings = await getSemanticSearchSettings(projectRoot);
				const useHybrid = settings?.enabled === true && settings.model && !options.keyword;

				// Perform search
				if (useHybrid && settings?.model) {
					// Use hybrid semantic search
					await performHybridSearch(query, projectRoot, settings.model, options, settings);
				} else {
					// Use legacy keyword search
					await performKeywordSearch(query, projectRoot, options);
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
 * Perform hybrid semantic search
 */
async function performHybridSearch(
	query: string,
	projectRoot: string,
	model: EmbeddingModel,
	options: {
		type?: string;
		status?: string;
		label?: string;
		assignee?: string;
		priority?: string;
		plain?: boolean;
	},
	settings?: SemanticSearchSettings,
): Promise<void> {
	const embeddingService = new EmbeddingService({
		model,
		huggingFaceId: settings?.huggingFaceId,
		dimensions: settings?.dimensions,
		maxTokens: settings?.maxTokens,
	});
	const store = new SearchIndexStore(projectRoot, model);

	// Check if model is available
	if (!embeddingService.isModelDownloaded()) {
		if (options.plain) {
			console.log("WARNING: Embedding model not downloaded. Falling back to keyword search.");
			console.log("  To enable semantic search, run: knowns search --reindex");
		} else {
			console.log(chalk.yellow("⚠ Embedding model not downloaded"));
			console.log(chalk.gray(`  Model: ${model}`));
			console.log(chalk.gray("  To download and enable semantic search, run:"));
			console.log(chalk.cyan("    knowns search --reindex"));
			console.log();
			console.log(chalk.gray("Falling back to keyword search..."));
			console.log();
		}
		await performKeywordSearch(query, projectRoot, options);
		return;
	}

	// Check if index exists - auto-rebuild if missing
	if (!store.indexExists()) {
		if (options.plain) {
			console.log("Search index not found. Building index...");
		} else {
			console.log(chalk.yellow("⚠ Search index not found (may have been gitignored or cloned fresh)"));
			console.log(chalk.cyan("  Auto-rebuilding index from tasks and docs..."));
			console.log();
		}

		// Auto-rebuild the index
		try {
			await rebuildIndex(
				projectRoot,
				model,
				(message) => {
					if (options.plain) {
						console.log(`  ${message}`);
					} else {
						console.log(chalk.gray(`  ${message}`));
					}
				},
				settings,
			);

			if (options.plain) {
				console.log("Index rebuilt successfully.");
				console.log();
			} else {
				console.log(chalk.green("✓ Index rebuilt successfully"));
				console.log();
			}

			// Reload the store after rebuild
			await store.load();
		} catch (error) {
			if (options.plain) {
				console.log("WARNING: Failed to rebuild index. Falling back to keyword search.");
			} else {
				console.log(chalk.yellow("⚠ Failed to rebuild index, falling back to keyword search"));
				if (error instanceof Error) {
					console.log(chalk.gray(`  ${error.message}`));
				}
				console.log();
			}
			await performKeywordSearch(query, projectRoot, options);
			return;
		}
	}

	// Load model and index
	await embeddingService.loadModel();
	await store.load();

	const engine = new HybridSearchEngine(store, embeddingService, model);

	const searchType = options.type || "all";
	const response = await engine.search(query, {
		mode: "hybrid" as SearchMode,
		type: searchType === "all" ? "all" : (searchType as "doc" | "task"),
		status: options.status,
		priority: options.priority,
		labels: options.label ? [options.label] : undefined,
		limit: 20,
	});

	// Output results
	displayHybridResults(response.results, query, options.plain);

	// Cleanup
	embeddingService.dispose();
}

/**
 * Display hybrid search results
 */
function displayHybridResults(results: SearchResult[], query: string, plain?: boolean): void {
	if (results.length === 0) {
		if (plain) {
			console.log("No results found");
		} else {
			console.log(chalk.yellow(`No results found for "${query}"`));
		}
		return;
	}

	if (plain) {
		// Group by type
		const taskResults = results.filter((r) => r.type === "task");
		const docResults = results.filter((r) => r.type === "doc");

		if (taskResults.length > 0) {
			console.log("Tasks:");
			// Group by status
			const statusGroups: Record<string, SearchResult[]> = {};
			const statusOrder = ["todo", "in-progress", "in-review", "blocked", "done"];
			const statusNames: Record<string, string> = {
				todo: "To Do",
				"in-progress": "In Progress",
				"in-review": "In Review",
				blocked: "Blocked",
				done: "Done",
			};

			for (const result of taskResults) {
				const status = result.status || "todo";
				if (!statusGroups[status]) {
					statusGroups[status] = [];
				}
				statusGroups[status].push(result);
			}

			for (const status of statusOrder) {
				const tasks = statusGroups[status];
				if (!tasks || tasks.length === 0) continue;

				console.log(`  ${statusNames[status]}:`);
				for (const task of tasks) {
					const scorePercent = Math.round(task.score * 100);
					console.log(`    #${task.taskId} [${task.status}] [${task.priority}] (${scorePercent}%)`);
					console.log(
						`      ${task.content.substring(0, 80).replace(/\n/g, " ")}${task.content.length > 80 ? "..." : ""}`,
					);
					if (task.matchedBy && task.matchedBy.length > 0) {
						console.log(`      Matched by: ${task.matchedBy.join(", ")}`);
					}
				}
			}
		}

		if (docResults.length > 0) {
			if (taskResults.length > 0) console.log("");
			console.log("Docs:");

			for (const doc of docResults) {
				const scorePercent = Math.round(doc.score * 100);
				console.log(`  ${doc.docPath} (${scorePercent}%)`);
				if (doc.section) {
					console.log(`    Section: ${doc.section}`);
				}
				if (doc.matchedBy && doc.matchedBy.length > 0) {
					console.log(`    Matched by: ${doc.matchedBy.join(", ")}`);
				}
			}
		}
	} else {
		console.log(chalk.bold(`\n🔍 Found ${results.length} result(s) for "${query}" (hybrid mode):\n`));

		// Group by type
		const taskResults = results.filter((r) => r.type === "task");
		const docResults = results.filter((r) => r.type === "doc");

		if (taskResults.length > 0) {
			console.log(chalk.bold("📋 Tasks:\n"));
			for (const result of taskResults) {
				const statusColor = getStatusColor(result.status || "todo");
				const priorityColor = getPriorityColor(result.priority || "medium");
				const scorePercent = Math.round(result.score * 100);

				const parts = [
					chalk.gray(`#${result.taskId}`),
					result.content.substring(0, 60) + (result.content.length > 60 ? "..." : ""),
					statusColor(`[${result.status}]`),
					priorityColor(`[${result.priority}]`),
					chalk.gray(`(${scorePercent}%)`),
				];

				console.log(`  ${parts.join(" ")}`);
				console.log(chalk.gray(`    Matched by: ${result.matchedBy.join(", ")}`));
			}
			console.log();
		}

		if (docResults.length > 0) {
			console.log(chalk.bold("📚 Documentation:\n"));
			for (const result of docResults) {
				const scorePercent = Math.round(result.score * 100);
				console.log(`  ${chalk.cyan(result.docPath)} ${chalk.gray(`(${scorePercent}%)`)}`);
				if (result.section) {
					console.log(chalk.gray(`    Section: ${result.section}`));
				}
				console.log(chalk.gray(`    Matched by: ${result.matchedBy.join(", ")}`));
				console.log();
			}
		}
	}
}

/**
 * Perform legacy keyword search
 */
async function performKeywordSearch(
	query: string,
	projectRoot: string,
	options: {
		type?: string;
		status?: string;
		label?: string;
		assignee?: string;
		priority?: string;
		plain?: boolean;
	},
): Promise<void> {
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
					const folder = parts.length > 1 ? `${parts.slice(0, -1).join("/")}/` : "";
					if (!pathGroups[folder]) {
						pathGroups[folder] = [];
					}
					pathGroups[folder].push(doc);
				}

				const sortedPaths = Object.keys(pathGroups).sort((a, b) => {
					if (a === "") return -1;
					if (b === "") return 1;
					return a.localeCompare(b);
				});

				for (const path of sortedPaths) {
					if (path) {
						console.log(`  ${path}:`);
					}
					const indent = path ? "    " : "  ";
					for (const doc of pathGroups[path]) {
						const filename = doc.filename.split("/").pop() || doc.filename;
						console.log(`${indent}${filename} - ${doc.metadata.title}`);
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

		console.log(chalk.bold(`\n🔍 Found ${totalResults} result(s) for "${query}" (keyword mode):\n`));

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
}

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
