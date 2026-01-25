/**
 * Template Engine Models
 *
 * TypeScript interfaces for the template system.
 * See @doc/features/templates/template-config for full specification.
 */

/**
 * Prompt types supported by the template system
 */
export type PromptType = "text" | "confirm" | "select" | "multiselect" | "number";

/**
 * Choice option for select/multiselect prompts
 */
export interface PromptChoice {
	/** Display title */
	title: string;
	/** Value when selected */
	value: string;
	/** Optional description */
	description?: string;
	/** Pre-selected (for multiselect) */
	selected?: boolean;
}

/**
 * Template prompt definition
 */
export interface TemplatePrompt {
	/** Variable name (used in templates) */
	name: string;
	/** Prompt type */
	type: PromptType;
	/** Message shown to user */
	message: string;
	/** Default value */
	initial?: string | number | boolean;
	/** Validation rule: "required" or custom message */
	validate?: "required" | string;
	/** Hint text */
	hint?: string;
	/** Choices for select/multiselect */
	choices?: PromptChoice[];
	/** Conditional display (Handlebars expression) */
	when?: string;
}

/**
 * Action types supported by the template system
 */
export type ActionType = "add" | "addMany" | "modify" | "append";

/**
 * Base action interface
 */
export interface BaseAction {
	/** Action type */
	type: ActionType;
	/** Conditional execution (Handlebars expression) */
	when?: string;
}

/**
 * Add action - create a single file
 */
export interface AddAction extends BaseAction {
	type: "add";
	/** Source template file (relative to template folder) */
	template: string;
	/** Destination path (supports Handlebars) */
	path: string;
	/** Skip if file exists */
	skipIfExists?: boolean;
}

/**
 * AddMany action - create multiple files from a folder
 */
export interface AddManyAction extends BaseAction {
	type: "addMany";
	/** Source folder (relative to template folder) */
	source: string;
	/** Destination folder (supports Handlebars) */
	destination: string;
	/** Glob pattern for files */
	globPattern?: string;
	/** Skip if files exist */
	skipIfExists?: boolean;
}

/**
 * Modify action - edit existing file
 */
export interface ModifyAction extends BaseAction {
	type: "modify";
	/** Target file path */
	path: string;
	/** Pattern to find (string or regex) */
	pattern: string;
	/** Replacement template */
	template: string;
}

/**
 * Append action - add to end of file
 */
export interface AppendAction extends BaseAction {
	type: "append";
	/** Target file path */
	path: string;
	/** Content to append (Handlebars template) */
	template: string;
	/** Skip if content already exists */
	unique?: boolean;
	/** Separator before appended content */
	separator?: string;
}

/**
 * Union of all action types
 */
export type TemplateAction = AddAction | AddManyAction | ModifyAction | AppendAction;

/**
 * Success/failure message templates
 */
export interface TemplateMessages {
	/** Message shown on success */
	success?: string;
	/** Message shown on failure */
	failure?: string;
}

/**
 * Template configuration (_template.yaml)
 */
export interface TemplateConfig {
	/** Template name (unique identifier) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** Template version */
	version?: string;
	/** Template author */
	author?: string;
	/** Base destination path (relative to project root) */
	destination?: string;
	/** Link to Knowns documentation */
	doc?: string;
	/** Interactive prompts */
	prompts?: TemplatePrompt[];
	/** File generation actions */
	actions?: TemplateAction[];
	/** Custom messages */
	messages?: TemplateMessages;
}

/**
 * Context passed to Handlebars templates
 * Contains all prompt values plus built-in variables
 */
export interface TemplateContext {
	/** Prompt values (dynamic keys) */
	[key: string]: unknown;
}

/**
 * Result of running a template
 */
export interface TemplateResult {
	/** Whether the template ran successfully */
	success: boolean;
	/** Files created */
	created: string[];
	/** Files modified */
	modified: string[];
	/** Files skipped */
	skipped: string[];
	/** Error message if failed */
	error?: string;
}

/**
 * Loaded template with resolved paths
 */
export interface LoadedTemplate {
	/** Template configuration */
	config: TemplateConfig;
	/** Absolute path to template folder */
	templateDir: string;
	/** Template files (relative paths) */
	files: string[];
}
