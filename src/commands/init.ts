/**
 * Init Command
 * Initialize .knowns/ folder in current directory
 */

import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FileStore } from "@storage/file-store";
import chalk from "chalk";
import { Command } from "commander";
import prompts from "prompts";
import packageJson from "../../package.json";
import { type Platform, syncSkills } from "../codegen/skill-sync";
import { UnifiedGuidelines } from "../instructions/guidelines";
import { type IDEConfig, IDE_CONFIGS } from "../instructions/ide";
import { INSTRUCTION_FILES, updateInstructionFile } from "./agents";

import type { GitTrackingMode } from "@models/project";

const CLI_VERSION = packageJson.version;

/**
 * Platform skill directories
 */
const SKILL_DIRS = [".claude/skills", ".agent/skills"];

/**
 * Write version file after syncing skills (for all platforms)
 */
function writeSkillsVersionFile(projectRoot: string): void {
	const info = {
		cliVersion: CLI_VERSION,
		syncedAt: new Date().toISOString(),
	};

	for (const dir of SKILL_DIRS) {
		const skillsDir = join(projectRoot, dir);
		if (existsSync(skillsDir)) {
			const versionFile = join(skillsDir, ".version");
			writeFileSync(versionFile, JSON.stringify(info, null, 2), "utf-8");
		}
	}
}

/**
 * Map init platform IDs to skill-sync platform IDs
 */
function mapPlatformId(initId: string): Platform | null {
	const mapping: Record<string, Platform> = {
		"claude-code": "claude",
		antigravity: "antigravity",
		cursor: "cursor",
	};
	return mapping[initId] || null;
}

/**
 * Platform definitions for init
 */
interface InitPlatform {
	id: string;
	name: string;
	description: string;
	hasSkills: boolean;
	ideConfig?: IDEConfig;
}

