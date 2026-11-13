// Port of internal/models/template.go. A template is a folder with a `_template.yaml`.
import { z } from "zod";
import { nilableArray } from "./common.ts";

export const promptChoiceSchema = z.object({
  title: z.string(),
  value: z.string(),
  description: z.string().optional(),
  selected: z.boolean().optional(),
});
export type PromptChoice = z.infer<typeof promptChoiceSchema>;

export const TEMPLATE_PROMPT_TYPES = [
  "text",
  "confirm",
  "select",
  "multiselect",
  "number",
] as const;

export const templatePromptSchema = z.object({
  name: z.string(),
  /** One of TEMPLATE_PROMPT_TYPES (not enforced: Go does not). */
  type: z.string(),
  message: z.string(),
  validate: z.string().optional(),
  initial: z.string().optional(),
  hint: z.string().optional(),
  when: z.string().optional(),
  choices: z.array(promptChoiceSchema).optional(),
});
export type TemplatePrompt = z.infer<typeof templatePromptSchema>;

export const TEMPLATE_ACTION_TYPES = ["add", "addMany", "modify", "append"] as const;

export const templateActionSchema = z.object({
  /** One of TEMPLATE_ACTION_TYPES (not enforced: Go does not). */
  type: z.string(),
  template: z.string().optional(),
  path: z.string().optional(),
  skipIfExists: z.boolean().optional(),
  when: z.string().optional(),
  source: z.string().optional(),
  destination: z.string().optional(),
  globPattern: z.string().optional(),
  pattern: z.string().optional(),
  unique: z.boolean().optional(),
  separator: z.string().optional(),
});
export type TemplateAction = z.infer<typeof templateActionSchema>;

export const templateMessagesSchema = z.object({
  success: z.string().optional(),
  failure: z.string().optional(),
});
export type TemplateMessages = z.infer<typeof templateMessagesSchema>;

/**
 * models.Template. The YAML (`_template.yaml`) carries name..messages; `path`, `imported` and
 * `importName` are derived at load time and appear only in the JSON form.
 */
export const templateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  destination: z.string().optional(),
  doc: z.string().optional(),
  prompts: z.array(templatePromptSchema).optional(),
  actions: z.array(templateActionSchema).optional(),
  messages: templateMessagesSchema.optional(),
  path: z.string().optional(),
  imported: z.boolean().optional(),
  importName: z.string().optional(),
});
export type Template = z.infer<typeof templateSchema>;

/** The `_template.yaml` document: Template without the derived fields. */
export const templateYamlSchema = templateSchema.omit({
  path: true,
  imported: true,
  importName: true,
});
export type TemplateYaml = z.infer<typeof templateYamlSchema>;

export const templateResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  created: nilableArray(z.string()),
  modified: nilableArray(z.string()),
  skipped: nilableArray(z.string()),
});
export type TemplateResult = z.infer<typeof templateResultSchema>;
