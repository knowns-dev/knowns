/**
 * Init Command
 * Initialize .knowns/ folder in current directory
 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { FileStore } from "@storage/file-store";
import chalk from "chalk";
import { Command } from "commander";
import prompts from "prompts";
import { type GuidelinesType, INSTRUCTION_FILES, getGuidelines, updateInstructionFile } from "./agents";

import type { GitTrackingMode } from "@models/project";

interface InitConfig {
	name: string;
	defaultPriority: "low" | "medium" | "high";
	defaultLabels: string[];
	timeFormat: "12h" | "24h";
	gitTrackingMode: GitTrackingMode;
	guidelinesType: GuidelinesType;
	agentFiles: Array<{ path: string; name: string; selected: boolean }>;
}

/**
 * Check if git is initialized - exit if not
 */
function checkGitExists(projectRoot: string): void {
	const gitPath = join(projectRoot, ".git");

	if (!existsSync(gitPath)) {
		console.log();
		console.log(chalk.red("✗ Not a git repository"));
		console.log();
		console.log(chalk.gray("  Knowns requires git for version control."));
		console.log(chalk.gray("  Please initialize git first:"));
		console.log();
		console.log(chalk.cyan("    git init"));
		console.log();
		process.exit(1);
	}
}

/**
 * Create .mcp.json file for Claude Code auto-discovery
 */
async function createMcpJsonFile(projectRoot: string): Promise<void> {
	const { writeFileSync, readFileSync } = await import("node:fs");
	const mcpJsonPath = join(projectRoot, ".mcp.json");

	const mcpConfig = {
		mcpServers: {
			knowns: {
				command: "npx",
				args: ["-y", "knowns", "mcp"],
			},
		},
	};

	if (existsSync(mcpJsonPath)) {
		// Check if knowns is already configured
		try {
			const existing = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
			if (existing?.mcpServers?.knowns) {
				console.log(chalk.gray("  .mcp.json already has knowns configuration"));
				return;
			}
			// Merge with existing config
			existing.mcpServers = {
				...existing.mcpServers,
				...mcpConfig.mcpServers,
			};
			writeFileSync(mcpJsonPath, JSON.stringify(existing, null, "\t"), "utf-8");
			console.log(chalk.green("✓ Added knowns to existing .mcp.json"));
		} catch {
			// Invalid JSON, overwrite
			writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, "\t"), "utf-8");
			console.log(chalk.green("✓ Created .mcp.json (replaced invalid file)"));
		}
	} else {
		writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, "\t"), "utf-8");
		console.log(chalk.green("✓ Created .mcp.json for Claude Code MCP auto-discovery"));
	}
}

/**
 * Update .gitignore for git-ignored mode
 */
async function updateGitignoreForIgnoredMode(projectRoot: string): Promise<void> {
	const { appendFileSync, readFileSync, writeFileSync } = await import("node:fs");
	const gitignorePath = join(projectRoot, ".gitignore");

	const knownsIgnorePattern = `
# knowns (ignore all except docs)
.knowns/*
!.knowns/docs/
!.knowns/docs/**
`;

	if (existsSync(gitignorePath)) {
		const content = readFileSync(gitignorePath, "utf-8");
		// Check if pattern already exists
		if (content.includes(".knowns/*")) {
			console.log(chalk.gray("  .gitignore already has knowns pattern"));
			return;
		}
		appendFileSync(gitignorePath, knownsIgnorePattern);
		console.log(chalk.green("✓ Updated .gitignore with knowns pattern"));
	} else {
		writeFileSync(gitignorePath, `${knownsIgnorePattern.trim()}\n`, "utf-8");
		console.log(chalk.green("✓ Created .gitignore with knowns pattern"));
	}
}

