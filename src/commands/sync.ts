/**
 * Sync Command
 * Sync skills and agent instruction files
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { renderString } from "../codegen/renderer";
import { type IDEConfig, IDE_CONFIGS, getIDEConfig, getIDENames } from "../instructions/ide";
import { SKILLS } from "../instructions/skills";
import { type GuidelinesType, INSTRUCTION_FILES, getGuidelines, updateInstructionFile } from "./agents";

const PROJECT_ROOT = process.cwd();

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
 * Sync skills to .claude/skills/
 */
async function syncSkills(options: { force?: boolean; mode?: InstructionMode }): Promise<{
	created: number;
	updated: number;
	skipped: number;
}> {
	const skillsDir = join(PROJECT_ROOT, ".claude", "skills");
	const mode = options.mode ?? "mcp"; // Default to MCP for Claude Code

	// Create directory if not exists
	if (!existsSync(skillsDir)) {
		mkdirSync(skillsDir, { recursive: true });
		console.log(chalk.green("✓ Created .claude/skills/"));
	}

	let created = 0;
	let updated = 0;
	let skipped = 0;

	for (const skill of SKILLS) {
		const skillFolder = join(skillsDir, skill.folderName);
		const skillFile = join(skillFolder, "SKILL.md");
		const renderedContent = renderSkillContent(skill.content, mode);

		if (existsSync(skillFile)) {
			if (options.force) {
				const existing = readFileSync(skillFile, "utf-8");
				if (existing.trim() !== renderedContent.trim()) {
					writeFileSync(skillFile, renderedContent, "utf-8");
					console.log(chalk.green(`✓ Updated: ${skill.name}`));
					updated++;
				} else {
					console.log(chalk.gray(`  Unchanged: ${skill.name}`));
					skipped++;
				}
			} else {
				console.log(chalk.gray(`  Skipped: ${skill.name} (use --force to update)`));
				skipped++;
			}
		} else {
			if (!existsSync(skillFolder)) {
				mkdirSync(skillFolder, { recursive: true });
			}
			writeFileSync(skillFile, renderedContent, "utf-8");
			console.log(chalk.green(`✓ Created: ${skill.name}`));
			created++;
		}
	}

	return { created, updated, skipped };
}

/**
 * Sync agent instruction files
 */
async function syncAgents(options: { force?: boolean; type?: string; all?: boolean }): Promise<{
	created: number;
	updated: number;
	skipped: number;
}> {
	const type = (options.type === "mcp" ? "mcp" : "cli") as GuidelinesType;
	const guidelines = getGuidelines(type);
	const filesToUpdate = options.all ? INSTRUCTION_FILES : INSTRUCTION_FILES.filter((f) => f.selected);

	let created = 0;
	let updated = 0;
	let skipped = 0;

	for (const file of filesToUpdate) {
		try {
			const result = await updateInstructionFile(file.path, guidelines);
			if (result.success) {
				if (result.action === "created") {
					console.log(chalk.green(`✓ Created: ${file.path}`));
					created++;
				} else if (result.action === "appended") {
					console.log(chalk.cyan(`✓ Appended: ${file.path}`));
					updated++;
				} else {
					console.log(chalk.green(`✓ Updated: ${file.path}`));
					updated++;
				}
			}
		} catch (error) {
			console.log(chalk.gray(`  Skipped: ${file.path}`));
			skipped++;
		}
	}

	return { created, updated, skipped };
}

/**
 * Sync IDE configurations
 */
async function syncIDE(options: { force?: boolean; ide?: string }): Promise<{
	created: number;
	updated: number;
	skipped: number;
}> {
	let created = 0;
	let updated = 0;
	let skipped = 0;

	const configs = options.ide ? ([getIDEConfig(options.ide)].filter(Boolean) as IDEConfig[]) : IDE_CONFIGS;

	for (const config of configs) {
		const targetDir = join(PROJECT_ROOT, config.targetDir);

		for (const file of config.files) {
			const filePath = join(targetDir, file.filename);
			const fileDir = join(targetDir, ...file.filename.split("/").slice(0, -1));
			const content = file.isJson ? `${JSON.stringify(file.content, null, 2)}\n` : String(file.content);

			if (existsSync(filePath)) {
				if (options.force) {
					const existing = readFileSync(filePath, "utf-8");
					if (existing.trim() !== content.trim()) {
						writeFileSync(filePath, content, "utf-8");
						console.log(chalk.green(`✓ Updated: ${config.name}/${file.filename}`));
						updated++;
					} else {
						console.log(chalk.gray(`  Unchanged: ${config.name}/${file.filename}`));
						skipped++;
					}
				} else {
					console.log(chalk.gray(`  Skipped: ${config.name}/${file.filename} (use --force to update)`));
					skipped++;
				}
			} else {
				if (!existsSync(fileDir)) {
					mkdirSync(fileDir, { recursive: true });
				}
				writeFileSync(filePath, content, "utf-8");
				console.log(chalk.green(`✓ Created: ${config.name}/${file.filename}`));
				created++;
			}
		}
	}

	return { created, updated, skipped };
}

