/**
 * Unit Tests for Project Domain Model
 */
import { describe, expect, test } from "vitest";
import { type Project, type ProjectSettings, createDefaultProjectSettings, createProject } from "./project";

describe("Project Entity", () => {
	describe("createProject", () => {
		test("creates a project with given name", () => {
			const project = createProject("My Project");

			expect(project.name).toBe("My Project");
		});

		test("generates id from name when not provided", () => {
			const project = createProject("My Cool Project");

			expect(project.id).toBe("my-cool-project");
		});

		test("uses provided id when given", () => {
			const project = createProject("My Project", "custom-id");

			expect(project.id).toBe("custom-id");
		});

		test("sets createdAt to current time", () => {
			const before = new Date();
			const project = createProject("Test");
			const after = new Date();

			expect(project.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
			expect(project.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
		});

		test("initializes with default settings", () => {
			const project = createProject("Test");

			expect(project.settings).toBeDefined();
			expect(project.settings.defaultPriority).toBe("medium");
			expect(project.settings.statuses).toContain("todo");
			expect(project.settings.statuses).toContain("done");
		});

		test("handles names with special characters", () => {
			const project = createProject("Project  With   Multiple   Spaces");

			expect(project.id).toBe("project-with-multiple-spaces");
		});

		test("handles single word names", () => {
			const project = createProject("Backend");

			expect(project.id).toBe("backend");
		});

		test("handles names with numbers", () => {
			const project = createProject("Project 2025");

			expect(project.id).toBe("project-2025");
		});
	});
});

describe("ProjectSettings", () => {
	describe("createDefaultProjectSettings", () => {
		test("returns settings with medium priority", () => {
			const settings = createDefaultProjectSettings();

			expect(settings.defaultPriority).toBe("medium");
		});

		test("returns settings without default assignee", () => {
			const settings = createDefaultProjectSettings();

			expect(settings.defaultAssignee).toBeUndefined();
		});

		test("returns all standard statuses", () => {
			const settings = createDefaultProjectSettings();

			expect(settings.statuses).toEqual(["todo", "in-progress", "in-review", "done", "blocked", "on-hold", "urgent"]);
		});

		test("returns statuses in workflow order", () => {
			const settings = createDefaultProjectSettings();

			expect(settings.statuses[0]).toBe("todo");
			expect(settings.statuses[settings.statuses.length - 1]).toBe("urgent");
		});

		test("returns a new object each time", () => {
			const settings1 = createDefaultProjectSettings();
			const settings2 = createDefaultProjectSettings();

			expect(settings1).not.toBe(settings2);
			expect(settings1.statuses).not.toBe(settings2.statuses);
		});
	});

	describe("ProjectSettings interface", () => {
		test("allows custom default assignee", () => {
			const settings: ProjectSettings = {
				defaultAssignee: "@team-lead",
				defaultPriority: "high",
				statuses: ["todo", "done"],
			};

			expect(settings.defaultAssignee).toBe("@team-lead");
		});

		test("allows custom priority", () => {
			const settings: ProjectSettings = {
				defaultPriority: "high",
				statuses: ["todo", "done"],
			};

			expect(settings.defaultPriority).toBe("high");
		});

		test("allows custom statuses", () => {
			const settings: ProjectSettings = {
				defaultPriority: "medium",
				statuses: ["backlog", "todo", "done"],
			};

			expect(settings.statuses).toHaveLength(3);
			expect(settings.statuses).toContain("backlog");
		});
	});
});