async function runWizard(): Promise<InitConfig | null> {
	const projectRoot = process.cwd();
	const defaultName = basename(projectRoot);

	console.log();
	console.log(chalk.bold.cyan("🚀 Knowns Project Setup Wizard"));
	console.log(chalk.gray("   Configure your project settings"));
	console.log();

	const response = await prompts(
		[
			{
				type: "text",
				name: "name",
				message: "Project name",
				initial: defaultName,
				validate: (value) => (value.trim() ? true : "Project name is required"),
			},
			{
				type: "select",
				name: "gitTrackingMode",
				message: "Git tracking mode",
				choices: [
					{
						title: "Git Tracked (recommended for teams)",
						value: "git-tracked",
						description: "All .knowns/ files tracked in git",
					},
					{
						title: "Git Ignored (personal use)",
						value: "git-ignored",
						description: "Only docs tracked, tasks/config ignored",
					},
				],
				initial: 0, // git-tracked
			},
			{
				type: "select",
				name: "guidelinesType",
				message: "AI Guidelines type",
				choices: [
					{ title: "CLI", value: "cli", description: "Use CLI commands (knowns task edit, knowns doc view)" },
					{ title: "MCP", value: "mcp", description: "Use MCP tools (mcp__knowns__update_task, etc.)" },
				],
				initial: 0, // CLI
			},
			{
				type: "multiselect",
				name: "agentFiles",
				message: "Select AI agent files to create/update",
				choices: INSTRUCTION_FILES.map((f) => ({
					title: `${f.name} (${f.path})`,
					value: f,
					selected: f.selected,
				})),
				hint: "- Space to select. Return to submit",
			},
		],
		{
			onCancel: () => {
				console.log();
				console.log(chalk.yellow("Setup cancelled"));
				return false;
			},
		},
	);

	// Check if user cancelled
	if (!response.name) {
		return null;
	}

	return {
		name: response.name,
		defaultPriority: "medium",
		defaultLabels: [],
		timeFormat: "24h",
		gitTrackingMode: response.gitTrackingMode || "git-tracked",
		guidelinesType: response.guidelinesType || "cli",
		agentFiles: response.agentFiles || [],
	};
}

export const initCommand = new Command("init")
	.description("Initialize .knowns/ folder in current directory")
	.argument("[name]", "Project name (runs wizard if not provided)")
	.option("--wizard", "Force interactive wizard mode")
	.option("--no-wizard", "Skip wizard, use defaults")
	.option("-f, --force", "Force reinitialize (overwrites existing config)")
	.action(async (name: string | undefined, options: { wizard?: boolean; force?: boolean }) => {
		try {
			const projectRoot = process.cwd();
			const knownsPath = join(projectRoot, ".knowns");

			// Check if already initialized
			if (existsSync(knownsPath) && !options.force) {
				console.log(chalk.yellow("⚠️  Project already initialized"));
				console.log(chalk.gray(`   Location: ${knownsPath}`));
				console.log(chalk.gray("   Use --force to reinitialize"));
				return;
			}

			if (existsSync(knownsPath) && options.force) {
				console.log(chalk.yellow("⚠️  Reinitializing existing project (--force)"));
				console.log();
			}

			// Check git exists - exit if not
			checkGitExists(projectRoot);

			let config: InitConfig;

			// Determine if we should run wizard
			const shouldRunWizard = options.wizard === true || (name === undefined && options.wizard !== false);

			if (shouldRunWizard) {
				const wizardResult = await runWizard();
				if (!wizardResult) {
					process.exit(0);
				}
				config = wizardResult;
			} else {
				// Use provided name or default
				config = {
					name: name || basename(projectRoot),
					defaultPriority: "medium",
					defaultLabels: [],
					timeFormat: "24h",
					gitTrackingMode: "git-tracked",
					guidelinesType: "cli",
					agentFiles: INSTRUCTION_FILES.filter((f) => f.selected),
				};
			}

			// Handle git-ignored mode: update .gitignore
			if (config.gitTrackingMode === "git-ignored") {
				await updateGitignoreForIgnoredMode(projectRoot);
			}

			// Create .mcp.json for Claude Code auto-discovery when MCP mode is selected
			if (config.guidelinesType === "mcp") {
				await createMcpJsonFile(projectRoot);
			}

			// Initialize project
			const fileStore = new FileStore(projectRoot);
			const project = await fileStore.initProject(config.name, {
				defaultPriority: config.defaultPriority,
				defaultLabels: config.defaultLabels,
				timeFormat: config.timeFormat,
				gitTrackingMode: config.gitTrackingMode,
			});

			console.log();
			console.log(chalk.green(`✓ Project initialized: ${project.name}`));

			// Update AI instruction files
			if (config.agentFiles.length > 0) {
				const guidelines = getGuidelines(config.guidelinesType);

				for (const file of config.agentFiles) {
					try {
						const result = await updateInstructionFile(file.path, guidelines);
						if (result.success) {
							const action =
								result.action === "created" ? "Created" : result.action === "appended" ? "Appended" : "Updated";
							console.log(chalk.green(`✓ ${action}: ${file.path}`));
						}
					} catch {
						console.log(chalk.yellow(`⚠️  Skipped: ${file.path}`));
					}
				}
			}

			console.log();
			console.log(chalk.cyan("Get started:"));
			console.log(chalk.gray('  knowns task create "My first task"'));
		} catch (error) {
			console.error(chalk.red("✗ Failed to initialize project"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});
