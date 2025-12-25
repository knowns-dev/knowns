/**
 * Browser Command
 * Opens web UI for task management
 */

import { startServer } from "@server/index";
import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";

export const browserCommand = new Command("browser")
	.description("Open web UI for task management")
	.option("-p, --port <port>", "Port number", "6420")
	.option("--no-open", "Don't open browser automatically")
	.action(async (options) => {
		const projectRoot = findProjectRoot();
		if (!projectRoot) {
			console.error(chalk.red("✗ Not in a Knowns project"));
			console.log(chalk.gray("Run 'knowns init' to initialize a project"));
			process.exit(1);
		}

		console.log(chalk.cyan("◆ Starting Knowns.dev Web UI..."));
		console.log("");

		try {
			await startServer({
				port: Number.parseInt(options.port),
				projectRoot,
				open: options.open,
			});

			// Keep the process running
			console.log("");
			console.log(chalk.gray("Press Ctrl+C to stop the server"));
		} catch (error) {
			console.error(chalk.red("✗ Failed to start server:"), error instanceof Error ? error.message : error);
			process.exit(1);
		}
	});
