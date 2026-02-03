/**
 * Task routes module
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Request, type Response, Router } from "express";
import matter from "gray-matter";
import type { AcceptanceCriterion, Task } from "../../models/task";
import type { RouteContext } from "../types";

/**
 * Normalize text for comparison (lowercase, remove special chars)
 */
function normalizeText(text: string): string {
	return text
		.toLowerCase()
		.replace(/^(ac-?\d+:?\s*|#\d+\s*)/i, "") // Remove AC-1:, #1, etc prefixes
		.replace(/[^\w\s]/g, " ") // Remove special chars
		.replace(/\s+/g, " ") // Normalize whitespace
		.trim();
}

/**
 * Calculate similarity between two strings (0-1)
 * Uses word overlap (Jaccard similarity)
 */
function textSimilarity(a: string, b: string): number {
	const wordsA = new Set(normalizeText(a).split(" ").filter(Boolean));
	const wordsB = new Set(normalizeText(b).split(" ").filter(Boolean));
	if (wordsA.size === 0 || wordsB.size === 0) return 0;

	const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
	const union = new Set([...wordsA, ...wordsB]).size;
	return intersection / union;
}

/**
 * Sync spec ACs based on task ACs
 * When task ACs are checked, find matching ACs in linked spec and check them
 */
async function syncSpecACs(
	task: Task,
	projectRoot: string | undefined,
	broadcast: (data: object) => void,
): Promise<void> {
	// Skip if no project root
	if (!projectRoot) return;
	// Skip if no spec linked
	if (!task.spec) return;

	// Get completed task ACs
	const completedACs = task.acceptanceCriteria.filter((ac) => ac.completed);
	if (completedACs.length === 0) return;

	// Load spec document
	const specPath = join(projectRoot, ".knowns", "docs", `${task.spec}.md`);
	if (!existsSync(specPath)) return;

	try {
		const content = await readFile(specPath, "utf-8");
		const { data: frontmatter, content: docContent } = matter(content);

		// Find and update ACs in spec content
		let updatedContent = docContent;
		let hasChanges = false;

		// Match unchecked ACs in spec: - [ ] AC text
		const acPattern = /^([ \t]*)-\s*\[\s*\]\s*(.+)$/gm;

		updatedContent = docContent.replace(acPattern, (match, indent, acText) => {
			// Check if any completed task AC matches this spec AC
			for (const taskAC of completedACs) {
				const similarity = textSimilarity(taskAC.text, acText);
				// Threshold: 0.5 = at least half the words match
				if (similarity >= 0.5) {
					hasChanges = true;
					return `${indent}- [x] ${acText}`;
				}
			}
			return match; // No match, keep unchanged
		});

		// Save if changes were made
		if (hasChanges) {
			const newFileContent = matter.stringify(updatedContent, frontmatter);
			await writeFile(specPath, newFileContent, "utf-8");

			// Broadcast doc update
			broadcast({ type: "docs:updated", path: task.spec });
		}
	} catch (err) {
		console.error("Error syncing spec ACs:", err);
	}
}

export function createTaskRoutes(ctx: RouteContext): Router {
	const router = Router();
	const { store, broadcast } = ctx;

	// GET /api/tasks - List all tasks
	router.get("/", async (_req: Request, res: Response) => {
		try {
			const tasks = await store.getAllTasks();
			res.json(tasks);
		} catch (error) {
			console.error("Error getting tasks:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// GET /api/tasks/:id/history - Get task version history
	router.get("/:id/history", async (req: Request, res: Response) => {
		try {
			const taskId = req.params.id;
			const history = await store.getTaskVersionHistory(taskId);
			res.json({ versions: history });
		} catch (error) {
			console.error("Error getting task history:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// GET /api/tasks/:id - Get single task
	router.get("/:id", async (req: Request, res: Response) => {
		try {
			const task = await store.getTask(req.params.id);
			if (!task) {
				res.status(404).json({ error: "Task not found" });
				return;
			}
			res.json(task);
		} catch (error) {
			console.error("Error getting task:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/tasks - Create task
	router.post("/", async (req: Request, res: Response) => {
		try {
			const data = req.body;
			const task = await store.createTask(data);
			broadcast({ type: "tasks:updated", task });
			res.status(201).json(task);
		} catch (error) {
			console.error("Error creating task:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/tasks/batch-archive - Batch archive done tasks older than specified duration
	// NOTE: This route MUST be before /:id routes to avoid matching "batch-archive" as an id
	router.post("/batch-archive", async (req: Request, res: Response) => {
		try {
			const { olderThanMs } = req.body as { olderThanMs: number };
			if (typeof olderThanMs !== "number" || olderThanMs < 0) {
				res.status(400).json({ error: "olderThanMs must be a positive number" });
				return;
			}
			const archivedTasks = await store.batchArchiveTasks(olderThanMs);
			broadcast({ type: "tasks:batch-archived", tasks: archivedTasks });
			res.json({ success: true, count: archivedTasks.length, tasks: archivedTasks });
		} catch (error) {
			console.error("Error batch archiving tasks:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// PUT /api/tasks/:id - Update task
	router.put("/:id", async (req: Request, res: Response) => {
		try {
			const updates = req.body;
			const task = await store.updateTask(req.params.id, updates);
			broadcast({ type: "tasks:updated", task });

			// Sync spec ACs when task ACs are updated
			if (updates.acceptanceCriteria || updates.status === "done") {
				await syncSpecACs(task, store.projectRoot, broadcast);
			}

			res.json(task);
		} catch (error) {
			console.error("Error updating task:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/tasks/sync-spec-acs - Sync all done task ACs to their linked specs
	// NOTE: This route MUST be before /:id routes
	router.post("/sync-spec-acs", async (_req: Request, res: Response) => {
		try {
			const tasks = await store.getAllTasks();
			const doneTasks = tasks.filter((t) => t.status === "done" && t.spec);
			let syncedCount = 0;

			for (const task of doneTasks) {
				await syncSpecACs(task, store.projectRoot, broadcast);
				syncedCount++;
			}

			res.json({ success: true, synced: syncedCount });
		} catch (error) {
			console.error("Error syncing spec ACs:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/tasks/:id/archive - Archive task
	router.post("/:id/archive", async (req: Request, res: Response) => {
		try {
			const task = await store.archiveTask(req.params.id);
			broadcast({ type: "tasks:archived", task });
			res.json({ success: true, task });
		} catch (error) {
			console.error("Error archiving task:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/tasks/:id/unarchive - Unarchive task
	router.post("/:id/unarchive", async (req: Request, res: Response) => {
		try {
			const task = await store.unarchiveTask(req.params.id);
			broadcast({ type: "tasks:unarchived", task });
			res.json({ success: true, task });
		} catch (error) {
			console.error("Error unarchiving task:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	return router;
}
