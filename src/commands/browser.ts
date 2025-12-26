/**
 * Browser Command
 * Opens web UI for task management
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startServer } from "@server/index";
import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";

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
		// Read existing config or create new
		let config: Record<string, unknown> = {};
		if (existsSync(configPath)) {
			const content = await readFile(configPath, "utf-8");
			config = JSON.parse(content);
		}

		// Update settings.serverPort
		const settings = (config.settings as Record<string, unknown>) || {};
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
	.action(async (options) => {
		const projectRoot = findProjectRoot();
		if (!projectRoot) {
			console.error(chalk.red("✗ Not in a Knowns project"));
			console.log(chalk.gray("Run 'knowns init' to initialize a project"));
			process.exit(1);
		}

		const port = Number.parseInt(options.port);

		// Save custom port to config if user specified -p
		if (options.port !== String(DEFAULT_PORT)) {
			await saveServerPort(projectRoot, port);
		}

		console.log(chalk.cyan("◆ Starting Knowns.dev Web UI..."));
		console.log("");

		try {
			await startServer({
				port,
				projectRoot,
				open: options.open,
			});

			console.log("");
			console.log(chalk.gray("Press Ctrl+C to stop the server"));
		} catch (error) {
			console.error(chalk.red("✗ Failed to start server:"), error instanceof Error ? error.message : error);
			process.exit(1);
		}
	});
