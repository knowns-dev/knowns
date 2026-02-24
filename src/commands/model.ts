/**
 * Model Command
 * Manage embedding models for semantic search
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { findProjectRoot } from "@utils/find-project-root";
import { ProgressBar, formatBytes } from "@utils/progress-bar";
import chalk from "chalk";
import { Command } from "commander";

/**
 * Model info structure
 */
interface ModelInfo {
	id: string;
	huggingFaceId: string;
	name: string;
	description: string;
	dimensions: number;
	maxTokens: number;
	sizeEstimate: string;
	quality: "fast" | "balanced" | "quality";
	recommended?: boolean;
	custom?: boolean;
}

/**
 * Recommended models curated list
 */
const RECOMMENDED_MODELS: ModelInfo[] = [
	{
		id: "gte-small",
		huggingFaceId: "Xenova/gte-small",
		name: "GTE Small",
		description: "Fast, good quality. Best for most projects.",
		dimensions: 384,
		maxTokens: 512,
		sizeEstimate: "~50MB",
		quality: "balanced",
		recommended: true,
	},
	{
		id: "all-MiniLM-L6-v2",
		huggingFaceId: "Xenova/all-MiniLM-L6-v2",
		name: "MiniLM L6",
		description: "Fastest, lightweight. Good for large codebases.",
		dimensions: 384,
		maxTokens: 256,
		sizeEstimate: "~45MB",
		quality: "fast",
	},
	{
		id: "gte-base",
		huggingFaceId: "Xenova/gte-base",
		name: "GTE Base",
		description: "Higher quality, slower. Best for accuracy.",
		dimensions: 768,
		maxTokens: 512,
		sizeEstimate: "~110MB",
		quality: "quality",
	},
	{
		id: "bge-small-en-v1.5",
		huggingFaceId: "Xenova/bge-small-en-v1.5",
		name: "BGE Small EN",
		description: "Excellent English model. Great balance.",
		dimensions: 384,
		maxTokens: 512,
		sizeEstimate: "~50MB",
		quality: "balanced",
	},
	{
		id: "bge-base-en-v1.5",
		huggingFaceId: "Xenova/bge-base-en-v1.5",
		name: "BGE Base EN",
		description: "High quality English embeddings.",
		dimensions: 768,
		maxTokens: 512,
		sizeEstimate: "~110MB",
		quality: "quality",
	},
	{
		id: "e5-small-v2",
		huggingFaceId: "Xenova/e5-small-v2",
		name: "E5 Small",
		description: "Microsoft E5 model. Fast and accurate.",
		dimensions: 384,
		maxTokens: 512,
		sizeEstimate: "~50MB",
		quality: "balanced",
	},
];

/**
 * Custom models config file path
 */
function getCustomModelsPath(): string {
	return join(homedir(), ".knowns", "custom-models.json");
}

/**
 * Models directory
 */
function getModelsDir(): string {
	return join(homedir(), ".knowns", "models");
}

/**
 * Load custom models from config
 */
async function loadCustomModels(): Promise<ModelInfo[]> {
	const configPath = getCustomModelsPath();
	if (!existsSync(configPath)) return [];

	try {
		const content = await readFile(configPath, "utf-8");
		return JSON.parse(content);
	} catch {
		return [];
	}
}

/**
 * Save custom models to config
 */
async function saveCustomModels(models: ModelInfo[]): Promise<void> {
	const configPath = getCustomModelsPath();
	const dir = join(homedir(), ".knowns");
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}
	await writeFile(configPath, JSON.stringify(models, null, 2));
}

/**
 * Get all available models (recommended + custom)
 */
async function getAllModels(): Promise<ModelInfo[]> {
	const customModels = await loadCustomModels();
	return [...RECOMMENDED_MODELS, ...customModels];
}

/**
 * Find model by ID or HuggingFace ID
 */
async function findModel(idOrHfId: string): Promise<ModelInfo | undefined> {
	const allModels = await getAllModels();
	return allModels.find(
		(m) => m.id === idOrHfId || m.huggingFaceId === idOrHfId || m.huggingFaceId.endsWith(`/${idOrHfId}`),
	);
}

/**
 * Check if model is downloaded
 */
function isModelDownloaded(model: ModelInfo): boolean {
	const modelPath = join(getModelsDir(), model.huggingFaceId);
	return existsSync(modelPath);
}

/**
 * Get downloaded model size
 */
