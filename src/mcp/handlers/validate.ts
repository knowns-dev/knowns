/**
 * Validate MCP handler
 * Validates tasks, docs, and templates for broken refs and quality
 */

import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getTemplateConfig } from "@codegen/index";
import type { FileStore } from "@storage/file-store";
import matter from "gray-matter";
import Handlebars from "handlebars";
import { readConfig } from "../../import/config";
import { listAllTemplates, resolveDoc, resolveTemplate } from "../../import/resolver";
import { errorResponse, successResponse } from "../utils";
import { getProjectRoot } from "./project";

// Tool definitions
export const validateTools = [
	{
		name: "validate",
		description:
			"Validate tasks, docs, and templates for reference integrity and quality. Returns errors, warnings, and info about broken refs, missing AC, orphan docs, etc.",
		inputSchema: {
			type: "object",
			properties: {
				type: {
					type: "string",
					enum: ["task", "doc", "template"],
					description: "Entity type to validate (optional, validates all if not specified)",
				},
				strict: {
					type: "boolean",
					description: "Treat warnings as errors (default: false)",
				},
				fix: {
					type: "boolean",
					description: "Auto-fix supported issues like broken doc refs (default: false)",
				},
			},
		},
	},
];

// Types
type Severity = "error" | "warning" | "info";
type RuleSeverity = "error" | "warning" | "info" | "off";

interface ValidationIssue {
	entity: string;
	entityType: "task" | "doc" | "template";
	rule: string;
	severity: Severity;
	message: string;
	fixable?: boolean;
	fix?: () => Promise<void>;
}

interface ValidateConfig {
	rules?: Record<string, RuleSeverity>;
	ignore?: string[];
}

interface FixResult {
	entity: string;
	rule: string;
	action: string;
	success: boolean;
}

