/**
 * Skill Platform Sync
 *
 * Sync skills from .knowns/skills/ to various AI platforms.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SKILLS as BUILTIN_SKILLS } from "../instructions/skills";
import { renderString } from "./renderer";
import { type Skill, listSkills } from "./skill-parser";

/**
 * Supported AI platforms
 */
export type Platform = "claude" | "antigravity" | "cursor" | "windsurf" | "cline";

/**
 * Platform configuration
 */
export interface PlatformConfig {
	/** Platform identifier */
	id: Platform;
	/** Display name */
	name: string;
	/** Target directory (relative to project root) */
	targetDir: string;
	/** File naming pattern */
	filePattern: "folder" | "single" | "append";
	/** File extension */
	extension: string;
	/** Whether platform supports MCP */
	supportsMcp: boolean;
}

/**
 * All supported platforms
 */
export const PLATFORMS: PlatformConfig[] = [
	{
		id: "claude",
		name: "Claude Code",
		targetDir: ".claude/skills",
		filePattern: "folder",
		extension: "SKILL.md",
		supportsMcp: true,
	},
	{
		id: "antigravity",
		name: "Antigravity",
		targetDir: ".agent/skills",
		filePattern: "folder",
		extension: "SKILL.md",
		supportsMcp: true,
	},
	{
		id: "cursor",
		name: "Cursor",
		targetDir: ".cursor/rules",
		filePattern: "folder",
		extension: "SKILL.md",
		supportsMcp: true,
	},
	{
		id: "windsurf",
		name: "Windsurf",
		targetDir: ".",
		filePattern: "single",
		extension: ".windsurfrules",
		supportsMcp: false,
	},
	{
		id: "cline",
		name: "Cline",
		targetDir: ".clinerules",
		filePattern: "folder",
		extension: "SKILL.md",
		supportsMcp: true,
	},
];

/**
 * Get platform config by ID
 */
export function getPlatform(id: Platform): PlatformConfig | undefined {
	return PLATFORMS.find((p) => p.id === id);
}

/**
 * Get all platform IDs
 */
export function getPlatformIds(): Platform[] {
	return PLATFORMS.map((p) => p.id);
}

/**
 * Sync result
 */
export interface SyncResult {
	platform: Platform;
	created: number;
	updated: number;
	skipped: number;
	errors: string[];
}

/**
 * Instruction mode for skills
 */
export type InstructionMode = "mcp" | "cli";

/**
 * Sync options
 */
export interface SyncOptions {
	/** Project root directory */
	projectRoot: string;
	/** Skills directory (optional if useBuiltIn is true) */
	skillsDir?: string;
	/** Platforms to sync (default: all) */
	platforms?: Platform[];
	/** Force overwrite */
	force?: boolean;
	/** Dry run */
	dryRun?: boolean;
	/** Instruction mode: mcp or cli (default: determined by platform) */
	mode?: InstructionMode;
	/** Use built-in skills instead of reading from skillsDir */
	useBuiltIn?: boolean;
}

/**
 * Render skill content with mode context (mcp or cli)
 */
function renderSkillContent(content: string, mode: InstructionMode): string {
	try {
		return renderString(content, { mcp: mode === "mcp", cli: mode === "cli" });
	} catch {
		// If rendering fails (e.g., no Handlebars syntax), return original
		return content;
	}
}

/**
 * Prepare skills for a platform by rendering with appropriate mode
 */
function prepareSkillsForPlatform(skills: Skill[], platform: PlatformConfig, mode?: InstructionMode): Skill[] {
	// Determine mode: explicit > platform default
	const effectiveMode: InstructionMode = mode ?? (platform.supportsMcp ? "mcp" : "cli");

	return skills.map((skill) => ({
		...skill,
		content: renderSkillContent(skill.content, effectiveMode),
	}));
}

/**
 * Sync skills to all specified platforms
 */
export async function syncSkills(options: SyncOptions): Promise<SyncResult[]> {
	// Use built-in skills or read from skillsDir
	const skills = options.useBuiltIn ? BUILTIN_SKILLS : await listSkills(options.skillsDir || "");
	const platforms = options.platforms || getPlatformIds();
	const results: SyncResult[] = [];

	for (const platformId of platforms) {
		const platform = getPlatform(platformId);
		if (!platform) continue;

		// Prepare skills with rendered content for this platform
		const preparedSkills = prepareSkillsForPlatform(skills, platform, options.mode);
		const result = await syncToPlatform(preparedSkills, platform, options);
		results.push(result);
	}

	return results;
}

/**
 * Sync skills to a specific platform
 */
async function syncToPlatform(skills: Skill[], platform: PlatformConfig, options: SyncOptions): Promise<SyncResult> {
	const result: SyncResult = {
		platform: platform.id,
		created: 0,
		updated: 0,
		skipped: 0,
		errors: [],
	};

	if (skills.length === 0) {
		return result;
	}

	try {
		switch (platform.filePattern) {
			case "folder":
				await syncToFolderPattern(skills, platform, options, result);
				break;
			case "single":
				await syncToSingleFile(skills, platform, options, result);
				break;
			case "append":
				await syncToAppendFile(skills, platform, options, result);
				break;
		}
	} catch (error) {
		result.errors.push(error instanceof Error ? error.message : String(error));
	}

	return result;
}

/**
 * Check if folder is a deprecated skill folder
 * Deprecated formats: "knowns.*" and "kn:*" (colon not valid on Windows)
 */
function isDeprecatedSkillFolder(name: string): boolean {
	return name.startsWith("knowns.") || name.startsWith("kn:");
}

/**
 * Clean up deprecated skill folders (any folder starting with "knowns." or "kn:")
 */
