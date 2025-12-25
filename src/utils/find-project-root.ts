/**
 * Find Project Root
 * Searches for .knowns/ directory up the directory tree
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Find the project root by looking for .knowns/ folder
 * @param startPath Starting directory path
 * @returns Path to project root or null if not found
 */
export function findProjectRoot(startPath: string = process.cwd()): string | null {
	let currentPath = startPath;

	// Maximum 20 levels up to prevent infinite loops
	for (let i = 0; i < 20; i++) {
		const knownsPath = join(currentPath, ".knowns");
		if (existsSync(knownsPath)) {
			return currentPath;
		}

		const parentPath = dirname(currentPath);

		// Reached filesystem root
		if (parentPath === currentPath) {
			return null;
		}

		currentPath = parentPath;
	}

	return null;
}
