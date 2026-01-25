/**
 * Template Parser
 *
 * Parses _template.yaml and loads template files.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { LoadedTemplate, TemplateConfig } from "./models";
import { type ValidatedTemplateConfig, safeValidateTemplateConfig } from "./schema";

const CONFIG_FILENAME = "_template.yaml";
const TEMPLATE_EXTENSION = ".hbs";

/**
 * Error thrown when template parsing fails
 */
export class TemplateParseError extends Error {
	constructor(
		message: string,
		public readonly templateName?: string,
		public readonly details?: string[],
	) {
		super(message);
		this.name = "TemplateParseError";
	}
}

/**
 * Load and parse a template from a directory
 */
export async function loadTemplate(templateDir: string): Promise<LoadedTemplate> {
	// Check directory exists
	if (!existsSync(templateDir)) {
		throw new TemplateParseError(`Template directory not found: ${templateDir}`);
	}

	// Load config file
	const configPath = join(templateDir, CONFIG_FILENAME);
	if (!existsSync(configPath)) {
		throw new TemplateParseError(`Template config not found: ${CONFIG_FILENAME}`, undefined, [
			`Expected file at: ${configPath}`,
		]);
	}

	const configContent = await readFile(configPath, "utf-8");
	let rawConfig: unknown;

	try {
		rawConfig = parseYaml(configContent);
	} catch (error) {
		throw new TemplateParseError("Invalid YAML in template config", undefined, [
			error instanceof Error ? error.message : String(error),
		]);
	}

	// Validate config
	const validation = safeValidateTemplateConfig(rawConfig);
	if (!validation.success) {
		const details = validation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
		throw new TemplateParseError("Invalid template configuration", (rawConfig as { name?: string })?.name, details);
	}

	const config: TemplateConfig = validation.data;

	// Find template files
	const files = await findTemplateFiles(templateDir);

	return {
		config,
		templateDir,
		files,
	};
}

/**
 * Find all .hbs template files in a directory (recursive)
 */
async function findTemplateFiles(dir: string, base = ""): Promise<string[]> {
	const files: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const relativePath = base ? join(base, entry.name) : entry.name;

		if (entry.isDirectory()) {
			// Recurse into subdirectories
			const subFiles = await findTemplateFiles(join(dir, entry.name), relativePath);
			files.push(...subFiles);
		} else if (entry.name.endsWith(TEMPLATE_EXTENSION)) {
			files.push(relativePath);
		}
	}

	return files;
}

/**
 * Load template by name from templates directory
 */
export async function loadTemplateByName(templatesDir: string, templateName: string): Promise<LoadedTemplate> {
	const templateDir = join(templatesDir, templateName);
	return loadTemplate(templateDir);
}

/**
 * List all available templates in a directory
 */
export async function listTemplates(templatesDir: string): Promise<TemplateConfig[]> {
	if (!existsSync(templatesDir)) {
		return [];
	}

	const entries = await readdir(templatesDir, { withFileTypes: true });
	const templates: TemplateConfig[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		const configPath = join(templatesDir, entry.name, CONFIG_FILENAME);
		if (!existsSync(configPath)) continue;

		try {
			const loaded = await loadTemplate(join(templatesDir, entry.name));
			templates.push(loaded.config);
		} catch {
			// Skip invalid templates
		}
	}

	return templates;
}

/**
 * Check if a directory contains a valid template
 */
export async function isValidTemplate(templateDir: string): Promise<boolean> {
	try {
		await loadTemplate(templateDir);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get template config without loading files (faster)
 */
export async function getTemplateConfig(templateDir: string): Promise<ValidatedTemplateConfig | null> {
	const configPath = join(templateDir, CONFIG_FILENAME);

	if (!existsSync(configPath)) {
		return null;
	}

	try {
		const content = await readFile(configPath, "utf-8");
		const raw = parseYaml(content);
		const result = safeValidateTemplateConfig(raw);
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}
