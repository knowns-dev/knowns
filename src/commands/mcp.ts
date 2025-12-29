/**
 * MCP Command
 * Starts the Model Context Protocol server for AI agent integration
 */

import { startMcpServer } from "@mcp/server";
import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";

export const mcpCommand = new Command("mcp")
	.description("Start MCP server for AI agent integration (Claude Desktop, etc.)")
	.option("-v, --verbose", "Enable verbose logging")
	.option("--info", "Show configuration instructions")
	.action(async (options) => {
		// Show configuration info if requested
		if (options.info) {
			showConfigInfo();
			return;
		}

		const projectRoot = findProjectRoot();
		if (!projectRoot) {
			console.error(chalk.red("Error: Not in a Knowns project"));
			console.error(chalk.gray("Run 'knowns init' to initialize a project"));
			process.exit(1);
		}

		// Change to project root for FileStore
		process.chdir(projectRoot);

		try {
			await startMcpServer({ verbose: options.verbose });
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : error);
			process.exit(1);
		}
	});

function showConfigInfo() {
	const configExample = {
		mcpServers: {
			knowns: {
				command: "knowns",
				args: ["mcp"],
				cwd: "/path/to/your/project",
			},
		},
	};

	console.log(chalk.cyan.bold("\n  Knowns MCP Server Configuration\n"));
	console.log(chalk.white("  The MCP server allows AI agents like Claude to interact with your tasks."));
	console.log("");
	console.log(chalk.yellow("  Claude Desktop Configuration:"));
	console.log(chalk.gray("  Add this to your Claude Desktop config file:"));
	console.log("");
	console.log(chalk.gray("  macOS: ~/Library/Application Support/Claude/claude_desktop_config.json"));
	console.log(chalk.gray("  Windows: %APPDATA%\\Claude\\claude_desktop_config.json"));
	console.log("");
	console.log(chalk.white(JSON.stringify(configExample, null, 2)));
	console.log("");
	console.log(chalk.gray("  Replace '/path/to/your/project' with your actual project path."));
	console.log("");
	console.log(chalk.yellow("  Available MCP Tools:"));
	console.log(chalk.gray("  - create_task    Create a new task"));
	console.log(chalk.gray("  - get_task       Get task by ID"));
	console.log(chalk.gray("  - update_task    Update task fields"));
	console.log(chalk.gray("  - list_tasks     List tasks with filters"));
	console.log(chalk.gray("  - search_tasks   Search tasks"));
	console.log(chalk.gray("  - start_time     Start time tracking"));
	console.log(chalk.gray("  - stop_time      Stop time tracking"));
	console.log(chalk.gray("  - add_time       Add manual time entry"));
	console.log(chalk.gray("  - get_time_report Get time report"));
	console.log(chalk.gray("  - get_board      Get kanban board state"));
	console.log("");
	console.log(chalk.cyan("  Usage:"));
	console.log(chalk.gray("  $ knowns mcp           # Start MCP server"));
	console.log(chalk.gray("  $ knowns mcp --verbose # Start with debug logging"));
	console.log(chalk.gray("  $ knowns mcp --info    # Show this help"));
	console.log("");
}
