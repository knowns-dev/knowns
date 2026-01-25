/**
 * Import Service
 *
 * Main service for importing and syncing templates/docs from external sources.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { glob } from "tinyglobby";
import {
	getImportConfig,
	getImportDir,
	getImportsDir,
	importExists,
	readMetadata,
	removeImportConfig,
	saveImportConfig,
	writeMetadata,
} from "./config";
import type {
	FileChange,
	ImportConfig,
	ImportMetadata,
	ImportOptions,
	ImportResult,
	ImportType,
	SyncOptions,
} from "./models";
import { ImportError, ImportErrorCode } from "./models";
import { getProvider, localProvider } from "./providers";
import { detectImportType, generateImportName, validateImportName } from "./validator";

const KNOWNS_DIR = ".knowns";

/**
 * Calculate file hash for conflict detection
 */
async function hashFile(filePath: string): Promise<string> {
	const content = await readFile(filePath);
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * List all files in a directory recursively
 */
async function listFiles(dir: string, patterns?: string[]): Promise<string[]> {
	if (!existsSync(dir)) {
		return [];
	}

	const globPatterns = patterns || ["**/*"];

	const files = await glob(globPatterns, {
		cwd: dir,
		onlyFiles: true,
		dot: true,
		ignore: [".git/**", ".import.json"],
	});

	return files.sort();
}

/**
 * Copy files with change tracking
 */
async function copyFiles(
	sourceDir: string,
	targetDir: string,
	files: string[],
	existingHashes?: Record<string, string>,
	force = false,
): Promise<{ changes: FileChange[]; hashes: Record<string, string> }> {
	const changes: FileChange[] = [];
	const hashes: Record<string, string> = {};

	await mkdir(targetDir, { recursive: true });

	for (const file of files) {
		const sourcePath = join(sourceDir, file);
		const targetPath = join(targetDir, file);

		// Skip if source doesn't exist
		if (!existsSync(sourcePath)) {
			continue;
		}

		// Get source hash
		const sourceHash = await hashFile(sourcePath);
		hashes[file] = sourceHash;

		// Check if target exists
		if (existsSync(targetPath)) {
			const targetHash = await hashFile(targetPath);

			// Check if file was modified locally
			if (existingHashes?.[file] && existingHashes[file] !== targetHash) {
				if (!force) {
					changes.push({
						path: file,
						action: "skip",
						skipReason: "Local modifications detected",
					});
					hashes[file] = targetHash; // Keep current hash
					continue;
				}
			}

			// Check if content changed
			if (sourceHash === targetHash) {
				changes.push({
					path: file,
					action: "skip",
					skipReason: "No changes",
				});
				continue;
			}

			// Update file
			await mkdir(join(targetDir, file, ".."), { recursive: true });
			await cp(sourcePath, targetPath, { force: true });
			changes.push({ path: file, action: "update" });
		} else {
			// Add new file
			await mkdir(join(targetDir, file, ".."), { recursive: true });
			await cp(sourcePath, targetPath);
			changes.push({ path: file, action: "add" });
		}
	}

	return { changes, hashes };
}

/**
 * Import from an external source
 */
export async function importSource(
	projectRoot: string,
	source: string,
	options: ImportOptions = {},
): Promise<ImportResult> {
	// Detect type
	const type = options.type || detectImportType(source);
	if (!type) {
		throw new ImportError(
			`Cannot detect import type for: ${source}`,
			ImportErrorCode.INVALID_SOURCE,
			"Specify --type git|npm|local",
		);
	}

	// Generate or validate name
	const name = options.name || generateImportName(source, type);
	const nameValidation = validateImportName(name);
	if (!nameValidation.valid) {
		throw new ImportError(nameValidation.error || "Invalid name", ImportErrorCode.NAME_CONFLICT);
	}

	// Check for name conflict
	if (!options.force && (await importExists(projectRoot, name))) {
		throw new ImportError(
			`Import "${name}" already exists`,
			ImportErrorCode.NAME_CONFLICT,
			"Use --force to overwrite or --name to specify a different name",
		);
	}

	// Get provider
	const provider = getProvider(type);

	// Validate source
	const validation = await provider.validate(source, {
		ref: options.ref,
		include: options.include,
		exclude: options.exclude,
	});

	if (!validation.valid) {
		throw new ImportError(validation.error || "Invalid source", ImportErrorCode.INVALID_SOURCE, validation.hint);
	}

	// Handle symlink for local imports
	if (type === "local" && options.link) {
		return importLocalLink(projectRoot, source, name, options);
	}

	// Fetch to temp directory
	const tempDir = await provider.fetch(source, {
		ref: options.ref,
		include: options.include,
		exclude: options.exclude,
	});

	try {
		// Get .knowns path in temp
		const sourceKnowns = join(tempDir, KNOWNS_DIR);
		const targetDir = getImportDir(projectRoot, name);

		// Determine which directories to copy
		const dirsToImport: string[] = [];
		if (existsSync(join(sourceKnowns, "templates"))) {
			dirsToImport.push("templates");
		}
		if (existsSync(join(sourceKnowns, "docs"))) {
			dirsToImport.push("docs");
		}

		if (dirsToImport.length === 0) {
			throw new ImportError("Source .knowns/ contains no templates or docs", ImportErrorCode.EMPTY_IMPORT);
		}

		// Dry run - just list files
		if (options.dryRun) {
			const allFiles: string[] = [];
			for (const dir of dirsToImport) {
				const files = await listFiles(join(sourceKnowns, dir), options.include);
				allFiles.push(...files.map((f) => `${dir}/${f}`));
			}

			await provider.cleanup(tempDir);

			return {
				success: true,
				name,
				source,
				type,
				changes: allFiles.map((f) => ({ path: f, action: "add" })),
			};
		}

		// Copy files
		const allChanges: FileChange[] = [];
		const allHashes: Record<string, string> = {};

		// Get existing metadata for conflict detection
		const existingMetadata = await readMetadata(projectRoot, name);

		for (const dir of dirsToImport) {
			const sourceSubDir = join(sourceKnowns, dir);
			const targetSubDir = join(targetDir, dir);

			const files = await listFiles(sourceSubDir, options.include);
			const { changes, hashes } = await copyFiles(
				sourceSubDir,
				targetSubDir,
				files,
				existingMetadata?.fileHashes,
				options.force,
			);

			for (const change of changes) {
				allChanges.push({ ...change, path: `${dir}/${change.path}` });
			}
			for (const [file, hash] of Object.entries(hashes)) {
				allHashes[`${dir}/${file}`] = hash;
			}
		}

		// Get provider metadata (commit hash, version, etc.)
		const providerMeta = await provider.getMetadata(tempDir, {
			ref: options.ref,
		});

		// Write metadata
		const metadata: ImportMetadata = {
			name,
			source,
			type,
			importedAt: existingMetadata?.importedAt || new Date().toISOString(),
			lastSync: new Date().toISOString(),
			ref: options.ref || providerMeta.ref,
			commit: providerMeta.commit,
			version: providerMeta.version,
			files: allChanges.filter((c) => c.action !== "skip" || c.skipReason === "No changes").map((c) => c.path),
			fileHashes: allHashes,
		};

		await writeMetadata(projectRoot, name, metadata);

		// Save config
		if (!options.noSave) {
			const config: ImportConfig = {
				name,
				source,
				type,
				ref: options.ref,
				include: options.include,
				exclude: options.exclude,
				autoSync: false,
			};
			await saveImportConfig(projectRoot, config);
		}

		// Cleanup
		await provider.cleanup(tempDir);

		return {
			success: true,
			name,
			source,
			type,
			changes: allChanges,
			metadata,
		};
	} catch (error) {
		await provider.cleanup(tempDir);
		throw error;
	}
}

/**
 * Import local source as symlink
 */
async function importLocalLink(
	projectRoot: string,
	source: string,
	name: string,
	options: ImportOptions,
): Promise<ImportResult> {
	const targetDir = getImportDir(projectRoot, name);

	// Dry run
	if (options.dryRun) {
		return {
			success: true,
			name,
			source,
			type: "local",
			changes: [{ path: ".", action: "add" }],
		};
	}

	// Create symlink
	await localProvider.createSymlink(source, targetDir);

	// Write minimal metadata
	const metadata: ImportMetadata = {
		name,
		source,
		type: "local",
		importedAt: new Date().toISOString(),
		lastSync: new Date().toISOString(),
		files: ["(symlinked)"],
	};

	// Note: We can't write metadata inside symlinked dir
	// Store it in a separate location
	const metaPath = join(getImportsDir(projectRoot), `${name}.import.json`);
	await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`);

	// Save config
	if (!options.noSave) {
		const config: ImportConfig = {
			name,
			source,
			type: "local",
			link: true,
		};
		await saveImportConfig(projectRoot, config);
	}

	return {
		success: true,
		name,
		source,
		type: "local",
		changes: [{ path: ".", action: "add" }],
		metadata,
	};
}

/**
 * Sync an existing import
 */
export async function syncImport(projectRoot: string, name: string, options: SyncOptions = {}): Promise<ImportResult> {
	// Get config
	const config = await getImportConfig(projectRoot, name);
	if (!config) {
		throw new ImportError(`Import "${name}" not found`, ImportErrorCode.SOURCE_NOT_FOUND);
	}

	// Symlinked imports don't need syncing
	if (config.link) {
		return {
			success: true,
			name,
			source: config.source,
			type: config.type,
			changes: [],
		};
	}

	// Re-import with existing config
	return importSource(projectRoot, config.source, {
		name: config.name,
		type: config.type,
		ref: config.ref,
		include: config.include,
		exclude: config.exclude,
		force: options.force,
		dryRun: options.dryRun,
		noSave: true, // Don't update config on sync
	});
}

/**
 * Sync all imports
 */
export async function syncAllImports(projectRoot: string, options: SyncOptions = {}): Promise<ImportResult[]> {
	const { getImportConfigs } = await import("./config");
	const configs = await getImportConfigs(projectRoot);

	const results: ImportResult[] = [];

	for (const config of configs) {
		if (config.autoSync === false && !options.force) {
			continue;
		}

		try {
			const result = await syncImport(projectRoot, config.name, options);
			results.push(result);
		} catch (error) {
			results.push({
				success: false,
				name: config.name,
				source: config.source,
				type: config.type,
				changes: [],
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return results;
}

/**
 * Remove an import
 */
export async function removeImport(
	projectRoot: string,
	name: string,
	deleteFiles = false,
): Promise<{ success: boolean; deleted: boolean }> {
	// Check if exists
	const config = await getImportConfig(projectRoot, name);
	if (!config) {
		throw new ImportError(`Import "${name}" not found`, ImportErrorCode.SOURCE_NOT_FOUND);
	}

	// Remove config
	await removeImportConfig(projectRoot, name);

	// Delete files if requested
	if (deleteFiles) {
		const importDir = getImportDir(projectRoot, name);
		if (existsSync(importDir)) {
			await rm(importDir, { recursive: true, force: true });
		}

		// Also remove metadata file for symlinked imports
		const metaPath = join(getImportsDir(projectRoot), `${name}.import.json`);
		if (existsSync(metaPath)) {
			await rm(metaPath);
		}
	}

	return { success: true, deleted: deleteFiles };
}
