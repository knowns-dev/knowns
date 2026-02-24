/**
 * Embedding Service
 * Generate vector embeddings using Transformers.js
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Chunk, EmbeddingConfig, EmbeddingModel, EmbeddingResult, ModelConfig } from "./types";
import { EMBEDDING_MODELS } from "./types";

/**
 * Custom model info structure (matches model command)
 */
interface CustomModelInfo {
	id: string;
	huggingFaceId: string;
	dimensions: number;
	maxTokens: number;
	custom?: boolean;
}

/**
 * Load custom models from global config
 */
async function loadCustomModels(): Promise<CustomModelInfo[]> {
	const configPath = join(homedir(), ".knowns", "custom-models.json");
	if (!existsSync(configPath)) return [];

	try {
		const content = await readFile(configPath, "utf-8");
		return JSON.parse(content);
	} catch {
		return [];
	}
}

/**
 * Get model config from various sources
 * Priority: EMBEDDING_MODELS > custom-models.json > provided config
 */
async function resolveModelConfig(modelId: string, providedConfig?: Partial<ModelConfig>): Promise<ModelConfig | null> {
	// 1. Check built-in models first
	if (EMBEDDING_MODELS[modelId]) {
		return EMBEDDING_MODELS[modelId];
	}

	// 2. Check custom models
	const customModels = await loadCustomModels();
	const customModel = customModels.find((m) => m.id === modelId || m.huggingFaceId === modelId);
	if (customModel) {
		return {
			name: customModel.id,
			dimensions: customModel.dimensions,
			maxTokens: customModel.maxTokens,
			huggingFaceId: customModel.huggingFaceId,
		};
	}

	// 3. Use provided config if available (from project config)
	if (providedConfig?.huggingFaceId) {
		return {
			name: modelId,
			dimensions: providedConfig.dimensions || 384,
			maxTokens: providedConfig.maxTokens || 512,
			huggingFaceId: providedConfig.huggingFaceId,
		};
	}

	return null;
}

// Dynamic import for transformers.js (ESM module)
type Pipeline = Awaited<ReturnType<typeof import("@xenova/transformers")["pipeline"]>>;

/**
 * Model status information
 */
export interface ModelStatus {
	model: EmbeddingModel;
	downloaded: boolean;
	valid: boolean;
	path: string;
	sizeBytes?: number;
	fileCount?: number;
	error?: string;
}

/**
 * Expected model files for validation
 * Note: transformers.js downloads quantized models by default
 */
const EXPECTED_MODEL_FILES = ["config.json", "tokenizer.json"];
const EXPECTED_ONNX_FILES = ["onnx/model.onnx", "onnx/model_quantized.onnx"];

/**
 * Extended embedding config that includes custom model fields
 */
export interface ExtendedEmbeddingConfig extends Partial<EmbeddingConfig> {
	huggingFaceId?: string;
	dimensions?: number;
	maxTokens?: number;
}

/**
 * Embedding Service
 * Handles model loading and embedding generation
 */
export class EmbeddingService {
	private pipeline: Pipeline | null = null;
	private model: EmbeddingModel;
	private modelPath: string;
	private isLoading = false;
	private loadError: Error | null = null;
	private resolvedConfig: ModelConfig | null = null;
	private providedConfig?: ExtendedEmbeddingConfig;

	constructor(config?: ExtendedEmbeddingConfig) {
		this.model = config?.model || "gte-small";
		this.providedConfig = config;
		this.modelPath = config?.modelPath || this.getDefaultModelPathSync();
	}

	/**
	 * Get default model path in user's home directory (sync version for constructor)
	 * Uses HuggingFace ID to match transformers.js cache structure
	 */
	private getDefaultModelPathSync(): string {
		// First check built-in models
		const builtInConfig = EMBEDDING_MODELS[this.model];
		if (builtInConfig) {
			return join(homedir(), ".knowns", "models", builtInConfig.huggingFaceId);
		}

		// Check if huggingFaceId was provided in config
		if (this.providedConfig?.huggingFaceId) {
			return join(homedir(), ".knowns", "models", this.providedConfig.huggingFaceId);
		}

		// Fallback: assume model ID is the HuggingFace ID
		return join(homedir(), ".knowns", "models", this.model);
	}

	/**
	 * Resolve model path asynchronously (checks custom models)
	 */
	private async resolveModelPath(): Promise<string> {
		const config = await this.getModelConfigResolved();
		if (config) {
			return join(homedir(), ".knowns", "models", config.huggingFaceId);
		}
		return this.modelPath;
	}

	/**
	 * Get global models directory
	 */
	static getModelsDir(): string {
		return join(homedir(), ".knowns", "models");
	}

	/**
	 * Check if model is downloaded
	 */
	isModelDownloaded(): boolean {
		return existsSync(this.modelPath);
	}