function cleanupDeprecatedSkills(targetDir: string, dryRun?: boolean): number {
	let removed = 0;

	if (existsSync(targetDir)) {
		const entries = readdirSync(targetDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() && isDeprecatedSkillFolder(entry.name)) {
				if (!dryRun) {
					const deprecatedPath = join(targetDir, entry.name);
					rmSync(deprecatedPath, { recursive: true, force: true });
				}
				removed++;
			}
		}
	}

	return removed;
}

/**
 * Sync to folder pattern (each skill in its own folder)
 * Used by: Claude Code, Antigravity, Cursor, Cline
 */
async function syncToFolderPattern(
	skills: Skill[],
	platform: PlatformConfig,
	options: SyncOptions,
	result: SyncResult,
): Promise<void> {
	const targetDir = join(options.projectRoot, platform.targetDir);

	// Ensure target directory exists
	if (!options.dryRun && !existsSync(targetDir)) {
		await mkdir(targetDir, { recursive: true });
	}

	// Clean up deprecated skill folders (starting with "knowns.")
	cleanupDeprecatedSkills(targetDir, options.dryRun);

	for (const skill of skills) {
		const skillFolder = join(targetDir, skill.folderName);
		const skillFile = join(skillFolder, platform.extension);

		try {
			if (existsSync(skillFile)) {
				if (options.force) {
					const existing = await readFile(skillFile, "utf-8");
					if (existing.trim() !== skill.content.trim()) {
						if (!options.dryRun) {
							await writeFile(skillFile, skill.content, "utf-8");
						}
						result.updated++;
					} else {
						result.skipped++;
					}
				} else {
					result.skipped++;
				}
			} else {
				if (!options.dryRun) {
					await mkdir(skillFolder, { recursive: true });
					await writeFile(skillFile, skill.content, "utf-8");
				}
				result.created++;
			}
		} catch (error) {
			result.errors.push(`${skill.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/**
 * Sync to single file (all skills in one file)
 * Used by: Windsurf
 */
async function syncToSingleFile(
	skills: Skill[],
	platform: PlatformConfig,
	options: SyncOptions,
	result: SyncResult,
): Promise<void> {
	const targetFile = join(options.projectRoot, platform.targetDir, platform.extension);

	// Combine all skills into one file
	const content = skills.map((s) => `# ${s.name}\n\n${extractContent(s.content)}`).join("\n\n---\n\n");

	try {
		if (existsSync(targetFile)) {
			if (options.force) {
				const existing = await readFile(targetFile, "utf-8");
				if (existing.trim() !== content.trim()) {
					if (!options.dryRun) {
						await writeFile(targetFile, content, "utf-8");
					}
					result.updated = skills.length;
				} else {
					result.skipped = skills.length;
				}
			} else {
				result.skipped = skills.length;
			}
		} else {
			if (!options.dryRun) {
				await mkdir(dirname(targetFile), { recursive: true });
				await writeFile(targetFile, content, "utf-8");
			}
			result.created = skills.length;
		}
	} catch (error) {
		result.errors.push(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Sync to append file (append to existing file with markers)
 * Used by: Gemini CLI
 */
async function syncToAppendFile(
	skills: Skill[],
	platform: PlatformConfig,
	options: SyncOptions,
	result: SyncResult,
): Promise<void> {
	const targetFile = join(options.projectRoot, platform.targetDir, platform.extension);
	const startMarker = "<!-- KNOWNS SKILLS START -->";
	const endMarker = "<!-- KNOWNS SKILLS END -->";

	// Combine all skills
	const skillsContent = skills.map((s) => `## ${s.name}\n\n${extractContent(s.content)}`).join("\n\n---\n\n");
	const markedContent = `${startMarker}\n# Knowns Skills\n\n${skillsContent}\n${endMarker}`;

	try {
		if (existsSync(targetFile)) {
			const existing = await readFile(targetFile, "utf-8");
			const startIndex = existing.indexOf(startMarker);
			const endIndex = existing.indexOf(endMarker);

			let newContent: string;
			if (startIndex !== -1 && endIndex !== -1) {
				// Replace existing section
				newContent =
					existing.substring(0, startIndex) + markedContent + existing.substring(endIndex + endMarker.length);
				result.updated = skills.length;
			} else {
				// Append to end
				newContent = `${existing.trimEnd()}\n\n${markedContent}\n`;
				result.created = skills.length;
			}

			if (!options.dryRun) {
				await writeFile(targetFile, newContent, "utf-8");
			}
		} else {
			if (!options.dryRun) {
				await mkdir(dirname(targetFile), { recursive: true });
				await writeFile(targetFile, markedContent, "utf-8");
			}
			result.created = skills.length;
		}
	} catch (error) {
		result.errors.push(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Extract content from skill (remove frontmatter)
 */
function extractContent(content: string): string {
	const lines = content.split("\n");
	let inFrontmatter = false;
	let frontmatterEnd = 0;

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			if (!inFrontmatter) {
				inFrontmatter = true;
			} else {
				frontmatterEnd = i + 1;
				break;
			}
		}
	}

	return lines.slice(frontmatterEnd).join("\n").trim();
}

/**
 * Detect which platforms are present in a project
 */
export function detectPlatforms(projectRoot: string): Platform[] {
	const detected: Platform[] = [];

	for (const platform of PLATFORMS) {
		const checkPath =
			platform.filePattern === "folder"
				? join(projectRoot, platform.targetDir)
				: join(projectRoot, platform.targetDir, platform.extension);

		if (existsSync(checkPath)) {
			detected.push(platform.id);
		}
	}

	return detected;
}
