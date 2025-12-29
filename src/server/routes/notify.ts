/**
 * Notify routes module - CLI notifies server about changes
 */

import { type Request, type Response, Router } from "express";
import type { RouteContext } from "../types";

export function createNotifyRoutes(ctx: RouteContext): Router {
	const router = Router();
	const { store, broadcast } = ctx;

	// POST /api/notify - CLI notifies server about task/doc changes
	router.post("/", async (req: Request, res: Response) => {
		try {
			const { taskId, type, docPath } = req.body;

			if (taskId) {
				// Reload task from disk and broadcast
				const task = await store.getTask(taskId);
				if (task) {
					broadcast({ type: "tasks:updated", task });
					res.json({ success: true });
					return;
				}
			} else if (type === "tasks:refresh") {
				// Broadcast refresh signal to reload all tasks
				broadcast({ type: "tasks:refresh" });
				res.json({ success: true });
				return;
			} else if (type === "docs:updated" && docPath) {
				// Broadcast doc update
				broadcast({ type: "docs:updated", docPath });
				res.json({ success: true });
				return;
			} else if (type === "docs:refresh") {
				// Broadcast docs refresh signal
				broadcast({ type: "docs:refresh" });
				res.json({ success: true });
				return;
			} else if (type === "time:updated") {
				// Broadcast time tracking update
				const { active } = req.body;
				broadcast({ type: "time:updated", active });
				res.json({ success: true });
				return;
			}

			res.status(400).json({ success: false, error: "Invalid notify request" });
		} catch (error) {
			console.error("[Server] Notify error:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	return router;
}
