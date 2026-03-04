/**
 * Browser Command
 * Opens web UI for task management
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImportConfig } from "@import/models";
import { startServer } from "@server/index";
import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";

// Check if running in Bun
const isBun = typeof globalThis.Bun !== "undefined";

/**
 * Check if a Knowns server is already running on the given port
 * Returns true only if it's a Knowns server (responds to /api/events)
 */
async function isKnownsServerRunning(port: number): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 1000);

		const response = await fetch(`http://localhost:${port}/api/events`, {
			method: "HEAD",
			signal: controller.signal,
		});

		clearTimeout(timeout);
		return response.ok || response.status === 405; // 405 = Method Not Allowed (SSE endpoint)
	} catch {
		return false;
	}
}

/**
 * Open browser to a URL
 */
function openBrowser(url: string): void {
	try {
		if (isBun) {
			const openCommand = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
			Bun.spawn([openCommand, url]);
		} else if (process.platform === "darwin") {
			spawn("open", [url], { stdio: "ignore" });
		} else if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" });
		} else {
			spawn("xdg-open", [url], { stdio: "ignore" });
		}
	} catch (error) {
		console.error("Failed to open browser:", error);
	}
}

const DEFAULT_PORT = 6420;
const CONFIG_FILE = ".knowns/config.json";

/**
 * Save server port to config when user specifies custom port
 */
async function saveServerPort(projectRoot: string, port: number): Promise<void> {
	const configPath = join(projectRoot, CONFIG_FILE);
	const knownsDir = join(projectRoot, ".knowns");

	// Ensure .knowns directory exists
	if (!existsSync(knownsDir)) {
		await mkdir(knownsDir, { recursive: true });
	}

	try {
		// Read existing config or create new (preserves imports and other fields)
		let config: {
			name?: string;
			id?: string;
			createdAt?: string;
			imports?: ImportConfig[];
			settings?: Record<string, unknown>;
		} = {};
		if (existsSync(configPath)) {
			const content = await readFile(configPath, "utf-8");
			config = JSON.parse(content);
		}

		// Update settings.serverPort (preserves existing settings)
		const settings = config.settings || {};
		settings.serverPort = port;
		config.settings = settings;

		await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
	} catch {
		// Silently ignore config save errors
	}
}

export const browserCommand = new Command("browser")
	.description("Open web UI for task management")
	.option("-p, --port <port>", "Port number", String(DEFAULT_PORT))
	.option("--no-open", "Don't open browser automatically")
	.option("--cors-origin <origin>", "Custom CORS origin(s) for development (comma-separated)")
	.option("--cors-credentials", "Enable CORS credentials (default: true)", true)
	.option("--strict-cors", "Use strict CORS (localhost only, no dev origins)")
	.action(async (options) => {
		const projectRoot = findProjectRoot();
		if (!projectRoot) {
			console.error(chalk.red("✗ Not in a Knowns project"));
			console.log(chalk.gray("Run 'knowns init' to initialize a project"));
			process.exit(1);
		}

		const port = Number.parseInt(options.port);
		const portFilePath = join(projectRoot, ".knowns", ".server-port");

		// Check multiple possible ports where Knowns server might be running
		const portsToCheck: number[] = [port];

		// Also check port from file if it exists
		if (existsSync(portFilePath)) {
			try {
				const filePort = Number.parseInt(await readFile(portFilePath, "utf-8"));
				if (!portsToCheck.includes(filePort)) {
					portsToCheck.push(filePort);
				}
			} catch {
				// Ignore parse errors
			}
		}

		// Check if Knowns server is already running on any of these ports
		for (const checkPort of portsToCheck) {
			if (await isKnownsServerRunning(checkPort)) {
				const url = `http://localhost:${checkPort}`;
				console.log(chalk.green(`✓ Server already running at ${url}`));
				if (options.open) {
					console.log(chalk.gray("Opening browser..."));
					openBrowser(url);
				}
				return;
			}
		}

		// Always save port to config so notify-server stays in sync
		await saveServerPort(projectRoot, port);

		// Configure CORS options
		let corsOrigin: string | string[] | undefined;
		
		if (options.strictCors) {
			// Strict mode: localhost only
			corsOrigin = "http://localhost:3000";
		} else if (options.corsOrigin) {
			// Custom origins from CLI
			corsOrigin = options.corsOrigin.split(",").map((o: string) => o.trim());
		}
		// else: use default dev origins (localhost:3000, localhost:5173, etc.)

		console.log(chalk.cyan("◆ Starting Knowns.dev Web UI..."));
		if (options.corsOrigin) {
			console.log(chalk.gray(`  CORS origins: ${options.corsOrigin}`));
		} else if (options.strictCors) {
			console.log(chalk.gray("  CORS: Strict mode (localhost:3000 only)"));
		} else {
			console.log(chalk.gray("  CORS: Development mode (localhost + common dev ports)"));
		}
		console.log("");

		try {
			await startServer({
				port,
				projectRoot,
				open: options.open,
				corsOrigin,
				corsCredentials: options.corsCredentials,
			});

			console.log("");
			console.log(chalk.gray("Press Ctrl+C to stop the server"));
		} catch (error) {
			console.error(chalk.red("✗ Failed to start server:"), error instanceof Error ? error.message : error);
			process.exit(1);
		}
	});