async function getModelSize(model: ModelInfo): Promise<number> {
	const modelPath = join(getModelsDir(), model.huggingFaceId);
	if (!existsSync(modelPath)) return 0;

	let totalSize = 0;
	const entries = await readdir(modelPath, { withFileTypes: true });

	for (const entry of entries) {
		const entryPath = join(modelPath, entry.name);
		if (entry.isFile()) {
			const stats = await stat(entryPath);
			totalSize += stats.size;
		} else if (entry.isDirectory()) {
			const subEntries = await readdir(entryPath, { withFileTypes: true });
			for (const subEntry of subEntries) {
				if (subEntry.isFile()) {
					const stats = await stat(join(entryPath, subEntry.name));
					totalSize += stats.size;
				}
			}
		}
	}

	return totalSize;
}

/**
 * Quality badge
 */
function getQualityBadge(quality: string): string {
	switch (quality) {
		case "fast":
			return chalk.cyan("⚡ Fast");
		case "balanced":
			return chalk.green("⚖️  Balanced");
		case "quality":
			return chalk.magenta("✨ Quality");
		default:
			return "";
	}
}

/**
 * List command - show available models
 */
async function listModels(): Promise<void> {
	const allModels = await getAllModels();

	console.log(chalk.bold("\n📦 Available Embedding Models\n"));

	// Group by quality
	const groups = {
		fast: allModels.filter((m) => m.quality === "fast"),
		balanced: allModels.filter((m) => m.quality === "balanced"),
		quality: allModels.filter((m) => m.quality === "quality"),
	};

	for (const [quality, models] of Object.entries(groups)) {
		if (models.length === 0) continue;

		console.log(chalk.gray(`─── ${getQualityBadge(quality)} ───`));
		console.log();

		for (const model of models) {
			const downloaded = isModelDownloaded(model);
			const size = downloaded ? formatBytes(await getModelSize(model)) : model.sizeEstimate;

			const status = downloaded ? chalk.green("✓ Downloaded") : chalk.gray("Not downloaded");

			const recommended = model.recommended ? chalk.yellow(" ★ Recommended") : "";
			const custom = model.custom ? chalk.blue(" [Custom]") : "";

			console.log(`  ${chalk.bold(model.id)}${recommended}${custom}`);
			console.log(`    ${chalk.gray(model.description)}`);
			console.log(`    ${chalk.gray(`HuggingFace: ${model.huggingFaceId}`)}`);
			console.log(`    ${chalk.gray(`Dimensions: ${model.dimensions} | Tokens: ${model.maxTokens} | Size: ${size}`)}`);
			console.log(`    ${status}`);
			console.log();
		}
	}

	console.log(chalk.gray("Usage:"));
	console.log(chalk.gray("  knowns model download <model-id>   Download a model"));
	console.log(chalk.gray("  knowns model set <model-id>        Set model for current project"));
	console.log(chalk.gray("  knowns model add <hf-id>           Add custom HuggingFace model"));
	console.log();
}

/**
 * Download command - download a model
 */
async function downloadModel(modelId: string): Promise<void> {
	const model = await findModel(modelId);

	if (!model) {
		console.log(chalk.red(`✗ Model not found: ${modelId}`));
		console.log(chalk.gray("  Use 'knowns model list' to see available models"));
		console.log(chalk.gray("  Or 'knowns model add <hf-id>' to add a custom model"));
		return;
	}

	if (isModelDownloaded(model)) {
		const size = formatBytes(await getModelSize(model));
		console.log(chalk.green(`✓ Model already downloaded: ${model.id} (${size})`));
		return;
	}

	console.log(chalk.cyan(`\nDownloading ${model.name}...`));
	console.log(chalk.gray(`  HuggingFace: ${model.huggingFaceId}`));
	console.log(chalk.gray(`  Estimated size: ${model.sizeEstimate}`));
	console.log();

	const progressBar = new ProgressBar({
		width: 30,
		prefix: chalk.cyan("  "),
		showEta: true,
	});

	try {
		// Dynamic import transformers.js
		const { pipeline, env } = await import("@xenova/transformers");

		// Configure cache directory
		env.cacheDir = getModelsDir();

		// Download by creating a pipeline (this triggers download)
		await pipeline("feature-extraction", model.huggingFaceId, {
			progress_callback: (data: { progress?: number; status?: string }) => {
				if (typeof data.progress === "number" && data.progress > 0 && data.progress < 100) {
					progressBar.update(data.progress);
				}
			},
		});

		const size = formatBytes(await getModelSize(model));
		progressBar.complete(`Downloaded: ${model.id} (${size})`);
	} catch (error) {
		progressBar.error("Download failed");
		if (error instanceof Error) {
			console.log(chalk.red(`  ${error.message}`));
		}
	}
}

/**
 * Set command - set model for current project
 */
