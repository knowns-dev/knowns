/**
 * Local Import Provider
 *
 * Imports from local paths (copy or symlink).
 */

import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readlink, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ImportType, ValidationResult } from "../models";
import { ImportError, ImportErrorCode } from "../models";
import { validateKnownsDir } from "../validator";
import { type FetchOptions, ImportProvider } from "./base";

const KNOWNS_DIR = ".knowns";

/**
 * Resolve path with ~ expansion
 */
function resolvePath(source: string): string {
	let resolved = source;

	// Expand ~
	if (resolved.startsWith("~")) {
		resolved = join(homedir(), resolved.slice(1));
	}

	// Make absolute
	if (!isAbsolute(resolved)) {
		resolved = resolve(resolved);
	}

	return resolved;
}

/**
 * Local import provider
 */
export class LocalProvider extends ImportProvider {
	readonly type: ImportType = "local";

	async validate(source: string, _options?: FetchOptions): Promise<ValidationResult> {
		const resolvedPath = resolvePath(source);

		// Check if path exists
		if (!existsSync(resolvedPath)) {
			return {
				valid: false,
				error: `Path not found: ${source}`,
				hint: "Check the path and try again",
			};
		}

		// Check if it's a directory
		const stat = statSync(resolvedPath);
		if (!stat.isDirectory()) {
			return {
				valid: false,
				error: `Path is not a directory: ${source}`,
			};
		}

		// Determine the .knowns path
		let knownsPath: string;
		if (resolvedPath.endsWith(KNOWNS_DIR)) {
			// Source is the .knowns directory itself
			knownsPath = resolvedPath;
		} else if (existsSync(join(resolvedPath, KNOWNS_DIR))) {
			// Source contains .knowns
			knownsPath = join(resolvedPath, KNOWNS_DIR);
		} else {
			return {
				valid: false,
				error: "Source does not contain .knowns/ directory",
				hint: "Only Knowns-enabled projects can be imported",
			};
		}

		// Validate the .knowns directory contents
		// For local, we validate the actual path, not a copy
		const parentDir = knownsPath.endsWith(KNOWNS_DIR) ? resolve(knownsPath, "..") : resolvedPath;
		return validateKnownsDir(parentDir);
	}

	async fetch(source: string, options?: FetchOptions & { link?: boolean }): Promise<string> {
		const resolvedPath = resolvePath(source);

		if (!existsSync(resolvedPath)) {
			throw new ImportError(`Path not found: ${source}`, ImportErrorCode.SOURCE_NOT_FOUND);
		}

		// Determine the source .knowns path
		let sourceKnowns: string;
		if (resolvedPath.endsWith(KNOWNS_DIR)) {
			sourceKnowns = resolvedPath;
		} else {
			sourceKnowns = join(resolvedPath, KNOWNS_DIR);
		}

		if (!existsSync(sourceKnowns)) {
			throw new ImportError(
				"Source does not contain .knowns/ directory",
				ImportErrorCode.NO_KNOWNS_DIR,
				"Only Knowns-enabled projects can be imported",
			);
		}

		// Validate
		const parentDir = sourceKnowns.endsWith(KNOWNS_DIR) ? resolve(sourceKnowns, "..") : resolvedPath;
		const validation = await validateKnownsDir(parentDir);
		if (!validation.valid) {
			throw new ImportError(validation.error || "Invalid source", ImportErrorCode.NO_KNOWNS_DIR, validation.hint);
		}

		// For symlink mode, we return the resolved source path directly
		// The service will create the symlink
		if (options?.link) {
			return sourceKnowns;
		}

		// For copy mode, copy to temp directory
		const tempDir = this.getTempDir();
		await mkdir(tempDir, { recursive: true });

		// Copy the entire parent (which contains .knowns)
		// This preserves the structure
		try {
			await cp(parentDir, tempDir, { recursive: true });
			return tempDir;
		} catch (error) {
			await this.cleanup(tempDir);
			throw new ImportError(
				`Failed to copy: ${error instanceof Error ? error.message : String(error)}`,
				ImportErrorCode.SOURCE_NOT_FOUND,
			);
		}
	}

	async getMetadata(_tempDir: string, _options?: FetchOptions): Promise<Record<string, string>> {
		// Local imports don't have version metadata
		return {};
	}

	/**
	 * Create symlink for linked imports
	 */
	async createSymlink(source: string, target: string): Promise<void> {
		const resolvedSource = resolvePath(source);

		// Remove existing if present
		if (existsSync(target)) {
			const { rm } = await import("node:fs/promises");
			await rm(target, { recursive: true, force: true });
		}

		// Create parent directory
		const { dirname } = await import("node:path");
		await mkdir(dirname(target), { recursive: true });

		// Create symlink
		await symlink(resolvedSource, target, "junction");
	}

	/**
	 * Check if path is a symlink
	 */
	async isSymlink(path: string): Promise<boolean> {
		try {
			await readlink(path);
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Default local provider instance
 */
export const localProvider = new LocalProvider();
