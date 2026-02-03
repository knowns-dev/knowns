/**
 * Knowns Skills Module
 *
 * Built-in skills for Claude Code integration.
 * Skills are workflow templates that can be invoked via /kn:<skill> commands.
 *
 * Structure follows superpowers pattern:
 * - Each skill is in a subfolder with SKILL.md
 * - Frontmatter contains name and description
 * - Content is the skill instructions
 */

import knCommitMd from "./kn:commit/SKILL.md";
import knDocMd from "./kn:doc/SKILL.md";
import knExtractMd from "./kn:extract/SKILL.md";
import knImplementMd from "./kn:implement/SKILL.md";
import knInitMd from "./kn:init/SKILL.md";
import knPlanMd from "./kn:plan/SKILL.md";
import knResearchMd from "./kn:research/SKILL.md";
import knTemplateMd from "./kn:template/SKILL.md";

/**
 * Skill definition
 */
export interface Skill {
	/** Skill name (e.g., "kn:init") */
	name: string;
	/** Folder name for .claude/skills/ */
	folderName: string;
	/** Skill description */
	description: string;
	/** Full skill content (markdown with frontmatter) */
	content: string;
}

/**
 * Parse skill frontmatter to extract name and description
 */
function parseSkillFrontmatter(content: string): { name: string; description: string } {
	const lines = content.trim().split("\n");
	let name = "";
	let description = "";

	if (lines[0] === "---") {
		for (let i = 1; i < lines.length; i++) {
			if (lines[i] === "---") break;

			const nameMatch = lines[i].match(/^name:\s*(.+)$/);
			if (nameMatch) name = nameMatch[1].trim();

			const descMatch = lines[i].match(/^description:\s*(.+)$/);
			if (descMatch) description = descMatch[1].trim();
		}
	}

	return { name, description };
}

/**
 * Create skill object from markdown content
 */
function createSkill(content: string, folderName: string): Skill {
	const { name, description } = parseSkillFrontmatter(content);
	return {
		name: name || folderName,
		folderName,
		description,
		content: content.trim(),
	};
}

// Export individual skills
export const SKILL_INIT = createSkill(knInitMd, "kn:init");
export const SKILL_PLAN = createSkill(knPlanMd, "kn:plan");
export const SKILL_IMPLEMENT = createSkill(knImplementMd, "kn:implement");
export const SKILL_RESEARCH = createSkill(knResearchMd, "kn:research");
export const SKILL_COMMIT = createSkill(knCommitMd, "kn:commit");
export const SKILL_EXTRACT = createSkill(knExtractMd, "kn:extract");
export const SKILL_DOC = createSkill(knDocMd, "kn:doc");
export const SKILL_TEMPLATE = createSkill(knTemplateMd, "kn:template");

/**
 * All built-in skills
 */
export const SKILLS: Skill[] = [
	SKILL_INIT,
	SKILL_PLAN,
	SKILL_IMPLEMENT,
	SKILL_RESEARCH,
	SKILL_COMMIT,
	SKILL_EXTRACT,
	SKILL_DOC,
	SKILL_TEMPLATE,
];

/**
 * Get skill by name
 */
export function getSkill(name: string): Skill | undefined {
	return SKILLS.find((s) => s.name === name);
}

/**
 * Get skill by folder name
 */
export function getSkillByFolder(folderName: string): Skill | undefined {
	return SKILLS.find((s) => s.folderName === folderName);
}

/**
 * Get all skill names
 */
export function getSkillNames(): string[] {
	return SKILLS.map((s) => s.name);
}

export default SKILLS;
