/**
 * Notify the web server about task changes from CLI/MCP
 * This allows real-time updates in the Web UI when AI/CLI modifies tasks
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "./find-project-root";

const DEFAULT_PORT = 6420;

// Cache the project root for MCP context where process.cwd() is not reliable
let cachedProjectRoot: string | null = null;

/**
 * Set the project root for notification functions
 * Call this when initializing MCP to ensure notifications find the right port file
 */
export function setNotifyProjectRoot(projectRoot: string): void {
	cachedProjectRoot = projectRoot;
}

/**
 * Get server port from port file, config, or use default
 * @param projectRoot - Optional project root override (for MCP context)
 */
function getServerPort(projectRoot?: string): number {
	try {
		// Priority: explicit param > cached > findProjectRoot
		const root = projectRoot || cachedProjectRoot || findProjectRoot();
		if (!root) return DEFAULT_PORT;

		// First, check for running server's port file
		const portFilePath = join(root, ".knowns/.server-port");
		if (existsSync(portFilePath)) {
			const portFromFile = Number.parseInt(readFileSync(portFilePath, "utf-8").trim(), 10);
			if (!Number.isNaN(portFromFile) && portFromFile > 0) {
				return portFromFile;
			}
		}

		// Fall back to config
		const configPath = join(root, ".knowns/config.json");
		if (!existsSync(configPath)) return DEFAULT_PORT;

		const content = readFileSync(configPath, "utf-8");
		const config = JSON.parse(content);
		const port = config.settings?.serverPort;

		return typeof port === "number" ? port : DEFAULT_PORT;
	} catch {
		return DEFAULT_PORT;
	}
}

/**
 * Notify server that a task was updated
 * Silently fails if server is not running
 */
export async function notifyTaskUpdate(taskId: string): Promise<void> {
	try {
		const port = getServerPort();
		const response = await fetch(`http://localhost:${port}/api/notify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ taskId }),
			signal: AbortSignal.timeout(1000), // 1 second timeout
		});

		if (response.ok) {
			// Server notified successfully
		}
	} catch {
		// Server not running or timeout - silently ignore
	}
}

/**
 * Notify server to refresh all tasks
 * Useful after bulk operations
 */
export async function notifyRefresh(): Promise<void> {
	try {
		const port = getServerPort();
		await fetch(`http://localhost:${port}/api/notify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "tasks:refresh" }),
			signal: AbortSignal.timeout(1000),
		});
	} catch {
		// Server not running - silently ignore
	}
}

/**
 * Notify server that a doc was updated
 * Silently fails if server is not running
 */
export async function notifyDocUpdate(docPath: string): Promise<void> {
	try {
		const port = getServerPort();
		await fetch(`http://localhost:${port}/api/notify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "docs:updated", docPath }),
			signal: AbortSignal.timeout(1000),
		});
	} catch {
		// Server not running - silently ignore
	}
}

/**
 * Notify server to refresh all docs
 */
export async function notifyDocsRefresh(): Promise<void> {
	try {
		const port = getServerPort();
		await fetch(`http://localhost:${port}/api/notify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "docs:refresh" }),
			signal: AbortSignal.timeout(1000),
		});
	} catch {
		// Server not running - silently ignore
	}
}

/**
 * Notify server about time tracking updates
 * @param active - Active timer data or null if stopped
 */
export async function notifyTimeUpdate(
	active: {
		taskId: string;
		taskTitle: string;
		startedAt: string;
		pausedAt: string | null;
		totalPausedMs: number;
	} | null,
): Promise<void> {
	try {
		const port = getServerPort();
		await fetch(`http://localhost:${port}/api/notify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "time:updated", active }),
			signal: AbortSignal.timeout(1000),
		});
	} catch {
		// Server not running - silently ignore
	}
}
