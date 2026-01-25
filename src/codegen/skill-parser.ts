/**
 * Skill Parser
 *
 * Parse and load skills from .knowns/skills/ directory.
 * Skills are markdown files with YAML frontmatter.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

const SKILL_FILENAME = "SKILL.md";

/**
 * Skill definition
 */
export interface Skill {
	/** Skill name (from frontmatter or folder name) */
	name: string;
	/** Skill description */
	description: string;
	/** Full skill content (markdown with frontmatter) */
	content: string;
	/** Folder name */
	folderName: string;
	/** Source directory */
	sourceDir: string;
}

/**
 * Skill frontmatter
 */
export interface SkillFrontmatter {
	name?: string;
	description?: string;
	[key: string]: unknown;
}

/**
 * Parse skill frontmatter from content
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
	try {
		const { data } = matter(content);
		return data as SkillFrontmatter;
	} catch {
		return {};
	}
}

/**
 * Load a skill from a directory
 */
export async function loadSkill(skillDir: string): Promise<Skill | null> {
	const skillFile = join(skillDir, SKILL_FILENAME);

	if (!existsSync(skillFile)) {
		return null;
	}

	const content = await readFile(skillFile, "utf-8");
	const frontmatter = parseSkillFrontmatter(content);
	const folderName = skillDir.split("/").pop() || "";

	return {
		name: frontmatter.name || folderName,
		description: frontmatter.description || "",
		content: content.trim(),
		folderName,
		sourceDir: skillDir,
	};
}

/**
 * Load a skill by name from skills directory
 */
export async function loadSkillByName(skillsDir: string, name: string): Promise<Skill | null> {
	const skillDir = join(skillsDir, name);
	return loadSkill(skillDir);
}

/**
 * List all skills from a directory
 */
export async function listSkills(skillsDir: string): Promise<Skill[]> {
	if (!existsSync(skillsDir)) {
		return [];
	}

	const entries = await readdir(skillsDir, { withFileTypes: true });
	const skills: Skill[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		const skill = await loadSkill(join(skillsDir, entry.name));
		if (skill) {
			skills.push(skill);
		}
	}

	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Check if a directory is a valid skill
 */
export function isValidSkillDir(skillDir: string): boolean {
	return existsSync(join(skillDir, SKILL_FILENAME));
}

/**
 * Get skill names from a directory
 */
export async function getSkillNames(skillsDir: string): Promise<string[]> {
	const skills = await listSkills(skillsDir);
	return skills.map((s) => s.name);
}
