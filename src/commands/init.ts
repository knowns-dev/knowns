/**
 * Init Command
 * Initialize .knowns/ folder in current directory
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { FileStore } from "@storage/file-store";
import chalk from "chalk";
import { Command } from "commander";
import { KNOWNS_GUIDELINES } from "../constants/knowns-guidelines";
import { INSTRUCTION_FILES, updateInstructionFile } from "./agents";

export const initCommand = new Command("init")
	.description("Initialize .knowns/ folder in current directory")
	.argument("[name]", "Project name", "My Project")
	.action(async (name: string) => {
		try {
			const projectRoot = process.cwd();
			const knownsPath = join(projectRoot, ".knowns");

			// Check if already initialized
			if (existsSync(knownsPath)) {
				console.log(chalk.yellow("⚠️  Project already initialized"));
				console.log(chalk.gray(`   Location: ${knownsPath}`));
				return;
			}

			// Initialize project
			const fileStore = new FileStore(projectRoot);
			const project = await fileStore.initProject(name);

			console.log(chalk.green("✓ Project initialized successfully!"));
			console.log(chalk.gray(`  Name: ${project.name}`));
			console.log(chalk.gray(`  Location: ${knownsPath}`));
			console.log();

			// Update AI instruction files
			console.log(chalk.bold("Updating AI instruction files..."));
			console.log();

			let syncedCount = 0;
			for (const file of INSTRUCTION_FILES) {
				try {
					const result = await updateInstructionFile(file.path, KNOWNS_GUIDELINES);
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
			console.log();
			console.log(chalk.cyan("Next steps:"));
			console.log(chalk.gray('  1. Create a task: knowns task create "My first task"'));
			console.log(chalk.gray("  2. List tasks: knowns task list"));
			console.log(chalk.gray("  3. Update AI instructions: knowns agents --update-instructions"));
		} catch (error) {
			console.error(chalk.red("✗ Failed to initialize project"));
			if (error instanceof Error) {
				console.error(chalk.red(`  ${error.message}`));
			}
			process.exit(1);
		}
	});
