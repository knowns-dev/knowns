/**
 * Handlebars Helpers
 *
 * Built-in helpers for template rendering.
 * Includes case conversion, string manipulation, and pluralization.
 */

import { camelCase, capitalCase, constantCase, kebabCase, pascalCase, snakeCase } from "change-case";
import type Handlebars from "handlebars";
import pluralizeLib from "pluralize";

/**
 * Register all built-in helpers with Handlebars instance
 */
export function registerHelpers(handlebars: typeof Handlebars): void {
	// Case conversion helpers
	handlebars.registerHelper("camelCase", (str: string) => {
		return typeof str === "string" ? camelCase(str) : str;
	});

	handlebars.registerHelper("pascalCase", (str: string) => {
		return typeof str === "string" ? pascalCase(str) : str;
	});

	handlebars.registerHelper("kebabCase", (str: string) => {
		return typeof str === "string" ? kebabCase(str) : str;
	});

	handlebars.registerHelper("snakeCase", (str: string) => {
		return typeof str === "string" ? snakeCase(str) : str;
	});

	handlebars.registerHelper("constantCase", (str: string) => {
		return typeof str === "string" ? constantCase(str) : str;
	});

	handlebars.registerHelper("titleCase", (str: string) => {
		return typeof str === "string" ? capitalCase(str) : str;
	});

	// String manipulation helpers
	handlebars.registerHelper("lowerCase", (str: string) => {
		return typeof str === "string" ? str.toLowerCase() : str;
	});

	handlebars.registerHelper("upperCase", (str: string) => {
		return typeof str === "string" ? str.toUpperCase() : str;
	});

	// Pluralization helpers
	handlebars.registerHelper("pluralize", (str: string) => {
		return typeof str === "string" ? pluralizeLib.plural(str) : str;
	});

	handlebars.registerHelper("singularize", (str: string) => {
		return typeof str === "string" ? pluralizeLib.singular(str) : str;
	});

	// Conditional helpers
	handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);
	handlebars.registerHelper("ne", (a: unknown, b: unknown) => a !== b);
	handlebars.registerHelper("gt", (a: number, b: number) => a > b);
	handlebars.registerHelper("gte", (a: number, b: number) => a >= b);
	handlebars.registerHelper("lt", (a: number, b: number) => a < b);
	handlebars.registerHelper("lte", (a: number, b: number) => a <= b);

	// Logical helpers
	handlebars.registerHelper("and", (...args: unknown[]) => {
		// Last argument is Handlebars options object
		const values = args.slice(0, -1);
		return values.every(Boolean);
	});

	handlebars.registerHelper("or", (...args: unknown[]) => {
		// Last argument is Handlebars options object
		const values = args.slice(0, -1);
		return values.some(Boolean);
	});

	handlebars.registerHelper("not", (value: unknown) => !value);

	// Array helpers
	handlebars.registerHelper("includes", (arr: unknown[], value: unknown) => {
		return Array.isArray(arr) && arr.includes(value);
	});

	handlebars.registerHelper("join", (arr: unknown[], separator = ", ") => {
		return Array.isArray(arr) ? arr.join(separator) : arr;
	});

	// String helpers
	handlebars.registerHelper("trim", (str: string) => {
		return typeof str === "string" ? str.trim() : str;
	});

	handlebars.registerHelper("replace", (str: string, search: string, replacement: string) => {
		return typeof str === "string" ? str.replace(new RegExp(search, "g"), replacement) : str;
	});

	handlebars.registerHelper("concat", (...args: unknown[]) => {
		// Last argument is Handlebars options object
		const values = args.slice(0, -1);
		return values.join("");
	});
}

/**
 * Available helper names for documentation
 */
export const HELPER_NAMES = {
	case: ["camelCase", "pascalCase", "kebabCase", "snakeCase", "constantCase", "titleCase"],
	string: ["lowerCase", "upperCase", "trim", "replace", "concat"],
	pluralize: ["pluralize", "singularize"],
	comparison: ["eq", "ne", "gt", "gte", "lt", "lte"],
	logical: ["and", "or", "not"],
	array: ["includes", "join"],
} as const;
