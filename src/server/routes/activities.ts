/**
 * Activities routes module
 */

import { type Request, type Response, Router } from "express";
import type { RouteContext } from "../types";

export function createActivityRoutes(ctx: RouteContext): Router {
	const router = Router();
	const { store } = ctx;

	// GET /api/activities
	router.get("/", async (req: Request, res: Response) => {
		try {
			const limit = Number.parseInt((req.query.limit as string) || "50", 10);
			const type = req.query.type as string | undefined;

			const tasks = await store.getAllTasks();
			const allActivities: Array<{
				taskId: string;
				taskTitle: string;
				version: number;
				timestamp: Date;
				author?: string;
				changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>;
			}> = [];

			// Collect version history from all tasks
			for (const task of tasks) {
				const versions = await store.getTaskVersionHistory(task.id);
				for (const version of versions) {
					// Filter by change type if specified
					if (type) {
						const hasMatchingChange = version.changes.some((c) => c.field === type);
						if (!hasMatchingChange) continue;
					}

					allActivities.push({
						taskId: task.id,
						taskTitle: task.title,
						version: version.version,
						timestamp: version.timestamp,
						author: version.author,
						changes: version.changes,
					});
				}
			}

			// Sort by timestamp descending (most recent first)
			allActivities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

			// Limit results
			const limited = allActivities.slice(0, limit);

			res.json({ activities: limited });
		} catch (error) {
			console.error("Error getting activities:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	return router;
}
