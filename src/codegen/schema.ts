/**
 * Template Engine Schemas
 *
 * Zod validation schemas for template configuration.
 */

import { z } from "zod";

/**
 * Prompt choice schema
 */
export const PromptChoiceSchema = z.object({
	title: z.string(),
	value: z.string(),
	description: z.string().optional(),
	selected: z.boolean().optional(),
});

/**
 * Template prompt schema
 */
export const TemplatePromptSchema = z.object({
	name: z.string().min(1, "Prompt name is required"),
	type: z.enum(["text", "confirm", "select", "multiselect", "number"]),
	message: z.string().min(1, "Prompt message is required"),
	initial: z.union([z.string(), z.number(), z.boolean()]).optional(),
	validate: z.union([z.literal("required"), z.string()]).optional(),
	hint: z.string().optional(),
	choices: z.array(PromptChoiceSchema).optional(),
	when: z.string().optional(),
});

/**
 * Add action schema
 */
export const AddActionSchema = z.object({
	type: z.literal("add"),
	template: z.string().min(1, "Template path is required"),
	path: z.string().min(1, "Destination path is required"),
	skipIfExists: z.boolean().optional(),
	when: z.string().optional(),
});

/**
 * AddMany action schema
 */
export const AddManyActionSchema = z.object({
	type: z.literal("addMany"),
	source: z.string().min(1, "Source folder is required"),
	destination: z.string().min(1, "Destination folder is required"),
	globPattern: z.string().optional().default("**/*.hbs"),
	skipIfExists: z.boolean().optional(),
	when: z.string().optional(),
});

/**
 * Modify action schema
 */
export const ModifyActionSchema = z.object({
	type: z.literal("modify"),
	path: z.string().min(1, "Target path is required"),
	pattern: z.string().min(1, "Search pattern is required"),
	template: z.string().min(1, "Replacement template is required"),
	when: z.string().optional(),
});

/**
 * Append action schema
 */
export const AppendActionSchema = z.object({
	type: z.literal("append"),
	path: z.string().min(1, "Target path is required"),
	template: z.string().min(1, "Content template is required"),
	unique: z.boolean().optional(),
	separator: z.string().optional().default("\n"),
	when: z.string().optional(),
});

/**
 * Union of all action schemas
 */
export const TemplateActionSchema = z.discriminatedUnion("type", [
	AddActionSchema,
	AddManyActionSchema,
	ModifyActionSchema,
	AppendActionSchema,
]);

/**
 * Template messages schema
 */
export const TemplateMessagesSchema = z.object({
	success: z.string().optional(),
	failure: z.string().optional(),
});

/**
 * Template configuration schema
 */
export const TemplateConfigSchema = z.object({
	name: z.string().min(1, "Template name is required"),
	description: z.string().optional(),
	version: z.string().optional(),
	author: z.string().optional(),
	destination: z.string().optional(),
	doc: z.string().optional(),
	prompts: z.array(TemplatePromptSchema).optional().default([]),
	actions: z.array(TemplateActionSchema).optional().default([]),
	messages: TemplateMessagesSchema.optional(),
});

/**
 * Inferred types from schemas
 */
export type ValidatedTemplateConfig = z.infer<typeof TemplateConfigSchema>;
export type ValidatedTemplatePrompt = z.infer<typeof TemplatePromptSchema>;
export type ValidatedTemplateAction = z.infer<typeof TemplateActionSchema>;

/**
 * Validate template configuration
 */
export function validateTemplateConfig(data: unknown): ValidatedTemplateConfig {
	return TemplateConfigSchema.parse(data);
}

/**
 * Safe validation (returns result instead of throwing)
 */
export function safeValidateTemplateConfig(
	data: unknown,
): { success: true; data: ValidatedTemplateConfig } | { success: false; error: z.ZodError } {
	const result = TemplateConfigSchema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data };
	}
	return { success: false, error: result.error };
}
