/**
 * MCP Command
 * Starts the Model Context Protocol server for AI agent integration
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMcpServer } from "@mcp/server";
import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";

/**
 * Get MCP configuration for knowns
 */
function getMcpConfig() {
	return {
		command: "npx",
		args: ["-y", "knowns", "mcp"],
	};
}

/**
 * Setup MCP in Claude Code via CLI
 */
async function setupClaudeCode(): Promise<boolean> {
	const { spawnSync } = await import("node:child_process");

	// Check if claude CLI is available
	const claudeCheck = spawnSync("claude", ["--version"], { stdio: "pipe" });

	if (claudeCheck.status !== 0) {
		console.log(chalk.yellow("⚠️  Claude Code CLI not found"));
		console.log(chalk.gray("  Install Claude Code first: https://claude.ai/code"));
		console.log(chalk.gray("  After installing, run: knowns mcp setup"));
		return false;
	}

	const config = getMcpConfig();
	const configJson = JSON.stringify(config);

	// Use spawnSync without shell to avoid security warnings
	const result = spawnSync("claude", ["mcp", "add-json", "knowns", configJson], {
		stdio: "inherit",
	});

	if (result.status === 0) {
		console.log(chalk.green("✓ Added knowns MCP server to Claude Code"));
		console.log(chalk.gray("  Restart Claude Code to activate the server"));
		return true;
	}

	// Try alternative: claude mcp add command
	const altResult = spawnSync("claude", ["mcp", "add", "knowns", "--", "npx", "-y", "knowns", "mcp"], {
		stdio: "inherit",
	});

	if (altResult.status === 0) {
		console.log(chalk.green("✓ Added knowns MCP server to Claude Code"));
		console.log(chalk.gray("  Restart Claude Code to activate the server"));
		return true;
	}

	console.log(chalk.red("✗ Failed to add MCP server to Claude Code"));
	console.log(chalk.gray("  Try adding manually with:"));
	console.log(chalk.cyan(`    claude mcp add-json knowns '${configJson}'`));
	return false;
}

/**
 * Create .mcp.json file in project root
 */
function createProjectMcpJson(projectRoot: string): boolean {
	const mcpJsonPath = join(projectRoot, ".mcp.json");
	const mcpConfig = {
		mcpServers: {
			knowns: getMcpConfig(),
		},
	};

	if (existsSync(mcpJsonPath)) {
		try {
			const existing = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
			if (existing?.mcpServers?.knowns) {
				console.log(chalk.gray("  .mcp.json already has knowns configuration"));
				return true;
			}
			existing.mcpServers = {
				...existing.mcpServers,
				...mcpConfig.mcpServers,
			};
			writeFileSync(mcpJsonPath, JSON.stringify(existing, null, "\t"), "utf-8");
			console.log(chalk.green("✓ Added knowns to existing .mcp.json"));
		} catch {
			writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, "\t"), "utf-8");
			console.log(chalk.green("✓ Created .mcp.json (replaced invalid file)"));
		}
	} else {
		writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, "\t"), "utf-8");
		console.log(chalk.green("✓ Created .mcp.json for Claude Code project-level auto-discovery"));
	}

	return true;
}

// Setup subcommand
const setupCommand = new Command("setup")
	.description("Setup knowns MCP server in Claude Code")
	.option("--project", "Only create .mcp.json in project (skip Claude Code setup)")
	.option("--global", "Only setup in Claude Code globally (skip .mcp.json)")
	.action(async (options: { project?: boolean; global?: boolean }) => {
		const projectRoot = findProjectRoot();

		// Default: do both unless specific option is provided
		const doProject = options.project || (!options.project && !options.global);
		const doGlobal = options.global || (!options.project && !options.global);

		// Create project-level .mcp.json
		if (doProject) {
			if (projectRoot) {
				createProjectMcpJson(projectRoot);
			} else {
				console.log(chalk.yellow("⚠️  Not in a Knowns project. Run 'knowns init' first."));
			}
		}

		// Setup in Claude Code globally
		if (doGlobal) {
			await setupClaudeCode();
		}
	});

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

		// Try to find project root, but don't require it
		// With detect_projects and set_project tools, the AI agent can select project at runtime
		const projectRoot = findProjectRoot();
		if (projectRoot) {
			// Change to project root if found (for backward compatibility)
			process.chdir(projectRoot);
		}
		// If no project found, server will still start
		// AI agent can use detect_projects + set_project to select a project

		try {
			await startMcpServer({ verbose: options.verbose });
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : error);
			process.exit(1);
		}
	})
	.addCommand(setupCommand);

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
