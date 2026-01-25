/**
 * Base Import Provider
 *
 * Abstract class for import providers (git, npm, local, registry).
 */

import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportType, ValidationResult } from "../models";

/**
 * Provider options passed to fetch
 */
export interface FetchOptions {
	/** Git ref (branch/tag) */
	ref?: string;
	/** npm version */
	version?: string;
	/** Include patterns */
	include?: string[];
	/** Exclude patterns */
	exclude?: string[];
}

/**
 * Abstract base class for import providers
 */
export abstract class ImportProvider {
	/** Provider type identifier */
	abstract readonly type: ImportType;

	/**
	 * Validate that the source is accessible and has .knowns/
	 */
	abstract validate(source: string, options?: FetchOptions): Promise<ValidationResult>;

	/**
	 * Fetch source to a temporary directory
	 * Returns path to temp directory containing the source
	 */
	abstract fetch(source: string, options?: FetchOptions): Promise<string>;

	/**
	 * Get additional metadata from the fetched source
	 * (e.g., git commit hash, npm version)
	 */
	abstract getMetadata(tempDir: string, options?: FetchOptions): Promise<Record<string, string>>;

	/**
	 * Generate a unique temp directory path
	 */
	protected getTempDir(): string {
		const id = randomBytes(8).toString("hex");
		return join(tmpdir(), `knowns-import-${id}`);
	}

	/**
	 * Cleanup temp directory
	 */
	async cleanup(tempDir: string): Promise<void> {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}
