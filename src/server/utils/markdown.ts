/**
 * Markdown utility functions for server
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { normalizePath } from "@utils/index";

/**
 * Recursively find all .md files in a directory
 */
export async function findMarkdownFiles(dir: string, baseDir: string): Promise<string[]> {
	const files: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);

		if (entry.isDirectory()) {
			const subFiles = await findMarkdownFiles(fullPath, baseDir);
			files.push(...subFiles);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			// Use forward slashes for cross-platform consistency (Windows uses backslash)
			const relativePath = normalizePath(relative(baseDir, fullPath));
			files.push(relativePath);
		}
	}

	return files;
}
