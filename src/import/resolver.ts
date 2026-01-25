/**
 * Import Resolver
 *
 * Resolves templates and docs from local and imported sources.
 * Local always takes precedence over imported.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getImportConfigs, getImportsDir } from "./config";

const KNOWNS_DIR = ".knowns";
const TEMPLATES_DIR = "templates";
const DOCS_DIR = "docs";

/**
 * Resolved source info
 */
export interface ResolvedSource {
	/** Full path to the item */
	path: string;
	/** Source: "local" or import name */
	source: string;
	/** Whether from import */
	isImported: boolean;
}

/**
 * Get all template directories (local + imported)
 */
export async function getTemplateDirectories(projectRoot: string): Promise<ResolvedSource[]> {
	const results: ResolvedSource[] = [];

	// 1. Local templates (highest priority)
	const localTemplates = join(projectRoot, KNOWNS_DIR, TEMPLATES_DIR);
	if (existsSync(localTemplates)) {
		results.push({
			path: localTemplates,
			source: "local",
			isImported: false,
		});
	}

	// 2. Imported templates
	const importsDir = getImportsDir(projectRoot);
	if (existsSync(importsDir)) {
		try {
			const entries = await readdir(importsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;

				const importedTemplates = join(importsDir, entry.name, TEMPLATES_DIR);
				if (existsSync(importedTemplates)) {
					results.push({
						path: importedTemplates,
						source: entry.name,
						isImported: true,
					});
				}
			}
		} catch {
			// Ignore errors
		}
	}

	return results;
}

/**
 * Get all doc directories (local + imported)
 */
export async function getDocDirectories(projectRoot: string): Promise<ResolvedSource[]> {
	const results: ResolvedSource[] = [];

	// 1. Local docs (highest priority)
	const localDocs = join(projectRoot, KNOWNS_DIR, DOCS_DIR);
	if (existsSync(localDocs)) {
		results.push({
			path: localDocs,
			source: "local",
			isImported: false,
		});
	}

	// 2. Imported docs
	const importsDir = getImportsDir(projectRoot);
	if (existsSync(importsDir)) {
		try {
			const entries = await readdir(importsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;

				const importedDocs = join(importsDir, entry.name, DOCS_DIR);
				if (existsSync(importedDocs)) {
					results.push({
						path: importedDocs,
						source: entry.name,
						isImported: true,
					});
				}
			}
		} catch {
			// Ignore errors
		}
	}

	return results;
}

/**
 * Parse path to extract import name if present
 * e.g., "shared/component" -> { importName: "shared", subPath: "component" }
 * e.g., "component" -> { importName: null, subPath: "component" }
 */
async function parseImportPath(
	projectRoot: string,
	refPath: string,
): Promise<{ importName: string | null; subPath: string }> {
	const parts = refPath.split("/");
	if (parts.length < 2) {
		return { importName: null, subPath: refPath };
	}

	// Check if first part is an import name
	const potentialImport = parts[0];
	const importsDir = getImportsDir(projectRoot);
	const importPath = join(importsDir, potentialImport);

	if (existsSync(importPath)) {
		return {
			importName: potentialImport,
			subPath: parts.slice(1).join("/"),
		};
	}

	return { importName: null, subPath: refPath };
}

/**
 * Resolve a template by name
 * Supports: "component" (local first) or "shared/component" (from import "shared")
 * Returns null if not found
 */
export async function resolveTemplate(projectRoot: string, templateName: string): Promise<ResolvedSource | null> {
	// Check if referencing specific import
	const { importName, subPath } = await parseImportPath(projectRoot, templateName);

	if (importName) {
		// Direct reference to imported template
		const importedTemplates = join(getImportsDir(projectRoot), importName, TEMPLATES_DIR);
		const templatePath = join(importedTemplates, subPath);
		if (existsSync(templatePath)) {
			return {
				path: templatePath,
				source: importName,
				isImported: true,
			};
		}
		return null;
	}

	// Search local first, then imports
	const directories = await getTemplateDirectories(projectRoot);

	for (const dir of directories) {
		const templatePath = join(dir.path, templateName);
		if (existsSync(templatePath)) {
			return {
				path: templatePath,
				source: dir.source,
				isImported: dir.isImported,
			};
		}
	}

	return null;
}

