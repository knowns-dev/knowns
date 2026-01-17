/**
 * Sync Command
 * Sync skills and agent instruction files
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { SKILLS } from "../templates/skills";
import { type GuidelinesType, INSTRUCTION_FILES, getGuidelines, updateInstructionFile } from "./agents";

const PROJECT_ROOT = process.cwd();

/**
 * Sync skills to .claude/skills/
 */
async function syncSkills(options: { force?: boolean }): Promise<{
	created: number;
	updated: number;
	skipped: number;
}> {
	const skillsDir = join(PROJECT_ROOT, ".claude", "skills");

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

		if (existsSync(skillFile)) {
			if (options.force) {
				const existing = readFileSync(skillFile, "utf-8");
				if (existing.trim() !== skill.content.trim()) {
					writeFileSync(skillFile, skill.content, "utf-8");
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
			writeFileSync(skillFile, skill.content, "utf-8");
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
	.option("--type <type>", "Guidelines type for agents: cli or mcp", "cli")
	.option("--all", "Update all agent files (including Gemini, Copilot)")
	.action(async (options: { force?: boolean; type?: string; all?: boolean }) => {
		try {
			console.log(chalk.bold("\nSyncing all...\n"));

			// Sync skills
			console.log(chalk.cyan("Skills:"));
			const skillStats = await syncSkills(options);

			// Sync agents
			console.log(chalk.cyan("\nAgent files:"));
			const agentStats = await syncAgents(options);

			// Summary
			printSummary("Skills", skillStats);
			printSummary("Agents", agentStats);
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
	.action(async (options: { force?: boolean }) => {
		try {
			console.log(chalk.bold("\nSyncing skills...\n"));
			const stats = await syncSkills({ force: options.force });
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
	.option("--type <type>", "Guidelines type: cli or mcp", "cli")
	.option("--all", "Update all agent files (including Gemini, Copilot)")
	.action(async (options: { force?: boolean; type?: string; all?: boolean }) => {
		try {
			const type = options.type === "mcp" ? "mcp" : "cli";
			console.log(chalk.bold(`\nSyncing agent files (${type.toUpperCase()})...\n`));
			const stats = await syncAgents(options);
			printSummary("Summary", stats);
			console.log();
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

syncCommand.addCommand(skillsSubcommand);
syncCommand.addCommand(agentSubcommand);
