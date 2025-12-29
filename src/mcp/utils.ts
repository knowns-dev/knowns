/**
 * Shared utilities for MCP handlers
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@models/task";
import { extractDocPaths, resolveDocReferences } from "@utils/doc-links";
import matter from "gray-matter";

// Helper function to parse duration strings (e.g., "2h", "30m", "1h30m")
export function parseDuration(durationStr: string): number {
	let totalSeconds = 0;

	// Match hours
	const hoursMatch = durationStr.match(/(\d+)h/);
	if (hoursMatch) {
		totalSeconds += Number.parseInt(hoursMatch[1]) * 3600;
	}

	// Match minutes
	const minutesMatch = durationStr.match(/(\d+)m/);
	if (minutesMatch) {
		totalSeconds += Number.parseInt(minutesMatch[1]) * 60;
	}

	// Match seconds
	const secondsMatch = durationStr.match(/(\d+)s/);
	if (secondsMatch) {
		totalSeconds += Number.parseInt(secondsMatch[1]);
	}

	// If no units found, assume minutes
	if (totalSeconds === 0 && /^\d+$/.test(durationStr)) {
		totalSeconds = Number.parseInt(durationStr) * 60;
	}

	return totalSeconds;
}

// Helper function to format duration (seconds to human readable)
export function formatDuration(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;

	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (secs > 0) parts.push(`${secs}s`);

	return parts.length > 0 ? parts.join(" ") : "0s";
}

// Helper function to fetch linked documentation from a task
export async function fetchLinkedDocs(task: Task): Promise<Array<{ path: string; title: string; content: string }>> {
	const projectRoot = process.cwd();
	const docsDir = join(projectRoot, ".knowns", "docs");

	// Combine all task content to search for doc references
	const allContent = [task.description || "", task.implementationPlan || "", task.implementationNotes || ""].join("\n");

	// Resolve doc references
	const docRefs = resolveDocReferences(allContent, projectRoot);
	const linkedDocs: Array<{ path: string; title: string; content: string }> = [];

	for (const ref of docRefs) {
		if (!ref.exists) continue;

		try {
			// Extract filename from resolved path (@.knowns/docs/filename.md)
			const filename = ref.resolvedPath.replace("@.knowns/docs/", "");
			const filepath = join(docsDir, filename);

			const fileContent = await readFile(filepath, "utf-8");
			const { data, content } = matter(fileContent);

			linkedDocs.push({
				path: ref.resolvedPath,
				title: data.title || ref.text,
				content: content.trim(),
			});
		} catch (_error) {}
	}

	return linkedDocs;
}

// Create a success response for MCP
export function successResponse(data: Record<string, unknown>) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({ success: true, ...data }, null, 2),
			},
		],
	};
}

// Create an error response for MCP
export function errorResponse(error: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({ success: false, error }, null, 2),
			},
		],
	};
}
