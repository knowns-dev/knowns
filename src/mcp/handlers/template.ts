/**
 * Template management MCP handlers
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	type LoadedTemplate,
	type TemplateResult,
	listTemplates,
	loadTemplateByName,
	runTemplate,
} from "../../codegen";
import { listAllTemplates } from "../../import";
import { errorResponse, successResponse } from "../utils";

const TEMPLATES_DIR = join(process.cwd(), ".knowns", "templates");

// Schemas
export const listTemplatesSchema = z.object({});

export const getTemplateSchema = z.object({
	name: z.string(), // Template name
});

export const runTemplateSchema = z.object({
	name: z.string(), // Template name
	variables: z.record(z.string()).optional(), // Variables for template
	dryRun: z.boolean().optional(), // Preview only, don't write files (default: true for safety)
});

export const createTemplateSchema = z.object({
	name: z.string(), // Template name
	description: z.string().optional(), // Template description
	doc: z.string().optional(), // Link to documentation
});

// Tool definitions
export const templateTools = [
	{
		name: "list_templates",
		description: "List all available code generation templates in .knowns/templates/",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "get_template",
		description:
			"Get template configuration including prompts, files, and linked documentation. Use this to understand what variables a template needs.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "Template name (folder name in .knowns/templates/)",
				},
			},
			required: ["name"],
		},
	},
	{
		name: "run_template",
		description:
			"Run a code generation template. By default runs in dry-run mode (preview only). Set dryRun: false to actually write files.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "Template name to run",
				},
				variables: {
					type: "object",
					additionalProperties: { type: "string" },
					description: "Variables for the template (e.g., { name: 'MyComponent', type: 'page' })",
				},
				dryRun: {
					type: "boolean",
					description: "Preview only without writing files (default: true for safety)",
				},
			},
			required: ["name"],
		},
	},
	{
		name: "create_template",
		description:
			"Create a new code generation template scaffold. Creates the template folder with _template.yaml config and example .hbs file.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "Template name (will be folder name in .knowns/templates/)",
				},
				description: {
					type: "string",
					description: "Template description",
				},
				doc: {
					type: "string",
					description: "Link to documentation (e.g., 'patterns/my-pattern')",
				},
			},
			required: ["name"],
		},
	},
];

// Handlers
export async function handleListTemplates(_args: unknown) {
	listTemplatesSchema.parse(_args);

	const projectRoot = process.cwd();

	try {
		const allTemplates = await listAllTemplates(projectRoot);

		if (allTemplates.length === 0) {
			return successResponse({
				count: 0,
				templates: [],
				message: "No templates found. Create templates in .knowns/templates/",
			});
		}

		// Load template configs for descriptions
		const templateList: Array<{
			name: string;
			ref: string;
			description: string;
			doc?: string;
			promptCount: number;
			fileCount: number;
			source: string;
			sourceUrl?: string;
			isImported: boolean;
		}> = [];

		for (const t of allTemplates) {
			try {
				const loaded = await listTemplates(join(t.path, ".."));
				const match = loaded.find((l) => l.name === t.name);
				templateList.push({
					name: t.name,
					ref: t.ref,
					description: match?.description || "No description",
					doc: match?.doc,
					promptCount: match?.prompts?.length || 0,
					fileCount: match?.files?.length || 0,
					source: t.source,
					sourceUrl: t.sourceUrl,
					isImported: t.isImported,
				});
			} catch {
				templateList.push({
					name: t.name,
					ref: t.ref,
					description: "No description",
					promptCount: 0,
					fileCount: 0,
					source: t.source,
					sourceUrl: t.sourceUrl,
					isImported: t.isImported,
				});
			}
		}

		return successResponse({
			count: templateList.length,
			templates: templateList,
		});
	} catch (error) {
		return errorResponse(`Failed to list templates: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function handleGetTemplate(args: unknown) {
	const input = getTemplateSchema.parse(args);

	if (!existsSync(TEMPLATES_DIR)) {
		return errorResponse("No templates directory found");
	}

	try {
		const template = await loadTemplateByName(input.name, TEMPLATES_DIR);

		if (!template) {
			return errorResponse(`Template not found: ${input.name}`);
		}

		// Format prompts for display
		const prompts = template.config.prompts?.map((p) => ({
			name: p.name,
			message: p.message,
			type: p.type || "input",
			required: p.validate === "required",
			default: p.default,
			choices: p.choices,
		}));

		// Format files for display
		const files = template.config.files?.map((f) => ({
			template: f.template,
			destination: f.destination,
			condition: f.condition,
		}));

		return successResponse({
			template: {
				name: template.config.name,
				description: template.config.description,
				doc: template.config.doc, // Linked documentation - AI should read this
				prompts: prompts || [],
				files: files || [],
				messages: template.config.messages,
			},
			hint: template.config.doc
				? `This template links to @doc/${template.config.doc}. Read the doc for context before running.`
				: undefined,
		});
	} catch (error) {
		return errorResponse(`Failed to load template: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function handleRunTemplate(args: unknown) {
	const input = runTemplateSchema.parse(args);
	const dryRun = input.dryRun !== false; // Default to true for safety

	if (!existsSync(TEMPLATES_DIR)) {
		return errorResponse("No templates directory found");
	}

	try {
		const template = await loadTemplateByName(input.name, TEMPLATES_DIR);

		if (!template) {
			return errorResponse(`Template not found: ${input.name}`);
		}

		// Check required variables
		const requiredPrompts = template.config.prompts?.filter((p) => p.validate === "required") || [];
		const missingVars = requiredPrompts.filter((p) => !input.variables?.[p.name]).map((p) => p.name);

		if (missingVars.length > 0) {
			return errorResponse(
				`Missing required variables: ${missingVars.join(", ")}. Use get_template to see all required variables.`,
			);
		}

		// Build values from variables + defaults
		const values: Record<string, string> = {};
		for (const prompt of template.config.prompts || []) {
			if (input.variables?.[prompt.name]) {
				values[prompt.name] = input.variables[prompt.name];
			} else if (prompt.default) {
				values[prompt.name] = String(prompt.default);
			}
		}

		// Run template
		const result = await runTemplate(template, {
			projectRoot: process.cwd(),
			values,
			dryRun,
		});

		if (!result.success) {
			return errorResponse(`Template failed: ${result.error}`);
		}

		// Format output
		const filesCreated = result.files?.map((f) => ({
			path: f.path,
			action: f.action,
			skipped: f.skipped,
			skipReason: f.skipReason,
		}));

		return successResponse({
			success: true,
			dryRun,
			template: input.name,
			variables: values,
			files: filesCreated || [],
			message: dryRun
				? `Dry run complete. ${filesCreated?.length || 0} files would be created. Set dryRun: false to write files.`
				: `Template executed. ${filesCreated?.filter((f) => !f.skipped).length || 0} files created.`,
		});
	} catch (error) {
		return errorResponse(`Failed to run template: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function handleCreateTemplate(args: unknown) {
	const input = createTemplateSchema.parse(args);

	try {
		// Ensure templates directory exists
		if (!existsSync(TEMPLATES_DIR)) {
			await mkdir(TEMPLATES_DIR, { recursive: true });
		}

		const templateDir = join(TEMPLATES_DIR, input.name);

		if (existsSync(templateDir)) {
			return errorResponse(`Template "${input.name}" already exists`);
		}

		// Create template directory
		await mkdir(templateDir, { recursive: true });

		// Create _template.yaml
		const docLine = input.doc ? `doc: ${input.doc}\n` : "";
		const configContent = `# Template: ${input.name}
name: ${input.name}
description: ${input.description || "Description of your template"}
version: 1.0.0
${docLine}
# Interactive prompts
prompts:
  - name: name
    type: text
    message: "Enter name?"
    validate: required

# File generation actions
actions:
  - type: add
    template: "example.ts.hbs"
    path: "{{kebabCase name}}.ts"

# Success message
messages:
  success: |
    ✓ Created {{name}}!
`;

		await writeFile(join(templateDir, "_template.yaml"), configContent, "utf-8");

		// Create example template file
		const exampleTemplate = `/**
 * {{pascalCase name}}
 * Generated from ${input.name} template
 */

export function {{camelCase name}}() {
  console.log("Hello from {{name}}!");
}
`;

		await writeFile(join(templateDir, "example.ts.hbs"), exampleTemplate, "utf-8");

		return successResponse({
			message: `Created template: ${input.name}`,
			template: {
				name: input.name,
				description: input.description,
				doc: input.doc,
				path: `.knowns/templates/${input.name}/`,
			},
			files: ["_template.yaml", "example.ts.hbs"],
			nextSteps: [
				"Edit _template.yaml to configure prompts and actions",
				"Create your .hbs template files",
				`Run with: mcp__knowns__run_template({ name: "${input.name}", variables: { name: "..." } })`,
			],
		});
	} catch (error) {
		return errorResponse(`Failed to create template: ${error instanceof Error ? error.message : String(error)}`);
	}
}
