/**
 * Template management commands
 * CLI commands for template system: list, run, create, view
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";
import {
	type LoadedTemplate,
	type TemplateResult,
	listTemplates,
	loadTemplateByName,
	runTemplateByName,
} from "../codegen";

const TEMPLATES_DIR = ".knowns/templates";

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
 * Get templates directory path
 */
function getTemplatesDir(projectRoot: string): string {
	return join(projectRoot, TEMPLATES_DIR);
}

/**
 * Ensure templates directory exists
 */
async function ensureTemplatesDir(projectRoot: string): Promise<string> {
	const templatesDir = getTemplatesDir(projectRoot);
	if (!existsSync(templatesDir)) {
		await mkdir(templatesDir, { recursive: true });
	}
	return templatesDir;
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Main template command
 */
export const templateCommand = new Command("template")
	.description("Manage code generation templates")
	.enablePositionalOptions();

/**
 * List templates subcommand
 */
const listCommand = new Command("list")
	.description("List available templates")
	.option("--plain", "Plain text output for AI")
	.action(async (options: { plain?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const templatesDir = getTemplatesDir(projectRoot);

			if (!existsSync(templatesDir)) {
				if (options.plain) {
					console.log("No templates found");
				} else {
					console.log(chalk.yellow("No templates found"));
					console.log(chalk.gray("  Create one with: knowns template create <name>"));
				}
				return;
			}

			const templates = await listTemplates(templatesDir);

			if (templates.length === 0) {
				if (options.plain) {
					console.log("No templates found");
				} else {
					console.log(chalk.yellow("No templates found"));
					console.log(chalk.gray("  Create one with: knowns template create <name>"));
				}
				return;
			}

			if (options.plain) {
				for (const template of templates) {
					console.log(`${template.name} - ${template.description || "No description"}`);
				}
			} else {
				console.log(chalk.bold("\nTemplates:\n"));

				// Calculate column widths
				const maxNameLen = Math.max(...templates.map((t) => t.name.length), 4);

				// Header
				console.log(chalk.gray(`${"Name".padEnd(maxNameLen + 2)}Description`));
				console.log(chalk.gray("─".repeat(60)));

				// Rows
				for (const template of templates) {
					const name = chalk.cyan(template.name.padEnd(maxNameLen + 2));
					const desc = template.description || chalk.gray("No description");
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
 * Run template subcommand
 */
const runCommand = new Command("run")
	.description("Run a template to generate files")
	.argument("<name>", "Template name")
	.option("--dry-run", "Preview without writing files")
	.option("-f, --force", "Overwrite existing files")
	.option("--plain", "Plain text output for AI")
	.allowUnknownOption(true) // Allow pre-filled values
	.action(async (name: string, options: { dryRun?: boolean; force?: boolean; plain?: boolean }, command: Command) => {
		try {
			const projectRoot = getProjectRoot();
			const templatesDir = getTemplatesDir(projectRoot);

			// Parse pre-filled values from unknown options
			const values: Record<string, unknown> = {};
			const args = command.args.slice(1); // Skip template name

			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg.startsWith("--")) {
					const key = arg.slice(2);
					// Check for --no-<key> pattern
					if (key.startsWith("no-")) {
						values[key.slice(3)] = false;
					} else {
						// Check if next arg is a value or another flag
						const nextArg = args[i + 1];
						if (nextArg && !nextArg.startsWith("--")) {
							values[key] = nextArg;
							i++; // Skip next arg
						} else {
							values[key] = true;
						}
					}
				}
			}

			if (options.dryRun && !options.plain) {
				console.log(chalk.cyan("\n🔍 Dry run mode - no files will be written\n"));
			}

			const result = await runTemplateByName(templatesDir, name, {
				projectRoot,
				values,
				dryRun: options.dryRun,
				force: options.force,
				silent: options.plain,
			});

			printRunResult(result, options);
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

/**
 * Print run result
 */
function printRunResult(result: TemplateResult, options: { dryRun?: boolean; plain?: boolean }): void {
	const prefix = options.dryRun ? "Would create" : "Created";
	const modPrefix = options.dryRun ? "Would modify" : "Modified";

	if (options.plain) {
		for (const file of result.created) {
			console.log(`${prefix}: ${file}`);
		}
		for (const file of result.modified) {
			console.log(`${modPrefix}: ${file}`);
		}
		for (const file of result.skipped) {
			console.log(`Skipped: ${file}`);
		}
		if (result.error) {
			console.log(`Error: ${result.error}`);
		}
	} else {
		console.log();
		for (const file of result.created) {
			console.log(chalk.green(`✓ ${prefix}: ${file}`));
		}
		for (const file of result.modified) {
			console.log(chalk.cyan(`✓ ${modPrefix}: ${file}`));
		}
		for (const file of result.skipped) {
			console.log(chalk.gray(`  Skipped: ${file}`));
		}
		if (result.error) {
			console.log(chalk.red(`✗ Error: ${result.error}`));
		}
		console.log();
	}
}

/**
 * Create template subcommand
 */
const createCommand = new Command("create")
	.description("Create a new template scaffold")
	.argument("<name>", "Template name")
	.option("-d, --description <desc>", "Template description")
	.action(async (name: string, options: { description?: string }) => {
		try {
			const projectRoot = getProjectRoot();
			const templatesDir = await ensureTemplatesDir(projectRoot);
			const templateDir = join(templatesDir, name);

			if (existsSync(templateDir)) {
				console.error(chalk.red(`✗ Template "${name}" already exists`));
				process.exit(1);
			}

			// Create template directory
			await mkdir(templateDir, { recursive: true });

			// Create _template.yaml
			const configContent = `# Template: ${name}
name: ${name}
description: ${options.description || "Description of your template"}
version: 1.0.0

# Base destination path (relative to project root)
# destination: src

# Interactive prompts
prompts:
  - name: name
    type: text
    message: "Enter name?"
    validate: required

# File generation actions
actions:
  - type: add
    template: "example.ts.hbs"
    path: "{{kebabCase name}}.ts"

# Success message
messages:
  success: |
    ✓ Created {{name}}!
`;

			await writeFile(join(templateDir, "_template.yaml"), configContent, "utf-8");

			// Create example template file
			const exampleTemplate = `/**
 * {{pascalCase name}}
 * Generated from ${name} template
 */

export function {{camelCase name}}() {
  console.log("Hello from {{name}}!");
}
`;

			await writeFile(join(templateDir, "example.ts.hbs"), exampleTemplate, "utf-8");

			console.log();
			console.log(chalk.green(`✓ Created template: ${name}`));
			console.log(chalk.gray(`  Location: ${TEMPLATES_DIR}/${name}/`));
			console.log();
			console.log(chalk.cyan("Files created:"));
			console.log(chalk.gray("  - _template.yaml (config)"));
			console.log(chalk.gray("  - example.ts.hbs (template)"));
			console.log();
			console.log(chalk.cyan("Next steps:"));
			console.log(chalk.gray("  1. Edit _template.yaml to configure prompts and actions"));
			console.log(chalk.gray("  2. Create your .hbs template files"));
			console.log(chalk.gray(`  3. Run with: knowns template run ${name}`));
			console.log();
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

/**
 * View template subcommand
 */
const viewCommand = new Command("view")
	.description("View template details")
	.argument("<name>", "Template name")
	.option("--plain", "Plain text output for AI")
	.action(async (name: string, options: { plain?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const templatesDir = getTemplatesDir(projectRoot);
			const template = await loadTemplateByName(templatesDir, name);

			if (options.plain) {
				printTemplatePlain(template);
			} else {
				printTemplateFormatted(template);
			}
		} catch (error) {
			console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

/**
 * Print template details (plain)
 */
function printTemplatePlain(template: LoadedTemplate): void {
	const { config, files } = template;

	console.log(`Template: ${config.name}`);
	if (config.description) console.log(`Description: ${config.description}`);
	if (config.version) console.log(`Version: ${config.version}`);
	if (config.destination) console.log(`Destination: ${config.destination}`);
	if (config.doc) console.log(`Linked Doc: ${config.doc}`);

	if (config.prompts && config.prompts.length > 0) {
		console.log("\nPrompts:");
		for (const prompt of config.prompts) {
			const conditional = prompt.when ? ` (when: ${prompt.when})` : "";
			console.log(`  - ${prompt.name} (${prompt.type}): ${prompt.message}${conditional}`);
		}
	}

	if (config.actions && config.actions.length > 0) {
		console.log("\nActions:");
		for (const action of config.actions) {
			const conditional = action.when ? ` (when: ${action.when})` : "";
			if (action.type === "add") {
				console.log(`  - add: ${action.path}${conditional}`);
			} else if (action.type === "addMany") {
				console.log(`  - addMany: ${action.source} -> ${action.destination}${conditional}`);
			} else if (action.type === "modify") {
				console.log(`  - modify: ${action.path}${conditional}`);
			} else if (action.type === "append") {
				console.log(`  - append: ${action.path}${conditional}`);
			}
		}
	}

	if (files.length > 0) {
		console.log("\nFiles:");
		for (const file of files) {
			console.log(`  - ${file}`);
		}
	}
}

/**
 * Print template details (formatted)
 */
function printTemplateFormatted(template: LoadedTemplate): void {
	const { config, files } = template;

	console.log();
	console.log(chalk.bold.cyan(`Template: ${config.name}`));
	if (config.description) {
		console.log(chalk.gray(config.description));
	}
	console.log();

	// Metadata
	if (config.version || config.destination || config.doc) {
		if (config.version) console.log(`${chalk.gray("Version:")} ${config.version}`);
		if (config.destination) console.log(`${chalk.gray("Destination:")} ${config.destination}`);
		if (config.doc) console.log(`${chalk.gray("Linked Doc:")} @doc/${config.doc}`);
		console.log();
	}

	// Prompts
	if (config.prompts && config.prompts.length > 0) {
		console.log(chalk.bold("Prompts:"));
		for (let i = 0; i < config.prompts.length; i++) {
			const prompt = config.prompts[i];
			const num = chalk.gray(`${i + 1}.`);
			const name = chalk.cyan(prompt.name);
			const type = chalk.gray(`(${prompt.type})`);
			const conditional = prompt.when ? chalk.yellow(` [when: ${prompt.when}]`) : "";
			console.log(`  ${num} ${name} ${type} - ${prompt.message}${conditional}`);
		}
		console.log();
	}

	// Actions
	if (config.actions && config.actions.length > 0) {
		console.log(chalk.bold("Actions:"));
		for (let i = 0; i < config.actions.length; i++) {
			const action = config.actions[i];
			const num = chalk.gray(`${i + 1}.`);
			const conditional = action.when ? chalk.yellow(` [when: ${action.when}]`) : "";

			if (action.type === "add") {
				console.log(`  ${num} ${chalk.green("add:")} ${action.path}${conditional}`);
			} else if (action.type === "addMany") {
				console.log(`  ${num} ${chalk.green("addMany:")} ${action.source} → ${action.destination}${conditional}`);
			} else if (action.type === "modify") {
				console.log(`  ${num} ${chalk.blue("modify:")} ${action.path}${conditional}`);
			} else if (action.type === "append") {
				console.log(`  ${num} ${chalk.blue("append:")} ${action.path}${conditional}`);
			}
		}
		console.log();
	}

	// Files
	if (files.length > 0) {
		console.log(chalk.bold("Template Files:"));
		for (const file of files) {
			console.log(`  ${chalk.gray("-")} ${file}`);
		}
		console.log();
	}
}

// Register subcommands
templateCommand.addCommand(listCommand);
templateCommand.addCommand(runCommand);
templateCommand.addCommand(createCommand);
templateCommand.addCommand(viewCommand);

// Add shorthand alias for view
templateCommand
	.argument("[name]", "Template name (shorthand for view)")
	.option("--plain", "Plain text output")
	.action(async (name: string | undefined, options: { plain?: boolean }) => {
		if (name) {
			// Shorthand: knowns template <name> -> knowns template view <name>
			await viewCommand.parseAsync(["view", name, ...(options.plain ? ["--plain"] : [])], { from: "user" });
		} else {
			// No name provided, show help
			templateCommand.help();
		}
	});
