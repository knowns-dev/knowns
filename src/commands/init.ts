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
import { renderString } from "../codegen/renderer";
import { Guidelines } from "../instructions/guidelines";
import { type IDEConfig, IDE_CONFIGS } from "../instructions/ide";
import { SKILLS } from "../instructions/skills";
import { type GuidelinesType, INSTRUCTION_FILES, getGuidelines, updateInstructionFile } from "./agents";

import type { GitTrackingMode } from "@models/project";

/**
 * Instruction mode for skills
 */
type InstructionMode = "mcp" | "cli";

/**
 * Render skill content with mode context
 */
function renderSkillContent(content: string, mode: InstructionMode): string {
	try {
		return renderString(content, { mcp: mode === "mcp", cli: mode === "cli" });
	} catch {
		// If rendering fails, return original
		return content;
	}
}

/**
 * Platform definitions for init
 */
interface Platform {
	id: string;
	name: string;
	description: string;
	hasSkills: boolean;
	ideConfig?: IDEConfig;
}

const PLATFORMS: Platform[] = [
	{
		id: "claude-code",
		name: "Claude Code",
		description: "Skills + MCP + CLI (recommended)",
		hasSkills: true,
	},
	{
		id: "antigravity",
		name: "Antigravity (Gemini CLI)",
		description: "Skills + MCP + CLI",
		hasSkills: true,
	},
	{
		id: "cursor",
		name: "Cursor",
		description: "MCP + Rules",
		hasSkills: false,
		ideConfig: IDE_CONFIGS.find((c) => c.name === "cursor"),
	},
	{
		id: "windsurf",
		name: "Windsurf",
		description: "Rules",
		hasSkills: false,
		ideConfig: IDE_CONFIGS.find((c) => c.name === "windsurf"),
	},
	{
		id: "generic",
		name: "Generic AI",
		description: "AGENTS.md only",
		hasSkills: false,
	},
];