/**
 * Print summary
 */
function printSummary(label: string, stats: { created: number; updated: number; skipped: number }) {
	console.log(chalk.bold(`\n${label}:`));
	if (stats.created > 0) console.log(chalk.green(`  Created: ${stats.created}`));
	if (stats.updated > 0) console.log(chalk.green(`  Updated: ${stats.updated}`));
	if (stats.skipped > 0) console.log(chalk.gray(`  Skipped: ${stats.skipped}`));
}

/**
 * Main sync command
 */
export const syncCommand = new Command("sync")
	.description("Sync skills and agent instruction files")
	.enablePositionalOptions()
	.option("-f, --force", "Force overwrite existing files")
	.option("--mode <mode>", "Skill instruction mode: mcp or cli", "mcp")
	.option("--type <type>", "Guidelines type for agents: cli, mcp, or skills", "skills")
	.option("--all", "Update all agent files (including Gemini, Copilot)")
	.option("--ide", "Also sync IDE configurations")
	.action(async (options: { force?: boolean; mode?: string; type?: string; all?: boolean; ide?: boolean }) => {
		try {
			const mode = (options.mode === "cli" ? "cli" : "mcp") as InstructionMode;
			console.log(chalk.bold(`\nSyncing all (skills: ${mode.toUpperCase()})...\n`));

			// Sync skills
			console.log(chalk.cyan("Skills:"));
			const skillStats = await syncSkills({ force: options.force, mode });

			// Sync agents
			console.log(chalk.cyan("\nAgent files:"));
			const agentStats = await syncAgents(options);

			// Sync IDE configs (if --ide flag)
			let ideStats = { created: 0, updated: 0, skipped: 0 };
			if (options.ide) {
				console.log(chalk.cyan("\nIDE configs:"));
				ideStats = await syncIDE(options);
			}

			// Summary
			printSummary("Skills", skillStats);
			printSummary("Agents", agentStats);
			if (options.ide) {
				printSummary("IDE", ideStats);
			}
			console.log();
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

/**
 * Sync skills subcommand
 */
const skillsSubcommand = new Command("skills")
	.description("Sync Claude Code skills only")
	.option("-f, --force", "Force overwrite existing skills")
	.option("--mode <mode>", "Instruction mode: mcp or cli", "mcp")
	.action(async (options: { force?: boolean; mode?: string }) => {
		try {
			const mode = (options.mode === "cli" ? "cli" : "mcp") as InstructionMode;
			console.log(chalk.bold(`\nSyncing skills (${mode.toUpperCase()})...\n`));
			const stats = await syncSkills({ force: options.force, mode });
			printSummary("Summary", stats);
			console.log();
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

/**
 * Sync agent subcommand
 */
const agentSubcommand = new Command("agent")
	.description("Sync agent instruction files only (CLAUDE.md, AGENTS.md, etc.)")
	.option("--force", "Force overwrite existing files")
	.option("--type <type>", "Guidelines type: cli, mcp, or skills", "skills")
	.option("--all", "Update all agent files (including Gemini, Copilot)")
	.action(async (options: { force?: boolean; type?: string; all?: boolean }) => {
		try {
			const type = options.type === "mcp" ? "mcp" : options.type === "cli" ? "cli" : "skills";
			console.log(chalk.bold(`\nSyncing agent files (${type.toUpperCase()})...\n`));
			const stats = await syncAgents(options);
			printSummary("Summary", stats);
			console.log();
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

/**
 * Sync IDE subcommand
 */
const ideSubcommand = new Command("ide")
	.description(`Sync IDE configurations (${getIDENames().join(", ")})`)
	.option("-f, --force", "Force overwrite existing files")
	.option("--ide <name>", `Specific IDE: ${getIDENames().join(", ")}`)
	.action(async (options: { force?: boolean; ide?: string }) => {
		try {
			const label = options.ide || "all IDEs";
			console.log(chalk.bold(`\nSyncing ${label} configs...\n`));
			const stats = await syncIDE(options);
			printSummary("Summary", stats);
			console.log();
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

syncCommand.addCommand(skillsSubcommand);
syncCommand.addCommand(agentSubcommand);
syncCommand.addCommand(ideSubcommand);
