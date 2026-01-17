/**
 * Knowns Skills Module
 *
 * Built-in skills for Claude Code integration.
 * Skills are workflow templates that can be invoked via /knowns.<skill> commands.
 *
 * Structure follows superpowers pattern:
 * - Each skill is in a subfolder with SKILL.md
 * - Frontmatter contains name and description
 * - Content is the skill instructions
 */

import knownsCommitMd from "./knowns.commit/SKILL.md";
import knownsDocMd from "./knowns.doc/SKILL.md";
import knownsInitMd from "./knowns.init/SKILL.md";
import knownsResearchMd from "./knowns.research/SKILL.md";
import knownsTaskBrainstormMd from "./knowns.task.brainstorm/SKILL.md";
import knownsTaskExtractMd from "./knowns.task.extract/SKILL.md";
import knownsTaskReopenMd from "./knowns.task.reopen/SKILL.md";
// Import skill templates
import knownsTaskMd from "./knowns.task/SKILL.md";

/**
 * Skill definition
 */
export interface Skill {
	/** Skill name (e.g., "knowns.task") */
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
export const SKILL_TASK = createSkill(knownsTaskMd, "knowns.task");
export const SKILL_TASK_BRAINSTORM = createSkill(knownsTaskBrainstormMd, "knowns.task.brainstorm");
export const SKILL_TASK_REOPEN = createSkill(knownsTaskReopenMd, "knowns.task.reopen");
export const SKILL_TASK_EXTRACT = createSkill(knownsTaskExtractMd, "knowns.task.extract");
export const SKILL_DOC = createSkill(knownsDocMd, "knowns.doc");
export const SKILL_COMMIT = createSkill(knownsCommitMd, "knowns.commit");
export const SKILL_INIT = createSkill(knownsInitMd, "knowns.init");
export const SKILL_RESEARCH = createSkill(knownsResearchMd, "knowns.research");

/**
 * All built-in skills
 */
export const SKILLS: Skill[] = [
	// Task skills
	SKILL_TASK,
	SKILL_TASK_BRAINSTORM,
	SKILL_TASK_REOPEN,
	SKILL_TASK_EXTRACT,
	// Doc skills
	SKILL_DOC,
	// Git skills
	SKILL_COMMIT,
	// Session skills
	SKILL_INIT,
	SKILL_RESEARCH,
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
