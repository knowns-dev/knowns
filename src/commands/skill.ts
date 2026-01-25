/**
 * Skill management commands
 * CLI commands for skill system: list, create, view, sync
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";
import {
	PLATFORMS,
	type Platform,
	type Skill,
	getPlatform,
	getPlatformIds,
	listSkills,
	loadSkillByName,
	syncSkills,
} from "../codegen";

const SKILLS_DIR = ".knowns/skills";

/**
 * Get project root or exit with error
 */
function getProjectRoot(): string {
	const projectRoot = findProjectRoot();
	if (!projectRoot) {
		console.error(chalk.red("✗ Not a knowns project"));
		console.error(chalk.gray('  Run "knowns init" to initialize'));
		process.exit(1);
	}
	return projectRoot;
}

/**
 * Get skills directory path
 */
function getSkillsDir(projectRoot: string): string {
	return join(projectRoot, SKILLS_DIR);
}

/**
 * Ensure skills directory exists
 */
async function ensureSkillsDir(projectRoot: string): Promise<string> {
	const skillsDir = getSkillsDir(projectRoot);
	if (!existsSync(skillsDir)) {
		await mkdir(skillsDir, { recursive: true });
	}
	return skillsDir;
}

/**
 * Main skill command
 */
export const skillCommand = new Command("skill").description("Manage AI skills").enablePositionalOptions();

/**
 * List skills subcommand
 */
