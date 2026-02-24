/**
 * Beautiful progress bar for CLI
 */

import chalk from "chalk";

export interface ProgressBarOptions {
	/** Total width of the progress bar (default: 30) */
	width?: number;
	/** Show percentage (default: true) */
	showPercent?: boolean;
	/** Show ETA (default: false) */
	showEta?: boolean;
	/** Fill character (default: "█") */
	fillChar?: string;
	/** Empty character (default: "░") */
	emptyChar?: string;
	/** Prefix text */
	prefix?: string;
	/** Show spinner for indeterminate progress */
	spinner?: boolean;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

/**
 * Format duration to human readable string
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const mins = Math.floor(ms / 60000);
	const secs = Math.round((ms % 60000) / 1000);
	return `${mins}m ${secs}s`;
}

/**
 * Create a progress bar string
 */
export function createProgressBar(progress: number, options: ProgressBarOptions = {}): string {
	const { width = 30, showPercent = true, fillChar = "█", emptyChar = "░", prefix = "" } = options;

	// Clamp progress to 0-100
	const clampedProgress = Math.max(0, Math.min(100, progress));
	const filled = Math.round((clampedProgress / 100) * width);
	const empty = width - filled;

	const bar = fillChar.repeat(filled) + emptyChar.repeat(empty);
	const percent = showPercent ? ` ${clampedProgress.toFixed(0).padStart(3)}%` : "";
	const prefixStr = prefix ? `${prefix} ` : "";

	return `${prefixStr}${chalk.cyan(bar)}${chalk.white(percent)}`;
}

/**
 * Progress bar class for tracking download/upload progress
 */
export class ProgressBar {
	private startTime: number;
	private lastUpdate = 0;
	private spinnerIndex = 0;
	private currentProgress = 0;
	private options: ProgressBarOptions;

	constructor(options: ProgressBarOptions = {}) {
		this.options = {
			width: 30,
			showPercent: true,
			showEta: true,
			fillChar: "█",
			emptyChar: "░",
			prefix: "",
			...options,
		};
		this.startTime = Date.now();
	}

	/**
	 * Update progress and render
	 */
	update(progress: number, extraInfo?: string): void {
		this.currentProgress = progress;
		const now = Date.now();

		// Throttle updates to max 10 per second
		if (now - this.lastUpdate < 100 && progress < 100) return;
		this.lastUpdate = now;

		this.render(extraInfo);
	}

	/**
	 * Render the progress bar
	 */
	private render(extraInfo?: string): void {
		const { width, fillChar, emptyChar, prefix, showEta } = this.options;

		const clampedProgress = Math.max(0, Math.min(100, this.currentProgress));
		const filled = Math.round((clampedProgress / 100) * (width || 30));
		const empty = (width || 30) - filled;

		// Build the bar with gradient effect
		let bar = "";
		for (let i = 0; i < filled; i++) {
			// Gradient from cyan to green
			if (i < filled * 0.3) {
				bar += chalk.cyan(fillChar);
			} else if (i < filled * 0.7) {
				bar += chalk.cyanBright(fillChar);
			} else {
				bar += chalk.greenBright(fillChar);
			}
		}
		bar += chalk.gray(emptyChar?.repeat(empty) || "");

		// Calculate ETA
		let etaStr = "";
		if (showEta && clampedProgress > 0 && clampedProgress < 100) {
			const elapsed = Date.now() - this.startTime;
			const estimated = (elapsed / clampedProgress) * (100 - clampedProgress);
			etaStr = chalk.gray(` ETA: ${formatDuration(estimated)}`);
		}

		// Format percentage with color
		const percentNum = clampedProgress.toFixed(0);
		let percentStr = "";
		if (clampedProgress < 30) {
			percentStr = chalk.red(`${percentNum.padStart(3)}%`);
		} else if (clampedProgress < 70) {
			percentStr = chalk.yellow(`${percentNum.padStart(3)}%`);
		} else {
			percentStr = chalk.green(`${percentNum.padStart(3)}%`);
		}

		const prefixStr = prefix ? `${prefix} ` : "";
		const extra = extraInfo ? chalk.gray(` ${extraInfo}`) : "";

		// Clear line and write progress
		process.stdout.write(`\r${prefixStr}${bar} ${percentStr}${etaStr}${extra}   `);
	}

	/**
	 * Show spinner for indeterminate progress
	 */
	spin(message: string): void {
		this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
		const spinner = chalk.cyan(SPINNER_FRAMES[this.spinnerIndex]);
		process.stdout.write(`\r${spinner} ${message}   `);
	}

	/**
	 * Complete the progress bar
	 */
	complete(message?: string): void {
		const elapsed = Date.now() - this.startTime;
		process.stdout.write(`\r${" ".repeat(80)}\r`); // Clear line
		if (message) {
			console.log(`${chalk.green("✓")} ${message}${chalk.gray(` (${formatDuration(elapsed)})`)}`);
		}
	}

	/**
	 * Show error and stop
	 */
	error(message: string): void {
		process.stdout.write(`\r${" ".repeat(80)}\r`); // Clear line
		console.log(`${chalk.red("✗")} ${message}`);
	}
}

/**
 * Create and return a progress callback for model download
 */
export function createModelDownloadProgress(modelName: string): {
	onProgress: (progress: number) => void;
	complete: () => void;
	error: (msg: string) => void;
} {
	const bar = new ProgressBar({
		width: 25,
		prefix: chalk.cyan("  Downloading"),
		showEta: true,
	});

	return {
		onProgress: (progress: number) => {
			if (progress > 0 && progress < 100) {
				bar.update(progress);
			}
		},
		complete: () => {
			bar.complete(`Model downloaded: ${modelName}`);
		},
		error: (msg: string) => {
			bar.error(msg);
		},
	};
}
