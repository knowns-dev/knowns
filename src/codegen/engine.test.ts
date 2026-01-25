/**
 * Unit Tests for Template Engine
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerHelpers } from "./helpers";
import { evaluateCondition, renderPath, renderString, resetHandlebars } from "./renderer";
import {
	TemplateConfigSchema,
	TemplatePromptSchema,
	safeValidateTemplateConfig,
	validateTemplateConfig,
} from "./schema";

describe("Template Engine", () => {
	beforeEach(() => {
		resetHandlebars();
	});

	afterEach(() => {
		resetHandlebars();
	});

	describe("Handlebars Helpers", () => {
		describe("Case Conversion", () => {
			test("camelCase converts string correctly", () => {
				expect(renderString("{{camelCase name}}", { name: "user profile" })).toBe("userProfile");
				expect(renderString("{{camelCase name}}", { name: "UserProfile" })).toBe("userProfile");
			});

			test("pascalCase converts string correctly", () => {
				expect(renderString("{{pascalCase name}}", { name: "user profile" })).toBe("UserProfile");
				expect(renderString("{{pascalCase name}}", { name: "user-profile" })).toBe("UserProfile");
			});

			test("kebabCase converts string correctly", () => {
				expect(renderString("{{kebabCase name}}", { name: "userProfile" })).toBe("user-profile");
				expect(renderString("{{kebabCase name}}", { name: "UserProfile" })).toBe("user-profile");
			});

			test("snakeCase converts string correctly", () => {
				expect(renderString("{{snakeCase name}}", { name: "userProfile" })).toBe("user_profile");
				expect(renderString("{{snakeCase name}}", { name: "UserProfile" })).toBe("user_profile");
			});

			test("constantCase converts string correctly", () => {
				expect(renderString("{{constantCase name}}", { name: "userProfile" })).toBe("USER_PROFILE");
			});

			test("titleCase converts string correctly", () => {
				expect(renderString("{{titleCase name}}", { name: "user profile" })).toBe("User Profile");
			});
		});

		describe("String Manipulation", () => {
			test("lowerCase converts to lowercase", () => {
				expect(renderString("{{lowerCase name}}", { name: "HELLO" })).toBe("hello");
			});

			test("upperCase converts to uppercase", () => {
				expect(renderString("{{upperCase name}}", { name: "hello" })).toBe("HELLO");
			});

			test("trim removes whitespace", () => {
				expect(renderString("{{trim name}}", { name: "  hello  " })).toBe("hello");
			});
		});

		describe("Pluralization", () => {
			test("pluralize converts to plural form", () => {
				expect(renderString("{{pluralize name}}", { name: "user" })).toBe("users");
				expect(renderString("{{pluralize name}}", { name: "child" })).toBe("children");
			});

			test("singularize converts to singular form", () => {
				expect(renderString("{{singularize name}}", { name: "users" })).toBe("user");
				expect(renderString("{{singularize name}}", { name: "children" })).toBe("child");
			});
		});

		describe("Comparison Helpers", () => {
			test("eq compares equality", () => {
				expect(renderString("{{#if (eq a b)}}yes{{/if}}", { a: 1, b: 1 })).toBe("yes");
				expect(renderString("{{#if (eq a b)}}yes{{/if}}", { a: 1, b: 2 })).toBe("");
			});

			test("ne compares inequality", () => {
				expect(renderString("{{#if (ne a b)}}yes{{/if}}", { a: 1, b: 2 })).toBe("yes");
				expect(renderString("{{#if (ne a b)}}yes{{/if}}", { a: 1, b: 1 })).toBe("");
			});
		});

		describe("Logical Helpers", () => {
			test("and returns true if all values are truthy", () => {
				expect(renderString("{{#if (and a b)}}yes{{/if}}", { a: true, b: true })).toBe("yes");
				expect(renderString("{{#if (and a b)}}yes{{/if}}", { a: true, b: false })).toBe("");
			});

			test("or returns true if any value is truthy", () => {
				expect(renderString("{{#if (or a b)}}yes{{/if}}", { a: true, b: false })).toBe("yes");
				expect(renderString("{{#if (or a b)}}yes{{/if}}", { a: false, b: false })).toBe("");
			});

			test("not negates value", () => {
				expect(renderString("{{#if (not a)}}yes{{/if}}", { a: false })).toBe("yes");
				expect(renderString("{{#if (not a)}}yes{{/if}}", { a: true })).toBe("");
			});
		});
	});

	describe("Renderer", () => {
		describe("renderString", () => {
			test("renders simple variable", () => {
				expect(renderString("Hello {{name}}!", { name: "World" })).toBe("Hello World!");
			});

			test("renders nested variables", () => {
				const result = renderString("{{user.name}} ({{user.email}})", {
					user: { name: "John", email: "john@example.com" },
				});
				expect(result).toBe("John (john@example.com)");
			});

			test("renders conditional blocks", () => {
				expect(renderString("{{#if show}}visible{{/if}}", { show: true })).toBe("visible");
				expect(renderString("{{#if show}}visible{{/if}}", { show: false })).toBe("");
			});

			test("renders each loops", () => {
				const result = renderString("{{#each items}}{{this}},{{/each}}", {
					items: ["a", "b", "c"],
				});
				expect(result).toBe("a,b,c,");
			});
		});

		describe("renderPath", () => {
			test("renders path with helpers", () => {
				expect(renderPath("{{pascalCase name}}.tsx.hbs", { name: "user profile" })).toBe("UserProfile.tsx");
			});

			test("removes .hbs extension", () => {
				expect(renderPath("Component.tsx.hbs", {})).toBe("Component.tsx");
			});

			test("keeps path without .hbs extension", () => {
				expect(renderPath("Component.tsx", {})).toBe("Component.tsx");
			});
		});

		describe("evaluateCondition", () => {
			test("returns true for undefined condition", () => {
				expect(evaluateCondition(undefined, {})).toBe(true);
			});

			test("evaluates simple variable reference", () => {
				expect(evaluateCondition("{{show}}", { show: true })).toBe(true);
				expect(evaluateCondition("{{show}}", { show: false })).toBe(false);
			});

			test("evaluates bare variable name", () => {
				expect(evaluateCondition("show", { show: true })).toBe(true);
				expect(evaluateCondition("show", { show: false })).toBe(false);
			});
		});
	});

	describe("Schema Validation", () => {
		describe("TemplateConfigSchema", () => {
			test("validates minimal config", () => {
				const config = { name: "test-template" };
				const result = safeValidateTemplateConfig(config);
				expect(result.success).toBe(true);
			});

			test("validates full config", () => {
				const config = {
					name: "react-component",
					description: "Create a React component",
					version: "1.0.0",
					destination: "src/components",
					prompts: [
						{
							name: "componentName",
							type: "text",
							message: "Component name?",
						},
					],
					actions: [
						{
							type: "add",
							template: "Component.tsx.hbs",
							path: "{{pascalCase componentName}}.tsx",
						},
					],
				};
				const result = safeValidateTemplateConfig(config);
				expect(result.success).toBe(true);
			});

			test("rejects config without name", () => {
				const config = { description: "Missing name" };
				const result = safeValidateTemplateConfig(config);
				expect(result.success).toBe(false);
			});

			test("rejects invalid prompt type", () => {
				const config = {
					name: "test",
					prompts: [
						{
							name: "foo",
							type: "invalid",
							message: "test",
						},
					],
				};
				const result = safeValidateTemplateConfig(config);
				expect(result.success).toBe(false);
			});

			test("rejects invalid action type", () => {
				const config = {
					name: "test",
					actions: [
						{
							type: "invalid",
							path: "test.txt",
						},
					],
				};
				const result = safeValidateTemplateConfig(config);
				expect(result.success).toBe(false);
			});
		});

		describe("TemplatePromptSchema", () => {
			test("validates text prompt", () => {
				const prompt = {
					name: "componentName",
					type: "text",
					message: "Enter component name",
				};
				expect(() => TemplatePromptSchema.parse(prompt)).not.toThrow();
			});

			test("validates select prompt with choices", () => {
				const prompt = {
					name: "framework",
					type: "select",
					message: "Select framework",
					choices: [
						{ title: "React", value: "react" },
						{ title: "Vue", value: "vue" },
					],
				};
				expect(() => TemplatePromptSchema.parse(prompt)).not.toThrow();
			});

			test("validates prompt with validation", () => {
				const prompt = {
					name: "name",
					type: "text",
					message: "Enter name",
					validate: "required",
				};
				expect(() => TemplatePromptSchema.parse(prompt)).not.toThrow();
			});

			test("validates prompt with conditional", () => {
				const prompt = {
					name: "styleType",
					type: "select",
					message: "Style type",
					when: "{{withStyles}}",
					choices: [{ title: "CSS", value: "css" }],
				};
				expect(() => TemplatePromptSchema.parse(prompt)).not.toThrow();
			});
		});
	});
});
