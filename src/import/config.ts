/**
 * Import Configuration Management
 *
 * Read/write import configs from .knowns/config.json
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ImportConfig, ImportMetadata, ImportType } from "./models";

const CONFIG_FILE = "config.json";
const IMPORTS_DIR = "imports";
const METADATA_FILE = ".import.json";

/**
 * Project config structure
 */
interface ProjectConfig {
	imports?: ImportConfig[];
	[key: string]: unknown;
}

/**
 * Get path to .knowns directory
 */
export function getKnownsDir(projectRoot: string): string {
	return join(projectRoot, ".knowns");
}

/**
 * Get path to config file
 */
export function getConfigPath(projectRoot: string): string {
	return join(getKnownsDir(projectRoot), CONFIG_FILE);
}

/**
 * Get path to imports directory
 */
export function getImportsDir(projectRoot: string): string {
	return join(getKnownsDir(projectRoot), IMPORTS_DIR);
}

/**
 * Get path to a specific import directory
 */
export function getImportDir(projectRoot: string, name: string): string {
	return join(getImportsDir(projectRoot), name);
}

/**
 * Get path to import metadata file
 */
export function getMetadataPath(projectRoot: string, name: string): string {
	return join(getImportDir(projectRoot, name), METADATA_FILE);
}

/**
 * Read project config
 */
export async function readConfig(projectRoot: string): Promise<ProjectConfig> {
	const configPath = getConfigPath(projectRoot);

	if (!existsSync(configPath)) {
		return {};
	}

	try {
		const content = await readFile(configPath, "utf-8");
		return JSON.parse(content) as ProjectConfig;
	} catch {
		return {};
	}
}

/**
 * Write project config
 */
export async function writeConfig(projectRoot: string, config: ProjectConfig): Promise<void> {
	const configPath = getConfigPath(projectRoot);
	const dir = dirname(configPath);

	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}

	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/**
 * Get all import configs
 */
export async function getImportConfigs(projectRoot: string): Promise<ImportConfig[]> {
	const config = await readConfig(projectRoot);
	return config.imports || [];
}

/**
 * Get a specific import config by name
 */
export async function getImportConfig(projectRoot: string, name: string): Promise<ImportConfig | null> {
	const imports = await getImportConfigs(projectRoot);
	return imports.find((i) => i.name === name) || null;
}

/**
 * Add or update an import config
 */
export async function saveImportConfig(projectRoot: string, importConfig: ImportConfig): Promise<void> {
	const config = await readConfig(projectRoot);
	const imports = config.imports || [];

	const existingIndex = imports.findIndex((i) => i.name === importConfig.name);
	if (existingIndex >= 0) {
		imports[existingIndex] = importConfig;
	} else {
		imports.push(importConfig);
	}

	config.imports = imports;
	await writeConfig(projectRoot, config);
}

/**
 * Remove an import config
 */
export async function removeImportConfig(projectRoot: string, name: string): Promise<boolean> {
	const config = await readConfig(projectRoot);
	const imports = config.imports || [];

	const index = imports.findIndex((i) => i.name === name);
	if (index < 0) {
		return false;
	}

	imports.splice(index, 1);
	config.imports = imports;
	await writeConfig(projectRoot, config);
	return true;
}

/**
 * Check if import name exists
 */
export async function importExists(projectRoot: string, name: string): Promise<boolean> {
	const config = await getImportConfig(projectRoot, name);
	return config !== null;
}

/**
 * Read import metadata
 */
export async function readMetadata(projectRoot: string, name: string): Promise<ImportMetadata | null> {
	const metadataPath = getMetadataPath(projectRoot, name);

	if (!existsSync(metadataPath)) {
		return null;
	}

	try {
		const content = await readFile(metadataPath, "utf-8");
		return JSON.parse(content) as ImportMetadata;
	} catch {
		return null;
	}
}

/**
 * Write import metadata
 */
export async function writeMetadata(projectRoot: string, name: string, metadata: ImportMetadata): Promise<void> {
	const metadataPath = getMetadataPath(projectRoot, name);
	const dir = dirname(metadataPath);

	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}

	await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
}

/**
 * Get all imports with their metadata
 * Includes both configured imports AND orphaned imports (on disk but not in config)
 */
export async function getImportsWithMetadata(
	projectRoot: string,
): Promise<Array<{ config: ImportConfig; metadata: ImportMetadata | null }>> {
	const configs = await getImportConfigs(projectRoot);
	const configuredNames = new Set(configs.map((c) => c.name));

	const results: Array<{ config: ImportConfig; metadata: ImportMetadata | null }> = [];

	// Add configured imports
	for (const config of configs) {
		results.push({
			config,
			metadata: await readMetadata(projectRoot, config.name),
		});
	}

	// Scan imports directory for orphaned imports (exist on disk but not in config)
	const importsDir = getImportsDir(projectRoot);
	if (existsSync(importsDir)) {
		const { readdir } = await import("node:fs/promises");
		try {
			const entries = await readdir(importsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (entry.name.startsWith(".")) continue;
				if (configuredNames.has(entry.name)) continue; // Already in config

				// Found orphaned import - create synthetic config from metadata if available
				const metadata = await readMetadata(projectRoot, entry.name);

				results.push({
					config: {
						name: entry.name,
						source: metadata?.source || "unknown",
						type: (metadata?.type as ImportType) || "local",
					},
					metadata,
				});
			}
		} catch {
			// Ignore errors
		}
	}

	return results;
}
