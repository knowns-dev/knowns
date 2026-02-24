/**
 * Sync spec ACs based on task fulfills field
 * When task is done and has fulfills, check the corresponding ACs in the spec doc
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@models/task";
import matter from "gray-matter";

export interface SyncResult {
	synced: boolean;
	specPath?: string;
	checkedCount?: number;
	checkedACs?: string[];
}

/**
 * Extract AC identifier from spec AC line
 * e.g., "- [ ] AC-1: description" → "AC-1"
 * e.g., "- [ ] AC-2: description" → "AC-2"
 */
function extractACId(acText: string): string | null {
	// Match patterns: AC-1, AC-2, AC1, AC2, etc.
	const match = acText.match(/^(AC-?\d+)/i);
	return match ? match[1].toUpperCase().replace(/^AC(\d)/, "AC-$1") : null;
}

/**
 * Sync spec ACs based on task fulfills field
 * When task has fulfills array, check matching ACs in the linked spec
 *
 * @param task - The task with fulfills field
 * @param projectRoot - Project root directory
 * @returns Sync result
 */
export async function syncSpecACs(task: Task, projectRoot: string | undefined): Promise<SyncResult> {
	// Skip if no project root
	if (!projectRoot) return { synced: false };

	// Skip if no spec linked
	if (!task.spec) return { synced: false };

	// Skip if no fulfills defined
	if (!task.fulfills || task.fulfills.length === 0) return { synced: false };

	// Load spec document
	const specPath = join(projectRoot, ".knowns", "docs", `${task.spec}.md`);
	if (!existsSync(specPath)) return { synced: false };

	try {
		const content = await readFile(specPath, "utf-8");
		const { data: frontmatter, content: docContent } = matter(content);

		// Normalize fulfills to uppercase with hyphen (AC-1, AC-2, etc.)
		const fulfillsSet = new Set(task.fulfills.map((f) => f.toUpperCase().replace(/^AC(\d)/, "AC-$1")));

		// Find and update ACs in spec content
		let updatedContent = docContent;
		let checkedCount = 0;
		const checkedACs: string[] = [];

		// Match unchecked ACs in spec: - [ ] AC-X: description
		const acPattern = /^([ \t]*)-\s*\[\s*\]\s*(.+)$/gm;

		updatedContent = docContent.replace(acPattern, (match, indent, acText) => {
			const acId = extractACId(acText);
			if (acId && fulfillsSet.has(acId)) {
				checkedCount++;
				checkedACs.push(acId);
				return `${indent}- [x] ${acText}`;
			}
			return match; // No match, keep unchanged
		});

		// Save if changes were made
		if (checkedCount > 0) {
			const newFileContent = matter.stringify(updatedContent, frontmatter);
			await writeFile(specPath, newFileContent, "utf-8");
			return { synced: true, specPath: task.spec, checkedCount, checkedACs };
		}

		return { synced: false };
	} catch (err) {
		console.error("Error syncing spec ACs:", err);
		return { synced: false };
	}
}
