/**
 * Skill Parser and Sync Tests
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PLATFORMS,
	type Platform,
	type Skill,
	getPlatform,
	getPlatformIds,
	getSkillNames,
	isValidSkillDir,
	listSkills,
	loadSkill,
	loadSkillByName,
	parseSkillFrontmatter,
	syncSkills,
} from "./index";

describe("Skill Parser", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `skill-parser-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("parseSkillFrontmatter", () => {
		it("should parse valid frontmatter", () => {
			const content = `---
name: test-skill
description: A test skill
---

# Test Skill

Content here.
`;
			const result = parseSkillFrontmatter(content);
			expect(result.name).toBe("test-skill");
			expect(result.description).toBe("A test skill");
		});

		it("should return empty object for invalid frontmatter", () => {
			const content = "No frontmatter here";
			const result = parseSkillFrontmatter(content);
			expect(result).toEqual({});
		});

		it("should handle empty content", () => {
			const result = parseSkillFrontmatter("");
			expect(result).toEqual({});
		});
	});

	describe("loadSkill", () => {
		it("should load skill from directory", async () => {
			const skillDir = join(testDir, "my-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: my-skill
description: My skill description
---

# My Skill

Instructions here.
`,
				"utf-8",
			);

			const skill = await loadSkill(skillDir);
			expect(skill).not.toBeNull();
			expect(skill?.name).toBe("my-skill");
			expect(skill?.description).toBe("My skill description");
			expect(skill?.folderName).toBe("my-skill");
		});

		it("should return null for missing SKILL.md", async () => {
			const skillDir = join(testDir, "empty-skill");
			mkdirSync(skillDir, { recursive: true });

			const skill = await loadSkill(skillDir);
			expect(skill).toBeNull();
		});

		it("should use folder name if name not in frontmatter", async () => {
			const skillDir = join(testDir, "folder-name-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
description: No name field
---

Content
`,
				"utf-8",
			);

			const skill = await loadSkill(skillDir);
			expect(skill?.name).toBe("folder-name-skill");
		});
	});

	describe("loadSkillByName", () => {
		it("should load skill by name", async () => {
			const skillDir = join(testDir, "named-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: named-skill
---

Content
`,
				"utf-8",
			);

			const skill = await loadSkillByName(testDir, "named-skill");
			expect(skill).not.toBeNull();
			expect(skill?.name).toBe("named-skill");
		});

		it("should return null for non-existent skill", async () => {
			const skill = await loadSkillByName(testDir, "non-existent");
			expect(skill).toBeNull();
		});
	});

	describe("listSkills", () => {
		it("should list all skills", async () => {
			// Create multiple skills
			for (const name of ["skill-a", "skill-b", "skill-c"]) {
				const dir = join(testDir, name);
				mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(dir, "SKILL.md"),
					`---
name: ${name}
---

Content
`,
					"utf-8",
				);
			}

			const skills = await listSkills(testDir);
			expect(skills).toHaveLength(3);
			expect(skills.map((s) => s.name)).toEqual(["skill-a", "skill-b", "skill-c"]);
		});

		it("should return empty array for non-existent directory", async () => {
			const skills = await listSkills(join(testDir, "non-existent"));
			expect(skills).toEqual([]);
		});

		it("should ignore files (only process directories)", async () => {
			writeFileSync(join(testDir, "not-a-skill.txt"), "content", "utf-8");
			const skillDir = join(testDir, "real-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(join(skillDir, "SKILL.md"), "---\nname: real-skill\n---\n", "utf-8");

			const skills = await listSkills(testDir);
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("real-skill");
		});
	});

	describe("isValidSkillDir", () => {
		it("should return true for valid skill directory", () => {
			const skillDir = join(testDir, "valid-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(join(skillDir, "SKILL.md"), "content", "utf-8");

			expect(isValidSkillDir(skillDir)).toBe(true);
		});

		it("should return false for directory without SKILL.md", () => {
			const skillDir = join(testDir, "invalid-skill");
			mkdirSync(skillDir, { recursive: true });

			expect(isValidSkillDir(skillDir)).toBe(false);
		});
	});

	describe("getSkillNames", () => {
		it("should return skill names", async () => {
			for (const name of ["alpha", "beta"]) {
				const dir = join(testDir, name);
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf-8");
			}

			const names = await getSkillNames(testDir);
			expect(names).toEqual(["alpha", "beta"]);
		});
	});
});

describe("Skill Sync", () => {
	let projectRoot: string;
	let skillsDir: string;

	beforeEach(() => {
		projectRoot = join(tmpdir(), `skill-sync-test-${Date.now()}`);
		skillsDir = join(projectRoot, ".knowns", "skills");
		mkdirSync(skillsDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(projectRoot)) {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	describe("getPlatform", () => {
		it("should return platform config by id", () => {
			const claude = getPlatform("claude");
			expect(claude).toBeDefined();
			expect(claude?.name).toBe("Claude Code");
			expect(claude?.targetDir).toBe(".claude/skills");
		});

		it("should return undefined for unknown platform", () => {
			const unknown = getPlatform("unknown" as Platform);
			expect(unknown).toBeUndefined();
		});
	});

	describe("getPlatformIds", () => {
		it("should return all platform ids", () => {
			const ids = getPlatformIds();
			expect(ids).toContain("claude");
			expect(ids).toContain("cursor");
			expect(ids).toContain("windsurf");
			expect(ids).toContain("gemini");
		});
	});

	describe("PLATFORMS", () => {
		it("should have correct configurations", () => {
			expect(PLATFORMS.length).toBeGreaterThan(0);

			for (const platform of PLATFORMS) {
				expect(platform.id).toBeTruthy();
				expect(platform.name).toBeTruthy();
				expect(platform.targetDir).toBeTruthy();
				expect(platform.filePattern).toMatch(/^(folder|single|append)$/);
			}
		});
	});

	describe("syncSkills", () => {
		beforeEach(() => {
			// Create a test skill
			const skillDir = join(skillsDir, "test-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: test-skill
description: Test skill for sync
---

# Test Skill

Instructions here.
`,
				"utf-8",
			);
		});

		it("should sync skills to claude platform (folder pattern)", async () => {
			const results = await syncSkills({
				projectRoot,
				skillsDir,
				platforms: ["claude"],
			});

			expect(results).toHaveLength(1);
			expect(results[0].platform).toBe("claude");
			expect(results[0].created).toBe(1);
			expect(results[0].errors).toHaveLength(0);

			// Verify file created
			const targetFile = join(projectRoot, ".claude", "skills", "test-skill", "SKILL.md");
			expect(existsSync(targetFile)).toBe(true);
		});

		it("should sync skills to windsurf platform (single file pattern)", async () => {
			const results = await syncSkills({
				projectRoot,
				skillsDir,
				platforms: ["windsurf"],
			});

			expect(results).toHaveLength(1);
			expect(results[0].platform).toBe("windsurf");
			expect(results[0].created).toBe(1);

			// Verify single file created
			const targetFile = join(projectRoot, ".windsurfrules");
			expect(existsSync(targetFile)).toBe(true);
			const content = readFileSync(targetFile, "utf-8");
			expect(content).toContain("test-skill");
		});

		it("should sync skills to gemini platform (append pattern)", async () => {
			const results = await syncSkills({
				projectRoot,
				skillsDir,
				platforms: ["gemini"],
			});

			expect(results).toHaveLength(1);
			expect(results[0].platform).toBe("gemini");
			expect(results[0].created).toBe(1);

			// Verify file created with markers
			const targetFile = join(projectRoot, "GEMINI.md");
			expect(existsSync(targetFile)).toBe(true);
			const content = readFileSync(targetFile, "utf-8");
			expect(content).toContain("<!-- KNOWNS SKILLS START -->");
			expect(content).toContain("<!-- KNOWNS SKILLS END -->");
			expect(content).toContain("test-skill");
		});

		it("should skip existing files without force flag", async () => {
			// First sync
			await syncSkills({
				projectRoot,
				skillsDir,
				platforms: ["claude"],
			});

			// Second sync without force
			const results = await syncSkills({
				projectRoot,
				skillsDir,
				platforms: ["claude"],
			});

			expect(results[0].skipped).toBe(1);
			expect(results[0].created).toBe(0);
			expect(results[0].updated).toBe(0);
		});

		it("should update files with force flag", async () => {
			// First sync
			await syncSkills({
				projectRoot,
				skillsDir,
				platforms: ["claude"],
			});

			// Modify source skill
			writeFileSync(
				join(skillsDir, "test-skill", "SKILL.md"),
				`---
name: test-skill
---

# Updated Content
`,
				"utf-8",
			);

			// Second sync with force
			const results = await syncSkills({
				projectRoot,
				skillsDir,
				platforms: ["claude"],
				force: true,
			});

			expect(results[0].updated).toBe(1);
		});

		it("should support dry run mode", async () => {
			const results = await syncSkills({
				projectRoot,
				skillsDir,
				platforms: ["claude"],
				dryRun: true,
			});

			expect(results[0].created).toBe(1);

			// Verify no file created
			const targetFile = join(projectRoot, ".claude", "skills", "test-skill", "SKILL.md");
			expect(existsSync(targetFile)).toBe(false);
		});

		it("should sync to multiple platforms", async () => {
			const results = await syncSkills({
				projectRoot,
				skillsDir,
				platforms: ["claude", "cursor"],
			});

			expect(results).toHaveLength(2);
			expect(results[0].platform).toBe("claude");
			expect(results[1].platform).toBe("cursor");
		});

		it("should return empty result for no skills", async () => {
			// Remove the test skill
			rmSync(join(skillsDir, "test-skill"), { recursive: true, force: true });

			const results = await syncSkills({
				projectRoot,
				skillsDir,
				platforms: ["claude"],
			});

			expect(results[0].created).toBe(0);
			expect(results[0].updated).toBe(0);
			expect(results[0].skipped).toBe(0);
		});
	});
});
