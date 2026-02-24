/**
 * Configuration management commands
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImportConfig } from "@import/models";
import type { EmbeddingModel } from "@models/project";
import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";
import prompts from "prompts";
import { z } from "zod";

const CONFIG_FILE = ".knowns/config.json";

// Semantic search settings schema
const SemanticSearchSchema = z.object({
	enabled: z.boolean().optional(),
	model: z.enum(["gte-small", "all-MiniLM-L6-v2", "gte-base"]).optional(),
});

// Config schema
const ConfigSchema = z.object({
	defaultAssignee: z.string().optional(),
	defaultPriority: z.enum(["low", "medium", "high"]).optional(),
	defaultLabels: z.array(z.string()).optional(),
	timeFormat: z.enum(["12h", "24h"]).optional(),
	editor: z.string().optional(),
	visibleColumns: z.array(z.enum(["todo", "in-progress", "in-review", "done", "blocked"])).optional(),
	serverPort: z.number().optional(),
	semanticSearch: SemanticSearchSchema.optional(),
});

type Config = z.infer<typeof ConfigSchema>;

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

const DEFAULT_CONFIG: Config = {
	defaultPriority: "medium",
	defaultLabels: [],
	timeFormat: "24h",
	visibleColumns: ["todo", "in-progress", "done"],
	serverPort: 6420,
	semanticSearch: {
		enabled: false,
		model: "gte-small",
	},
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
		// Read existing file to preserve project metadata and imports
		let existingData: {
			name?: string;
			id?: string;
			createdAt?: string;
			imports?: ImportConfig[];
		} = {};
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
	const parts = key.split(".");
	let current: unknown = obj;

	for (const part of parts) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}

	return current;
}

/**
 * Set nested config value by dot notation key
 */
function setNestedValue(obj: Config, key: string, value: unknown): void {
	const parts = key.split(".");

	// Handle top-level keys
	if (parts.length === 1) {
		const validKeys = Object.keys(ConfigSchema.shape);
		if (validKeys.includes(key)) {
			(obj as Record<string, unknown>)[key] = value;
		} else {
			throw new Error(`Unknown config key: ${key}. Valid keys: ${validKeys.join(", ")}`);
		}
		return;
	}

	// Handle nested keys (e.g., "semanticSearch.enabled")
	let current: Record<string, unknown> = obj as Record<string, unknown>;

	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		if (!part) continue;

		if (current[part] === undefined || current[part] === null) {
			current[part] = {};
		}
		current = current[part] as Record<string, unknown>;
	}

	const lastPart = parts[parts.length - 1];
	if (lastPart) {
		current[lastPart] = value;
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

/**
 * Check if a key is valid in the config schema
 */
function isValidConfigKey(key: string): boolean {
	const parts = key.split(".");
	const topLevelKey = parts[0];

	// Check if top-level key is valid
	const validTopLevelKeys = Object.keys(ConfigSchema.shape);
	if (!topLevelKey || !validTopLevelKeys.includes(topLevelKey)) {
		return false;
	}

	// For nested keys like "semanticSearch.enabled", validate against nested schema
	if (parts.length > 1 && topLevelKey === "semanticSearch") {
		const nestedKey = parts[1];
		const validNestedKeys = Object.keys(SemanticSearchSchema.shape);
		return nestedKey ? validNestedKeys.includes(nestedKey) : false;
	}

	return true;
}

// Get command
const getCommand = new Command("get")
	.description("Get a configuration value")
	.argument("<key>", "Configuration key")
	.option("--plain", "Plain text output for AI")
	.action(async (key: string, options: { plain?: boolean }) => {
		try {
			// First check if the key is valid in the schema
			if (!isValidConfigKey(key)) {
				const validKeys = Object.keys(ConfigSchema.shape);
				console.error(chalk.red(`✗ Unknown config key: ${key}`));
				console.error(chalk.gray(`  Valid keys: ${validKeys.join(", ")}`));
				process.exit(1);
			}

			const projectRoot = getProjectRoot();
			const config = await loadConfig(projectRoot);
			const value = getNestedValue(config, key);

			// Key is valid but value is not set
			if (value === undefined) {
				if (options.plain) {
					// Return empty string for plain mode (allows scripts to handle gracefully)
					console.log("");
				} else {
					console.log(`${chalk.cyan(key)}: ${chalk.gray("(not set)")}`);
				}
				return;
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
 * Handle enabling semantic search
 * - Prompt for model selection if not configured
 * - Download model if missing
 * - Auto-run reindex after enabling
 */
async function enableSemanticSearch(projectRoot: string, config: Config): Promise<void> {
	// Initialize semanticSearch if not present
	if (!config.semanticSearch) {
		config.semanticSearch = { enabled: true };
	} else {
		config.semanticSearch.enabled = true;
	}

	// Prompt for model selection if not configured
	if (!config.semanticSearch.model) {
		console.log();
		const response = await prompts({
			type: "select",
			name: "model",
			message: "Select embedding model",
			choices: EMBEDDING_MODELS.map((m) => ({
				title: m.title,
				value: m.value,
				description: m.description,
			})),
			initial: 0, // gte-small
		});

		if (!response.model) {
			console.log(chalk.yellow("Model selection cancelled"));
			process.exit(0);
		}

		config.semanticSearch.model = response.model as EmbeddingModel;
	}

	// Save config first
	await saveConfig(projectRoot, config);
	console.log(chalk.green(`✓ Semantic search enabled with model: ${config.semanticSearch.model}`));

	// Add search-index to .gitignore
	await addSearchIndexToGitignore(projectRoot);

	// Download model if missing
	console.log();
	console.log(chalk.cyan("Checking embedding model..."));
	try {
		const { createEmbeddingService } = await import("../search/embedding");
		const { createModelDownloadProgress } = await import("../utils/progress-bar");
		const embeddingService = createEmbeddingService({ model: config.semanticSearch.model });

		if (!embeddingService.isModelDownloaded()) {
			console.log(chalk.cyan("Downloading embedding model..."));
			const progress = createModelDownloadProgress(config.semanticSearch.model);
			try {
				await embeddingService.loadModel(progress.onProgress);
				progress.complete();
			} catch (err) {
				progress.error("Download failed");
				throw err;
			}
		} else {
			console.log(chalk.green(`✓ Model already downloaded: ${config.semanticSearch.model}`));
		}

		// Auto-run reindex
		console.log();
		console.log(chalk.cyan("Building search index..."));

		const { rebuildIndex } = await import("./search");
		await rebuildIndex(projectRoot, config.semanticSearch.model);
		console.log(chalk.green("✓ Search index built"));
	} catch (error) {
		console.log();
		console.log(chalk.yellow(`⚠️  Setup incomplete. Run "knowns search --reindex" later.`));
		if (error instanceof Error) {
			console.log(chalk.gray(`  ${error.message}`));
		}
	}
}

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

			// Handle boolean values
			if (value === "true") {
				parsedValue = true;
			} else if (value === "false") {
				parsedValue = false;
			}

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
			} else if (key === "semanticSearch.model") {
				const validModels = EMBEDDING_MODELS.map((m) => m.value);
				if (!validModels.includes(value as EmbeddingModel)) {
					console.error(chalk.red(`✗ Invalid model: ${value}. Must be one of: ${validModels.join(", ")}`));
					process.exit(1);
				}
			}

			// Special handling for enabling semantic search
			if (key === "semanticSearch.enabled" && parsedValue === true) {
				await enableSemanticSearch(projectRoot, config);
				return;
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