const PLATFORMS: InitPlatform[] = [
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

import type { EmbeddingModel } from "@models/project";

/**
 * Available embedding models for semantic search
 */
const EMBEDDING_MODELS: Array<{ value: EmbeddingModel; title: string; description: string }> = [
	{
		value: "gte-small",
		title: "gte-small (recommended)",
		description: "384 dimensions, 67MB - best balance of speed and quality",
	},
	{
		value: "all-MiniLM-L6-v2",
		title: "all-MiniLM-L6-v2",
		description: "384 dimensions, 45MB - fastest, slightly lower quality",
	},
	{
		value: "gte-base",
		title: "gte-base",
		description: "768 dimensions, 220MB - highest quality, larger download",
	},
];

interface InitConfig {
	name: string;
	defaultPriority: "low" | "medium" | "high";
	defaultLabels: string[];
	timeFormat: "12h" | "24h";
	gitTrackingMode: GitTrackingMode;
	platforms: string[];
	semanticSearch?: {
		enabled: boolean;
		model: EmbeddingModel;
	};
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
async function createMcpJsonFile(projectRoot: string, force = false): Promise<void> {
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
			if (existing?.mcpServers?.knowns && !force) {
				console.log(chalk.gray("  .mcp.json already has knowns configuration"));
				return;
			}
			// Merge with existing config (or update if force)
			existing.mcpServers = {
				...existing.mcpServers,
				...mcpConfig.mcpServers,
			};
			writeFileSync(mcpJsonPath, JSON.stringify(existing, null, "\t"), "utf-8");
			const action = force ? "Updated" : "Added";
			console.log(chalk.green(`✓ ${action} knowns in .mcp.json`));
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
 * Create/update Antigravity MCP config at ~/.gemini/antigravity/mcp_config.json
 */
async function createAntigravityMcpConfig(force = false): Promise<void> {
	const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
	const { homedir } = await import("node:os");

	const homeDir = homedir();
	const antigravityDir = join(homeDir, ".gemini", "antigravity");
	const mcpConfigPath = join(antigravityDir, "mcp_config.json");

	const mcpConfig = {
		mcpServers: {
			knowns: {
				command: "npx",
				args: ["-y", "knowns", "mcp"],
			},
		},
	};

	// Ensure directory exists
	if (!existsSync(antigravityDir)) {
		mkdirSync(antigravityDir, { recursive: true });
	}

	if (existsSync(mcpConfigPath)) {
		// Check if knowns is already configured
		try {
			const existing = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
			if (existing?.mcpServers?.knowns && !force) {
				console.log(chalk.gray("  Antigravity MCP already has knowns configuration"));
				return;
			}
			// Merge with existing config (or update if force)
			existing.mcpServers = {
				...existing.mcpServers,
				...mcpConfig.mcpServers,
			};
			writeFileSync(mcpConfigPath, JSON.stringify(existing, null, "\t"), "utf-8");
			const action = force ? "Updated" : "Added";
			console.log(chalk.green(`✓ ${action} knowns in Antigravity MCP config`));
		} catch {
			// Invalid JSON, overwrite
			writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, "\t"), "utf-8");
			console.log(chalk.green("✓ Created Antigravity MCP config (replaced invalid file)"));
		}
	} else {
		writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, "\t"), "utf-8");
		console.log(chalk.green("✓ Created Antigravity MCP config (~/.gemini/antigravity/mcp_config.json)"));
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
 * Add search-index to .gitignore (always ignored - rebuild on demand)
 */
async function addSearchIndexToGitignore(projectRoot: string): Promise<void> {
	const { appendFileSync, readFileSync, writeFileSync } = await import("node:fs");
	const gitignorePath = join(projectRoot, ".gitignore");

	const searchIndexPattern = `
# knowns search index (rebuilt on demand)
.knowns/search-index/
`;

	if (existsSync(gitignorePath)) {
		const content = readFileSync(gitignorePath, "utf-8");
		// Check if pattern already exists
		if (content.includes(".knowns/search-index/")) {
			return; // Already has the pattern
		}
		appendFileSync(gitignorePath, searchIndexPattern);
		console.log(chalk.green("✓ Added search-index to .gitignore"));
	} else {
		writeFileSync(gitignorePath, `${searchIndexPattern.trim()}\n`, "utf-8");
		console.log(chalk.green("✓ Created .gitignore with search-index pattern"));
	}
}

/**
 * Create IDE-specific configuration files
 */
async function createIDEConfig(projectRoot: string, ideConfig: IDEConfig, force = false): Promise<void> {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const targetDir = join(projectRoot, ideConfig.targetDir);

	let createdCount = 0;
	let updatedCount = 0;
	let skippedCount = 0;

	for (const file of ideConfig.files) {
		const filePath = join(targetDir, file.filename);
		const fileDir = join(targetDir, ...file.filename.split("/").slice(0, -1));
		const content = file.isJson ? `${JSON.stringify(file.content, null, 2)}\n` : String(file.content);
		const exists = existsSync(filePath);

		if (exists && !force) {
			skippedCount++;
			continue;
		}

		if (!existsSync(fileDir)) {
			mkdirSync(fileDir, { recursive: true });
		}
		writeFileSync(filePath, content, "utf-8");

		if (exists) {
			updatedCount++;
		} else {
			createdCount++;
		}
	}

	if (createdCount > 0) {
		console.log(chalk.green(`✓ Created ${createdCount} ${ideConfig.name} config files in ${ideConfig.targetDir}/`));
	}
	if (updatedCount > 0) {
		console.log(chalk.green(`✓ Updated ${updatedCount} ${ideConfig.name} config files in ${ideConfig.targetDir}/`));
	}
	if (skippedCount > 0) {
		console.log(chalk.gray(`  Skipped ${skippedCount} existing ${ideConfig.name} files`));
	}
}

async function runWizard(): Promise<InitConfig | null> {
	const projectRoot = process.cwd();
	const defaultName = basename(projectRoot);

	console.log();
	console.log(chalk.bold.cyan("🚀 Knowns Project Setup"));
	console.log(chalk.gray("   Quick configuration"));
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
			{
				type: "confirm",
				name: "enableSemanticSearch",
				message: "Enable semantic search? (requires model download)",
				initial: false,
			},
			{
				type: (prev) => (prev ? "select" : null),
				name: "semanticModel",
				message: "Select embedding model",
				choices: EMBEDDING_MODELS.map((m) => ({
					title: m.title,
					value: m.value,
					description: m.description,
				})),
				initial: 0, // gte-small
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

	// Auto-configure all platforms (no selection needed)
	return {
		name: response.name,
		defaultPriority: "medium",
		defaultLabels: [],
		timeFormat: "24h",
		gitTrackingMode: response.gitTrackingMode || "git-tracked",
		platforms: ["claude-code", "antigravity"], // Auto-configure both
		semanticSearch: response.enableSemanticSearch
			? {
					enabled: true,
					model: response.semanticModel || "gte-small",
				}
			: undefined,
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
				// Use provided name or default - auto-configure all platforms
				config = {
					name: name || basename(projectRoot),
					defaultPriority: "medium",
					defaultLabels: [],
					timeFormat: "24h",
					gitTrackingMode: "git-tracked",
					platforms: ["claude-code", "antigravity"], // Auto-configure both
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
				semanticSearch: config.semanticSearch,
			});

			console.log();
			console.log(chalk.green(`✓ Project initialized: ${project.name}`));

			// Handle semantic search setup
			if (config.semanticSearch?.enabled) {
				console.log(chalk.cyan(`  Semantic search: ${config.semanticSearch.model}`));

				// Add search-index to .gitignore (always ignored - rebuilt on demand)
				await addSearchIndexToGitignore(projectRoot);

				// Trigger model download
				console.log();
				console.log(chalk.cyan("Downloading embedding model..."));
				try {
					const { createEmbeddingService } = await import("../search/embedding");
					const { createModelDownloadProgress } = await import("../utils/progress-bar");
					const embeddingService = createEmbeddingService({ model: config.semanticSearch.model });

					const progress = createModelDownloadProgress(config.semanticSearch.model);
					try {
						await embeddingService.loadModel(progress.onProgress);
						progress.complete();
					} catch (err) {
						progress.error("Download failed");
						throw err;
					}
				} catch (error) {
					console.log(chalk.yellow(`⚠️  Model download failed. Run "knowns search --rebuild" later.`));
					if (error instanceof Error) {
						console.log(chalk.gray(`  ${error.message}`));
					}
				}
			}

			// Check platform types
			const selectedPlatforms = config.platforms.map((id) => PLATFORMS.find((p) => p.id === id)).filter(Boolean);
			const hasSkillsPlatform = selectedPlatforms.some((p) => p?.hasSkills);
			const hasNonSkillsPlatform = selectedPlatforms.some((p) => !p?.hasSkills);

			// Skills platform setup (Claude Code, Antigravity)
			if (hasSkillsPlatform) {
				// Map selected platforms to skill-sync platform IDs and sync skills
				const skillPlatforms = config.platforms.map(mapPlatformId).filter((p): p is Platform => p !== null);

				if (skillPlatforms.length > 0) {
					// Sync built-in skills directly to platform folders (no .knowns/skills/)
					const results = await syncSkills({
						projectRoot,
						platforms: skillPlatforms,
						mode: "mcp",
						force: options.force,
						useBuiltIn: true,
					});

					for (const result of results) {
						if (result.created > 0) {
							console.log(chalk.green(`✓ Created ${result.created} skills for ${result.platform}`));
						}
						if (result.updated > 0) {
							console.log(chalk.green(`✓ Updated ${result.updated} skills for ${result.platform}`));
						}
						if (result.skipped > 0) {
							console.log(chalk.gray(`  Skipped ${result.skipped} existing ${result.platform} skills`));
						}
						if (result.errors.length > 0) {
							console.log(chalk.yellow(`  Errors: ${result.errors.join(", ")}`));
						}
					}

					// Write version file so auto-sync doesn't re-sync
					writeSkillsVersionFile(projectRoot);
				}

				// Check which platforms are selected
				const hasClaudeCode = config.platforms.includes("claude-code");
				const hasAntigravity = config.platforms.includes("antigravity");

				// Create .mcp.json for Claude Code MCP auto-discovery
				if (hasClaudeCode) {
					await createMcpJsonFile(projectRoot, options.force);
				}

				// Create Antigravity MCP config at ~/.gemini/antigravity/mcp_config.json
				if (hasAntigravity) {
					await createAntigravityMcpConfig(options.force);
				}
			}

			// Create ALL instruction files (AGENTS.md, CLAUDE.md, GEMINI.md, copilot-instructions.md)
			const guidelines = UnifiedGuidelines.getFull(true);
			for (const file of INSTRUCTION_FILES.filter((f) => f.selected)) {
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

			// IDE platform setups (Cursor, Windsurf)
			for (const platform of selectedPlatforms) {
				if (platform?.ideConfig) {
					await createIDEConfig(projectRoot, platform.ideConfig, options.force);
				}
			}

			console.log();
			console.log(chalk.cyan("Get started:"));
			console.log(chalk.gray('  knowns task create "My first task"'));
			console.log(chalk.gray("  Use /kn-init to start an AI session"));
		} catch (error) {
			console.error(chalk.red("✗ Failed to initialize project"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});