/**
 * Resolve a doc by path
 * Supports: "readme" (local first) or "shared/patterns/auth" (from import "shared")
 * Returns null if not found
 */
export async function resolveDoc(projectRoot: string, docPath: string): Promise<ResolvedSource | null> {
	return resolveDocWithContext(projectRoot, docPath);
}

/**
 * Resolve a doc by path with optional context
 * When context (import name) is provided, check that import first
 * This enables context-aware resolution for refs within imported docs
 *
 * Resolution order:
 * - With context: context import → other imports → local
 * - Without context: imports → local
 */
export async function resolveDocWithContext(
	projectRoot: string,
	docPath: string,
	context?: string,
): Promise<ResolvedSource | null> {
	// Check if referencing specific import (e.g., "shared/patterns/auth")
	const { importName, subPath } = await parseImportPath(projectRoot, docPath);

	// Ensure .md extension
	const normalizedSubPath = subPath.endsWith(".md") ? subPath : `${subPath}.md`;

	if (importName) {
		// Direct reference to imported doc - ignore context
		const importedDocs = join(getImportsDir(projectRoot), importName, DOCS_DIR);
		const fullPath = join(importedDocs, normalizedSubPath);
		if (existsSync(fullPath)) {
			return {
				path: fullPath,
				source: importName,
				isImported: true,
			};
		}
		return null;
	}

	// Get all doc directories
	const directories = await getDocDirectories(projectRoot);

	// If context provided, check context import first
	if (context) {
		const contextDir = directories.find((d) => d.source === context && d.isImported);
		if (contextDir) {
			const fullPath = join(contextDir.path, normalizedSubPath);
			if (existsSync(fullPath)) {
				return {
					path: fullPath,
					source: contextDir.source,
					isImported: true,
				};
			}
		}
	}

	// Search: imports first, then local
	// Separate into imports and local
	const importDirs = directories.filter((d) => d.isImported && d.source !== context);
	const localDirs = directories.filter((d) => !d.isImported);

	// Check imports first
	for (const dir of importDirs) {
		const fullPath = join(dir.path, normalizedSubPath);
		if (existsSync(fullPath)) {
			return {
				path: fullPath,
				source: dir.source,
				isImported: true,
			};
		}
	}

	// Then check local
	for (const dir of localDirs) {
		const fullPath = join(dir.path, normalizedSubPath);
		if (existsSync(fullPath)) {
			return {
				path: fullPath,
				source: dir.source,
				isImported: false,
			};
		}
	}

	return null;
}

/**
 * List all available templates (local + imported)
 * Returns with full reference path including import name for imported templates
 */
export async function listAllTemplates(projectRoot: string): Promise<
	Array<{
		name: string; // Template name (e.g., "component")
		ref: string; // Full reference (e.g., "component" or "shared/component")
		source: string; // "local" or import name
		sourceUrl?: string; // Original source URL for imports
		path: string; // Full filesystem path
		isImported: boolean;
	}>
