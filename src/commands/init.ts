/**
 * Init Command
 * Initialize .knowns/ folder in current directory
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { FileStore } from "@storage/file-store";
import chalk from "chalk";
import { Command } from "commander";
import prompts from "prompts";
// Import markdown templates as text (esbuild loader: "text")
import KNOWNS_GUIDELINES_CLI from "../templates/knowns-guidelines-cli.md";
import KNOWNS_GUIDELINES_MCP from "../templates/knowns-guidelines-mcp.md";
import { type GuidelinesVersion, INSTRUCTION_FILES, updateInstructionFile } from "./agents";

interface InitConfig {
	name: string;
	defaultAssignee?: string;
	defaultPriority: "low" | "medium" | "high";
	defaultLabels: string[];
	timeFormat: "12h" | "24h";
	guidelinesVersion: GuidelinesVersion;
	agentFiles: Array<{ path: string; name: string; selected: boolean }>;
}

/**
 * Check if git is initialized and prompt to initialize if not
 */
async function checkAndInitGit(projectRoot: string): Promise<void> {
	const gitPath = join(projectRoot, ".git");

	if (existsSync(gitPath)) {
		return; // Git already initialized
	}

	console.log(chalk.yellow("⚠️  Git is not initialized in this project"));
	console.log();

	const response = await prompts({
		type: "confirm",
		name: "initGit",
		message: "Would you like to initialize git?",
		initial: true,
	});

	if (response.initGit) {
		try {
			execSync("git init", { cwd: projectRoot, stdio: "pipe" });
			console.log(chalk.green("✓ Git initialized successfully"));

			// Optionally add .knowns to .gitignore considerations
			const gitignorePath = join(projectRoot, ".gitignore");
			if (!existsSync(gitignorePath)) {
				const addGitignore = await prompts({
					type: "confirm",
					name: "add",
					message: "Create .gitignore with recommended exclusions?",
					initial: true,
				});

				if (addGitignore.add) {
					const { writeFileSync } = await import("node:fs");
					const gitignoreContent = `# Dependencies
node_modules/

# Build output
dist/

# Environment files
.env
.env.local
.env.*.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*

# Optional: Exclude time tracking data (uncomment if desired)
# .knowns/time/
`;
					writeFileSync(gitignorePath, gitignoreContent, "utf-8");
					console.log(chalk.green("✓ Created .gitignore"));
				}
			}
			console.log();
		} catch (error) {
			console.log(chalk.red("✗ Failed to initialize git"));
			if (error instanceof Error) {
				console.log(chalk.gray(`  ${error.message}`));
			}
			console.log();
		}
	} else {
		console.log(chalk.gray("  Skipping git initialization"));
		console.log();
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
				type: "text",
				name: "defaultAssignee",
				message: "Default assignee (optional)",
				initial: "",
				format: (value) => (value.trim() ? value.trim() : undefined),
			},
			{
				type: "select",
				name: "defaultPriority",
				message: "Default priority for new tasks",
				choices: [
					{ title: "Low", value: "low" },
					{ title: "Medium", value: "medium" },
					{ title: "High", value: "high" },
				],
				initial: 1, // medium
			},
			{
				type: "list",
				name: "defaultLabels",
				message: "Default labels (comma-separated, optional)",
				initial: "",
				separator: ",",
			},
			{
				type: "select",
				name: "timeFormat",
				message: "Time format",
				choices: [
					{ title: "24-hour (14:30)", value: "24h" },
					{ title: "12-hour (2:30 PM)", value: "12h" },
				],
				initial: 0, // 24h
			},
			{
				type: "select",
				name: "guidelinesVersion",
				message: "AI Guidelines version",
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
		defaultAssignee: response.defaultAssignee,
		defaultPriority: response.defaultPriority,
		defaultLabels: response.defaultLabels?.filter((l: string) => l.trim()) || [],
		timeFormat: response.timeFormat,
		guidelinesVersion: response.guidelinesVersion || "cli",
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

			// Check and prompt for git initialization
			await checkAndInitGit(projectRoot);

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
					guidelinesVersion: "cli",
					agentFiles: INSTRUCTION_FILES.filter((f) => f.selected),
				};
			}

			// Initialize project
			const fileStore = new FileStore(projectRoot);
			const project = await fileStore.initProject(config.name, {
				defaultAssignee: config.defaultAssignee,
				defaultPriority: config.defaultPriority,
				defaultLabels: config.defaultLabels,
				timeFormat: config.timeFormat,
			});

			console.log();
			console.log(chalk.green("✓ Project initialized successfully!"));
			console.log(chalk.gray(`  Name: ${project.name}`));
			console.log(chalk.gray(`  Location: ${knownsPath}`));

			if (config.defaultAssignee) {
				console.log(chalk.gray(`  Default Assignee: ${config.defaultAssignee}`));
			}
			console.log(chalk.gray(`  Default Priority: ${config.defaultPriority}`));
			if (config.defaultLabels.length > 0) {
				console.log(chalk.gray(`  Default Labels: ${config.defaultLabels.join(", ")}`));
			}
			console.log(chalk.gray(`  Time Format: ${config.timeFormat}`));
			console.log();

			// Update AI instruction files
			if (config.agentFiles.length > 0) {
				const guidelines = config.guidelinesVersion === "mcp" ? KNOWNS_GUIDELINES_MCP : KNOWNS_GUIDELINES_CLI;

				console.log(chalk.bold(`Updating AI instruction files (${config.guidelinesVersion.toUpperCase()} version)...`));
				console.log();

				let syncedCount = 0;
				for (const file of config.agentFiles) {
					try {
						const result = await updateInstructionFile(file.path, guidelines);
						if (result.success) {
							syncedCount++;
							const action =
								result.action === "created" ? "Created" : result.action === "appended" ? "Appended" : "Updated";
							console.log(chalk.green(`✓ ${action} ${file.name}: ${file.path}`));
						}
					} catch (error) {
						console.log(chalk.yellow(`⚠️  Skipped ${file.name}: ${file.path}`));
					}
				}

				console.log();
				console.log(chalk.green(`✓ Synced guidelines to ${syncedCount} AI instruction file(s)`));
			} else {
				console.log(chalk.gray("Skipped AI instruction files (none selected)"));
			}
			console.log();
			console.log(chalk.cyan("Next steps:"));
			console.log(chalk.gray('  1. Create a task: knowns task create "My first task"'));
			console.log(chalk.gray("  2. List tasks: knowns task list"));
			console.log(chalk.gray("  3. Open web UI: knowns browser"));
		} catch (error) {
			console.error(chalk.red("✗ Failed to initialize project"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});