async function setModel(modelId: string): Promise<void> {
	const projectRoot = findProjectRoot();
	if (!projectRoot) {
		console.log(chalk.red("✗ Not in a Knowns project. Run 'knowns init' first."));
		return;
	}

	const model = await findModel(modelId);
	if (!model) {
		console.log(chalk.red(`✗ Model not found: ${modelId}`));
		console.log(chalk.gray("  Use 'knowns model list' to see available models"));
		return;
	}

	// Check if downloaded
	if (!isModelDownloaded(model)) {
		console.log(chalk.yellow("⚠ Model not downloaded. Downloading first..."));
		await downloadModel(modelId);

		if (!isModelDownloaded(model)) {
			console.log(chalk.red("✗ Failed to download model"));
			return;
		}
	}

	// Update project config
	const configPath = join(projectRoot, ".knowns", "config.json");
	if (!existsSync(configPath)) {
		console.log(chalk.red("✗ Project config not found"));
		return;
	}

	try {
		const config = JSON.parse(await readFile(configPath, "utf-8"));

		// Update semantic search config
		config.semanticSearch = config.semanticSearch || { enabled: true };
		config.semanticSearch.model = model.id;
		config.semanticSearch.huggingFaceId = model.huggingFaceId;
		config.semanticSearch.dimensions = model.dimensions;
		config.semanticSearch.maxTokens = model.maxTokens;

		await writeFile(configPath, JSON.stringify(config, null, "\t"));

		console.log(chalk.green(`✓ Model set to: ${model.id}`));
		console.log(chalk.yellow("\n⚠ Run 'knowns search --reindex' to rebuild the search index"));
	} catch (error) {
		console.log(chalk.red("✗ Failed to update config"));
		if (error instanceof Error) {
			console.log(chalk.red(`  ${error.message}`));
		}
	}
}

/**
 * Status command - show current model status
 */
async function showStatus(): Promise<void> {
	const projectRoot = findProjectRoot();

	console.log(chalk.bold("\n📊 Model Status\n"));

	// Global models
	const modelsDir = getModelsDir();
	const allModels = await getAllModels();
	const downloadedModels = allModels.filter((m) => isModelDownloaded(m));

	console.log(chalk.gray("Global Models:"));
	console.log(`  Location: ${chalk.cyan(modelsDir)}`);
	console.log(`  Downloaded: ${chalk.green(downloadedModels.length)} / ${allModels.length}`);

	let totalSize = 0;
	for (const model of downloadedModels) {
		totalSize += await getModelSize(model);
	}
	console.log(`  Total size: ${chalk.cyan(formatBytes(totalSize))}`);
	console.log();

	if (downloadedModels.length > 0) {
		console.log(chalk.gray("Downloaded models:"));
		for (const model of downloadedModels) {
			const size = formatBytes(await getModelSize(model));
			console.log(`  ${chalk.green("✓")} ${model.id} (${size})`);
		}
		console.log();
	}

	// Project model
	if (projectRoot) {
		const configPath = join(projectRoot, ".knowns", "config.json");
		if (existsSync(configPath)) {
			try {
				const config = JSON.parse(await readFile(configPath, "utf-8"));
				const currentModel = config.semanticSearch?.model || "gte-small";
				const model = await findModel(currentModel);

				console.log(chalk.gray("Current Project:"));
				console.log(`  Path: ${chalk.cyan(projectRoot)}`);
				console.log(`  Model: ${chalk.green(currentModel)}`);
				if (model) {
					console.log(`  Dimensions: ${model.dimensions}`);
					console.log(`  Max Tokens: ${model.maxTokens}`);
				}
				console.log();
			} catch {
				// Ignore config read errors
			}
		}
	} else {
		console.log(chalk.gray("Not in a Knowns project"));
		console.log();
	}
}

/**
 * Add command - add custom HuggingFace model
 */
