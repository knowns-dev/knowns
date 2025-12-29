/**
 * Markdown utility functions for server
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

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
			const relativePath = relative(baseDir, fullPath);
			files.push(relativePath);
		}
	}

	return files;
}