interface InitConfig {
	name: string;
	defaultPriority: "low" | "medium" | "high";
	defaultLabels: string[];
	timeFormat: "12h" | "24h";
	gitTrackingMode: GitTrackingMode;
	platforms: string[];
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
 * Update .gitignore based on git tracking mode
 */
async function updateGitignore(projectRoot: string, mode: "git-ignored" | "none"): Promise<void> {
	const { appendFileSync, readFileSync, writeFileSync } = await import("node:fs");
	const gitignorePath = join(projectRoot, ".gitignore");

	// Different patterns based on mode
	const patterns = {
		"git-ignored": `
# knowns (ignore all except docs)
.knowns/*
!.knowns/docs/
!.knowns/docs/**
`,
		none: `
# knowns (ignore entire folder)
.knowns/
`,
	};

	const knownsIgnorePattern = patterns[mode];
	const checkPattern = mode === "none" ? ".knowns/" : ".knowns/*";

	if (existsSync(gitignorePath)) {
		const content = readFileSync(gitignorePath, "utf-8");
		// Check if pattern already exists
		if (content.includes(checkPattern)) {
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

/**
 * Create AGENTS.md in project root
 */
async function createAgentsMd(projectRoot: string): Promise<void> {
	const { writeFileSync } = await import("node:fs");
	const agentsMdPath = join(projectRoot, "AGENTS.md");

	if (existsSync(agentsMdPath)) {
		console.log(chalk.gray("  AGENTS.md already exists"));
		return;
	}

	writeFileSync(agentsMdPath, Guidelines.getFull(true), "utf-8");
	console.log(chalk.green("✓ Created AGENTS.md (full AI guidelines)"));
}

/**
 * Create IDE-specific configuration files
 */
async function createIDEConfig(projectRoot: string, ideConfig: IDEConfig): Promise<void> {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const targetDir = join(projectRoot, ideConfig.targetDir);

	let createdCount = 0;
	let skippedCount = 0;

	for (const file of ideConfig.files) {
		const filePath = join(targetDir, file.filename);
		const fileDir = join(targetDir, ...file.filename.split("/").slice(0, -1));
		const content = file.isJson ? `${JSON.stringify(file.content, null, 2)}\n` : String(file.content);

		if (existsSync(filePath)) {
			skippedCount++;
			continue;
		}

		if (!existsSync(fileDir)) {
			mkdirSync(fileDir, { recursive: true });
		}
		writeFileSync(filePath, content, "utf-8");
		createdCount++;
	}

	if (createdCount > 0) {
		console.log(chalk.green(`✓ Created ${createdCount} ${ideConfig.name} config files in ${ideConfig.targetDir}/`));
	}
	if (skippedCount > 0) {
		console.log(chalk.gray(`  Skipped ${skippedCount} existing ${ideConfig.name} files`));
	}
}

/**
 * Create local skills in .knowns/skills/ directory (source of truth)
 * Local skills keep Handlebars templates for future sync with different modes
 */
async function createLocalSkills(projectRoot: string): Promise<void> {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const skillsDir = join(projectRoot, ".knowns", "skills");

	// Create .knowns/skills directory
	if (!existsSync(skillsDir)) {
		mkdirSync(skillsDir, { recursive: true });
	}

	let createdCount = 0;
	let skippedCount = 0;

	for (const skill of SKILLS) {
		const skillFolder = join(skillsDir, skill.folderName);
		const skillFile = join(skillFolder, "SKILL.md");

		// Skip if skill already exists
		if (existsSync(skillFile)) {
			skippedCount++;
			continue;
		}

		// Create skill folder and file
		// Keep original content with Handlebars templates (source of truth)
		if (!existsSync(skillFolder)) {
			mkdirSync(skillFolder, { recursive: true });
		}
		writeFileSync(skillFile, skill.content, "utf-8");
		createdCount++;
	}

	if (createdCount > 0) {
		console.log(chalk.green(`✓ Created ${createdCount} skills in .knowns/skills/ (source of truth)`));
	}
	if (skippedCount > 0) {
		console.log(chalk.gray(`  Skipped ${skippedCount} existing local skills`));
	}
}

/**
 * Create Claude Code skills in .claude/skills/ directory
 * Skills are rendered with MCP mode (Claude Code uses MCP by default)
 */
async function createClaudeSkills(projectRoot: string, mode: InstructionMode = "mcp"): Promise<void> {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const skillsDir = join(projectRoot, ".claude", "skills");

	// Create .claude/skills directory
	if (!existsSync(skillsDir)) {
		mkdirSync(skillsDir, { recursive: true });
	}

	let createdCount = 0;
	let skippedCount = 0;

	for (const skill of SKILLS) {
		const skillFolder = join(skillsDir, skill.folderName);
		const skillFile = join(skillFolder, "SKILL.md");

		// Skip if skill already exists
		if (existsSync(skillFile)) {
			skippedCount++;
			continue;
		}

		// Create skill folder and file
		// Render content with specified mode (MCP or CLI)
		const renderedContent = renderSkillContent(skill.content, mode);
		if (!existsSync(skillFolder)) {
			mkdirSync(skillFolder, { recursive: true });
		}
		writeFileSync(skillFile, renderedContent, "utf-8");
		createdCount++;
	}

	if (createdCount > 0) {
		console.log(
			chalk.green(`✓ Created ${createdCount} Claude Code skills in .claude/skills/ (${mode.toUpperCase()} mode)`),
		);
	}
	if (skippedCount > 0) {
		console.log(chalk.gray(`  Skipped ${skippedCount} existing skills`));
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
				type: "multiselect",
				name: "platforms",
				message: "Select AI platforms to configure",
				choices: PLATFORMS.map((p) => ({
					title: `${p.name} (${p.description})`,
					value: p.id,
					selected: p.id === "claude-code",
				})),
				hint: "- Space to select. Return to submit",
				min: 1,
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
						description: "Only docs/templates tracked, tasks/config ignored",
					},
					{
						title: "None (ignore all)",
						value: "none",
						description: "Entire .knowns/ folder ignored by git",
					},
				],
				initial: 0, // git-tracked
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
		platforms: response.platforms || ["claude-code"],
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
					platforms: ["claude-code"],
				};
			}

			// Handle git-ignored or none mode: update .gitignore
			if (config.gitTrackingMode === "git-ignored" || config.gitTrackingMode === "none") {
				await updateGitignore(projectRoot, config.gitTrackingMode);
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

			// Always create agents.md (full guidelines for all platforms)
			await createAgentsMd(projectRoot);

			// Check platform types
			const selectedPlatforms = config.platforms.map((id) => PLATFORMS.find((p) => p.id === id)).filter(Boolean);
			const hasSkillsPlatform = selectedPlatforms.some((p) => p?.hasSkills);
			const hasNonSkillsPlatform = selectedPlatforms.some((p) => !p?.hasSkills);

			// Skills platform setup (Claude Code, Antigravity)
			if (hasSkillsPlatform) {
				// Create local skills in .knowns/skills/ (source of truth)
				await createLocalSkills(projectRoot);

				// Create skills in .claude/skills/
				await createClaudeSkills(projectRoot);

				// Create .mcp.json for MCP auto-discovery
				await createMcpJsonFile(projectRoot);

				// Create CLAUDE.md with MCP guidelines
				const guidelines = getGuidelines("mcp");
				try {
					const result = await updateInstructionFile("CLAUDE.md", guidelines);
					if (result.success) {
						const action =
							result.action === "created" ? "Created" : result.action === "appended" ? "Appended" : "Updated";
						console.log(chalk.green(`✓ ${action}: CLAUDE.md`));
					}
				} catch {
					console.log(chalk.yellow("⚠️  Skipped: CLAUDE.md"));
				}
			}

			// IDE platform setups (Cursor, Windsurf)
			for (const platform of selectedPlatforms) {
				if (platform?.ideConfig) {
					await createIDEConfig(projectRoot, platform.ideConfig);
				}
			}

			console.log();
			console.log(chalk.cyan("Get started:"));
			console.log(chalk.gray('  knowns task create "My first task"'));

			// Show platform-specific tips
			if (hasSkillsPlatform) {
				console.log(chalk.gray("  Use /knowns.init to start a session"));
			}
			if (hasNonSkillsPlatform) {
				console.log(chalk.gray("  See AGENTS.md for full AI guidelines"));
			}
		} catch (error) {
			console.error(chalk.red("✗ Failed to initialize project"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});