> {
	const directories = await getTemplateDirectories(projectRoot);
	const importConfigs = await getImportConfigs(projectRoot);
	const sourceUrlMap = new Map(importConfigs.map((c) => [c.name, c.source]));

	const results: Array<{
		name: string;
		ref: string;
		source: string;
		sourceUrl?: string;
		path: string;
		isImported: boolean;
	}> = [];

	for (const dir of directories) {
		try {
			const entries = await readdir(dir.path, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (entry.name.startsWith(".")) continue;

				// Build reference path
				const ref = dir.isImported ? `${dir.source}/${entry.name}` : entry.name;

				results.push({
					name: entry.name,
					ref,
					source: dir.source,
					sourceUrl: dir.isImported ? sourceUrlMap.get(dir.source) : undefined,
					path: join(dir.path, entry.name),
					isImported: dir.isImported,
				});
			}
		} catch {
			// Ignore errors
		}
	}

	return results.sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * List all available docs (local + imported)
 * Returns with full reference path including import name for imported docs
 */
export async function listAllDocs(projectRoot: string): Promise<
	Array<{
		name: string; // Doc path without import prefix (e.g., "patterns/auth")
		ref: string; // Full reference (e.g., "patterns/auth" or "shared/patterns/auth")
		source: string; // "local" or import name
		sourceUrl?: string; // Original source URL for imports
		fullPath: string; // Full filesystem path
		isImported: boolean;
	}>
> {
	const directories = await getDocDirectories(projectRoot);
	const importConfigs = await getImportConfigs(projectRoot);
	const sourceUrlMap = new Map(importConfigs.map((c) => [c.name, c.source]));

	const results: Array<{
		name: string;
		ref: string;
		source: string;
		sourceUrl?: string;
		fullPath: string;
		isImported: boolean;
	}> = [];

	async function scanDir(baseDir: string, relativePath: string, source: string, isImported: boolean) {
		const currentDir = join(baseDir, relativePath);
		try {
			const entries = await readdir(currentDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;

				const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

				if (entry.isDirectory()) {
					await scanDir(baseDir, entryRelPath, source, isImported);
				} else if (entry.name.endsWith(".md")) {
					// Remove .md extension for the path
					const docPath = entryRelPath.replace(/\.md$/, "");

					// Build reference path
					const ref = isImported ? `${source}/${docPath}` : docPath;

					results.push({
						name: docPath,
						ref,
						source,
						sourceUrl: isImported ? sourceUrlMap.get(source) : undefined,
						fullPath: join(currentDir, entry.name),
						isImported,
					});
				}
			}
		} catch {
			// Ignore errors
		}
	}

	for (const dir of directories) {
		await scanDir(dir.path, "", dir.source, dir.isImported);
	}

	return results.sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * Ref validation result
 */
export interface RefValidation {
	ref: string;
	type: "doc" | "task";
	path: string;
	exists: boolean;
}

/**
 * Extract and validate all refs from content
 * Returns list of refs with their validation status
 */
export async function validateRefs(projectRoot: string, content: string, tasksDir?: string): Promise<RefValidation[]> {
	const results: RefValidation[] = [];
	const seen = new Set<string>();

	// Match @doc/xxx refs (excluding those already with import prefix pattern like @doc/import-name/path)
	const docRefPattern = /@docs?\/([^\s,;:!?"'()\]]+)/g;
	const docMatches = content.matchAll(docRefPattern);

	for (const match of docMatches) {
		const docPath = (match[1] || "").replace(/\.md$/, "");
		const refKey = `doc:${docPath}`;

		if (seen.has(refKey)) continue;
		seen.add(refKey);

		const resolved = await resolveDoc(projectRoot, docPath);
		results.push({
			ref: `@doc/${docPath}`,
			type: "doc",
			path: docPath,
			exists: resolved !== null,
		});
	}

	// Match @task-xxx refs
	const taskRefPattern = /@task-([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?)/g;
	const taskMatches = content.matchAll(taskRefPattern);

	for (const match of taskMatches) {
		const taskId = match[1] || "";
		const refKey = `task:${taskId}`;

		if (seen.has(refKey)) continue;
		seen.add(refKey);

		// Check if task exists
		let exists = false;
		if (tasksDir) {
			const taskPath = join(tasksDir, `task-${taskId}.md`);
			exists = existsSync(taskPath);
		}

		results.push({
			ref: `@task-${taskId}`,
			type: "task",
			path: taskId,
			exists,
		});
	}

	return results;
}
