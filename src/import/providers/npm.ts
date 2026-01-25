/**
 * npm Import Provider
 *
 * Imports from npm packages using npm pack + extract.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ImportType, ValidationResult } from "../models";
import { ImportError, ImportErrorCode } from "../models";
import { validateKnownsDir } from "../validator";
import { type FetchOptions, ImportProvider } from "./base";

/**
 * Check if npm is available
 */
function isNpmAvailable(): boolean {
	try {
		const result = spawnSync("npm", ["--version"], { encoding: "utf-8" });
		return result.status === 0;
	} catch {
		return false;
	}
}

/**
 * npm import provider
 */
export class NpmProvider extends ImportProvider {
	readonly type: ImportType = "npm";

	async validate(source: string, options?: FetchOptions): Promise<ValidationResult> {
		if (!isNpmAvailable()) {
			return {
				valid: false,
				error: "npm is not installed",
				hint: "Install Node.js/npm to import from npm packages",
			};
		}

		// Check if package exists using npm view
		const packageSpec = options?.version ? `${source}@${options.version}` : source;

		try {
			const result = spawnSync("npm", ["view", packageSpec, "name"], {
				encoding: "utf-8",
				timeout: 30000,
			});

			if (result.status !== 0) {
				if (result.stderr?.includes("404") || result.stderr?.includes("Not Found")) {
					return {
						valid: false,
						error: `Package not found: ${source}`,
						hint: "Check the package name and registry",
					};
				}

				if (result.stderr?.includes("ENEEDAUTH") || result.stderr?.includes("authentication")) {
					return {
						valid: false,
						error: "Authentication required",
						hint: "Run 'npm login' to authenticate",
					};
				}

				return {
					valid: false,
					error: result.stderr || "Failed to access package",
				};
			}

			return {
				valid: true,
				type: "npm",
			};
		} catch (error) {
			return {
				valid: false,
				error: `Failed to check package: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	async fetch(source: string, options?: FetchOptions): Promise<string> {
		if (!isNpmAvailable()) {
			throw new ImportError("npm is not installed", ImportErrorCode.NPM_ERROR, "Install Node.js/npm first");
		}

		const tempDir = this.getTempDir();
		await mkdir(tempDir, { recursive: true });

		const packageSpec = options?.version ? `${source}@${options.version}` : source;

		try {
			// Use npm pack to download the package tarball
			const packResult = spawnSync("npm", ["pack", packageSpec, "--pack-destination", tempDir], {
				encoding: "utf-8",
				timeout: 60000,
			});

			if (packResult.status !== 0) {
				throw new Error(packResult.stderr || "npm pack failed");
			}

			// Find the tarball
			const files = await readdir(tempDir);
			const tarball = files.find((f) => f.endsWith(".tgz"));

			if (!tarball) {
				throw new Error("No tarball created by npm pack");
			}

			// Extract the tarball
			const tarballPath = join(tempDir, tarball);
			const extractResult = spawnSync("tar", ["-xzf", tarball], {
				cwd: tempDir,
				encoding: "utf-8",
			});

			if (extractResult.status !== 0) {
				throw new Error(extractResult.stderr || "tar extraction failed");
			}

			// npm pack extracts to 'package/' directory
			const packageDir = join(tempDir, "package");

			if (!existsSync(packageDir)) {
				throw new Error("Extracted package directory not found");
			}

			// Move contents up and cleanup
			const extractedDir = this.getTempDir();
			await rename(packageDir, extractedDir);
			await rm(tempDir, { recursive: true, force: true });

			// Validate .knowns/ exists
			const validation = await validateKnownsDir(extractedDir);
			if (!validation.valid) {
				await this.cleanup(extractedDir);
				throw new ImportError(
					validation.error || "Package does not contain .knowns/",
					ImportErrorCode.NO_KNOWNS_DIR,
					validation.hint,
				);
			}

			return extractedDir;
		} catch (error) {
			await this.cleanup(tempDir);

			if (error instanceof ImportError) {
				throw error;
			}

			throw new ImportError(
				`npm operation failed: ${error instanceof Error ? error.message : String(error)}`,
				ImportErrorCode.NPM_ERROR,
			);
		}
	}

	async getMetadata(tempDir: string, options?: FetchOptions): Promise<Record<string, string>> {
		const metadata: Record<string, string> = {};

		// Try to read package.json for version
		try {
			const packageJsonPath = join(tempDir, "package.json");
			if (existsSync(packageJsonPath)) {
				const { readFile } = await import("node:fs/promises");
				const content = await readFile(packageJsonPath, "utf-8");
				const pkg = JSON.parse(content);
				if (pkg.version) {
					metadata.version = pkg.version;
				}
			}
		} catch {
			// Ignore
		}

		// Use specified version if available
		if (options?.version) {
			metadata.requestedVersion = options.version;
		}

		return metadata;
	}
}

/**
 * Default npm provider instance
 */
export const npmProvider = new NpmProvider();
