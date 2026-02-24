/**
 * Task routes module
 */

import { type Request, type Response, Router } from "express";
import type { Task } from "../../models/task";
import { getIndexService } from "../../search/index-service";
import { syncSpecACs } from "../../utils/sync-spec-acs";
import type { RouteContext } from "../types";

export function createTaskRoutes(ctx: RouteContext): Router {
	const router = Router();
	const { store, broadcast } = ctx;

	// GET /api/tasks - List all tasks
	router.get("/", async (_req: Request, res: Response) => {
		try {
			const tasks = await store.getAllTasks();

			// Sort tasks: by order first (if exists), then by createdAt, then alphabetically
			tasks.sort((a: Task, b: Task) => {
				const orderA = a.order;
				const orderB = b.order;

				// Both have order: sort by order
				if (orderA !== undefined && orderB !== undefined) {
					return orderA - orderB;
				}
				// Only one has order: ordered items come first
				if (orderA !== undefined) return -1;
				if (orderB !== undefined) return 1;

				// Neither has order: sort by createdAt, then alphabetically
				const createdA = a.createdAt;
				const createdB = b.createdAt;
				if (createdA && createdB) {
					const dateCompare = new Date(createdA).getTime() - new Date(createdB).getTime();
					if (dateCompare !== 0) return dateCompare;
				}

				// Final fallback: alphabetical by title
				return a.title.localeCompare(b.title);
			});

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

			// Index task for semantic search (fire and forget)
			getIndexService(store.projectRoot)
				.indexTask(task)
				.catch(() => {});

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

			// Remove archived tasks from search index (fire and forget)
			const indexService = getIndexService(store.projectRoot);
			for (const task of archivedTasks) {
				indexService.removeTask(task.id).catch(() => {});
			}

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

			// Index task for semantic search (fire and forget)
			getIndexService(store.projectRoot)
				.indexTask(task)
				.catch(() => {});

			// Sync spec ACs when task ACs/fulfills are updated or task is done
			if (updates.acceptanceCriteria || updates.fulfills || updates.status === "done") {
				const syncResult = await syncSpecACs(task, store.projectRoot);
				if (syncResult.synced) {
					broadcast({ type: "docs:updated", path: task.spec });
				}
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
				const syncResult = await syncSpecACs(task, store.projectRoot);
				if (syncResult.synced) {
					broadcast({ type: "docs:updated", path: task.spec });
					syncedCount++;
				}
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

			// Remove task from search index (fire and forget)
			getIndexService(store.projectRoot)
				.removeTask(task.id)
				.catch(() => {});

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

			// Re-index task for semantic search (fire and forget)
			if (task) {
				getIndexService(store.projectRoot)
					.indexTask(task)
					.catch(() => {});
			}

			res.json({ success: true, task });
		} catch (error) {
			console.error("Error unarchiving task:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	return router;
}
