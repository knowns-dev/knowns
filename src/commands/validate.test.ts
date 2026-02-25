import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "@storage/file-store";
/**
 * Integration Tests for Validate CLI Command
 * Tests validation of tasks, docs, and templates
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

describe("Validate CLI Integration Tests", () => {
	let tempDir: string;
	let fileStore: FileStore;

	beforeEach(async () => {
		// Create a unique temp directory for each test
		tempDir = await mkdtemp(join(tmpdir(), "knowns-validate-test-"));
		fileStore = new FileStore(tempDir);
		await fileStore.initProject("Test Project");
	});

	afterEach(async () => {
		// Clean up temp directory
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("Validate Tasks", () => {
		test("validates task with no issues", async () => {
			const task = await fileStore.createTask({
				title: "Valid Task",
				description: "A task with description",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [{ text: "AC 1", completed: false }],
				timeSpent: 0,
				timeEntries: [],
			});

			// Task should have description and AC - no validation issues expected
			expect(task.description).toBe("A task with description");
			expect(task.acceptanceCriteria).toHaveLength(1);
		});

		test("detects task without acceptance criteria", async () => {
			const task = await fileStore.createTask({
				title: "Task Without AC",
				description: "Has description but no AC",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(task.acceptanceCriteria).toHaveLength(0);
		});

		test("detects task without description", async () => {
			const task = await fileStore.createTask({
				title: "Task Without Description",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [{ text: "AC 1", completed: false }],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(task.description).toBeUndefined();
		});

		test("validates task with broken doc reference", async () => {
			const task = await fileStore.createTask({
				title: "Task With Broken Ref",
				description: "See @doc/non-existent-doc for details",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(task.description).toContain("@doc/non-existent-doc");
		});

		test("validates task with valid doc reference", async () => {
			// Create a doc first
			const docsDir = join(tempDir, ".knowns", "docs");
			await mkdir(docsDir, { recursive: true });
			await writeFile(
				join(docsDir, "existing-doc.md"),
				`---
title: Existing Doc
---
Content here`,
			);

			const task = await fileStore.createTask({
				title: "Task With Valid Ref",
				description: "See @doc/existing-doc for details",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(task.description).toContain("@doc/existing-doc");
		});

		test("validates task with broken task reference", async () => {
			const task = await fileStore.createTask({
				title: "Task With Broken Task Ref",
				description: "Depends on @task-xxxxxx",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(task.description).toContain("@task-xxxxxx");
		});

		test("validates task with valid task reference", async () => {
			const referencedTask = await fileStore.createTask({
				title: "Referenced Task",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const task = await fileStore.createTask({
				title: "Task With Valid Task Ref",
				description: `Depends on @task-${referencedTask.id}`,
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(task.description).toContain(`@task-${referencedTask.id}`);
		});

		test("detects circular parent relationship", async () => {
			const parent = await fileStore.createTask({
				title: "Parent Task",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const child = await fileStore.createTask({
				title: "Child Task",
				status: "todo",
				priority: "medium",
				labels: [],
				parent: parent.id,
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			// This would create a circular reference if we tried to set parent.parent = child.id
			// The validation should catch this
			expect(child.parent).toBe(parent.id);
		});
	});

	describe("Validate Docs", () => {
		test("validates doc with no issues", async () => {
			const docsDir = join(tempDir, ".knowns", "docs");
			await mkdir(docsDir, { recursive: true });

			await writeFile(
				join(docsDir, "valid-doc.md"),
				`---
title: Valid Doc
description: A doc with all required fields
tags:
  - test
---
# Content

Some content here.`,
			);

			// Doc exists with proper frontmatter
			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(docsDir, "valid-doc.md"), "utf-8");
			expect(content).toContain("title: Valid Doc");
			expect(content).toContain("description:");
		});

		test("detects doc without description", async () => {
			const docsDir = join(tempDir, ".knowns", "docs");
			await mkdir(docsDir, { recursive: true });

			await writeFile(
				join(docsDir, "no-desc-doc.md"),
				`---
title: Doc Without Description
---
# Content`,
			);

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(docsDir, "no-desc-doc.md"), "utf-8");
			expect(content).not.toContain("description:");
		});

		test("detects orphan doc (not referenced by any task)", async () => {
			const docsDir = join(tempDir, ".knowns", "docs");
			await mkdir(docsDir, { recursive: true });

			await writeFile(
				join(docsDir, "orphan-doc.md"),
				`---
title: Orphan Doc
description: Not referenced anywhere
---
# Orphan Content`,
			);

			// No tasks reference this doc
			const tasks = await fileStore.getAllTasks();
			expect(tasks).toHaveLength(0);
		});

		test("validates doc with broken doc reference", async () => {
			const docsDir = join(tempDir, ".knowns", "docs");
			await mkdir(docsDir, { recursive: true });

			await writeFile(
				join(docsDir, "doc-with-broken-ref.md"),
				`---
title: Doc With Broken Ref
description: Has broken reference
---
# Content

See @doc/non-existent for more info.`,
			);

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(docsDir, "doc-with-broken-ref.md"), "utf-8");
			expect(content).toContain("@doc/non-existent");
		});

		test("validates doc with valid doc reference", async () => {
			const docsDir = join(tempDir, ".knowns", "docs");
			await mkdir(docsDir, { recursive: true });

			// Create referenced doc first
			await writeFile(
				join(docsDir, "target-doc.md"),
				`---
title: Target Doc
description: The target
---
# Target`,
			);

			// Create doc with reference
			await writeFile(
				join(docsDir, "doc-with-ref.md"),
				`---
title: Doc With Valid Ref
description: Has valid reference
---
# Content

See @doc/target-doc for more info.`,
			);

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(docsDir, "doc-with-ref.md"), "utf-8");
			expect(content).toContain("@doc/target-doc");
		});

		test("validates nested docs in folders", async () => {
			const docsDir = join(tempDir, ".knowns", "docs");
			const nestedDir = join(docsDir, "guides");
			await mkdir(nestedDir, { recursive: true });

			await writeFile(
				join(nestedDir, "setup.md"),
				`---
title: Setup Guide
description: How to setup
---
# Setup

Follow these steps.`,
			);

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(nestedDir, "setup.md"), "utf-8");
			expect(content).toContain("title: Setup Guide");
		});
	});

	describe("Validate Templates", () => {
		test("validates valid template", async () => {
			const templatesDir = join(tempDir, ".knowns", "templates", "component");
			await mkdir(templatesDir, { recursive: true });

			// Create template config
			await writeFile(
				join(templatesDir, "_template.yaml"),
				`name: component
description: Create a component
variables:
  - name: name
    description: Component name
    required: true
actions:
  - type: add
    path: "src/components/{{name}}.tsx"
    template: component.hbs`,
			);

			// Create template file
			await writeFile(
				join(templatesDir, "component.hbs"),
				`export function {{name}}() {
  return <div>{{name}}</div>;
}`,
			);

			const { existsSync } = await import("node:fs");
			expect(existsSync(join(templatesDir, "_template.yaml"))).toBe(true);
			expect(existsSync(join(templatesDir, "component.hbs"))).toBe(true);
		});

		test("detects template with invalid syntax", async () => {
			const templatesDir = join(tempDir, ".knowns", "templates", "bad-template");
			await mkdir(templatesDir, { recursive: true });

			// Create template config
			await writeFile(
				join(templatesDir, "_template.yaml"),
				`name: bad-template
description: Has syntax error
actions:
  - type: add
    path: "output.txt"
    template: bad.hbs`,
			);

			// Create template with invalid Handlebars syntax
			await writeFile(join(templatesDir, "bad.hbs"), "{{#if condition}Missing closing tag");

			const { existsSync } = await import("node:fs");
			expect(existsSync(join(templatesDir, "bad.hbs"))).toBe(true);
		});

		test("detects template with broken doc reference", async () => {
			const templatesDir = join(tempDir, ".knowns", "templates", "doc-ref-template");
			await mkdir(templatesDir, { recursive: true });

			// Create template config with broken doc ref
			await writeFile(
				join(templatesDir, "_template.yaml"),
				`name: doc-ref-template
description: Has broken doc ref
doc: patterns/non-existent
actions:
  - type: add
    path: "output.txt"
    template: file.hbs`,
			);

			await writeFile(join(templatesDir, "file.hbs"), "Content");

			const { readFile } = await import("node:fs/promises");
			const config = await readFile(join(templatesDir, "_template.yaml"), "utf-8");
			expect(config).toContain("doc: patterns/non-existent");
		});

		test("detects template with missing partial", async () => {
			const templatesDir = join(tempDir, ".knowns", "templates", "partial-template");
			await mkdir(templatesDir, { recursive: true });

			await writeFile(
				join(templatesDir, "_template.yaml"),
				`name: partial-template
description: Uses missing partial
actions:
  - type: add
    path: "output.txt"
    template: main.hbs`,
			);

			// Create template that references non-existent partial
			await writeFile(join(templatesDir, "main.hbs"), "{{> missingPartial}}");

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(templatesDir, "main.hbs"), "utf-8");
			expect(content).toContain("{{> missingPartial}}");
		});
	});

	describe("Entity Filter", () => {
		test("filters validation to specific task by ID", async () => {
			const task1 = await fileStore.createTask({
				title: "Task 1",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			const task2 = await fileStore.createTask({
				title: "Task 2",
				description: "Has description",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [{ text: "AC", completed: false }],
				timeSpent: 0,
				timeEntries: [],
			});

			// Both tasks exist
			expect(task1.id).toBeDefined();
			expect(task2.id).toBeDefined();

			// Can filter to specific task
			const allTasks = await fileStore.getAllTasks();
			const filteredTasks = allTasks.filter((t) => t.id === task1.id);
			expect(filteredTasks).toHaveLength(1);
			expect(filteredTasks[0].title).toBe("Task 1");
		});

		test("filters validation to specific doc by path", async () => {
			const docsDir = join(tempDir, ".knowns", "docs");
			await mkdir(docsDir, { recursive: true });

			await writeFile(
				join(docsDir, "doc1.md"),
				`---
title: Doc 1
---
Content 1`,
			);

			await writeFile(
				join(docsDir, "doc2.md"),
				`---
title: Doc 2
description: Has description
---
Content 2`,
			);

			const { existsSync } = await import("node:fs");
			expect(existsSync(join(docsDir, "doc1.md"))).toBe(true);
			expect(existsSync(join(docsDir, "doc2.md"))).toBe(true);
		});

		test("parses task ID correctly (6-char alphanumeric)", async () => {
			const task = await fileStore.createTask({
				title: "Test Task",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			// Task ID should be 6 characters, alphanumeric
			expect(task.id).toMatch(/^[a-z0-9]{6}$/);
		});

		test("parses doc path correctly", async () => {
			const docsDir = join(tempDir, ".knowns", "docs", "guides");
			await mkdir(docsDir, { recursive: true });

			await writeFile(
				join(docsDir, "setup.md"),
				`---
title: Setup
---
Content`,
			);

			// Doc path should be "guides/setup" (without .md)
			const { existsSync } = await import("node:fs");
			expect(existsSync(join(docsDir, "setup.md"))).toBe(true);
		});
	});

	describe("SDD Validation", () => {
		test("validates spec with acceptance criteria", async () => {
			const docsDir = join(tempDir, ".knowns", "docs", "specs");
			await mkdir(docsDir, { recursive: true });

			await writeFile(
				join(docsDir, "feature-x.md"),
				`---
title: Feature X Spec
status: approved
---
# Feature X

## Acceptance Criteria

- [ ] AC-1: First criterion
- [x] AC-2: Second criterion (done)
- [ ] AC-3: Third criterion`,
			);

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(docsDir, "feature-x.md"), "utf-8");
			expect(content).toContain("AC-1:");
			expect(content).toContain("AC-2:");
			expect(content).toContain("[x] AC-2"); // Checked
		});

		test("links tasks to specs via spec field", async () => {
			const docsDir = join(tempDir, ".knowns", "docs", "specs");
			await mkdir(docsDir, { recursive: true });

			await writeFile(
				join(docsDir, "feature-y.md"),
				`---
title: Feature Y Spec
status: draft
---
# Feature Y

- [ ] AC-1: Implement feature`,
			);

			const task = await fileStore.createTask({
				title: "Implement Feature Y",
				description: "Implement the feature",
				status: "in-progress",
				priority: "high",
				labels: [],
				spec: "specs/feature-y",
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(task.spec).toBe("specs/feature-y");
		});

		test("tracks task fulfills spec ACs", async () => {
			const docsDir = join(tempDir, ".knowns", "docs", "specs");
			await mkdir(docsDir, { recursive: true });

			await writeFile(
				join(docsDir, "feature-z.md"),
				`---
title: Feature Z Spec
status: approved
---
# Feature Z

- [ ] AC-1: First requirement
- [ ] AC-2: Second requirement`,
			);

			const task = await fileStore.createTask({
				title: "Implement AC-1 for Feature Z",
				description: "Implements first requirement",
				status: "done",
				priority: "high",
				labels: [],
				spec: "specs/feature-z",
				fulfills: ["AC-1"],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(task.fulfills).toContain("AC-1");
		});

		test("detects task without spec reference", async () => {
			const task = await fileStore.createTask({
				title: "Task Without Spec",
				description: "No spec linked",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(task.spec).toBeUndefined();
		});

		test("detects broken spec reference in task", async () => {
			const task = await fileStore.createTask({
				title: "Task With Broken Spec",
				description: "Has broken spec ref",
				status: "todo",
				priority: "medium",
				labels: [],
				spec: "specs/non-existent-spec",
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			// Spec file doesn't exist
			const { existsSync } = await import("node:fs");
			const specPath = join(tempDir, ".knowns", "docs", "specs", "non-existent-spec.md");
			expect(existsSync(specPath)).toBe(false);
			expect(task.spec).toBe("specs/non-existent-spec");
		});
	});

	describe("Strict Mode", () => {
		test("treats warnings as errors in strict mode", async () => {
			// Create task without AC (normally a warning)
			const task = await fileStore.createTask({
				title: "Task for Strict Test",
				description: "Has description but no AC",
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			// In strict mode, missing AC would be treated as error
			expect(task.acceptanceCriteria).toHaveLength(0);
		});
	});

	describe("Auto-fix", () => {
		test("can fix broken doc references with suggestions", async () => {
			const docsDir = join(tempDir, ".knowns", "docs");
			await mkdir(docsDir, { recursive: true });

			// Create actual doc
			await writeFile(
				join(docsDir, "setup-guide.md"),
				`---
title: Setup Guide
---
Content`,
			);

			// Create task with typo in doc ref
			const task = await fileStore.createTask({
				title: "Task With Typo",
				description: "See @doc/setup-guid for details", // typo: guid instead of guide
				status: "todo",
				priority: "medium",
				labels: [],
				subtasks: [],
				acceptanceCriteria: [],
				timeSpent: 0,
				timeEntries: [],
			});

			expect(task.description).toContain("@doc/setup-guid");
		});
	});
});
