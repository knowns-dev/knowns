/**
 * Time Tracking Command
 * Track time spent on tasks with start/stop/pause/resume
 * Supports multiple concurrent timers (one per task)
 */

import { select } from "@inquirer/prompts";
import { FileStore } from "@storage/file-store";
import { file, write } from "@utils/bun-compat";
import { findProjectRoot } from "@utils/find-project-root";
import { normalizeTaskId } from "@utils/normalize-id";
import { notifyTaskUpdate, notifyTimeUpdate } from "@utils/notify-server";
import chalk from "chalk";
import { Command } from "commander";

/**
 * Active timer state
 */
interface ActiveTimer {
	taskId: string;
	taskTitle?: string;
	startedAt: string;
	pausedAt: string | null;
	totalPausedMs: number;
}

/**
 * Time tracking data stored in .knowns/time.json
 * Supports multiple concurrent timers (one per task)
 */
interface TimeData {
	active: ActiveTimer[];
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
 * Get project root or exit
 */
function getProjectRoot(): string {
	const projectRoot = findProjectRoot();
	if (!projectRoot) {
		console.error(chalk.red("✗ Not a knowns project"));
		console.error(chalk.gray('  Run "knowns init" to initialize'));
		process.exit(1);
	}
	return projectRoot;
}

/**
 * Load time tracking data
 * Handles migration from old single-timer format to multi-timer format
 */
async function loadTimeData(projectRoot: string): Promise<TimeData> {
	const f = file(`${projectRoot}/.knowns/time.json`);
	if (await f.exists()) {
		const content = await f.text();
		const data = JSON.parse(content);

		// Migrate from old format (active: ActiveTimer | null) to new format (active: ActiveTimer[])
		if (data.active && !Array.isArray(data.active)) {
			// Old format: single timer
			return { active: [data.active] };
		}

		// Handle null case (no active timers)
		if (data.active === null) {
			return { active: [] };
		}

		return data;
	}
	return { active: [] };
}

/**
 * Save time tracking data
 */
async function saveTimeData(projectRoot: string, data: TimeData): Promise<void> {
	await write(`${projectRoot}/.knowns/time.json`, JSON.stringify(data, null, 2));
}

/**
 * Format duration in human-readable format
 */
function formatDuration(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;

	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

	return parts.join(" ");
}

/**
 * Format elapsed time as HH:MM:SS
 */
function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Calculate elapsed time for a timer
 */
function calculateElapsed(timer: ActiveTimer): number {
	const startTime = new Date(timer.startedAt).getTime();
	const currentTime = timer.pausedAt ? new Date(timer.pausedAt).getTime() : Date.now();
	return currentTime - startTime - timer.totalPausedMs;
}

/**
 * Interactive timer selection
 */
async function selectTimer(timers: ActiveTimer[], action: string, allowAll = false): Promise<string | "all" | null> {
	if (timers.length === 0) {
		return null;
	}

	if (timers.length === 1) {
		return timers[0].taskId;
	}

	const choices = timers.map((timer) => {
		const elapsed = formatElapsed(calculateElapsed(timer));
		const status = timer.pausedAt ? chalk.yellow("(paused)") : chalk.green("(running)");
		return {
			name: `#${timer.taskId}: ${timer.taskTitle || "Unknown"} ${elapsed} ${status}`,
			value: timer.taskId,
		};
	});

	if (allowAll) {
		choices.push({
			name: chalk.cyan(`[All] ${action} all timers`),
			value: "all",
		});
	}

	console.log(chalk.yellow(`\nMultiple timers running. Which one to ${action}?\n`));

	const selected = await select({
		message: "Select timer:",
		choices,
	});

	return selected;
}

/**
 * knowns time start
 */
const startCommand = new Command("start")
	.description("Start timer for a task")
	.argument("<taskId>", "Task ID")
	.action(async (rawTaskId: string) => {
		try {
			const taskId = normalizeTaskId(rawTaskId);
			const projectRoot = getProjectRoot();
			const fileStore = getFileStore();

			// Check if task exists
			const task = await fileStore.getTask(taskId);
			if (!task) {
				console.error(chalk.red(`✗ Task ${taskId} not found`));
				process.exit(1);
			}

			// Load time data
			const data = await loadTimeData(projectRoot);

			// Check if timer already running for this task
			const existingTimer = data.active.find((t) => t.taskId === taskId);
			if (existingTimer) {
				console.error(chalk.yellow(`Timer already running for task #${taskId}`));
				console.error(chalk.gray(`  Stop it first with: knowns time stop ${taskId}`));
				process.exit(1);
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
			await saveTimeData(projectRoot, data);

			// Notify web server for real-time updates
			await notifyTimeUpdate(data.active);

			console.log(chalk.green(`⏱  Started timer for #${taskId}: ${task.title}`));

			// Show count if multiple timers
			if (data.active.length > 1) {
				console.log(chalk.gray(`   ${data.active.length} timers now running`));
			}
		} catch (error) {
			console.error(chalk.red("✗ Failed to start timer"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

/**
 * knowns time stop
 */
const stopCommand = new Command("stop")
	.description("Stop timer and save time entry")
	.argument("[taskId]", "Task ID (optional - prompts if multiple timers)")
	.option("-a, --all", "Stop all timers")
	.action(async (rawTaskId?: string, options?: { all?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const fileStore = getFileStore();

			const data = await loadTimeData(projectRoot);
			if (data.active.length === 0) {
				console.log(chalk.yellow("No active timers"));
				return;
			}

			let timersToStop: ActiveTimer[] = [];

			if (options?.all) {
				// Stop all timers
				timersToStop = [...data.active];
			} else if (rawTaskId) {
				// Stop specific timer
				const taskId = normalizeTaskId(rawTaskId);
				const timer = data.active.find((t) => t.taskId === taskId);
				if (!timer) {
					console.error(chalk.red(`✗ No active timer for task #${taskId}`));
					process.exit(1);
				}
				timersToStop = [timer];
			} else {
				// Interactive selection
				const selected = await selectTimer(data.active, "stop", true);
				if (selected === null) {
					console.log(chalk.yellow("No active timers"));
					return;
				}

				if (selected === "all") {
					timersToStop = [...data.active];
				} else {
					const timer = data.active.find((t) => t.taskId === selected);
					if (timer) {
						timersToStop = [timer];
					}
				}
			}

			// Stop each timer
			for (const timer of timersToStop) {
				const { taskId, startedAt, pausedAt, totalPausedMs } = timer;

				// Calculate duration
				const endTime = pausedAt ? new Date(pausedAt) : new Date();
				const elapsed = endTime.getTime() - new Date(startedAt).getTime() - totalPausedMs;
				const seconds = Math.floor(elapsed / 1000);

				// Save time entry to task
				const task = await fileStore.getTask(taskId);
				if (task) {
					const entry = {
						id: `te-${Date.now()}-${taskId}`,
						startedAt: new Date(startedAt),
						endedAt: endTime,
						duration: seconds,
					};
					task.timeEntries.push(entry);
					task.timeSpent += seconds;
					await fileStore.updateTask(taskId, {
						timeEntries: task.timeEntries,
						timeSpent: task.timeSpent,
					});

					// Notify web server for real-time updates
					await notifyTaskUpdate(taskId);
				}

				// Remove timer from active list
				const index = data.active.findIndex((t) => t.taskId === taskId);
				if (index !== -1) {
					data.active.splice(index, 1);
				}

				console.log(chalk.green(`⏹  Stopped timer for #${taskId}`));
				console.log(chalk.gray(`   Duration: ${formatDuration(seconds)}`));
			}

			await saveTimeData(projectRoot, data);

			// Notify web server
			await notifyTimeUpdate(data.active.length > 0 ? data.active : null);
		} catch (error) {
			console.error(chalk.red("✗ Failed to stop timer"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

/**
 * knowns time pause
 */
const pauseCommand = new Command("pause")
	.description("Pause timer")
	.argument("[taskId]", "Task ID (optional - prompts if multiple timers)")
	.option("-a, --all", "Pause all running timers")
	.action(async (rawTaskId?: string, options?: { all?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const fileStore = getFileStore();

			const data = await loadTimeData(projectRoot);
			if (data.active.length === 0) {
				console.log(chalk.yellow("No active timers"));
				return;
			}

			// Filter to only running (not paused) timers
			const runningTimers = data.active.filter((t) => !t.pausedAt);
			if (runningTimers.length === 0) {
				console.log(chalk.yellow("All timers are already paused"));
				return;
			}

			let timersToPause: ActiveTimer[] = [];

			if (options?.all) {
				timersToPause = runningTimers;
			} else if (rawTaskId) {
				const taskId = normalizeTaskId(rawTaskId);
				const timer = data.active.find((t) => t.taskId === taskId);
				if (!timer) {
					console.error(chalk.red(`✗ No active timer for task #${taskId}`));
					process.exit(1);
				}
				if (timer.pausedAt) {
					console.log(chalk.yellow(`Timer for task #${taskId} is already paused`));
					return;
				}
				timersToPause = [timer];
			} else {
				const selected = await selectTimer(runningTimers, "pause", true);
				if (selected === null) {
					console.log(chalk.yellow("No running timers"));
					return;
				}

				if (selected === "all") {
					timersToPause = runningTimers;
				} else {
					const timer = data.active.find((t) => t.taskId === selected);
					if (timer) {
						timersToPause = [timer];
					}
				}
			}

			// Pause each timer
			const pauseTime = new Date().toISOString();
			for (const timer of timersToPause) {
				timer.pausedAt = pauseTime;
				console.log(chalk.yellow(`⏸  Paused timer for #${timer.taskId}`));
			}

			await saveTimeData(projectRoot, data);

			// Notify web server
			await notifyTimeUpdate(data.active);
		} catch (error) {
			console.error(chalk.red("✗ Failed to pause timer"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

/**
 * knowns time resume
 */
const resumeCommand = new Command("resume")
	.description("Resume paused timer")
	.argument("[taskId]", "Task ID (optional - prompts if multiple timers)")
	.option("-a, --all", "Resume all paused timers")
	.action(async (rawTaskId?: string, options?: { all?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const fileStore = getFileStore();

			const data = await loadTimeData(projectRoot);
			if (data.active.length === 0) {
				console.log(chalk.yellow("No active timers"));
				return;
			}

			// Filter to only paused timers
			const pausedTimers = data.active.filter((t) => t.pausedAt);
			if (pausedTimers.length === 0) {
				console.log(chalk.yellow("No paused timers"));
				return;
			}

			let timersToResume: ActiveTimer[] = [];

			if (options?.all) {
				timersToResume = pausedTimers;
			} else if (rawTaskId) {
				const taskId = normalizeTaskId(rawTaskId);
				const timer = data.active.find((t) => t.taskId === taskId);
				if (!timer) {
					console.error(chalk.red(`✗ No active timer for task #${taskId}`));
					process.exit(1);
				}
				if (!timer.pausedAt) {
					console.log(chalk.yellow(`Timer for task #${taskId} is already running`));
					return;
				}
				timersToResume = [timer];
			} else {
				const selected = await selectTimer(pausedTimers, "resume", true);
				if (selected === null) {
					console.log(chalk.yellow("No paused timers"));
					return;
				}

				if (selected === "all") {
					timersToResume = pausedTimers;
				} else {
					const timer = data.active.find((t) => t.taskId === selected);
					if (timer) {
						timersToResume = [timer];
					}
				}
			}

			// Resume each timer
			const now = Date.now();
			for (const timer of timersToResume) {
				if (timer.pausedAt) {
					const pausedDuration = now - new Date(timer.pausedAt).getTime();
					timer.totalPausedMs += pausedDuration;
					timer.pausedAt = null;
				}
				console.log(chalk.green(`▶  Resumed timer for #${timer.taskId}`));
			}

			await saveTimeData(projectRoot, data);

			// Notify web server
			await notifyTimeUpdate(data.active);
		} catch (error) {
			console.error(chalk.red("✗ Failed to resume timer"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

/**
 * knowns time status
 */
const statusCommand = new Command("status")
	.description("Show active timer status")
	.option("--plain", "Plain text output for AI")
	.action(async (options?: { plain?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const fileStore = getFileStore();

			const data = await loadTimeData(projectRoot);
			if (data.active.length === 0) {
				console.log(options?.plain ? "No active timers" : chalk.gray("No active timers"));
				return;
			}

			if (options?.plain) {
				console.log(`Active timers: ${data.active.length}`);
				console.log("");
				for (const timer of data.active) {
					const elapsed = calculateElapsed(timer);
					const seconds = Math.floor(elapsed / 1000);
					const status = timer.pausedAt ? "PAUSED" : "RUNNING";
					console.log(`#${timer.taskId}: ${timer.taskTitle || "Unknown"}`);
					console.log(`  Status: ${status}`);
					console.log(`  Elapsed: ${formatDuration(seconds)}`);
					console.log("");
				}
			} else {
				console.log(chalk.bold(`\n⏱  Active Timers (${data.active.length})\n`));

				for (const timer of data.active) {
					const elapsed = calculateElapsed(timer);
					const seconds = Math.floor(elapsed / 1000);
					const status = timer.pausedAt ? chalk.yellow("(paused)") : chalk.green("(running)");

					// Get task title if not cached
					let title = timer.taskTitle;
					if (!title) {
						const task = await fileStore.getTask(timer.taskId);
						title = task?.title || "Unknown";
					}

					console.log(`  #${timer.taskId}: ${title}`);
					console.log(`    ${formatDuration(seconds)} ${status}`);
					console.log("");
				}
			}
		} catch (error) {
			console.error(chalk.red("✗ Failed to get timer status"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

/**
 * knowns time log
 */
const logCommand = new Command("log")
	.description("Show time log for a task")
	.argument("<taskId>", "Task ID")
	.action(async (rawTaskId: string) => {
		try {
			const taskId = normalizeTaskId(rawTaskId);
			const fileStore = getFileStore();

			const task = await fileStore.getTask(taskId);
			if (!task) {
				console.error(chalk.red(`✗ Task ${taskId} not found`));
				process.exit(1);
			}

			console.log(chalk.bold(`\n⏱  Time Log for #${taskId}: ${task.title}\n`));
			console.log(chalk.gray(`Total time: ${formatDuration(task.timeSpent)}\n`));

			if (task.timeEntries.length === 0) {
				console.log(chalk.gray("No time entries yet"));
				return;
			}

			for (const entry of task.timeEntries) {
				const start = new Date(entry.startedAt);
				const _end = entry.endedAt ? new Date(entry.endedAt) : new Date();
				const duration = formatDuration(entry.duration);

				console.log(`  ${chalk.gray(start.toLocaleString())}`);
				console.log(`    ${chalk.green("→")} ${duration}`);
			}

			console.log();
		} catch (error) {
			console.error(chalk.red("✗ Failed to show time log"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

/**
 * Parse duration string (e.g., "2h", "30m", "1h30m", "90s")
 */
function parseDuration(durationStr: string): number {
	let totalSeconds = 0;

	// Match hours
	const hoursMatch = durationStr.match(/(\d+)h/);
	if (hoursMatch) {
		totalSeconds += Number.parseInt(hoursMatch[1]) * 3600;
	}

	// Match minutes
	const minutesMatch = durationStr.match(/(\d+)m/);
	if (minutesMatch) {
		totalSeconds += Number.parseInt(minutesMatch[1]) * 60;
	}

	// Match seconds
	const secondsMatch = durationStr.match(/(\d+)s/);
	if (secondsMatch) {
		totalSeconds += Number.parseInt(secondsMatch[1]);
	}

	// If no units found, assume minutes
	if (totalSeconds === 0 && /^\d+$/.test(durationStr)) {
		totalSeconds = Number.parseInt(durationStr) * 60;
	}

	return totalSeconds;
}

/**
 * knowns time add
 */
const addCommand = new Command("add")
	.description("Manually add time entry to a task")
	.argument("<taskId>", "Task ID")
	.argument("<duration>", "Duration (e.g., 2h, 30m, 1h30m)")
	.option("-n, --note <text>", "Note for this time entry")
	.option("-d, --date <date>", "Date for time entry (default: now)")
	.action(async (rawTaskId: string, durationStr: string, options: { note?: string; date?: string }) => {
		try {
			const taskId = normalizeTaskId(rawTaskId);
			const fileStore = getFileStore();

			const task = await fileStore.getTask(taskId);
			if (!task) {
				console.error(chalk.red(`✗ Task ${taskId} not found`));
				process.exit(1);
			}

			// Parse duration
			const seconds = parseDuration(durationStr);
			if (seconds <= 0) {
				console.error(chalk.red(`✗ Invalid duration: ${durationStr}`));
				console.error(chalk.gray("  Examples: 2h, 30m, 1h30m, 90s"));
				process.exit(1);
			}

			// Parse date
			const entryDate = options.date ? new Date(options.date) : new Date();
			if (Number.isNaN(entryDate.getTime())) {
				console.error(chalk.red(`✗ Invalid date: ${options.date}`));
				process.exit(1);
			}

			// Create time entry
			const entry = {
				id: `te-${Date.now()}`,
				startedAt: entryDate,
				endedAt: new Date(entryDate.getTime() + seconds * 1000),
				duration: seconds,
				note: options.note,
			};

			task.timeEntries.push(entry);
			task.timeSpent += seconds;

			await fileStore.updateTask(taskId, {
				timeEntries: task.timeEntries,
				timeSpent: task.timeSpent,
			});

			// Notify web server for real-time updates
			await notifyTaskUpdate(taskId);

			console.log(chalk.green(`✓ Added ${formatDuration(seconds)} to #${taskId}: ${task.title}`));
			if (options.note) {
				console.log(chalk.gray(`  Note: ${options.note}`));
			}
		} catch (error) {
			console.error(chalk.red("✗ Failed to add time entry"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

/**
 * knowns time report
 */
const reportCommand = new Command("report")
	.description("Generate time tracking report")
	.option("--from <date>", "Start date (YYYY-MM-DD)")
	.option("--to <date>", "End date (YYYY-MM-DD)")
	.option("--by-label", "Group by label")
	.option("--by-status", "Group by status")
	.option("--csv", "Export as CSV")
	.action(
		async (options: {
			from?: string;
			to?: string;
			byLabel?: boolean;
			byStatus?: boolean;
			csv?: boolean;
		}) => {
			try {
				const fileStore = getFileStore();
				const tasks = await fileStore.getAllTasks();

				// Parse date filters
				let fromDate: Date | null = null;
				let toDate: Date | null = null;

				if (options.from) {
					fromDate = new Date(options.from);
					if (Number.isNaN(fromDate.getTime())) {
						console.error(chalk.red(`✗ Invalid from date: ${options.from}`));
						process.exit(1);
					}
				}

				if (options.to) {
					toDate = new Date(options.to);
					toDate.setHours(23, 59, 59, 999); // End of day
					if (Number.isNaN(toDate.getTime())) {
						console.error(chalk.red(`✗ Invalid to date: ${options.to}`));
						process.exit(1);
					}
				}

				// Filter and aggregate time entries
				interface TaskTimeData {
					taskId: string;
					title: string;
					status: string;
					labels: string[];
					totalSeconds: number;
					entries: number;
				}

				const taskTimeData: TaskTimeData[] = [];

				for (const task of tasks) {
					let totalSeconds = 0;
					let entryCount = 0;

					for (const entry of task.timeEntries) {
						const entryDate = new Date(entry.startedAt);

						// Apply date filters
						if (fromDate && entryDate < fromDate) continue;
						if (toDate && entryDate > toDate) continue;

						totalSeconds += entry.duration;
						entryCount++;
					}

					if (totalSeconds > 0) {
						taskTimeData.push({
							taskId: task.id,
							title: task.title,
							status: task.status,
							labels: task.labels,
							totalSeconds,
							entries: entryCount,
						});
					}
				}

				if (taskTimeData.length === 0) {
					console.log(chalk.gray("No time entries found"));
					return;
				}

				// CSV export
				if (options.csv) {
					console.log("Task ID,Title,Status,Labels,Time (seconds),Time (formatted),Entries");
					for (const data of taskTimeData) {
						const labels = data.labels.join(";");
						console.log(
							`${data.taskId},"${data.title}",${data.status},"${labels}",${data.totalSeconds},"${formatDuration(data.totalSeconds)}",${data.entries}`,
						);
					}
					return;
				}

				// Group by label
				if (options.byLabel) {
					const byLabel = new Map<string, number>();

					for (const data of taskTimeData) {
						if (data.labels.length === 0) {
							byLabel.set("(no label)", (byLabel.get("(no label)") || 0) + data.totalSeconds);
						} else {
							for (const label of data.labels) {
								byLabel.set(label, (byLabel.get(label) || 0) + data.totalSeconds);
							}
						}
					}

					console.log(chalk.bold("\n📊 Time Report by Label\n"));

					const sorted = Array.from(byLabel.entries()).sort((a, b) => b[1] - a[1]);
					for (const [label, seconds] of sorted) {
						console.log(`${chalk.cyan(label.padEnd(20))} ${chalk.green(formatDuration(seconds))}`);
					}

					const total = sorted.reduce((sum, [, s]) => sum + s, 0);
					console.log(chalk.gray(`\n${"-".repeat(40)}`));
					console.log(chalk.bold(`Total: ${formatDuration(total)}\n`));
					return;
				}

				// Group by status
				if (options.byStatus) {
					const byStatus = new Map<string, number>();

					for (const data of taskTimeData) {
						byStatus.set(data.status, (byStatus.get(data.status) || 0) + data.totalSeconds);
					}

					console.log(chalk.bold("\n📊 Time Report by Status\n"));

					const sorted = Array.from(byStatus.entries()).sort((a, b) => b[1] - a[1]);
					for (const [status, seconds] of sorted) {
						console.log(`${chalk.cyan(status.padEnd(20))} ${chalk.green(formatDuration(seconds))}`);
					}

					const total = sorted.reduce((sum, [, s]) => sum + s, 0);
					console.log(chalk.gray(`\n${"-".repeat(40)}`));
					console.log(chalk.bold(`Total: ${formatDuration(total)}\n`));
					return;
				}

				// Default: list by task
				console.log(chalk.bold("\n📊 Time Report\n"));

				if (fromDate || toDate) {
					const range = [];
					if (fromDate) range.push(`From: ${fromDate.toLocaleDateString()}`);
					if (toDate) range.push(`To: ${toDate.toLocaleDateString()}`);
					console.log(chalk.gray(`${range.join(", ")}\n`));
				}

				// Sort by time spent (descending)
				taskTimeData.sort((a, b) => b.totalSeconds - a.totalSeconds);

				for (const data of taskTimeData) {
					console.log(`${chalk.bold(`#${data.taskId}`)} ${data.title}`);
					console.log(`  ${chalk.green(formatDuration(data.totalSeconds))} ${chalk.gray(`(${data.entries} entries)`)}`);
				}

				const total = taskTimeData.reduce((sum, data) => sum + data.totalSeconds, 0);
				console.log(chalk.gray(`\n${"-".repeat(40)}`));
				console.log(chalk.bold(`Total: ${formatDuration(total)}\n`));
			} catch (error) {
				console.error(chalk.red("✗ Failed to generate report"));
				if (error instanceof Error) {
					console.error(chalk.red(`  ${error.message}`));
				}
				process.exit(1);
			}
		},
	);

/**
 * Main time command
 */
export const timeCommand = new Command("time").description("Time tracking commands");

// Add subcommands
timeCommand.addCommand(startCommand);
timeCommand.addCommand(stopCommand);
timeCommand.addCommand(pauseCommand);
timeCommand.addCommand(resumeCommand);
timeCommand.addCommand(statusCommand);
timeCommand.addCommand(logCommand);
timeCommand.addCommand(addCommand);
timeCommand.addCommand(reportCommand);
