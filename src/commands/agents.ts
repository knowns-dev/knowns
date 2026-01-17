/**
 * Agent instruction file management commands
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import prompts from "prompts";
// Import modular guidelines
import { Guidelines, MCPGuidelines } from "../templates/guidelines";
// Import instruction templates (with markers)
import { CLI_INSTRUCTION, MCP_INSTRUCTION, SKILLS_INSTRUCTION } from "../templates/instruction";

const PROJECT_ROOT = process.cwd();

export const INSTRUCTION_FILES = [
	{ path: "CLAUDE.md", name: "Claude Code", selected: true },
	{ path: "AGENTS.md", name: "Agent SDK", selected: true },
	{ path: "GEMINI.md", name: "Gemini", selected: false },
	{
		path: ".github/copilot-instructions.md",
		name: "GitHub Copilot",
		selected: false,
	},
];

export type GuidelinesType = "cli" | "mcp" | "skills";
export type GuidelinesVariant = "general" | "instruction";

/**
 * Get guidelines content by type and variant
 */
export function getGuidelines(type: GuidelinesType, variant: GuidelinesVariant = "general"): string {
	// Skills type always uses the minimal skills instruction
	if (type === "skills") {
		return SKILLS_INSTRUCTION;
	}

	if (variant === "instruction") {
		// Instruction templates (minimal, tells AI to call guideline command)
		return type === "mcp" ? MCP_INSTRUCTION : CLI_INSTRUCTION;
	}
	// Full guidelines with markers (for embedding in CLAUDE.md) - DEFAULT
	// Return type-specific guidelines (CLI or MCP)
	return type === "mcp" ? MCPGuidelines.getFull(true) : Guidelines.getFull(true);
}

/**
 * Update instruction file with guidelines
 */
export async function updateInstructionFile(
	filePath: string,
	guidelines: string,
): Promise<{ success: boolean; action: "created" | "appended" | "updated" }> {
	const fullPath = join(PROJECT_ROOT, filePath);
	const startMarker = "<!-- KNOWNS GUIDELINES START -->";
	const endMarker = "<!-- KNOWNS GUIDELINES END -->";

	// Ensure directory exists
	const dir = dirname(fullPath);
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}

	if (!existsSync(fullPath)) {
		// Create new file with guidelines
		await writeFile(fullPath, guidelines, "utf-8");
		return { success: true, action: "created" };
	}

	// File exists, check for markers
	const content = await readFile(fullPath, "utf-8");
	const startIndex = content.indexOf(startMarker);
	const endIndex = content.indexOf(endMarker);

	if (startIndex === -1 || endIndex === -1) {
		// No markers found, append guidelines
		const newContent = `${content.trimEnd()}\n\n${guidelines}\n`;
		await writeFile(fullPath, newContent, "utf-8");
		return { success: true, action: "appended" };
	}

	// Markers found, update content between markers
	const before = content.substring(0, startIndex);
	const after = content.substring(endIndex + endMarker.length);
	const newContent = before + guidelines + after;

	await writeFile(fullPath, newContent, "utf-8");
	return { success: true, action: "updated" };
}

/**
 * Interactive agents command
 */
