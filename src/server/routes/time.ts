/**
 * Time tracking routes module
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Request, type Response, Router } from "express";
import type { RouteContext } from "../types";

interface ActiveTimer {
	taskId: string;
	startedAt: string;
	pausedAt: string | null;
	totalPausedMs: number;
}

interface TimeData {
	active: ActiveTimer | null;
}

export function createTimeRoutes(ctx: RouteContext): Router {
	const router = Router();
	const { store, broadcast } = ctx;
	const timePath = join(store.projectRoot, ".knowns", "time.json");

	async function loadTimeData(): Promise<TimeData> {
		if (!existsSync(timePath)) {
			return { active: null };
		}
		const content = await readFile(timePath, "utf-8");
		return JSON.parse(content);
	}

	async function saveTimeData(data: TimeData): Promise<void> {
		await writeFile(timePath, JSON.stringify(data, null, 2), "utf-8");
	}

	// GET /api/time/status - Get active timer status
	router.get("/status", async (_req: Request, res: Response) => {
		try {
			const data = await loadTimeData();

			if (!data.active) {
				res.json({ active: null });
				return;
			}

			// Get task details
			const task = await store.getTask(data.active.taskId);

			res.json({
				active: {
					...data.active,
					taskTitle: task?.title || "Unknown Task",
				},
			});
		} catch (error) {
			console.error("Error getting time status:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/time/start - Start timer for a task
	router.post("/start", async (req: Request, res: Response) => {
		try {
			const { taskId } = req.body;

			if (!taskId) {
				res.status(400).json({ error: "taskId is required" });
				return;
			}

			// Check if task exists
			const task = await store.getTask(taskId);
			if (!task) {
				res.status(404).json({ error: `Task ${taskId} not found` });
				return;
			}

			// Check for active timer
			const data = await loadTimeData();
			if (data.active) {
				res.status(409).json({
					error: `Timer already running for task #${data.active.taskId}`,
					activeTaskId: data.active.taskId,
				});
				return;
			}

			// Start new timer
			data.active = {
				taskId,
				startedAt: new Date().toISOString(),
				pausedAt: null,
				totalPausedMs: 0,
			};
			await saveTimeData(data);

			// Broadcast update
			broadcast({ type: "time:updated", active: { ...data.active, taskTitle: task.title } });

			res.json({
				success: true,
				active: { ...data.active, taskTitle: task.title },
			});
		} catch (error) {
			console.error("Error starting timer:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/time/stop - Stop current timer
	router.post("/stop", async (req: Request, res: Response) => {
		try {
			const data = await loadTimeData();

			if (!data.active) {
				res.status(400).json({ error: "No active timer" });
				return;
			}

			const { taskId, startedAt, pausedAt, totalPausedMs } = data.active;

			// Calculate duration
			const endTime = pausedAt ? new Date(pausedAt) : new Date();
			const elapsed = endTime.getTime() - new Date(startedAt).getTime() - totalPausedMs;
			const seconds = Math.floor(elapsed / 1000);

			// Save time entry to task
			const task = await store.getTask(taskId);
			if (task) {
				const entry = {
					id: `te-${Date.now()}`,
					startedAt: new Date(startedAt),
					endedAt: endTime,
					duration: seconds,
				};
				task.timeEntries.push(entry);
				task.timeSpent += seconds;

				await store.updateTask(taskId, {
					timeEntries: task.timeEntries,
					timeSpent: task.timeSpent,
				});

				// Broadcast task update
				broadcast({ type: "tasks:updated", task });
			}

			// Clear active timer
			data.active = null;
			await saveTimeData(data);

			// Broadcast time update
			broadcast({ type: "time:updated", active: null });

			res.json({
				success: true,
				duration: seconds,
				taskId,
			});
		} catch (error) {
			console.error("Error stopping timer:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/time/pause - Pause current timer
	router.post("/pause", async (_req: Request, res: Response) => {
		try {
			const data = await loadTimeData();

			if (!data.active) {
				res.status(400).json({ error: "No active timer" });
				return;
			}

			if (data.active.pausedAt) {
				res.status(400).json({ error: "Timer is already paused" });
				return;
			}

			data.active.pausedAt = new Date().toISOString();
			await saveTimeData(data);

			// Get task details for broadcast
			const task = await store.getTask(data.active.taskId);

			// Broadcast update
			broadcast({ type: "time:updated", active: { ...data.active, taskTitle: task?.title } });

			res.json({
				success: true,
				active: { ...data.active, taskTitle: task?.title },
			});
		} catch (error) {
			console.error("Error pausing timer:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/time/resume - Resume paused timer
	router.post("/resume", async (_req: Request, res: Response) => {
		try {
			const data = await loadTimeData();

			if (!data.active) {
				res.status(400).json({ error: "No active timer" });
				return;
			}

			if (!data.active.pausedAt) {
				res.status(400).json({ error: "Timer is not paused" });
				return;
			}

			// Add paused duration to total
			const pausedDuration = Date.now() - new Date(data.active.pausedAt).getTime();
			data.active.totalPausedMs += pausedDuration;
			data.active.pausedAt = null;
			await saveTimeData(data);

			// Get task details for broadcast
			const task = await store.getTask(data.active.taskId);

			// Broadcast update
			broadcast({ type: "time:updated", active: { ...data.active, taskTitle: task?.title } });

			res.json({
				success: true,
				active: { ...data.active, taskTitle: task?.title },
			});
		} catch (error) {
			console.error("Error resuming timer:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	return router;
}