// Helpers
function stripTrailingPunctuation(path: string): string {
	return path.replace(/[.,;:!?`'")\]]+$/, "");
}

function extractRefs(content: string): { docRefs: string[]; taskRefs: string[]; templateRefs: string[] } {
	const docRefs: string[] = [];
	const taskRefs: string[] = [];
	const templateRefs: string[] = [];

	const docRefPattern = /@docs?\/([^\s,;:!?"'()\]]+)/g;
	for (const match of content.matchAll(docRefPattern)) {
		let docPath = stripTrailingPunctuation(match[1] || "");
		docPath = docPath.replace(/\.md$/, "");
		if (docPath && !docRefs.includes(docPath)) {
			docRefs.push(docPath);
		}
	}

	const taskRefPattern = /@task-([a-zA-Z0-9]+)/g;
	for (const match of content.matchAll(taskRefPattern)) {
		const taskId = match[1] || "";
		if (taskId && !taskRefs.includes(taskId)) {
			taskRefs.push(taskId);
		}
	}

	const templateRefPattern = /@template\/([^\s,;:!?"'()\]]+)/g;
	for (const match of content.matchAll(templateRefPattern)) {
		const templateName = stripTrailingPunctuation(match[1] || "");
		if (templateName && !templateRefs.includes(templateName)) {
			templateRefs.push(templateName);
		}
	}

	return { docRefs, taskRefs, templateRefs };
}

async function loadValidateConfig(projectRoot: string): Promise<ValidateConfig> {
	const config = await readConfig(projectRoot);
	return (config.validate as ValidateConfig) || {};
}

function getRuleSeverity(rule: string, defaultSeverity: Severity, validateConfig: ValidateConfig): Severity | "off" {
	if (validateConfig.rules?.[rule]) {
		return validateConfig.rules[rule];
	}
	return defaultSeverity;
}

function shouldIgnore(entity: string, validateConfig: ValidateConfig): boolean {
	if (!validateConfig.ignore) return false;

	for (const pattern of validateConfig.ignore) {
		const regex = new RegExp(`^${pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`);
		if (regex.test(entity)) return true;
	}
	return false;
}

async function findSimilarDocs(projectRoot: string, brokenRef: string): Promise<string | null> {
	const docsDir = join(projectRoot, ".knowns", "docs");
	if (!existsSync(docsDir)) return null;

	const allDocs: string[] = [];

	async function scanDir(dir: string, relativePath: string) {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await scanDir(join(dir, entry.name), entryRelPath);
			} else if (entry.name.endsWith(".md")) {
				allDocs.push(entryRelPath.replace(/\.md$/, ""));
			}
		}
	}

	await scanDir(docsDir, "");

	const brokenLower = brokenRef.toLowerCase();
	let bestMatch: string | null = null;
	let bestScore = 0;

	for (const doc of allDocs) {
		const docLower = doc.toLowerCase();
		const brokenParts = brokenLower.split(/[-_/]/);
		const docParts = docLower.split(/[-_/]/);

		let matchScore = 0;
		for (const part of brokenParts) {
			if (docLower.includes(part) && part.length > 2) {
				matchScore += part.length;
			}
		}
		for (const part of docParts) {
			if (brokenLower.includes(part) && part.length > 2) {
				matchScore += part.length;
			}
		}

		if (matchScore > bestScore) {
			bestScore = matchScore;
			bestMatch = doc;
		}
	}

	return bestScore >= 3 ? bestMatch : null;
}

// Validate functions
async function validateTasks(
	projectRoot: string,
	fileStore: FileStore,
	validateConfig: ValidateConfig,
): Promise<ValidationIssue[]> {
	const issues: ValidationIssue[] = [];
	const tasks = await fileStore.getAllTasks();
	const taskIds = new Set(tasks.map((t) => t.id));

	for (const task of tasks) {
		const taskRef = `task-${task.id}`;
		if (shouldIgnore(taskRef, validateConfig)) continue;

		const content = `${task.description || ""} ${task.implementationPlan || ""} ${task.implementationNotes || ""}`;
		const { docRefs, taskRefs, templateRefs } = extractRefs(content);

		// task-no-ac
		const noAcSeverity = getRuleSeverity("task-no-ac", "warning", validateConfig);
		if (noAcSeverity !== "off" && (!task.acceptanceCriteria || task.acceptanceCriteria.length === 0)) {
			issues.push({
				entity: taskRef,
				entityType: "task",
				rule: "task-no-ac",
				severity: noAcSeverity,
				message: "Task has no acceptance criteria",
			});
		}

		// task-no-description
		const noDescSeverity = getRuleSeverity("task-no-description", "warning", validateConfig);
		if (noDescSeverity !== "off" && (!task.description || task.description.trim() === "")) {
			issues.push({
				entity: taskRef,
				entityType: "task",
				rule: "task-no-description",
				severity: noDescSeverity,
				message: "Task has no description",
			});
		}

		// task-broken-doc-ref
		const brokenDocSeverity = getRuleSeverity("task-broken-doc-ref", "error", validateConfig);
		if (brokenDocSeverity !== "off") {
			for (const docPath of docRefs) {
				const resolved = await resolveDoc(projectRoot, docPath);
				if (!resolved) {
					const suggestion = await findSimilarDocs(projectRoot, docPath);
					const issue: ValidationIssue = {
						entity: taskRef,
						entityType: "task",
						rule: "task-broken-doc-ref",
						severity: brokenDocSeverity,
						message: suggestion
							? `Broken reference: @doc/${docPath} → did you mean @doc/${suggestion}?`
							: `Broken reference: @doc/${docPath}`,
						fixable: !!suggestion,
					};

					if (suggestion) {
						issue.fix = async () => {
							const tasksDir = join(projectRoot, ".knowns", "tasks");
							const files = await readdir(tasksDir);
							const taskFile = files.find((f) => f.startsWith(`task-${task.id} `));
							if (taskFile) {
								const taskFilePath = join(tasksDir, taskFile);
								const taskContent = await readFile(taskFilePath, "utf-8");
								const updated = taskContent.replace(
									new RegExp(`@docs?/${docPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"),
									`@doc/${suggestion}`,
								);
								await writeFile(taskFilePath, updated, "utf-8");
							}
						};
					}

					issues.push(issue);
				}
			}
		}

		// task-broken-task-ref
		const brokenTaskSeverity = getRuleSeverity("task-broken-task-ref", "error", validateConfig);
		if (brokenTaskSeverity !== "off") {
			for (const refTaskId of taskRefs) {
				if (!taskIds.has(refTaskId)) {
					issues.push({
						entity: taskRef,
						entityType: "task",
						rule: "task-broken-task-ref",
						severity: brokenTaskSeverity,
						message: `Broken reference: @task-${refTaskId}`,
					});
				}
			}
		}

		// task-broken-template-ref
		const brokenTplSeverity = getRuleSeverity("task-broken-template-ref", "error", validateConfig);
		if (brokenTplSeverity !== "off") {
			for (const templateName of templateRefs) {
				const resolved = await resolveTemplate(projectRoot, templateName);
				if (!resolved) {
					issues.push({
						entity: taskRef,
						entityType: "task",
						rule: "task-broken-template-ref",
						severity: brokenTplSeverity,
						message: `Broken reference: @template/${templateName}`,
					});
				}
			}
		}

		// task-self-ref
		const selfRefSeverity = getRuleSeverity("task-self-ref", "warning", validateConfig);
		if (selfRefSeverity !== "off" && taskRefs.includes(task.id)) {
			issues.push({
				entity: taskRef,
				entityType: "task",
				rule: "task-self-ref",
				severity: selfRefSeverity,
				message: "Task references itself",
			});
		}

		// task-circular-parent
		const circularSeverity = getRuleSeverity("task-circular-parent", "error", validateConfig);
		if (circularSeverity !== "off" && task.parent) {
			const visited = new Set<string>();
			let currentId: string | undefined = task.parent;
			while (currentId) {
				if (visited.has(currentId) || currentId === task.id) {
					issues.push({
						entity: taskRef,
						entityType: "task",
						rule: "task-circular-parent",
						severity: circularSeverity,
						message: currentId === task.id ? "Task is its own ancestor" : "Circular parent-child relationship detected",
					});
					break;
				}
				visited.add(currentId);
				const parentTask = tasks.find((t) => t.id === currentId);
				currentId = parentTask?.parent;
			}
		}
	}

	return issues;
}