	/**
	 * Get model configuration (sync - for built-in models only)
	 * @deprecated Use getModelConfigResolved() for full support
	 */
	getModelConfig(): ModelConfig | undefined {
		return EMBEDDING_MODELS[this.model];
	}

	/**
	 * Get model configuration with full resolution (async)
	 * Resolves from: built-in models > custom models > provided config
	 */
	async getModelConfigResolved(): Promise<ModelConfig | null> {
		if (this.resolvedConfig) {
			return this.resolvedConfig;
		}

		this.resolvedConfig = await resolveModelConfig(this.model, {
			huggingFaceId: this.providedConfig?.huggingFaceId,
			dimensions: this.providedConfig?.dimensions,
			maxTokens: this.providedConfig?.maxTokens,
		});

		// Update model path if we resolved the config
		if (this.resolvedConfig && !this.providedConfig?.modelPath) {
			this.modelPath = join(homedir(), ".knowns", "models", this.resolvedConfig.huggingFaceId);
		}

		return this.resolvedConfig;
	}

	/**
	 * Check if we're offline (can't reach HuggingFace)
	 */
	async isOffline(): Promise<boolean> {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 3000);

			const response = await fetch("https://huggingface.co/api/models", {
				method: "HEAD",
				signal: controller.signal,
			});

