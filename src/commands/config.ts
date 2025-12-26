/**
 * Configuration management commands
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";
import { z } from "zod";

const CONFIG_FILE = ".knowns/config.json";

// Config schema
const ConfigSchema = z.object({
	defaultAssignee: z.string().optional(),
	defaultPriority: z.enum(["low", "medium", "high"]).optional(),
	defaultLabels: z.array(z.string()).optional(),
	timeFormat: z.enum(["12h", "24h"]).optional(),
	editor: z.string().optional(),
	visibleColumns: z.array(z.enum(["todo", "in-progress", "in-review", "done", "blocked"])).optional(),
	serverPort: z.number().optional(),
});

type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG: Config = {
	defaultPriority: "medium",
	defaultLabels: [],
	timeFormat: "24h",
	visibleColumns: ["todo", "in-progress", "done"],
	serverPort: 6420,
};

/**
 * Get project root
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
 * Load config from file
 */
async function loadConfig(projectRoot: string): Promise<Config> {
	const configPath = join(projectRoot, CONFIG_FILE);

	if (!existsSync(configPath)) {
		return { ...DEFAULT_CONFIG };
	}

	try {
		const content = await readFile(configPath, "utf-8");
		const data = JSON.parse(content);
		// Read from settings field
		const settings = data.settings || {};
		const validated = ConfigSchema.parse(settings);
		return { ...DEFAULT_CONFIG, ...validated };
	} catch (error) {
		console.error(chalk.red("✗ Invalid config file"));
		if (error instanceof Error) {
			console.error(chalk.gray(`  ${error.message}`));
		}
		process.exit(1);
	}
}

/**
 * Save config to file
 */
async function saveConfig(projectRoot: string, config: Config): Promise<void> {
	const configPath = join(projectRoot, CONFIG_FILE);
	const knownsDir = join(projectRoot, ".knowns");

	// Ensure .knowns directory exists
	if (!existsSync(knownsDir)) {
		await mkdir(knownsDir, { recursive: true });
	}

	try {
		// Read existing file to preserve project metadata
		let existingData: { name?: string; id?: string; createdAt?: string } = {};
		if (existsSync(configPath)) {
			const content = await readFile(configPath, "utf-8");
			existingData = JSON.parse(content);
		}

		// Merge: preserve project metadata, update settings
		const merged = {
			...existingData,
			settings: config,
		};

		await writeFile(configPath, JSON.stringify(merged, null, 2), "utf-8");
	} catch (error) {
		console.error(chalk.red("✗ Failed to save config"));
		if (error instanceof Error) {
			console.error(chalk.gray(`  ${error.message}`));
		}
		process.exit(1);
	}
}

/**
 * Get nested config value by dot notation key
 */
function getNestedValue(obj: Config, key: string): unknown {
	if (key in obj) {
		return obj[key as keyof Config];
	}
	return undefined;
}

/**
 * Set nested config value by dot notation key
 */
function setNestedValue(obj: Config, key: string, value: unknown): void {
	const validKeys = Object.keys(ConfigSchema.shape);
	if (validKeys.includes(key)) {
		(obj as Record<string, unknown>)[key] = value;
	} else {
		throw new Error(`Unknown config key: ${key}. Valid keys: ${validKeys.join(", ")}`);
	}
}