async function validateDocs(
	projectRoot: string,
	fileStore: FileStore,
	validateConfig: ValidateConfig,
): Promise<ValidationIssue[]> {
	const issues: ValidationIssue[] = [];
	const docsDir = join(projectRoot, ".knowns", "docs");

	if (!existsSync(docsDir)) return issues;

	const tasks = await fileStore.getAllTasks();
	const taskIds = new Set(tasks.map((t) => t.id));

	const referencedDocs = new Set<string>();
	for (const task of tasks) {
		const content = `${task.description || ""} ${task.implementationPlan || ""} ${task.implementationNotes || ""}`;
		const { docRefs } = extractRefs(content);
		for (const ref of docRefs) {
			referencedDocs.add(ref.toLowerCase());
		}
	}

	async function scanDir(dir: string, relativePath: string) {
		const entries = await readdir(dir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;

			const fullPath = join(dir, entry.name);
			const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

			if (entry.isDirectory()) {
				await scanDir(fullPath, entryRelPath);
			} else if (entry.name.endsWith(".md")) {
				const docPath = entryRelPath.replace(/\.md$/, "");
				const docRef = `docs/${docPath}`;

				if (shouldIgnore(docRef, validateConfig) || shouldIgnore(docPath, validateConfig)) continue;

				try {
					const content = await readFile(fullPath, "utf-8");
					const { data, content: docContent } = matter(content);

					// doc-no-description
					const noDescSeverity = getRuleSeverity("doc-no-description", "warning", validateConfig);
					if (noDescSeverity !== "off" && (!data.description || String(data.description).trim() === "")) {
						issues.push({
							entity: docRef,
							entityType: "doc",
							rule: "doc-no-description",
							severity: noDescSeverity,
							message: "Doc has no description",
						});
					}

					// doc-orphan
					const orphanSeverity = getRuleSeverity("doc-orphan", "info", validateConfig);
					if (orphanSeverity !== "off" && !referencedDocs.has(docPath.toLowerCase())) {
						issues.push({
							entity: docRef,
							entityType: "doc",
							rule: "doc-orphan",
							severity: orphanSeverity,
							message: "Doc is not referenced by any task",
						});
					}

					const { docRefs, taskRefs } = extractRefs(docContent);

					// doc-broken-doc-ref
					const brokenDocSeverity = getRuleSeverity("doc-broken-doc-ref", "error", validateConfig);
					if (brokenDocSeverity !== "off") {
						for (const refDocPath of docRefs) {
							const resolved = await resolveDoc(projectRoot, refDocPath);
							if (!resolved) {
								const suggestion = await findSimilarDocs(projectRoot, refDocPath);
								const issue: ValidationIssue = {
									entity: docRef,
									entityType: "doc",
									rule: "doc-broken-doc-ref",
									severity: brokenDocSeverity,
									message: suggestion
										? `Broken reference: @doc/${refDocPath} → did you mean @doc/${suggestion}?`
										: `Broken reference: @doc/${refDocPath}`,
									fixable: !!suggestion,
								};

								if (suggestion) {
									issue.fix = async () => {
										const docFileContent = await readFile(fullPath, "utf-8");
										const updated = docFileContent.replace(
											new RegExp(`@docs?/${refDocPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"),
											`@doc/${suggestion}`,
										);
										await writeFile(fullPath, updated, "utf-8");
									};
								}

								issues.push(issue);
							}
						}
					}

					// doc-broken-task-ref
					const brokenTaskSeverity = getRuleSeverity("doc-broken-task-ref", "error", validateConfig);
					if (brokenTaskSeverity !== "off") {
						for (const refTaskId of taskRefs) {
							if (!taskIds.has(refTaskId)) {
								const issue: ValidationIssue = {
									entity: docRef,
									entityType: "doc",
									rule: "doc-broken-task-ref",
									severity: brokenTaskSeverity,
									message: `Broken reference: @task-${refTaskId}`,
									fixable: true,
								};

								issue.fix = async () => {
									const docFileContent = await readFile(fullPath, "utf-8");
									const updated = docFileContent.replace(
										new RegExp(`@task-${refTaskId}\\b`, "g"),
										`~task-${refTaskId}`,
									);
									await writeFile(fullPath, updated, "utf-8");
								};

								issues.push(issue);
							}
						}
					}
				} catch {
					// Skip files that can't be parsed
				}
			}
		}
	}

	await scanDir(docsDir, "");
	return issues;
}

async function validateTemplates(projectRoot: string, validateConfig: ValidateConfig): Promise<ValidationIssue[]> {
	const issues: ValidationIssue[] = [];
	const templates = await listAllTemplates(projectRoot);

	for (const template of templates) {
		const templateRef = `templates/${template.ref}`;
		if (shouldIgnore(templateRef, validateConfig)) continue;

		try {
			const config = await getTemplateConfig(template.path);

			const invalidSyntaxSeverity = getRuleSeverity("template-invalid-syntax", "error", validateConfig);
			if (invalidSyntaxSeverity !== "off" && !config) {
				issues.push({
					entity: templateRef,
					entityType: "template",
					rule: "template-invalid-syntax",
					severity: invalidSyntaxSeverity,
					message: "Failed to load template config (invalid or missing _template.yaml)",
				});
				continue;
			}

			if (!config) continue;

			// template-broken-doc-ref
			const brokenDocSeverity = getRuleSeverity("template-broken-doc-ref", "error", validateConfig);
			if (brokenDocSeverity !== "off" && config.doc) {
				const resolved = await resolveDoc(projectRoot, config.doc);
				if (!resolved) {
					issues.push({
						entity: templateRef,
						entityType: "template",
						rule: "template-broken-doc-ref",
						severity: brokenDocSeverity,
						message: `Broken doc reference: @doc/${config.doc}`,
					});
				}
			}

			// Check template syntax
			if (invalidSyntaxSeverity !== "off") {
				for (const action of config.actions || []) {
					if (action.type === "add" && action.template) {
						const templateFilePath = join(template.path, action.template);
						if (existsSync(templateFilePath)) {
							try {
								const templateContent = await readFile(templateFilePath, "utf-8");
								Handlebars.compile(templateContent);
							} catch (err) {
								issues.push({
									entity: templateRef,
									entityType: "template",
									rule: "template-invalid-syntax",
									severity: invalidSyntaxSeverity,
									message: `Invalid Handlebars syntax in ${action.template}: ${err instanceof Error ? err.message : "unknown error"}`,
								});
							}
						}
					}
				}
			}

			// template-missing-partial
			const missingPartialSeverity = getRuleSeverity("template-missing-partial", "error", validateConfig);
			if (missingPartialSeverity !== "off" && existsSync(template.path)) {
				const files = await readdir(template.path);
				const hbsFiles = files.filter((f) => f.endsWith(".hbs"));

				for (const hbsFile of hbsFiles) {
					const content = await readFile(join(template.path, hbsFile), "utf-8");
					const partialPattern = /\{\{>\s*([^\s}]+)\s*\}\}/g;
					for (const match of content.matchAll(partialPattern)) {
						const partialName = match[1];
						const partialPath = join(template.path, `_${partialName}.hbs`);
						if (!existsSync(partialPath)) {
							issues.push({
								entity: templateRef,
								entityType: "template",
								rule: "template-missing-partial",
								severity: missingPartialSeverity,
								message: `Missing partial: ${partialName} (expected at _${partialName}.hbs)`,
							});
						}
					}
				}
			}
		} catch (err) {
			const invalidSyntaxSeverity = getRuleSeverity("template-invalid-syntax", "error", validateConfig);
			if (invalidSyntaxSeverity !== "off") {
				issues.push({
					entity: templateRef,
					entityType: "template",
					rule: "template-invalid-syntax",
					severity: invalidSyntaxSeverity,
					message: `Failed to load template config: ${err instanceof Error ? err.message : "unknown error"}`,
				});
			}
		}
	}

	return issues;
}

async function applyFixes(issues: ValidationIssue[]): Promise<FixResult[]> {
	const results: FixResult[] = [];
	const fixableIssues = issues.filter((i) => i.fixable && i.fix);

	for (const issue of fixableIssues) {
		try {
			await issue.fix?.();
			results.push({
				entity: issue.entity,
				rule: issue.rule,
				action: issue.message,
				success: true,
			});
		} catch (err) {
			results.push({
				entity: issue.entity,
				rule: issue.rule,
				action: `Failed: ${err instanceof Error ? err.message : "unknown error"}`,
				success: false,
			});
		}
	}

	return results;
}

// Handler
export async function handleValidate(
	args: { type?: string; strict?: boolean; fix?: boolean } | undefined,
	fileStore: FileStore,
) {
	try {
		const projectRoot = getProjectRoot();
		const validateConfig = await loadValidateConfig(projectRoot);

		const allIssues: ValidationIssue[] = [];
		const stats = { tasks: 0, docs: 0, templates: 0 };

		// Validate tasks
		if (!args?.type || args.type === "task") {
			const tasks = await fileStore.getAllTasks();
			stats.tasks = tasks.length;
			const taskIssues = await validateTasks(projectRoot, fileStore, validateConfig);
			allIssues.push(...taskIssues);
		}

		// Validate docs
		if (!args?.type || args.type === "doc") {
			const docsDir = join(projectRoot, ".knowns", "docs");
			if (existsSync(docsDir)) {
				async function countDocs(dir: string): Promise<number> {
					let count = 0;
					const entries = await readdir(dir, { withFileTypes: true });
					for (const entry of entries) {
						if (entry.name.startsWith(".")) continue;
						if (entry.isDirectory()) {
							count += await countDocs(join(dir, entry.name));
						} else if (entry.name.endsWith(".md")) {
							count++;
						}
					}
					return count;
				}
				stats.docs = await countDocs(docsDir);
			}
			const docIssues = await validateDocs(projectRoot, fileStore, validateConfig);
			allIssues.push(...docIssues);
		}

		// Validate templates
		if (!args?.type || args.type === "template") {
			const templates = await listAllTemplates(projectRoot);
			stats.templates = templates.length;
			const templateIssues = await validateTemplates(projectRoot, validateConfig);
			allIssues.push(...templateIssues);
		}

		// Strict mode
		if (args?.strict) {
			for (const issue of allIssues) {
				if (issue.severity === "warning") {
					issue.severity = "error";
				}
			}
		}

		// Apply fixes
		let fixes: FixResult[] = [];
		if (args?.fix) {
			fixes = await applyFixes(allIssues);
		}

		const errors = allIssues.filter((i) => i.severity === "error");
		const warnings = allIssues.filter((i) => i.severity === "warning");
		const infos = allIssues.filter((i) => i.severity === "info");

		return successResponse({
			valid: errors.length === 0,
			stats,
			summary: {
				errors: errors.length,
				warnings: warnings.length,
				info: infos.length,
			},
			issues: allIssues.map((i) => ({
				entity: i.entity,
				entityType: i.entityType,
				rule: i.rule,
				severity: i.severity,
				message: i.message,
				fixable: i.fixable || false,
			})),
			...(args?.fix && fixes.length > 0 ? { fixes } : {}),
		});
	} catch (error) {
		return errorResponse(error instanceof Error ? error.message : String(error));
	}
}
