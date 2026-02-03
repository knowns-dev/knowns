/**
 * Time tracking routes module
 * Supports multiple concurrent timers (one per task)
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Request, type Response, Router } from "express";
import type { RouteContext } from "../types";

interface ActiveTimer {
	taskId: string;
	taskTitle?: string;
	startedAt: string;
	pausedAt: string | null;
	totalPausedMs: number;
}

interface TimeData {
	active: ActiveTimer[];
}

export function createTimeRoutes(ctx: RouteContext): Router {
	const router = Router();
	const { store, broadcast } = ctx;
	const timePath = join(store.projectRoot, ".knowns", "time.json");

	/**
	 * Load time data with migration from old format
	 */
	async function loadTimeData(): Promise<TimeData> {
		if (!existsSync(timePath)) {
			return { active: [] };
		}
		const content = await readFile(timePath, "utf-8");
		const data = JSON.parse(content);

		// Migrate from old format (active: ActiveTimer | null) to new format (active: ActiveTimer[])
		if (data.active && !Array.isArray(data.active)) {
			return { active: [data.active] };
		}

		if (data.active === null) {
			return { active: [] };
		}

		return data;
	}

	async function saveTimeData(data: TimeData): Promise<void> {
		await writeFile(timePath, JSON.stringify(data, null, 2), "utf-8");
	}

	/**
	 * Enrich timers with task titles
	 */
	async function enrichTimers(timers: ActiveTimer[]): Promise<ActiveTimer[]> {
		return Promise.all(
			timers.map(async (timer) => {
				if (!timer.taskTitle) {
					const task = await store.getTask(timer.taskId);
					return { ...timer, taskTitle: task?.title || "Unknown Task" };
				}
				return timer;
			}),
		);
	}

	// GET /api/time/status - Get all active timers
	router.get("/status", async (_req: Request, res: Response) => {
		try {
			const data = await loadTimeData();

			if (data.active.length === 0) {
				res.json({ active: [] });
				return;
			}

			// Enrich with task titles
			const enriched = await enrichTimers(data.active);

			res.json({ active: enriched });
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

			// Load time data
			const data = await loadTimeData();

			// Check if timer already running for this task
			const existingTimer = data.active.find((t) => t.taskId === taskId);
			if (existingTimer) {
				res.status(409).json({
					error: `Timer already running for task #${taskId}`,
					activeTaskId: taskId,
				});
				return;
			}

			// Add new timer
			const newTimer: ActiveTimer = {
				taskId,
				taskTitle: task.title,
				startedAt: new Date().toISOString(),
				pausedAt: null,
				totalPausedMs: 0,
			};
			data.active.push(newTimer);
			await saveTimeData(data);

			// Broadcast update with all timers
			broadcast({ type: "time:updated", active: data.active });

			res.json({
				success: true,
				active: data.active,
				timer: newTimer,
			});
		} catch (error) {
			console.error("Error starting timer:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/time/stop - Stop timer(s)
	router.post("/stop", async (req: Request, res: Response) => {
		try {
			const { taskId, all } = req.body;
			const data = await loadTimeData();

			if (data.active.length === 0) {
				res.status(400).json({ error: "No active timers" });
				return;
			}

			let timersToStop: ActiveTimer[] = [];

			if (all) {
				// Stop all timers
				timersToStop = [...data.active];
			} else if (taskId) {
				// Stop specific timer
				const timer = data.active.find((t) => t.taskId === taskId);
				if (!timer) {
					res.status(404).json({ error: `No active timer for task #${taskId}` });
					return;
				}
				timersToStop = [timer];
			} else {
				// Default: stop most recent timer
				timersToStop = [data.active[data.active.length - 1]];
			}

			const results: Array<{ taskId: string; duration: number }> = [];

			// Stop each timer
			for (const timer of timersToStop) {
				const { taskId: tid, startedAt, pausedAt, totalPausedMs } = timer;

				// Calculate duration
				const endTime = pausedAt ? new Date(pausedAt) : new Date();
				const elapsed = endTime.getTime() - new Date(startedAt).getTime() - totalPausedMs;
				const seconds = Math.floor(elapsed / 1000);

				// Save time entry to task
				const task = await store.getTask(tid);
				if (task) {
					const entry = {
						id: `te-${Date.now()}-${tid}`,
						startedAt: new Date(startedAt),
						endedAt: endTime,
						duration: seconds,
					};
					task.timeEntries.push(entry);
					task.timeSpent += seconds;

					await store.updateTask(tid, {
						timeEntries: task.timeEntries,
						timeSpent: task.timeSpent,
					});

					// Broadcast task update
					broadcast({ type: "tasks:updated", task });
				}

				// Remove from active list
				const index = data.active.findIndex((t) => t.taskId === tid);
				if (index !== -1) {
					data.active.splice(index, 1);
				}

				results.push({ taskId: tid, duration: seconds });
			}

			await saveTimeData(data);

			// Broadcast time update
			broadcast({ type: "time:updated", active: data.active });

			res.json({
				success: true,
				stopped: results,
				active: data.active,
			});
		} catch (error) {
			console.error("Error stopping timer:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/time/pause - Pause timer(s)
	router.post("/pause", async (req: Request, res: Response) => {
		try {
			const { taskId, all } = req.body;
			const data = await loadTimeData();

			if (data.active.length === 0) {
				res.status(400).json({ error: "No active timers" });
				return;
			}

			// Filter to running timers only
			const runningTimers = data.active.filter((t) => !t.pausedAt);
			if (runningTimers.length === 0) {
				res.status(400).json({ error: "All timers are already paused" });
				return;
			}

			let timersToPause: ActiveTimer[] = [];

			if (all) {
				timersToPause = runningTimers;
			} else if (taskId) {
				const timer = data.active.find((t) => t.taskId === taskId);
				if (!timer) {
					res.status(404).json({ error: `No active timer for task #${taskId}` });
					return;
				}
				if (timer.pausedAt) {
					res.status(400).json({ error: `Timer for task #${taskId} is already paused` });
					return;
				}
				timersToPause = [timer];
			} else {
				// Default: pause most recent running timer
				timersToPause = [runningTimers[runningTimers.length - 1]];
			}

			// Pause each timer
			const pauseTime = new Date().toISOString();
			const pausedIds: string[] = [];
			for (const timer of timersToPause) {
				timer.pausedAt = pauseTime;
				pausedIds.push(timer.taskId);
			}

			await saveTimeData(data);

			// Broadcast update
			broadcast({ type: "time:updated", active: data.active });

			res.json({
				success: true,
				paused: pausedIds,
				active: data.active,
			});
		} catch (error) {
			console.error("Error pausing timer:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/time/resume - Resume paused timer(s)
	router.post("/resume", async (req: Request, res: Response) => {
		try {
			const { taskId, all } = req.body;
			const data = await loadTimeData();

			if (data.active.length === 0) {
				res.status(400).json({ error: "No active timers" });
				return;
			}

			// Filter to paused timers only
			const pausedTimers = data.active.filter((t) => t.pausedAt);
			if (pausedTimers.length === 0) {
				res.status(400).json({ error: "No paused timers" });
				return;
			}

			let timersToResume: ActiveTimer[] = [];

			if (all) {
				timersToResume = pausedTimers;
			} else if (taskId) {
				const timer = data.active.find((t) => t.taskId === taskId);
				if (!timer) {
					res.status(404).json({ error: `No active timer for task #${taskId}` });
					return;
				}
				if (!timer.pausedAt) {
					res.status(400).json({ error: `Timer for task #${taskId} is already running` });
					return;
				}
				timersToResume = [timer];
			} else {
				// Default: resume most recent paused timer
				timersToResume = [pausedTimers[pausedTimers.length - 1]];
			}

			// Resume each timer
			const now = Date.now();
			const resumedIds: string[] = [];
			for (const timer of timersToResume) {
				if (timer.pausedAt) {
					const pausedDuration = now - new Date(timer.pausedAt).getTime();
					timer.totalPausedMs += pausedDuration;
					timer.pausedAt = null;
					resumedIds.push(timer.taskId);
				}
			}

			await saveTimeData(data);

			// Broadcast update
			broadcast({ type: "time:updated", active: data.active });

			res.json({
				success: true,
				resumed: resumedIds,
				active: data.active,
			});
		} catch (error) {
			console.error("Error resuming timer:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	return router;
}
