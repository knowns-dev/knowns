/**
 * Agent instruction file management commands
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { KNOWNS_GUIDELINES } from "../constants/knowns-guidelines";

const PROJECT_ROOT = process.cwd();

export const INSTRUCTION_FILES = [
	{ path: "CLAUDE.md", name: "Claude Code" },
	{ path: "AGENTS.md", name: "Agent SDK" },
	{ path: "GEMINI.md", name: "Gemini" },
	{ path: ".github/copilot-instructions.md", name: "GitHub Copilot" },
];

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
 * Update all instruction files
 */
const updateInstructionsCommand = new Command("agents")
	.description("Manage agent instruction files")
	.option("--update-instructions", "Update agent instruction files")
	.action(async (options: { updateInstructions?: boolean }) => {
		if (!options.updateInstructions) {
			console.log(chalk.yellow("No action specified. Use --update-instructions to update files."));
			console.log(chalk.gray("\nExample: knowns agents --update-instructions"));
			return;
		}

		try {
			console.log(chalk.bold("\nUpdating agent instruction files...\n"));

			let createdCount = 0;
			let appendedCount = 0;
			let updatedCount = 0;
			let errorCount = 0;

			for (const file of INSTRUCTION_FILES) {
				try {
					const result = await updateInstructionFile(file.path, KNOWNS_GUIDELINES);

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
		} catch (error) {
			console.error(
				chalk.red("Error updating instruction files:"),
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	});

export const agentsCommand = updateInstructionsCommand;