const agentsCommand = new Command("agents")
	.description("Manage agent instruction files (CLAUDE.md, GEMINI.md, etc.)")
	.enablePositionalOptions()
	.passThroughOptions()
	.option("--update-instructions", "Update agent instruction files (non-interactive)")
	.option("--type <type>", "Guidelines type: cli or mcp", "cli")
	.option("--files <files>", "Comma-separated list of files to update")
	.action(
		async (options: {
			updateInstructions?: boolean;
			type?: string;
			files?: string;
		}) => {
			try {
				// Non-interactive mode with --update-instructions flag
				if (options.updateInstructions) {
					const type = (options.type === "mcp" ? "mcp" : "cli") as GuidelinesType;
					const variant: GuidelinesVariant = "general";
					const guidelines = getGuidelines(type, variant);

					// Determine which files to update
					let filesToUpdate = INSTRUCTION_FILES;
					if (options.files) {
						const requestedFiles = options.files.split(",").map((f) => f.trim());
						filesToUpdate = INSTRUCTION_FILES.filter(
							(f) => requestedFiles.includes(f.path) || requestedFiles.includes(f.name),
						);
					}

					const label = `${type.toUpperCase()}`;
					console.log(chalk.bold(`\nUpdating agent instruction files (${label})...\n`));
					await updateFiles(filesToUpdate, guidelines);
					return;
				}

				// Interactive mode
				console.log(chalk.bold("\n🤖 Agent Instructions Manager\n"));

				// Step 1: Select guidelines type
				const typeResponse = await prompts({
					type: "select",
					name: "type",
					message: "Select guidelines type:",
					choices: [
						{
							title: "CLI",
							value: "cli",
							description: "CLI commands (knowns task edit, knowns doc view, etc.)",
						},
						{
							title: "MCP",
							value: "mcp",
							description: "MCP tools (mcp__knowns__update_task, etc.)",
						},
					],
					initial: 0,
				});

				if (!typeResponse.type) {
					console.log(chalk.yellow("\n⚠️  Cancelled"));
					return;
				}

				// Step 2: Select variant
				const variantResponse = await prompts({
					type: "select",
					name: "variant",
					message: "Select variant:",
					choices: [
						{
							title: "Full (Recommended)",
							value: "general",
							description: "Complete guidelines embedded in file",
						},
						{
							title: "Minimal",
							value: "instruction",
							description: "Just tells AI to call `knowns agents guideline` for rules",
						},
					],
					initial: 0,
				});

				if (!variantResponse.variant) {
					console.log(chalk.yellow("\n⚠️  Cancelled"));
					return;
				}

				// Step 3: Select files to update
				const filesResponse = await prompts({
					type: "multiselect",
					name: "files",
					message: "Select agent files to update:",
					choices: INSTRUCTION_FILES.map((f) => ({
						title: `${f.name} (${f.path})`,
						value: f,
						selected: f.selected,
					})),
					hint: "- Space to select. Return to submit",
				});

				if (!filesResponse.files || filesResponse.files.length === 0) {
					console.log(chalk.yellow("\n⚠️  No files selected"));
					return;
				}

				// Step 4: Confirm
				const variantLabel = variantResponse.variant === "instruction" ? " (minimal)" : " (full)";
				const label = `${typeResponse.type.toUpperCase()}${variantLabel}`;
				const confirmResponse = await prompts({
					type: "confirm",
					name: "confirm",
					message: `Update ${filesResponse.files.length} file(s) with ${label} guidelines?`,
					initial: true,
				});

				if (!confirmResponse.confirm) {
					console.log(chalk.yellow("\n⚠️  Cancelled"));
					return;
				}

				// Step 5: Update files
				const guidelines = getGuidelines(
					typeResponse.type as GuidelinesType,
					variantResponse.variant as GuidelinesVariant,
				);
				console.log(chalk.bold(`\nUpdating files with ${label} guidelines...\n`));
				await updateFiles(filesResponse.files, guidelines);
			} catch (error) {
				console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		},
	);

/**
 * Update multiple files with guidelines
 */
async function updateFiles(files: Array<{ path: string; name: string }>, guidelines: string): Promise<void> {
	let createdCount = 0;
	let appendedCount = 0;
	let updatedCount = 0;
	let errorCount = 0;

	for (const file of files) {
		try {
			const result = await updateInstructionFile(file.path, guidelines);

			if (result.success) {
				if (result.action === "created") {
					createdCount++;
					console.log(chalk.green(`✓ Created ${file.name}: ${file.path}`));
				} else if (result.action === "appended") {
					appendedCount++;
					console.log(chalk.cyan(`✓ Appended ${file.name}: ${file.path}`));
				} else {
					updatedCount++;
					console.log(chalk.green(`✓ Updated ${file.name}: ${file.path}`));
				}
			}
		} catch (error) {
			errorCount++;
			console.error(
				chalk.red(`✗ Failed ${file.name}: ${file.path}`),
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	console.log(chalk.bold("\nSummary:"));
	if (createdCount > 0) {
		console.log(chalk.green(`  Created: ${createdCount}`));
	}
	if (appendedCount > 0) {
		console.log(chalk.cyan(`  Appended: ${appendedCount}`));
	}
	if (updatedCount > 0) {
		console.log(chalk.green(`  Updated: ${updatedCount}`));
	}
	if (errorCount > 0) {
		console.log(chalk.red(`  Failed: ${errorCount}`));
	}
	console.log();
}

/**
 * Guideline subcommand - output guidelines to stdout
 */
const guidelineCommand = new Command("guideline")
	.description("Output guidelines for AI agents (use this at session start)")
	.option("--cli", "Show CLI-specific guidelines (legacy)")
	.option("--mcp", "Show MCP-specific guidelines (legacy)")
	.option("--full", "Show full guidelines (all sections)")
	.option("--compact", "Show compact guidelines (core + mistakes only)")
	.option("--stage <stage>", "Show guidelines for specific stage: creation, execution, completion")
	.option("--core", "Show core rules only")
	.option("--commands", "Show commands reference only")
	.option("--mistakes", "Show common mistakes only")
	.action(
		async (options: {
			cli?: boolean;
			mcp?: boolean;
			full?: boolean;
			compact?: boolean;
			stage?: string;
			core?: boolean;
			commands?: boolean;
			mistakes?: boolean;
		}) => {
			try {
				// Legacy options (now just output full guidelines)
				if (options.cli || options.mcp) {
					console.log(Guidelines.getFull());
					return;
				}

				// Modular options
				if (options.core) {
					console.log(Guidelines.core);
					return;
				}
				if (options.commands) {
					console.log(Guidelines.commands);
					return;
				}
				if (options.mistakes) {
					console.log(Guidelines.mistakes);
					return;
				}
				if (options.compact) {
					console.log(Guidelines.getCompact());
					return;
				}
				if (options.stage) {
					const stage = options.stage as "creation" | "execution" | "completion";
					if (!["creation", "execution", "completion"].includes(stage)) {
						console.error("Error: Invalid stage. Use: creation, execution, or completion");
						process.exit(1);
					}
					console.log(Guidelines.getForStage(stage));
					return;
				}
				// Default: full guidelines (all sections)
				console.log(Guidelines.getFull());
			} catch (error) {
				console.error("Error:", error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		},
	);

agentsCommand.addCommand(guidelineCommand);

export { agentsCommand };
