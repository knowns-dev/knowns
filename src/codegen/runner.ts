/**
 * Template Runner
 *
 * Orchestrates template execution: prompts, rendering, and file operations.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { glob } from "glob";
import prompts from "prompts";
import type {
	AddAction,
	AddManyAction,
	AppendAction,
	LoadedTemplate,
	ModifyAction,
	TemplateAction,
	TemplateContext,
	TemplatePrompt,
	TemplateResult,
} from "./models";
import { loadTemplate, loadTemplateByName } from "./parser";
import { evaluateCondition, renderFile, renderPath, renderString } from "./renderer";

/**
 * Options for running a template
 */
export interface RunOptions {
	/** Project root directory */
	projectRoot: string;
	/** Pre-filled values (skip prompts for these) */
	values?: Record<string, unknown>;
	/** Dry run - don't write files */
	dryRun?: boolean;
	/** Force overwrite existing files */
	force?: boolean;
	/** Silent mode - no console output */
	silent?: boolean;
	/** Non-interactive mode - throw error instead of prompting */
	nonInteractive?: boolean;
}

/**
 * Run a template by name
 */
export async function runTemplateByName(
	templatesDir: string,
	templateName: string,
	options: RunOptions,
): Promise<TemplateResult> {
	const template = await loadTemplateByName(templatesDir, templateName);
	return runTemplate(template, options);
}

/**
 * Run a loaded template
 */
export async function runTemplate(template: LoadedTemplate, options: RunOptions): Promise<TemplateResult> {
	const result: TemplateResult = {
		success: false,
		created: [],
		modified: [],
		skipped: [],
	};

	try {
		// Step 1: Collect prompt values
		const context = await collectPromptValues(
			template.config.prompts || [],
			options.values || {},
			options.nonInteractive,
		);

		// Step 2: Execute actions
		for (const action of template.config.actions || []) {
			// Check condition
			if (!evaluateCondition(action.when, context)) {
				continue;
			}

			await executeAction(action, template, context, options, result);
		}

		// Step 3: Show success message
		if (!options.silent && template.config.messages?.success) {
			const message = renderString(template.config.messages.success, context);
			console.log(`\n${message}`);
		}

		result.success = true;
	} catch (error) {
		result.error = error instanceof Error ? error.message : String(error);

		if (!options.silent && template.config.messages?.failure) {
			const context = options.values || {};
			const message = renderString(template.config.messages.failure, context as TemplateContext);
			console.error(`\n${message}`);
		}
	}

	return result;
}

/**
 * Collect values from prompts
 */
async function collectPromptValues(
	promptDefs: TemplatePrompt[],
	prefilledValues: Record<string, unknown>,
	nonInteractive?: boolean,
): Promise<TemplateContext> {
	const context: TemplateContext = { ...prefilledValues };

	for (const promptDef of promptDefs) {
		// Skip if already has value
		if (promptDef.name in context) {
			continue;
		}

		// Check condition
		if (!evaluateCondition(promptDef.when, context)) {
			continue;
		}

		// In non-interactive mode, use default or throw error
		if (nonInteractive) {
			if (promptDef.initial !== undefined) {
				context[promptDef.name] = promptDef.initial;
			} else if (promptDef.validate === "required") {
				throw new Error(`Missing required variable: ${promptDef.name}`);
			}
			// Skip optional prompts without default
			continue;
		}

		const value = await runPrompt(promptDef);
		context[promptDef.name] = value;
	}

	return context;
}

/**
 * Run a single prompt and return the value
 */
async function runPrompt(promptDef: TemplatePrompt): Promise<unknown> {
	const promptConfig = buildPromptConfig(promptDef);
	const response = await prompts(promptConfig, {
		onCancel: () => {
			throw new Error("Template cancelled by user");
		},
	});

	return response[promptDef.name];
}

/**
 * Build prompts library config from template prompt definition
 */
function buildPromptConfig(promptDef: TemplatePrompt): prompts.PromptObject {
	const base: prompts.PromptObject = {
		type: mapPromptType(promptDef.type),
		name: promptDef.name,
		message: promptDef.message,
		hint: promptDef.hint,
	};

	// Handle initial value
	if (promptDef.initial !== undefined) {
		base.initial = promptDef.initial;
	}

	// Handle validation
	if (promptDef.validate === "required") {
		base.validate = (value) => (value !== undefined && value !== "" ? true : "This field is required");
	} else if (promptDef.validate) {
		base.validate = (value) => (value !== undefined && value !== "" ? true : promptDef.validate);
	}

	// Handle choices for select/multiselect
	if (promptDef.choices && (promptDef.type === "select" || promptDef.type === "multiselect")) {
		base.choices = promptDef.choices.map((choice) => ({
			title: choice.title,
			value: choice.value,
			description: choice.description,
			selected: choice.selected,
		}));
	}

	return base;
}

/**
 * Map template prompt type to prompts library type
 */