			clearTimeout(timeoutId);
			return !response.ok;
		} catch {
			return true;
		}
	}

	/**
	 * Validate model files exist and are complete
	 */
	async validateModel(): Promise<{ valid: boolean; missing: string[]; error?: string }> {
		if (!this.isModelDownloaded()) {
			return { valid: false, missing: ["(model not downloaded)"], error: "Model directory not found" };
		}

		const missing: string[] = [];

		try {
			// Check for expected files
			for (const expectedFile of EXPECTED_MODEL_FILES) {
				const filePath = join(this.modelPath, expectedFile);
				if (!existsSync(filePath)) {
					missing.push(expectedFile);
				}
			}

			// Check for ONNX model file (at least one must exist)
			const hasOnnxFile = EXPECTED_ONNX_FILES.some((onnxFile) => existsSync(join(this.modelPath, onnxFile)));
			if (!hasOnnxFile) {
				missing.push("onnx/model.onnx or onnx/model_quantized.onnx");
			}

			// If config.json exists, try to parse it
			const configPath = join(this.modelPath, "config.json");
			if (existsSync(configPath)) {
				try {
					const { readFile } = await import("node:fs/promises");
					const content = await readFile(configPath, "utf-8");
					JSON.parse(content);
				} catch {
					return { valid: false, missing, error: "Invalid config.json" };
				}
			}

			return { valid: missing.length === 0, missing };
		} catch (error) {
			return {
				valid: false,
				missing,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Get detailed model status
	 */
	async getModelStatus(): Promise<ModelStatus> {
		const status: ModelStatus = {
			model: this.model,
			downloaded: this.isModelDownloaded(),
			valid: false,
			path: this.modelPath,
		};

		if (!status.downloaded) {
			return status;
		}

		// Validate model files
		const validation = await this.validateModel();
		status.valid = validation.valid;
		if (validation.error) {
			status.error = validation.error;
		}

		// Get directory stats
		try {
			const files = await this.getModelFiles();
			status.fileCount = files.length;
			status.sizeBytes = await this.getModelSize();
		} catch {
			// Ignore stat errors
		}

		return status;
	}

	/**
	 * Get list of model files
	 */
	private async getModelFiles(): Promise<string[]> {
		if (!existsSync(this.modelPath)) return [];

		const files: string[] = [];
		const entries = await readdir(this.modelPath, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.isFile()) {
				files.push(entry.name);
			} else if (entry.isDirectory()) {
				// Check subdirectories (e.g., onnx/)
				const subPath = join(this.modelPath, entry.name);
				const subEntries = await readdir(subPath, { withFileTypes: true });
				for (const subEntry of subEntries) {
					if (subEntry.isFile()) {
						files.push(join(entry.name, subEntry.name));
					}
				}
			}
		}

		return files;
	}

	/**
	 * Get total model size in bytes
	 */
	private async getModelSize(): Promise<number> {
		const files = await this.getModelFiles();
		let totalSize = 0;

		for (const file of files) {
			const filePath = join(this.modelPath, file);
			const stats = await stat(filePath);
			totalSize += stats.size;
		}

		return totalSize;
	}

	/**
	 * Load the embedding model
	 * Downloads if not present locally
	 * Handles offline mode gracefully
	 */
	async loadModel(onProgress?: (progress: number) => void): Promise<void> {
		if (this.pipeline) return;
		if (this.isLoading) {
			// Wait for existing load to complete
			while (this.isLoading) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (this.loadError) throw this.loadError;
			return;
		}

		this.isLoading = true;
		this.loadError = null;

		try {
			// Ensure models directory exists
			const modelsDir = EmbeddingService.getModelsDir();
			if (!existsSync(modelsDir)) {
				await mkdir(modelsDir, { recursive: true });
			}

			const modelExists = this.isModelDownloaded();

			// Check offline status if model needs to be downloaded
			if (!modelExists) {
				const offline = await this.isOffline();
				if (offline) {
					throw new Error(
						`Cannot download model "${this.model}": No internet connection. Please connect to the internet and try again, or use a pre-downloaded model.`,
					);
				}
			}

			// Resolve model config first
			const modelConfig = await this.getModelConfigResolved();
			if (!modelConfig) {
				throw new Error(`Unknown model "${this.model}". Use 'knowns model add <huggingface-id>' to add custom models.`);
			}

			// Update model path after resolution
			this.modelPath = join(homedir(), ".knowns", "models", modelConfig.huggingFaceId);

			// Dynamic import of transformers.js
			const { pipeline, env } = await import("@xenova/transformers");

			// Configure transformers.js to use local cache
			env.cacheDir = modelsDir;
			env.localModelPath = this.modelPath;

			// Re-check if model exists after path resolution
			const modelExistsNow = existsSync(this.modelPath);

			// If model exists locally, disable remote loading (work offline)
			if (modelExistsNow) {
				env.allowRemoteModels = false;
			}

			// Create pipeline with progress callback
			this.pipeline = await pipeline("feature-extraction", modelConfig.huggingFaceId, {
				progress_callback: (data: { progress?: number }) => {
					if (onProgress && typeof data.progress === "number") {
						onProgress(data.progress);
					}
				},
			});

			// Validate model after loading (especially after download)
			if (!modelExists) {
				const validation = await this.validateModel();
				if (!validation.valid) {
					throw new Error(
						`Model validation failed: ${validation.error || `Missing files: ${validation.missing.join(", ")}`}`,
					);
				}
			}
		} catch (error) {
			this.loadError = error instanceof Error ? error : new Error(String(error));
			throw this.loadError;
		} finally {
			this.isLoading = false;
		}
	}

	/**
	 * Generate embedding for text
	 */
	async embed(text: string): Promise<EmbeddingResult> {
		if (!this.pipeline) {
			await this.loadModel();
		}

		if (!this.pipeline) {
			throw new Error("Failed to load embedding model");
		}

		// Truncate text if too long
		const modelConfig = await this.getModelConfigResolved();
		if (!modelConfig) {
			throw new Error(`Unknown model "${this.model}"`);
		}
		const truncatedText = this.truncateToTokens(text, modelConfig.maxTokens);

		// Generate embedding
		const output = await this.pipeline(truncatedText, {
			pooling: "mean",
			normalize: true,
		});

		// Convert to array
		const embedding = Array.from(output.data as Float32Array);

		return {
			embedding,
			tokenCount: this.estimateTokens(truncatedText),
		};
	}

	/**
	 * Generate embeddings for multiple texts (batch)
	 */
	async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
		const results: EmbeddingResult[] = [];

		for (const text of texts) {
			results.push(await this.embed(text));
		}

		return results;
	}

	/**
	 * Embed chunks and attach embeddings to them
	 */
	async embedChunks(chunks: Chunk[]): Promise<Chunk[]> {
		const embeddedChunks: Chunk[] = [];

		for (const chunk of chunks) {
			const result = await this.embed(chunk.content);
			embeddedChunks.push({
				...chunk,
				embedding: result.embedding,
				tokenCount: result.tokenCount,
			});
		}

		return embeddedChunks;
	}

	/**
	 * Estimate token count for text
	 * Rough estimate: ~4 characters per token
	 */
	private estimateTokens(text: string): number {
		if (!text) return 0;
		return Math.ceil(text.length / 4);
	}

	/**
	 * Truncate text to fit within token limit
	 */
	private truncateToTokens(text: string, maxTokens: number): string {
		const estimatedTokens = this.estimateTokens(text);
		if (estimatedTokens <= maxTokens) {
			return text;
		}

		// Truncate by characters (4 chars per token estimate)
		const maxChars = maxTokens * 4;
		return text.slice(0, maxChars);
	}

	/**
	 * Calculate cosine similarity between two vectors
	 */
	static cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length) {
			throw new Error("Vectors must have same length");
		}

		let dotProduct = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < a.length; i++) {
			dotProduct += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
		if (magnitude === 0) return 0;

		return dotProduct / magnitude;
	}

	/**
	 * Dispose of the model to free memory
	 */
	dispose(): void {
		this.pipeline = null;
	}
}

/**
 * Create embedding service with config
 */
export function createEmbeddingService(config?: ExtendedEmbeddingConfig): EmbeddingService {
	return new EmbeddingService(config);
}
