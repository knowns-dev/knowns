/**
 * Unit Tests for Template CLI Commands
 */

import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listTemplates, loadTemplateByName } from "../codegen";

const TEST_DIR = join(process.cwd(), ".knowns-test-templates");

describe("Template CLI", () => {
	beforeEach(async () => {
		// Create test templates directory
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		// Cleanup test directory
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	describe("listTemplates", () => {
		test("returns empty array when no templates exist", async () => {
			const templates = await listTemplates(TEST_DIR);
			expect(templates).toEqual([]);
		});

		test("lists templates with valid config", async () => {
			// Create a test template
			const templateDir = join(TEST_DIR, "test-template");
			await mkdir(templateDir, { recursive: true });

			const config = `
name: test-template
description: A test template
version: 1.0.0
prompts:
  - name: testName
    type: text
    message: Enter name
actions:
  - type: add
    template: example.hbs
    path: "{{testName}}.ts"
`;
			await writeFile(join(templateDir, "_template.yaml"), config, "utf-8");
			await writeFile(join(templateDir, "example.hbs"), "// {{testName}}", "utf-8");

			const templates = await listTemplates(TEST_DIR);

			expect(templates).toHaveLength(1);
			expect(templates[0].name).toBe("test-template");
			expect(templates[0].description).toBe("A test template");
		});

		test("ignores directories without _template.yaml", async () => {
			// Create a directory without config
			const invalidDir = join(TEST_DIR, "invalid-template");
			await mkdir(invalidDir, { recursive: true });
			await writeFile(join(invalidDir, "readme.md"), "# Not a template", "utf-8");

			const templates = await listTemplates(TEST_DIR);
			expect(templates).toEqual([]);
		});
	});

	describe("loadTemplateByName", () => {
		test("loads template with valid config", async () => {
			// Create a test template
			const templateDir = join(TEST_DIR, "my-template");
			await mkdir(templateDir, { recursive: true });

			const config = `
name: my-template
description: My template description
prompts:
  - name: componentName
    type: text
    message: Component name?
actions:
  - type: add
    template: Component.tsx.hbs
    path: "{{pascalCase componentName}}.tsx"
`;
			await writeFile(join(templateDir, "_template.yaml"), config, "utf-8");
			await writeFile(
				join(templateDir, "Component.tsx.hbs"),
				"export function {{pascalCase componentName}}() {}",
				"utf-8",
			);

			const template = await loadTemplateByName(TEST_DIR, "my-template");

			expect(template.config.name).toBe("my-template");
			expect(template.config.description).toBe("My template description");
			expect(template.config.prompts).toHaveLength(1);
			expect(template.config.prompts?.[0].name).toBe("componentName");
			expect(template.config.actions).toHaveLength(1);
			expect(template.files).toContain("Component.tsx.hbs");
		});

		test("throws error for non-existent template", async () => {
			await expect(loadTemplateByName(TEST_DIR, "non-existent")).rejects.toThrow();
		});

		test("throws error for invalid config", async () => {
			const templateDir = join(TEST_DIR, "invalid");
			await mkdir(templateDir, { recursive: true });

			// Config missing required 'name' field
			await writeFile(join(templateDir, "_template.yaml"), "description: No name", "utf-8");

			await expect(loadTemplateByName(TEST_DIR, "invalid")).rejects.toThrow();
		});
	});

	describe("Template Config Validation", () => {
		test("accepts minimal config with just name", async () => {
			const templateDir = join(TEST_DIR, "minimal");
			await mkdir(templateDir, { recursive: true });

			await writeFile(join(templateDir, "_template.yaml"), "name: minimal", "utf-8");

			const template = await loadTemplateByName(TEST_DIR, "minimal");
			expect(template.config.name).toBe("minimal");
		});

		test("accepts config with all fields", async () => {
			const templateDir = join(TEST_DIR, "full");
			await mkdir(templateDir, { recursive: true });

			const config = `
name: full-template
description: Full template with all fields
version: 2.0.0
author: test-author
destination: src/components
doc: patterns/component
prompts:
  - name: name
    type: text
    message: Name?
    initial: Default
    validate: required
  - name: withTest
    type: confirm
    message: Include tests?
    initial: true
  - name: framework
    type: select
    message: Framework?
    choices:
      - title: React
        value: react
      - title: Vue
        value: vue
actions:
  - type: add
    template: main.hbs
    path: "{{name}}.ts"
  - type: add
    template: test.hbs
    path: "{{name}}.test.ts"
    when: "{{withTest}}"
messages:
  success: "Created {{name}}!"
`;
			await writeFile(join(templateDir, "_template.yaml"), config, "utf-8");
			await writeFile(join(templateDir, "main.hbs"), "// main", "utf-8");
			await writeFile(join(templateDir, "test.hbs"), "// test", "utf-8");

			const template = await loadTemplateByName(TEST_DIR, "full");

			expect(template.config.name).toBe("full-template");
			expect(template.config.version).toBe("2.0.0");
			expect(template.config.destination).toBe("src/components");
			expect(template.config.doc).toBe("patterns/component");
			expect(template.config.prompts).toHaveLength(3);
			expect(template.config.actions).toHaveLength(2);
			expect(template.config.messages?.success).toBe("Created {{name}}!");
		});
	});
});