function mapPromptType(type: TemplatePrompt["type"]): prompts.PromptType {
	const mapping: Record<TemplatePrompt["type"], prompts.PromptType> = {
		text: "text",
		confirm: "confirm",
		select: "select",
		multiselect: "multiselect",
		number: "number",
	};
	return mapping[type];
}

/**
 * Execute a single action
 */
async function executeAction(
	action: TemplateAction,
	template: LoadedTemplate,
	context: TemplateContext,
	options: RunOptions,
	result: TemplateResult,
): Promise<void> {
	switch (action.type) {
		case "add":
			await executeAddAction(action, template, context, options, result);
			break;
		case "addMany":
			await executeAddManyAction(action, template, context, options, result);
			break;
		case "modify":
			await executeModifyAction(action, context, options, result);
			break;
		case "append":
			await executeAppendAction(action, context, options, result);
			break;
	}
}

/**
 * Execute add action - create a single file
 */
async function executeAddAction(
	action: AddAction,
	template: LoadedTemplate,
	context: TemplateContext,
	options: RunOptions,
	result: TemplateResult,
): Promise<void> {
	const sourcePath = join(template.templateDir, action.template);
	const destRelative = renderPath(action.path, context);
	const destPath = join(options.projectRoot, template.config.destination || "", destRelative);

	// Check if exists
	if (existsSync(destPath)) {
		if (action.skipIfExists && !options.force) {
			result.skipped.push(destRelative);
			return;
		}
		if (!options.force) {
			result.skipped.push(destRelative);
			return;
		}
	}

	// Render content
	const content = await renderFile(sourcePath, context);

	// Write file
	if (!options.dryRun) {
		await ensureDir(dirname(destPath));
		await writeFile(destPath, content, "utf-8");
	}

	result.created.push(destRelative);
}

/**
 * Execute addMany action - create multiple files from a folder
 */
async function executeAddManyAction(
	action: AddManyAction,
	template: LoadedTemplate,
	context: TemplateContext,
	options: RunOptions,
	result: TemplateResult,
): Promise<void> {
	const sourceDir = join(template.templateDir, action.source);
	const pattern = action.globPattern || "**/*.hbs";

	// Find matching files
	const files = await glob(pattern, { cwd: sourceDir, nodir: true });

	for (const file of files) {
		const sourcePath = join(sourceDir, file);
		const destRelative = renderPath(join(action.destination, file), context);
		const destPath = join(options.projectRoot, template.config.destination || "", destRelative);

		// Check if exists
		if (existsSync(destPath)) {
			if (action.skipIfExists && !options.force) {
				result.skipped.push(destRelative);
				continue;
			}
			if (!options.force) {
				result.skipped.push(destRelative);
				continue;
			}
		}

		// Render content
		const content = await renderFile(sourcePath, context);

		// Write file
		if (!options.dryRun) {
			await ensureDir(dirname(destPath));
			await writeFile(destPath, content, "utf-8");
		}

		result.created.push(destRelative);
	}
}

/**
 * Execute modify action - edit existing file
 */
async function executeModifyAction(
	action: ModifyAction,
	context: TemplateContext,
	options: RunOptions,
	result: TemplateResult,
): Promise<void> {
	const filePath = join(options.projectRoot, renderPath(action.path, context));

	if (!existsSync(filePath)) {
		throw new Error(`Cannot modify: file not found: ${action.path}`);
	}

	// Read existing content
	const content = await readFile(filePath, "utf-8");

	// Render replacement
	const replacement = renderString(action.template, context);

	// Replace pattern
	const pattern = new RegExp(action.pattern, "g");
	const newContent = content.replace(pattern, replacement);

	if (newContent === content) {
		result.skipped.push(action.path);
		return;
	}

	// Write file
	if (!options.dryRun) {
		await writeFile(filePath, newContent, "utf-8");
	}

	result.modified.push(action.path);
}

/**
 * Execute append action - add to end of file
 */
async function executeAppendAction(
	action: AppendAction,
	context: TemplateContext,
	options: RunOptions,
	result: TemplateResult,
): Promise<void> {
	const filePath = join(options.projectRoot, renderPath(action.path, context));

	// Render content to append
	const contentToAppend = renderString(action.template, context);

	// Check uniqueness if required
	if (action.unique && existsSync(filePath)) {
		const existingContent = await readFile(filePath, "utf-8");
		if (existingContent.includes(contentToAppend.trim())) {
			result.skipped.push(action.path);
			return;
		}
	}

	// Prepare content with separator
	const separator = action.separator ?? "\n";
	const fullContent = separator + contentToAppend;

	// Write file
	if (!options.dryRun) {
		await ensureDir(dirname(filePath));
		if (existsSync(filePath)) {
			await appendFile(filePath, fullContent, "utf-8");
		} else {
			await writeFile(filePath, contentToAppend, "utf-8");
		}
	}

	if (existsSync(filePath)) {
		result.modified.push(action.path);
	} else {
		result.created.push(action.path);
	}
}

/**
 * Ensure directory exists
 */
async function ensureDir(dir: string): Promise<void> {
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}
}
