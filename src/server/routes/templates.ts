/**
 * Template routes module
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Request, type Response, Router } from "express";
import { listTemplates, loadTemplate, loadTemplateByName, renderFile, renderPath, runTemplate } from "../../codegen";
import type { AddAction, AddManyAction, TemplateAction } from "../../codegen/models";
import { listAllTemplates, resolveTemplate } from "../../import";
import type { RouteContext } from "../types";

/**
 * Extract file information from template actions
 */
function extractFilesFromActions(actions: TemplateAction[] | undefined) {
	if (!actions) return [];

	return actions
		.filter((a): a is AddAction | AddManyAction => a.type === "add" || a.type === "addMany")
		.map((action) => {
			if (action.type === "add") {
				return {
					type: "add" as const,
					template: action.template,
					destination: action.path,
					condition: action.when,
				};
			}
			// addMany
			return {
				type: "addMany" as const,
				source: action.source,
				destination: action.destination,
				globPattern: action.globPattern,
				condition: action.when,
			};
		});
}

/**
 * Count file-generating actions
 */
function countFileActions(actions: TemplateAction[] | undefined): number {
	if (!actions) return 0;
	return actions.filter((a) => a.type === "add" || a.type === "addMany").length;
}

export function createTemplateRoutes(ctx: RouteContext): Router {
	const router = Router();
	const { store, broadcast } = ctx;
	const templatesDir = join(store.projectRoot, ".knowns", "templates");

	// GET /api/templates - List all templates (local + imported)
	router.get("/", async (_req: Request, res: Response) => {
		try {
			// Use listAllTemplates to get both local and imported templates
			const allTemplates = await listAllTemplates(store.projectRoot);

			const templateList = await Promise.all(
				allTemplates.map(async (t) => {
					// Load full template to get details
					const template = await loadTemplate(t.path);
					return {
						name: t.ref, // Use ref as name (includes import prefix for imported)
						description: template?.config.description || "",
						doc: template?.config.doc,
						promptCount: template?.config.prompts?.length || 0,
						fileCount: countFileActions(template?.config.actions),
						isImported: t.isImported,
						source: t.source,
					};
				}),
			);

			res.json({ templates: templateList, count: templateList.length });
		} catch (error) {
			console.error("Error listing templates:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/templates/run - Run template (supports imported templates with paths like "import/template")
	router.post("/run", async (req: Request, res: Response) => {
		try {
			const { name, variables = {}, dryRun = true } = req.body;

			if (!name) {
				res.status(400).json({ error: "Template name is required" });
				return;
			}

			// Use resolveTemplate to find local or imported template
			const resolved = await resolveTemplate(store.projectRoot, name);

			if (!resolved) {
				res.status(404).json({ error: `Template not found: ${name}` });
				return;
			}

			const template = await loadTemplate(resolved.path);

			if (!template) {
				res.status(404).json({ error: `Template not found: ${name}` });
				return;
			}

			// Check required variables
			const requiredPrompts = template.config.prompts?.filter((p) => p.validate === "required") || [];
			const missingVars = requiredPrompts.filter((p) => !variables[p.name]).map((p) => p.name);

			if (missingVars.length > 0) {
				res.status(400).json({
					error: `Missing required variables: ${missingVars.join(", ")}`,
					missingVariables: missingVars,
				});
				return;
			}

			// Build values from variables + defaults
			const values: Record<string, string> = {};
			for (const prompt of template.config.prompts || []) {
				if (variables[prompt.name]) {
					values[prompt.name] = variables[prompt.name];
				} else if (prompt.default) {
					values[prompt.name] = String(prompt.default);
				}
			}

			// Run template (non-interactive mode for API)
			const result = await runTemplate(template, {
				projectRoot: store.projectRoot,
				values,
				dryRun,
				nonInteractive: true,
				silent: true,
			});

			if (!result.success) {
				res.status(500).json({ error: result.error });
				return;
			}

			// Format output - combine created, modified, skipped into files array
			const files = [
				...result.created.map((path) => ({ path, action: "created", skipped: false })),
				...result.modified.map((path) => ({ path, action: "modified", skipped: false })),
				...result.skipped.map((path) => ({ path, action: "skipped", skipped: true, skipReason: "File exists" })),
			];

			// Broadcast event if files were actually created
			if (!dryRun && files.length > 0) {
				broadcast({ type: "templates:run", template: name, files });
			}

			const createdCount = files.filter((f) => !f.skipped).length;
			res.json({
				success: true,
				dryRun,
				template: name,
				variables: values,
				files,
				message: dryRun
					? `Dry run complete. ${createdCount} files would be created.`
					: `Template executed. ${createdCount} files created.`,
			});
		} catch (error) {
			console.error("Error running template:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/templates/preview - Preview rendered file content (supports imported templates)
	router.post("/preview", async (req: Request, res: Response) => {
		try {
			const { name, variables = {}, templateFile } = req.body;

			if (!name) {
				res.status(400).json({ error: "Template name is required" });
				return;
			}

			if (!templateFile) {
				res.status(400).json({ error: "templateFile is required" });
				return;
			}

			// Use resolveTemplate to find local or imported template
			const resolved = await resolveTemplate(store.projectRoot, name);

			if (!resolved) {
				res.status(404).json({ error: `Template not found: ${name}` });
				return;
			}

			const template = await loadTemplate(resolved.path);

			if (!template) {
				res.status(404).json({ error: `Template not found: ${name}` });
				return;
			}

			// Build context from variables + defaults
			const context: Record<string, unknown> = {};
			for (const prompt of template.config.prompts || []) {
				if (variables[prompt.name] !== undefined) {
					context[prompt.name] = variables[prompt.name];
				} else if (prompt.initial !== undefined) {
					context[prompt.name] = prompt.initial;
				}
			}

			// Render the template file
			const templatePath = join(template.templateDir, templateFile);
			if (!existsSync(templatePath)) {
				res.status(404).json({ error: `Template file not found: ${templateFile}` });
				return;
			}

			const content = await renderFile(templatePath, context);

			// Also render the destination path
			const action = template.config.actions?.find(
				(a) => a.type === "add" && (a as AddAction).template === templateFile,
			) as AddAction | undefined;

			const destinationPath = action ? renderPath(action.path, context) : templateFile.replace(/\.hbs$/, "");

			res.json({
				success: true,
				templateFile,
				destinationPath,
				content,
			});
		} catch (error) {
			console.error("Error previewing template:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// POST /api/templates - Create new template
	router.post("/", async (req: Request, res: Response) => {
		try {
			const { name, description, doc } = req.body;

			if (!name) {
				res.status(400).json({ error: "Template name is required" });
				return;
			}

			// Ensure templates directory exists
			if (!existsSync(templatesDir)) {
				await mkdir(templatesDir, { recursive: true });
			}

			const templateDir = join(templatesDir, name);

			if (existsSync(templateDir)) {
				res.status(409).json({ error: `Template "${name}" already exists` });
				return;
			}

			// Create template directory
			await mkdir(templateDir, { recursive: true });

			// Create _template.yaml
			const docLine = doc ? `doc: ${doc}\n` : "";
			const configContent = `# Template: ${name}
name: ${name}
description: ${description || "Description of your template"}
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
 * Generated from ${name} template
 */

export function {{camelCase name}}() {
  console.log("Hello from {{name}}!");
}
`;

			await writeFile(join(templateDir, "example.ts.hbs"), exampleTemplate, "utf-8");

			broadcast({ type: "templates:created", template: name });

			res.status(201).json({
				success: true,
				message: `Created template: ${name}`,
				template: {
					name,
					description,
					doc,
					path: `.knowns/templates/${name}/`,
				},
				files: ["_template.yaml", "example.ts.hbs"],
			});
		} catch (error) {
			console.error("Error creating template:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	// GET /api/templates/:name - Get template details (MUST be last - wildcard catches all)
	// Supports imported templates with paths like "import/template"
	router.get("/{*name}", async (req: Request, res: Response) => {
		try {
			const name = Array.isArray(req.params.name) ? req.params.name.join("/") : req.params.name;

			// Use resolveTemplate to find local or imported template
			const resolved = await resolveTemplate(store.projectRoot, name);

			if (!resolved) {
				res.status(404).json({ error: `Template not found: ${name}` });
				return;
			}

			const template = await loadTemplate(resolved.path);

			if (!template) {
				res.status(404).json({ error: `Template not found: ${name}` });
				return;
			}

			// Format prompts for display
			const prompts = template.config.prompts?.map((p) => ({
				name: p.name,
				message: p.message,
				type: p.type || "input",
				required: p.validate === "required",
				default: p.initial,
				choices: p.choices,
			}));

			// Extract files from actions
			const files = extractFilesFromActions(template.config.actions);

			res.json({
				template: {
					name: template.config.name,
					description: template.config.description,
					doc: template.config.doc,
					destination: template.config.destination || "./",
					prompts: prompts || [],
					files: files || [],
					messages: template.config.messages,
				},
			});
		} catch (error) {
			console.error("Error getting template:", error);
			res.status(500).json({ error: String(error) });
		}
	});

	return router;
}
