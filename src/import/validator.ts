/**
 * Import Source Validator
 *
 * Validates that import sources have .knowns/ directory.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ImportType, ValidationResult } from "./models";
import { ImportError, ImportErrorCode } from "./models";

const KNOWNS_DIR = ".knowns";
const TEMPLATES_DIR = "templates";
const DOCS_DIR = "docs";

/**
 * Validate that a directory contains .knowns/
 */
export async function validateKnownsDir(dir: string): Promise<ValidationResult> {
	const knownsPath = join(dir, KNOWNS_DIR);

	// Check .knowns/ exists
	if (!existsSync(knownsPath)) {
		return {
			valid: false,
			error: "Source does not contain .knowns/ directory",
			hint: "Only Knowns-enabled projects can be imported",
		};
	}

	// Check for templates/ or docs/
	const templatesPath = join(knownsPath, TEMPLATES_DIR);
	const docsPath = join(knownsPath, DOCS_DIR);

	const hasTemplates = existsSync(templatesPath);
	const hasDocs = existsSync(docsPath);

	if (!hasTemplates && !hasDocs) {
		return {
			valid: false,
			error: "Source .knowns/ directory is empty",
			hint: "The .knowns/ directory must contain templates/ or docs/",
		};
	}

	// Count items
	let templateCount = 0;
	let docCount = 0;

	if (hasTemplates) {
		try {
			const entries = await readdir(templatesPath, { withFileTypes: true });
			templateCount = entries.filter((e) => e.isDirectory()).length;
		} catch {
			// Ignore errors
		}
	}

	if (hasDocs) {
		try {
			const entries = await readdir(docsPath, { withFileTypes: true });
			docCount = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).length;
		} catch {
			// Ignore errors
		}
	}

	return {
		valid: true,
		content: {
			hasTemplates,
			hasDocs,
			templateCount,
			docCount,
		},
	};
}

/**
 * Detect import type from source string
 */
export function detectImportType(source: string): ImportType | null {
	// Git: URLs ending with .git or containing github/gitlab/bitbucket
	if (
		source.endsWith(".git") ||
		source.startsWith("git@") ||
		source.includes("github.com") ||
		source.includes("gitlab.com") ||
		source.includes("bitbucket.org")
	) {
		return "git";
	}

	// npm: Starts with @ or looks like a package name
	if (source.startsWith("@") || /^[a-z][a-z0-9-]*$/.test(source)) {
		return "npm";
	}

	// Registry: Starts with knowns://
	if (source.startsWith("knowns://")) {
		return "registry";
	}

	// Local: Starts with ./ ../ / ~ or is a path
	if (
		source.startsWith("./") ||
		source.startsWith("../") ||
		source.startsWith("/") ||
		source.startsWith("~") ||
		existsSync(source)
	) {
		return "local";
	}

	return null;
}

/**
 * Validate import name
 */
export function validateImportName(name: string): { valid: boolean; error?: string } {
	if (!name) {
		return { valid: false, error: "Import name is required" };
	}

	// Must be kebab-case
	if (!/^[a-z][a-z0-9-]*$/.test(name)) {
		return {
			valid: false,
			error: "Import name must be kebab-case (lowercase letters, numbers, hyphens)",
		};
	}

	// Max length
	if (name.length > 50) {
		return { valid: false, error: "Import name must be 50 characters or less" };
	}

	return { valid: true };
}

/**
 * Generate import name from source
 */
export function generateImportName(source: string, type: ImportType): string {
	let name: string;

	switch (type) {
		case "git": {
			// Extract repo name from URL
			// https://github.com/org/repo-name.git -> repo-name
			const match = source.match(/\/([^/]+?)(\.git)?$/);
			name = match?.[1] || "imported";
			break;
		}
		case "npm": {
			// @org/package-name -> package-name
			// package-name -> package-name
			const match = source.match(/(?:@[^/]+\/)?([^@]+)/);
			name = match?.[1] || "imported";
			break;
		}
		case "local": {
			// ../path/to/project -> project
			const parts = source.replace(/\/$/, "").split("/");
			name = parts[parts.length - 1] || "imported";
			// Handle .knowns suffix
			if (name === ".knowns") {
				name = parts[parts.length - 2] || "imported";
			}
			break;
		}
		case "registry": {
			// knowns://template-name -> template-name
			name = source.replace("knowns://", "").split("@")[0];
			break;
		}
		default:
			name = "imported";
	}

	// Ensure valid name
	name = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");

	// Remove leading/trailing hyphens
	name = name.replace(/^-+|-+$/g, "");

	return name || "imported";
}

/**
 * Throw ImportError if validation fails
 */
export function assertValidKnownsDir(result: ValidationResult): void {
	if (!result.valid) {
		throw new ImportError(result.error || "Invalid source", ImportErrorCode.NO_KNOWNS_DIR, result.hint);
	}
}