const listCommand = new Command("list")
	.description("List available skills")
	.option("--plain", "Plain text output for AI")
	.action(async (options: { plain?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const skillsDir = getSkillsDir(projectRoot);

			if (!existsSync(skillsDir)) {
				if (options.plain) {
					console.log("No skills found");
				} else {
					console.log(chalk.yellow("No skills found"));
					console.log(chalk.gray("  Create one with: knowns skill create <name>"));
				}
				return;
			}

			const skills = await listSkills(skillsDir);

			if (skills.length === 0) {
				if (options.plain) {
					console.log("No skills found");
				} else {
					console.log(chalk.yellow("No skills found"));
					console.log(chalk.gray("  Create one with: knowns skill create <name>"));
				}
				return;
			}

			if (options.plain) {
				for (const skill of skills) {
					console.log(`${skill.name} - ${skill.description || "No description"}`);
				}
			} else {
				console.log(chalk.bold("\nSkills:\n"));

				const maxNameLen = Math.max(...skills.map((s) => s.name.length), 4);

				console.log(chalk.gray(`${"Name".padEnd(maxNameLen + 2)}Description`));
				console.log(chalk.gray("─".repeat(60)));

				for (const skill of skills) {
					const name = chalk.cyan(skill.name.padEnd(maxNameLen + 2));
					const desc = skill.description || chalk.gray("No description");
					console.log(`${name}${desc}`);
				}

				console.log();
			}
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

/**
 * Create skill subcommand
 */
const createCommand = new Command("create")
	.description("Create a new skill")
	.argument("<name>", "Skill name")
	.option("-d, --description <desc>", "Skill description")
	.action(async (name: string, options: { description?: string }) => {
		try {
			const projectRoot = getProjectRoot();
			const skillsDir = await ensureSkillsDir(projectRoot);
			const skillDir = join(skillsDir, name);

			if (existsSync(skillDir)) {
				console.error(chalk.red(`✗ Skill "${name}" already exists`));
				process.exit(1);
			}

			await mkdir(skillDir, { recursive: true });

			const skillContent = `---
name: ${name}
description: ${options.description || "Description of your skill"}
---

# ${name}

Instructions for the AI agent.

## When to Use

Describe when this skill should be used.

## Steps

1. First step
2. Second step
3. Third step

## Example

\`\`\`bash
# Example commands
knowns task list
\`\`\`
`;

			await writeFile(join(skillDir, "SKILL.md"), skillContent, "utf-8");

			console.log();
			console.log(chalk.green(`✓ Created skill: ${name}`));
			console.log(chalk.gray(`  Location: ${SKILLS_DIR}/${name}/SKILL.md`));
			console.log();
			console.log(chalk.cyan("Next steps:"));
			console.log(chalk.gray("  1. Edit SKILL.md to define skill instructions"));
			console.log(chalk.gray("  2. Sync to platforms: knowns skill sync"));
			console.log();
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

/**
 * View skill subcommand
 */
const viewCommand = new Command("view")
	.description("View skill details")
	.argument("<name>", "Skill name")
	.option("--plain", "Plain text output for AI")
	.action(async (name: string, options: { plain?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const skillsDir = getSkillsDir(projectRoot);
			const skill = await loadSkillByName(skillsDir, name);

			if (!skill) {
				console.error(chalk.red(`✗ Skill "${name}" not found`));
				process.exit(1);
			}

			if (options.plain) {
				console.log(`Skill: ${skill.name}`);
				if (skill.description) console.log(`Description: ${skill.description}`);
				console.log(`Location: ${SKILLS_DIR}/${skill.folderName}/SKILL.md`);
				console.log("\nContent:");
				console.log(skill.content);
			} else {
				console.log();
				console.log(chalk.bold.cyan(`Skill: ${skill.name}`));
				if (skill.description) {
					console.log(chalk.gray(skill.description));
				}
				console.log();
				console.log(chalk.gray(`Location: ${SKILLS_DIR}/${skill.folderName}/SKILL.md`));
				console.log();
				console.log(chalk.bold("Content:"));
				console.log(chalk.gray("─".repeat(40)));
				console.log(skill.content);
				console.log();
			}
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

/**
 * Sync skill subcommand
 */
const syncCommand = new Command("sync")
	.description("Sync skills to AI platforms")
	.option("-p, --platform <platforms>", "Platforms to sync (comma-separated)")
	.option("-f, --force", "Force overwrite existing files")
	.option("--dry-run", "Preview without writing files")
	.option("--plain", "Plain text output for AI")
	.action(async (options: { platform?: string; force?: boolean; dryRun?: boolean; plain?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const skillsDir = getSkillsDir(projectRoot);

			if (!existsSync(skillsDir)) {
				console.error(chalk.red("✗ No skills directory found"));
				console.error(chalk.gray(`  Create skills in ${SKILLS_DIR}/`));
				process.exit(1);
			}

			const skills = await listSkills(skillsDir);
			if (skills.length === 0) {
				console.error(chalk.red("✗ No skills found to sync"));
				process.exit(1);
			}

			// Parse platforms
			let platforms: Platform[] | undefined;
			if (options.platform) {
				platforms = options.platform.split(",").map((p) => p.trim()) as Platform[];
				// Validate platforms
				for (const p of platforms) {
					if (!getPlatform(p)) {
						console.error(chalk.red(`✗ Unknown platform: ${p}`));
						console.error(chalk.gray(`  Available: ${getPlatformIds().join(", ")}`));
						process.exit(1);
					}
				}
			}

			if (!options.plain) {
				console.log(chalk.bold("\nSyncing skills...\n"));
				if (options.dryRun) {
					console.log(chalk.cyan("🔍 Dry run mode - no files will be written\n"));
				}
			}

			const results = await syncSkills({
				projectRoot,
				skillsDir,
				platforms,
				force: options.force,
				dryRun: options.dryRun,
			});

			// Print results
			for (const result of results) {
				const platform = getPlatform(result.platform);
				if (!platform) continue;

				if (options.plain) {
					console.log(
						`${platform.name}: created=${result.created} updated=${result.updated} skipped=${result.skipped}`,
					);
					for (const err of result.errors) {
						console.log(`  Error: ${err}`);
					}
				} else {
					const total = result.created + result.updated + result.skipped;
					if (total === 0 && result.errors.length === 0) continue;

					let status = chalk.green("✓");
					if (result.errors.length > 0) status = chalk.red("✗");

					console.log(`${status} ${chalk.bold(platform.name)}: ${platform.targetDir}/`);
					if (result.created > 0) console.log(chalk.green(`    Created: ${result.created}`));
					if (result.updated > 0) console.log(chalk.cyan(`    Updated: ${result.updated}`));
					if (result.skipped > 0) console.log(chalk.gray(`    Skipped: ${result.skipped}`));
					for (const err of result.errors) {
						console.log(chalk.red(`    Error: ${err}`));
					}
				}
			}

			if (!options.plain) {
				console.log();
				if (!options.force) {
					console.log(chalk.gray("  Use --force to update existing files"));
				}
			}
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

/**
 * Status subcommand
 */
const statusCommand = new Command("status")
	.description("Check skill sync status")
	.option("--plain", "Plain text output for AI")
	.action(async (options: { plain?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const skillsDir = getSkillsDir(projectRoot);

			const skills = existsSync(skillsDir) ? await listSkills(skillsDir) : [];

			if (options.plain) {
				console.log(`Skills: ${skills.length}`);
				for (const platform of PLATFORMS) {
					const targetPath = join(projectRoot, platform.targetDir);
					const exists = existsSync(targetPath);
					console.log(`${platform.name}: ${exists ? "present" : "not found"}`);
				}
			} else {
				console.log(chalk.bold("\nSkill Status\n"));
				console.log(`${chalk.gray("Source:")} ${SKILLS_DIR}/ (${skills.length} skills)`);
				console.log();

				console.log(chalk.bold("Platforms:"));
				console.log(chalk.gray("─".repeat(50)));

				for (const platform of PLATFORMS) {
					const targetPath = join(projectRoot, platform.targetDir);
					const exists = existsSync(targetPath);
					const status = exists ? chalk.green("✓ Present") : chalk.gray("○ Not synced");
					console.log(`  ${platform.name.padEnd(15)} ${platform.targetDir.padEnd(20)} ${status}`);
				}

				console.log();
				console.log(chalk.gray("  Run `knowns skill sync` to sync all platforms"));
				console.log();
			}
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// Register subcommands
skillCommand.addCommand(listCommand);
skillCommand.addCommand(createCommand);
skillCommand.addCommand(viewCommand);
skillCommand.addCommand(syncCommand);
skillCommand.addCommand(statusCommand);

// Add shorthand alias for view
skillCommand
	.argument("[name]", "Skill name (shorthand for view)")
	.option("--plain", "Plain text output")
	.action(async (name: string | undefined, options: { plain?: boolean }) => {
		if (name) {
			await viewCommand.parseAsync(["view", name, ...(options.plain ? ["--plain"] : [])], { from: "user" });
		} else {
			skillCommand.help();
		}
	});
