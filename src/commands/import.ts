/**
 * Import Command
 * Import templates and docs from external sources (git, npm, local)
 */

import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";
import {
	ImportError,
	type ImportResult,
	type ImportType,
	getImportsWithMetadata,
	importSource,
	removeImport,
	syncAllImports,
	syncImport,
} from "../import";

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
 * Format date for display
 */
function formatDate(isoDate: string): string {
	const date = new Date(isoDate);
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * Print import result
 */
function printResult(result: ImportResult, options: { plain?: boolean; dryRun?: boolean }): void {
	const actionPrefix = options.dryRun ? "Would " : "";

	if (options.plain) {
		if (!result.success) {
			console.log(`Error: ${result.error}`);
			return;
		}

		console.log(`Import: ${result.name}`);
		console.log(`Source: ${result.source}`);
		console.log(`Type: ${result.type}`);

		if (result.changes.length > 0) {
			console.log("\nChanges:");
			for (const change of result.changes) {
				if (change.action === "skip") {
					console.log(`  Skip: ${change.path} (${change.skipReason || "unchanged"})`);
				} else {
					console.log(`  ${actionPrefix}${change.action}: ${change.path}`);
				}
			}
		}
	} else {
		if (!result.success) {
			console.log(chalk.red(`\n✗ Failed to import: ${result.error}\n`));
			return;
		}

		console.log();
		console.log(chalk.green(`✓ ${options.dryRun ? "Would import" : "Imported"}: ${result.name}`));
		console.log(chalk.gray(`  Source: ${result.source}`));
		console.log(chalk.gray(`  Type: ${result.type}`));

		if (result.changes.length > 0) {
			const added = result.changes.filter((c) => c.action === "add").length;
			const updated = result.changes.filter((c) => c.action === "update").length;
			const skipped = result.changes.filter((c) => c.action === "skip").length;

			console.log();
			if (added > 0) console.log(chalk.green(`  ${actionPrefix}Added: ${added} files`));
			if (updated > 0) console.log(chalk.cyan(`  ${actionPrefix}Updated: ${updated} files`));
			if (skipped > 0) console.log(chalk.gray(`  Skipped: ${skipped} files`));

			// Show modified file warnings
			const modified = result.changes.filter((c) => c.skipReason === "Local modifications detected");
			if (modified.length > 0) {
				console.log(chalk.yellow("\n  ⚠ Locally modified files (skipped):"));
				for (const file of modified) {
					console.log(chalk.yellow(`    - ${file.path}`));
				}
				console.log(chalk.gray("    Use --force to overwrite"));
			}
		}
		console.log();
	}
}

/**
 * Main import command
 */
export const importCommand = new Command("import")
	.description("Import templates and docs from external sources")
	.enablePositionalOptions();

/**
 * Import from source (default action)
 */
const addCommand = new Command("add")
	.description("Import from a source (git, npm, or local path)")
	.argument("<source>", "Source to import (git URL, npm package, or local path)")
	.option("-n, --name <name>", "Custom name for the import")
	.option("-t, --type <type>", "Source type: git, npm, or local")
	.option("-r, --ref <ref>", "Git branch/tag or npm version")
	.option("--include <patterns...>", "Include only these file patterns")
	.option("--exclude <patterns...>", "Exclude these file patterns")
	.option("--link", "Create symlink for local imports (instead of copying)")
	.option("-f, --force", "Overwrite existing import")
	.option("--dry-run", "Preview without importing")
	.option("--plain", "Plain text output for AI")
	.action(
		async (
			source: string,
			options: {
				name?: string;
				type?: string;
				ref?: string;
				include?: string[];
				exclude?: string[];
				link?: boolean;
				force?: boolean;
				dryRun?: boolean;
				plain?: boolean;
			},
		) => {
			try {
				const projectRoot = getProjectRoot();

				if (!options.plain && !options.dryRun) {
					console.log(chalk.cyan(`\nImporting from: ${source}\n`));
				}

				const result = await importSource(projectRoot, source, {
					name: options.name,
					type: options.type as ImportType | undefined,
					ref: options.ref,
					include: options.include,
					exclude: options.exclude,
					link: options.link,
					force: options.force,
					dryRun: options.dryRun,
				});

				printResult(result, options);
			} catch (error) {
				if (error instanceof ImportError) {
					if (options.plain) {
						console.log(`Error: ${error.message}`);
						if (error.hint) console.log(`Hint: ${error.hint}`);
					} else {
						console.error(chalk.red(`\n✗ ${error.message}`));
						if (error.hint) console.error(chalk.gray(`  ${error.hint}`));
						console.log();
					}
					process.exit(1);
				}
				throw error;
			}
		},
	);

/**
 * List imports
 */
const listCommand = new Command("list")
	.description("List imported sources")
	.option("--plain", "Plain text output for AI")
	.action(async (options: { plain?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const imports = await getImportsWithMetadata(projectRoot);

			if (imports.length === 0) {
				if (options.plain) {
					console.log("No imports found");
				} else {
					console.log(chalk.yellow("\nNo imports found"));
					console.log(chalk.gray("  Add one with: knowns import add <source>"));
					console.log();
				}
				return;
			}

			if (options.plain) {
				for (const imp of imports) {
					const meta = imp.metadata;
					console.log(`${imp.config.name} (${imp.config.type})`);
					console.log(`  Source: ${imp.config.source}`);
					if (meta) {
						console.log(`  Last sync: ${meta.lastSync}`);
						console.log(`  Files: ${meta.files.length}`);
					}
					if (imp.config.link) {
						console.log("  Mode: symlink");
					}
				}
			} else {
				console.log(chalk.bold("\nImported Sources:\n"));

				for (const imp of imports) {
					const meta = imp.metadata;
					const name = chalk.cyan(imp.config.name);
					const type = chalk.gray(`(${imp.config.type})`);
					const linked = imp.config.link ? chalk.yellow(" [linked]") : "";

					console.log(`${name} ${type}${linked}`);
					console.log(chalk.gray(`  Source: ${imp.config.source}`));

					if (imp.config.ref) {
						console.log(chalk.gray(`  Ref: ${imp.config.ref}`));
					}

					if (meta) {
						console.log(chalk.gray(`  Last sync: ${formatDate(meta.lastSync)}`));
						console.log(chalk.gray(`  Files: ${meta.files.length}`));
					}
					console.log();
				}
			}
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

/**
 * Sync imports
 */
const syncCommand = new Command("sync")
	.description("Sync imports from their sources")
	.argument("[name]", "Import name to sync (syncs all if not specified)")
	.option("-f, --force", "Force overwrite locally modified files")
	.option("--dry-run", "Preview without syncing")
	.option("--plain", "Plain text output for AI")
	.action(
		async (
			name: string | undefined,
			options: {
				force?: boolean;
				dryRun?: boolean;
				plain?: boolean;
			},
		) => {
			try {
				const projectRoot = getProjectRoot();

				if (name) {
					// Sync single import
					if (!options.plain && !options.dryRun) {
						console.log(chalk.cyan(`\nSyncing: ${name}\n`));
					}

					const result = await syncImport(projectRoot, name, {
						force: options.force,
						dryRun: options.dryRun,
					});

					printResult(result, options);
				} else {
					// Sync all imports
					if (!options.plain && !options.dryRun) {
						console.log(chalk.cyan("\nSyncing all imports...\n"));
					}

					const results = await syncAllImports(projectRoot, {
						force: options.force,
						dryRun: options.dryRun,
					});

					if (results.length === 0) {
						if (options.plain) {
							console.log("No imports to sync");
						} else {
							console.log(chalk.yellow("No imports to sync"));
							console.log();
						}
						return;
					}

					for (const result of results) {
						printResult(result, options);
					}

					// Summary
					if (!options.plain) {
						const successful = results.filter((r) => r.success).length;
						const failed = results.filter((r) => !r.success).length;

						console.log(chalk.bold("Summary:"));
						if (successful > 0) console.log(chalk.green(`  Synced: ${successful}`));
						if (failed > 0) console.log(chalk.red(`  Failed: ${failed}`));
						console.log();
					}
				}
			} catch (error) {
				if (error instanceof ImportError) {
					if (options.plain) {
						console.log(`Error: ${error.message}`);
						if (error.hint) console.log(`Hint: ${error.hint}`);
					} else {
						console.error(chalk.red(`\n✗ ${error.message}`));
						if (error.hint) console.error(chalk.gray(`  ${error.hint}`));
						console.log();
					}
					process.exit(1);
				}
				throw error;
			}
		},
	);

/**
 * Remove import
 */
const removeCommand = new Command("remove")
	.description("Remove an imported source")
	.argument("<name>", "Import name to remove")
	.option("--delete", "Also delete imported files")
	.option("--plain", "Plain text output for AI")
	.action(
		async (
			name: string,
			options: {
				delete?: boolean;
				plain?: boolean;
			},
		) => {
			try {
				const projectRoot = getProjectRoot();
				const result = await removeImport(projectRoot, name, options.delete);

				if (options.plain) {
					console.log(`Removed: ${name}`);
					if (result.deleted) {
						console.log("Files: deleted");
					}
				} else {
					console.log();
					console.log(chalk.green(`✓ Removed import: ${name}`));
					if (result.deleted) {
						console.log(chalk.gray("  Files deleted"));
					} else {
						console.log(chalk.gray("  Files kept (use --delete to remove)"));
					}
					console.log();
				}
			} catch (error) {
				if (error instanceof ImportError) {
					if (options.plain) {
						console.log(`Error: ${error.message}`);
					} else {
						console.error(chalk.red(`\n✗ ${error.message}`));
						console.log();
					}
					process.exit(1);
				}
				throw error;
			}
		},
	);

// Register subcommands
importCommand.addCommand(addCommand);
importCommand.addCommand(listCommand);
importCommand.addCommand(syncCommand);
importCommand.addCommand(removeCommand);

// Default action: if first arg is not a subcommand, treat as source
importCommand
	.argument("[source]", "Source to import (shorthand for 'import add')")
	.option("-n, --name <name>", "Custom name for the import")
	.option("-t, --type <type>", "Source type: git, npm, or local")
	.option("-r, --ref <ref>", "Git branch/tag or npm version")
	.option("--link", "Create symlink for local imports")
	.option("-f, --force", "Overwrite existing import")
	.option("--dry-run", "Preview without importing")
	.option("--plain", "Plain text output for AI")
	.action(async (source: string | undefined, options: Record<string, unknown>) => {
		if (source && !["add", "list", "sync", "remove"].includes(source)) {
			// Shorthand: knowns import <source> -> knowns import add <source>
			const args = ["add", source];
			if (options.name) args.push("--name", String(options.name));
			if (options.type) args.push("--type", String(options.type));
			if (options.ref) args.push("--ref", String(options.ref));
			if (options.link) args.push("--link");
			if (options.force) args.push("--force");
			if (options.dryRun) args.push("--dry-run");
			if (options.plain) args.push("--plain");

			await addCommand.parseAsync(args, { from: "user" });
		} else if (!source) {
			// No args, show help
			importCommand.help();
		}
	});
