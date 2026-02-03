/**
 * Agent instruction file utilities
 * Used by init and sync commands
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
// Import modular guidelines
import { Guidelines, MCPGuidelines, UnifiedGuidelines } from "../instructions/guidelines";

const PROJECT_ROOT = process.cwd();

export const INSTRUCTION_FILES = [
	{ path: "CLAUDE.md", name: "Claude Code", selected: true },
	{ path: "GEMINI.md", name: "Antigravity (Gemini)", selected: true },
	{ path: "AGENTS.md", name: "Agent SDK", selected: true },
	{
		path: ".github/copilot-instructions.md",
		name: "GitHub Copilot",
		selected: false,
	},
];

export type GuidelinesType = "cli" | "mcp" | "unified";

/**
 * Get guidelines content by type
 */
export function getGuidelines(type: GuidelinesType): string {
	switch (type) {
		case "mcp":
			return MCPGuidelines.getFull(true);
		case "unified":
			return UnifiedGuidelines.getFull(true);
		default:
			return Guidelines.getFull(true);
	}
}

/**
 * Update instruction file with guidelines
 */
export async function updateInstructionFile(
	filePath: string,
	guidelines: string,
): Promise<{ success: boolean; action: "created" | "appended" | "updated" }> {
	const fullPath = join(PROJECT_ROOT, filePath);
	const startMarker = "<!-- KNOWNS GUIDELINES START -->";
	const endMarker = "<!-- KNOWNS GUIDELINES END -->";

	// Ensure directory exists
	const dir = dirname(fullPath);
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}

	if (!existsSync(fullPath)) {
		// Create new file with guidelines
		await writeFile(fullPath, guidelines, "utf-8");
		return { success: true, action: "created" };
	}

	// File exists, check for markers
	const content = await readFile(fullPath, "utf-8");
	const startIndex = content.indexOf(startMarker);
	const endIndex = content.indexOf(endMarker);

	if (startIndex === -1 || endIndex === -1) {
		// No markers found, append guidelines
		const newContent = `${content.trimEnd()}\n\n${guidelines}\n`;
		await writeFile(fullPath, newContent, "utf-8");
		return { success: true, action: "appended" };
	}

	// Markers found, update content between markers
	const before = content.substring(0, startIndex);
	const after = content.substring(endIndex + endMarker.length);
	const newContent = before + guidelines + after;

	await writeFile(fullPath, newContent, "utf-8");
	return { success: true, action: "updated" };
}
