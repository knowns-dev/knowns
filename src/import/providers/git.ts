/**
 * Git Import Provider
 *
 * Imports from git repositories using sparse checkout when possible.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ImportType, ValidationResult } from "../models";
import { ImportError, ImportErrorCode } from "../models";
import { validateKnownsDir } from "../validator";
import { type FetchOptions, ImportProvider } from "./base";

const KNOWNS_DIR = ".knowns";

/**
 * Check if git is available and supports sparse checkout
 */
function getGitInfo(): { available: boolean; version: string; supportsSparse: boolean } {
	try {
		const result = spawnSync("git", ["--version"], { encoding: "utf-8" });
		if (result.status !== 0) {
			return { available: false, version: "", supportsSparse: false };
		}

		const versionMatch = result.stdout.match(/(\d+)\.(\d+)/);
		if (!versionMatch) {
			return { available: true, version: result.stdout.trim(), supportsSparse: false };
		}

		const major = Number.parseInt(versionMatch[1], 10);
		const minor = Number.parseInt(versionMatch[2], 10);

		// Sparse checkout requires Git 2.25+
		const supportsSparse = major > 2 || (major === 2 && minor >= 25);

		return {
			available: true,
			version: `${major}.${minor}`,
			supportsSparse,
		};
	} catch {
		return { available: false, version: "", supportsSparse: false };
	}
}

/**
 * Git import provider
 */
export class GitProvider extends ImportProvider {
	readonly type: ImportType = "git";

	private gitInfo = getGitInfo();

	async validate(source: string, options?: FetchOptions): Promise<ValidationResult> {
		if (!this.gitInfo.available) {
			return {
				valid: false,
				error: "Git is not installed",
				hint: "Install git to import from git repositories",
			};
		}

		// Try ls-remote to check if repo exists
		try {
			const ref = options?.ref || "HEAD";
			const result = spawnSync("git", ["ls-remote", "--exit-code", source, ref], {
				encoding: "utf-8",
				timeout: 30000,
			});

			if (result.status !== 0) {
				if (result.stderr?.includes("Authentication failed") || result.stderr?.includes("Permission denied")) {
					return {
						valid: false,
						error: "Authentication required",
						hint: "Configure git credentials or use SSH",
					};
				}

				return {
					valid: false,
					error: "Repository not found or not accessible",
					hint: "Check the URL and your access permissions",
				};
			}
		} catch (error) {
			return {
				valid: false,
				error: `Failed to access repository: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		// We can't fully validate .knowns/ without fetching
		// Return valid=true with a note
		return {
			valid: true,
			type: "git",
		};
	}

	async fetch(source: string, options?: FetchOptions): Promise<string> {
		if (!this.gitInfo.available) {
			throw new ImportError("Git is not installed", ImportErrorCode.GIT_ERROR, "Install git first");
		}

		const tempDir = this.getTempDir();
		await mkdir(tempDir, { recursive: true });

		const ref = options?.ref || "HEAD";

		try {
			if (this.gitInfo.supportsSparse) {
				// Use sparse checkout - faster, only fetches .knowns/
				await this.sparseCheckout(source, tempDir, ref);
			} else {
				// Fallback to full clone
				await this.fullClone(source, tempDir, ref);
			}

			// Validate .knowns/ exists
			const validation = await validateKnownsDir(tempDir);
			if (!validation.valid) {
				await this.cleanup(tempDir);
				throw new ImportError(
					validation.error || "Source does not contain .knowns/",
					ImportErrorCode.NO_KNOWNS_DIR,
					validation.hint,
				);
			}

			return tempDir;
		} catch (error) {
			await this.cleanup(tempDir);

			if (error instanceof ImportError) {
				throw error;
			}

			throw new ImportError(
				`Git operation failed: ${error instanceof Error ? error.message : String(error)}`,
				ImportErrorCode.GIT_ERROR,
			);
		}
	}

	/**
	 * Sparse checkout - only fetch .knowns/ directory
	 */
	private async sparseCheckout(source: string, tempDir: string, ref: string): Promise<void> {
		// Initialize repo with sparse checkout
		execSync("git init", { cwd: tempDir, stdio: "pipe" });
		execSync(`git remote add origin "${source}"`, { cwd: tempDir, stdio: "pipe" });

		// Configure sparse checkout
		execSync("git config core.sparseCheckout true", { cwd: tempDir, stdio: "pipe" });
		execSync("git sparse-checkout init --cone", { cwd: tempDir, stdio: "pipe" });
		execSync(`git sparse-checkout set ${KNOWNS_DIR}`, { cwd: tempDir, stdio: "pipe" });

		// Fetch only what we need
		const fetchRef = ref === "HEAD" ? "HEAD" : ref;
		execSync(`git fetch --depth=1 origin ${fetchRef}`, { cwd: tempDir, stdio: "pipe" });

		// Checkout
		if (ref === "HEAD") {
			execSync("git checkout FETCH_HEAD", { cwd: tempDir, stdio: "pipe" });
		} else {
			execSync(`git checkout ${ref}`, { cwd: tempDir, stdio: "pipe" });
		}
	}

	/**
	 * Full clone - fallback for older git versions
	 */
	private async fullClone(source: string, tempDir: string, ref: string): Promise<void> {
		if (ref === "HEAD") {
			execSync(`git clone --depth=1 "${source}" .`, { cwd: tempDir, stdio: "pipe" });
		} else {
			execSync(`git clone --depth=1 --branch "${ref}" "${source}" .`, { cwd: tempDir, stdio: "pipe" });
		}
	}

	async getMetadata(tempDir: string, _options?: FetchOptions): Promise<Record<string, string>> {
		const metadata: Record<string, string> = {};

		try {
			// Get commit hash
			const commit = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();
			metadata.commit = commit;

			// Get current branch/ref
			try {
				const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();
				if (branch !== "HEAD") {
					metadata.ref = branch;
				}
			} catch {
				// Ignore
			}
		} catch {
			// Ignore metadata errors
		}

		return metadata;
	}
}

/**
 * Default git provider instance
 */
export const gitProvider = new GitProvider();
