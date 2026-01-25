/**
 * Template Engine
 *
 * Lightweight code generator for creating files from templates.
 *
 * @example
 * ```typescript
 * import { loadTemplate, runTemplate } from "@codegen";
 *
 * const template = await loadTemplate(".knowns/templates/react-component");
 * const result = await runTemplate(template, {
 *   projectRoot: process.cwd(),
 *   values: { name: "UserProfile" },
 * });
 * ```
 */

// Models
export type {
	ActionType,
	AddAction,
	AddManyAction,
	AppendAction,
	BaseAction,
	LoadedTemplate,
	ModifyAction,
	PromptChoice,
	PromptType,
	TemplateAction,
	TemplateConfig,
	TemplateContext,
	TemplateMessages,
	TemplatePrompt,
	TemplateResult,
} from "./models";

// Schemas
export {
	AddActionSchema,
	AddManyActionSchema,
	AppendActionSchema,
	ModifyActionSchema,
	PromptChoiceSchema,
	TemplateActionSchema,
	TemplateConfigSchema,
	TemplateMessagesSchema,
	TemplatePromptSchema,
	safeValidateTemplateConfig,
	validateTemplateConfig,
} from "./schema";
export type { ValidatedTemplateAction, ValidatedTemplateConfig, ValidatedTemplatePrompt } from "./schema";

// Parser
export {
	TemplateParseError,
	getTemplateConfig,
	isValidTemplate,
	listTemplates,
	loadTemplate,
	loadTemplateByName,
} from "./parser";

// Renderer
export {
	compileTemplate,
	evaluateCondition,
	registerHelper,
	registerPartial,
	renderFile,
	renderPath,
	renderString,
	resetHandlebars,
} from "./renderer";

// Helpers
export { HELPER_NAMES, registerHelpers } from "./helpers";

// Runner
export { runTemplate, runTemplateByName } from "./runner";
export type { RunOptions } from "./runner";

// Skill Parser
export {
	getSkillNames,
	isValidSkillDir,
	listSkills,
	loadSkill,
	loadSkillByName,
	parseSkillFrontmatter,
} from "./skill-parser";
export type { Skill, SkillFrontmatter } from "./skill-parser";

// Skill Sync
export { PLATFORMS, detectPlatforms, getPlatform, getPlatformIds, syncSkills } from "./skill-sync";
export type { InstructionMode, Platform, PlatformConfig, SyncOptions, SyncResult } from "./skill-sync";
