/**
 * Template Renderer
 *
 * Renders Handlebars templates with context and helpers.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Handlebars from "handlebars";
import { registerHelpers } from "./helpers";
import type { TemplateContext } from "./models";

/**
 * Handlebars instance with registered helpers
 */
let handlebarsInstance: typeof Handlebars | null = null;

/**
 * Get or create Handlebars instance with helpers
 */
function getHandlebars(): typeof Handlebars {
	if (!handlebarsInstance) {
		handlebarsInstance = Handlebars.create();
		registerHelpers(handlebarsInstance);
	}
	return handlebarsInstance;
}

/**
 * Render a template string with context
 */
export function renderString(template: string, context: TemplateContext): string {
	const hbs = getHandlebars();
	const compiled = hbs.compile(template, { noEscape: true });
	return compiled(context);
}

/**
 * Render a template file with context
 */
export async function renderFile(templatePath: string, context: TemplateContext): Promise<string> {
	const content = await readFile(templatePath, "utf-8");
	return renderString(content, context);
}

/**
 * Render a path pattern with context (for dynamic file names)
 * Removes .hbs extension from output
 */
export function renderPath(pathPattern: string, context: TemplateContext): string {
	let rendered = renderString(pathPattern, context);

	// Remove .hbs extension if present
	if (rendered.endsWith(".hbs")) {
		rendered = rendered.slice(0, -4);
	}

	return rendered;
}

/**
 * Evaluate a conditional expression
 * Returns true if condition is met
 */
export function evaluateCondition(condition: string | undefined, context: TemplateContext): boolean {
	if (!condition) {
		return true;
	}

	// Simple variable reference: "{{varName}}" or "varName"
	const varMatch = condition.match(/^\{\{(\w+)\}\}$/) || condition.match(/^(\w+)$/);
	if (varMatch) {
		const varName = varMatch[1];
		return Boolean(context[varName]);
	}

	// Try to render as Handlebars expression
	try {
		const rendered = renderString(condition, context);
		// Treat "true", non-empty strings as truthy
		return rendered === "true" || (rendered !== "false" && rendered.trim() !== "");
	} catch {
		return false;
	}
}

/**
 * Compile a template for reuse
 */
export function compileTemplate(template: string): Handlebars.TemplateDelegate {
	const hbs = getHandlebars();
	return hbs.compile(template, { noEscape: true });
}

/**
 * Register a custom helper
 */
export function registerHelper(name: string, helper: Handlebars.HelperDelegate): void {
	const hbs = getHandlebars();
	hbs.registerHelper(name, helper);
}

/**
 * Register a partial template
 */
export function registerPartial(name: string, template: string): void {
	const hbs = getHandlebars();
	hbs.registerPartial(name, template);
}

/**
 * Reset Handlebars instance (useful for testing)
 */
export function resetHandlebars(): void {
	handlebarsInstance = null;
}