async function addCustomModel(
	huggingFaceId: string,
	options: { dims?: string; tokens?: string; name?: string },
): Promise<void> {
	// Validate HuggingFace ID format
	if (!huggingFaceId.includes("/")) {
		console.log(chalk.red("✗ Invalid HuggingFace ID format"));
		console.log(chalk.gray("  Expected format: owner/model-name (e.g., Xenova/bge-small-en-v1.5)"));
		return;
	}

	// Check if already exists
	const existing = await findModel(huggingFaceId);
	if (existing) {
		console.log(chalk.yellow(`⚠ Model already exists: ${existing.id}`));
		return;
	}

	// Extract model ID from HuggingFace ID
	const id = huggingFaceId.split("/")[1] || huggingFaceId;

	const dimensions = options.dims ? Number.parseInt(options.dims, 10) : 384;
	const maxTokens = options.tokens ? Number.parseInt(options.tokens, 10) : 512;

	const newModel: ModelInfo = {
		id,
		huggingFaceId,
		name: options.name || id,
		description: `Custom model from ${huggingFaceId}`,
		dimensions,
		maxTokens,
		sizeEstimate: "Unknown",
		quality: "balanced",
		custom: true,
	};

	// Validate by trying to fetch model info
	console.log(chalk.cyan(`\nValidating model: ${huggingFaceId}...`));

	try {
		const response = await fetch(`https://huggingface.co/api/models/${huggingFaceId}`);
		if (!response.ok) {
			console.log(chalk.red(`✗ Model not found on HuggingFace: ${huggingFaceId}`));
			return;
		}

		const data = (await response.json()) as { pipeline_tag?: string };

		// Check if it's a feature-extraction model
		if (data.pipeline_tag && data.pipeline_tag !== "feature-extraction") {
			console.log(chalk.yellow(`⚠ Model pipeline: ${data.pipeline_tag} (expected: feature-extraction)`));
			console.log(chalk.gray("  This model may not work correctly for embeddings"));
		}
	} catch {
		console.log(chalk.yellow("⚠ Could not validate model (offline or API error)"));
		console.log(chalk.gray("  The model will be added but may fail during download"));
	}

	// Save to custom models
	const customModels = await loadCustomModels();
	customModels.push(newModel);
	await saveCustomModels(customModels);

	console.log(chalk.green(`✓ Added custom model: ${id}`));
	console.log(chalk.gray(`  HuggingFace: ${huggingFaceId}`));
	console.log(chalk.gray(`  Dimensions: ${dimensions} | Tokens: ${maxTokens}`));
	console.log();
	console.log(chalk.gray("Next steps:"));
	console.log(chalk.gray(`  knowns model download ${id}   # Download the model`));
	console.log(chalk.gray(`  knowns model set ${id}        # Use in current project`));
}

/**
 * Remove command - remove a custom model
 */
async function removeModel(modelId: string, options: { force?: boolean }): Promise<void> {
	const model = await findModel(modelId);

	if (!model) {
		console.log(chalk.red(`✗ Model not found: ${modelId}`));
		return;
	}

	if (!model.custom) {
		console.log(chalk.red(`✗ Cannot remove built-in model: ${modelId}`));
		console.log(chalk.gray("  Only custom models can be removed"));
		return;
	}

	// Remove from custom models list
	const customModels = await loadCustomModels();
	const filtered = customModels.filter((m) => m.id !== modelId);
	await saveCustomModels(filtered);

	// Optionally remove downloaded files
	if (options.force) {
		const modelPath = join(getModelsDir(), model.huggingFaceId);
		if (existsSync(modelPath)) {
			await rm(modelPath, { recursive: true });
			console.log(chalk.green(`✓ Removed model and files: ${modelId}`));
		} else {
			console.log(chalk.green(`✓ Removed model: ${modelId}`));
		}
	} else {
		console.log(chalk.green(`✓ Removed model from list: ${modelId}`));
		if (isModelDownloaded(model)) {
			console.log(chalk.gray("  Downloaded files kept. Use --force to delete files."));
		}
	}
}

/**
 * Create model command
 */
export function createModelCommand(): Command {
	const cmd = new Command("model").description("Manage embedding models for semantic search");

	// List subcommand
	cmd
		.command("list")
		.alias("ls")
		.description("List available embedding models")
		.action(async () => {
			await listModels();
		});

	// Download subcommand
	cmd
		.command("download <model-id>")
		.alias("dl")
		.description("Download an embedding model")
		.action(async (modelId: string) => {
			await downloadModel(modelId);
		});

	// Set subcommand
	cmd
		.command("set <model-id>")
		.description("Set embedding model for current project")
		.action(async (modelId: string) => {
			await setModel(modelId);
		});

	// Status subcommand
	cmd
		.command("status")
		.description("Show current model status")
		.action(async () => {
			await showStatus();
		});

	// Add subcommand
	cmd
		.command("add <huggingface-id>")
		.description("Add a custom HuggingFace embedding model")
		.option("--dims <number>", "Embedding dimensions (default: 384)")
		.option("--tokens <number>", "Max tokens (default: 512)")
		.option("--name <name>", "Display name")
		.action(async (hfId: string, options: { dims?: string; tokens?: string; name?: string }) => {
			await addCustomModel(hfId, options);
		});

	// Remove subcommand
	cmd
		.command("remove <model-id>")
		.alias("rm")
		.description("Remove a custom model")
		.option("-f, --force", "Also delete downloaded model files")
		.action(async (modelId: string, options: { force?: boolean }) => {
			await removeModel(modelId, options);
		});

	// Default action (no subcommand) - show status
	cmd.action(async () => {
		await showStatus();
	});

	return cmd;
}

/**
 * Export the model command
 */
export const modelCommand = createModelCommand();