// List command
const listCommand = new Command("list")
	.description("List all configuration settings")
	.option("--plain", "Plain text output for AI")
	.action(async (options: { plain?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const config = await loadConfig(projectRoot);

			if (options.plain) {
				const border = "=".repeat(50);
				console.log("Configuration Settings");
				console.log(border);
				console.log();

				for (const [key, value] of Object.entries(config)) {
					const valueStr = Array.isArray(value) ? `[${value.join(", ")}]` : String(value ?? "(not set)");
					console.log(`${key}: ${valueStr}`);
				}
			} else {
				console.log(chalk.bold("\n⚙️  Configuration\n"));

				for (const [key, value] of Object.entries(config)) {
					const valueStr = Array.isArray(value) ? `[${value.join(", ")}]` : String(value ?? chalk.gray("(not set)"));

					console.log(`  ${chalk.cyan(key)}: ${valueStr}`);
				}
				console.log();
			}
		} catch (error) {
			console.error(chalk.red("✗ Failed to list config"));
			if (error instanceof Error) {
				console.error(chalk.gray(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

// Get command
const getCommand = new Command("get")
	.description("Get a configuration value")
	.argument("<key>", "Configuration key")
	.option("--plain", "Plain text output for AI")
	.action(async (key: string, options: { plain?: boolean }) => {
		try {
			const projectRoot = getProjectRoot();
			const config = await loadConfig(projectRoot);
			const value = getNestedValue(config, key);

			if (value === undefined) {
				console.error(chalk.red(`✗ Config key not found: ${key}`));
				console.error(chalk.gray("  Run 'knowns config list' to see all keys"));
				process.exit(1);
			}

			if (options.plain) {
				if (Array.isArray(value)) {
					console.log(value.join(";"));
				} else {
					console.log(String(value));
				}
			} else {
				const valueStr = Array.isArray(value) ? `[${value.join(", ")}]` : String(value);
				console.log(`${chalk.cyan(key)}: ${valueStr}`);
			}
		} catch (error) {
			console.error(chalk.red("✗ Failed to get config"));
			if (error instanceof Error) {
				console.error(chalk.gray(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

// Set command
const setCommand = new Command("set")
	.description("Set a configuration value")
	.argument("<key>", "Configuration key")
	.argument("<value>", "Configuration value")
	.action(async (key: string, value: string) => {
		try {
			const projectRoot = getProjectRoot();
			const config = await loadConfig(projectRoot);

			// Parse value
			let parsedValue: unknown = value;

			// Handle special cases
			if (key === "defaultLabels") {
				parsedValue = value.split(",").map((l) => l.trim());
			} else if (key === "defaultPriority") {
				if (!["low", "medium", "high"].includes(value)) {
					console.error(chalk.red(`✗ Invalid priority: ${value}. Must be: low, medium, or high`));
					process.exit(1);
				}
			} else if (key === "timeFormat") {
				if (!["12h", "24h"].includes(value)) {
					console.error(chalk.red(`✗ Invalid timeFormat: ${value}. Must be: 12h or 24h`));
					process.exit(1);
				}
			}

			// Set value
			setNestedValue(config, key, parsedValue);

			// Validate
			try {
				ConfigSchema.parse(config);
			} catch (error) {
				if (error instanceof z.ZodError) {
					console.error(chalk.red("✗ Invalid configuration:"));
					for (const issue of error.errors) {
						console.error(chalk.gray(`  ${issue.path.join(".")}: ${issue.message}`));
					}
					process.exit(1);
				}
				throw error;
			}

			// Save
			await saveConfig(projectRoot, config);

			console.log(chalk.green(`✓ Updated config: ${chalk.bold(key)} = ${value}`));
		} catch (error) {
			console.error(chalk.red("✗ Failed to set config"));
			if (error instanceof Error) {
				console.error(chalk.gray(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

// Reset command
const resetCommand = new Command("reset")
	.description("Reset configuration to defaults")
	.option("-y, --yes", "Skip confirmation")
	.action(async (options: { yes?: boolean }) => {
		try {
			if (!options.yes) {
				console.log(chalk.yellow("⚠️  This will reset all configuration to defaults."));
				console.log(chalk.gray("  Use --yes to skip this confirmation."));
				process.exit(0);
			}

			const projectRoot = getProjectRoot();
			await saveConfig(projectRoot, { ...DEFAULT_CONFIG });

			console.log(chalk.green("✓ Configuration reset to defaults"));
		} catch (error) {
			console.error(chalk.red("✗ Failed to reset config"));
			if (error instanceof Error) {
				console.error(chalk.gray(`  ${error.message}`));
			}
			process.exit(1);
		}
	});

// Main config command
export const configCommand = new Command("config")
	.description("Manage configuration settings")
	.addCommand(listCommand)
	.addCommand(getCommand)
	.addCommand(setCommand)
	.addCommand(resetCommand);
