/**
 * Validate Command
 * Validates tasks, docs, and templates for quality and reference integrity
 */

import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getTemplateConfig } from "@codegen/index";
import type { Task } from "@models/index";
import { FileStore } from "@storage/file-store";
import { findProjectRoot } from "@utils/find-project-root";
import chalk from "chalk";
import { Command } from "commander";
import matter from "gray-matter";
import Handlebars from "handlebars";
import { readConfig } from "../import/config";
import { listAllTemplates, resolveDoc, resolveTemplate } from "../import/resolver";

// ============================================================================
// TYPES
// ============================================================================

type Severity = "error" | "warning" | "info";

interface ValidationIssue {
	entity: string;
	entityType: "task" | "doc" | "template";
	rule: string;
	severity: Severity;
	message: string;
	fixable?: boolean;
	fix?: () => Promise<void>;
}

interface ValidationResult {
	issues: ValidationIssue[];
	stats: {
		tasks: number;
		docs: number;
		templates: number;
	};
}

interface DocMetadata {
	title?: string;
	description?: string;
	createdAt?: string;
	updatedAt?: string;
	tags?: string[];
}

type RuleSeverity = "error" | "warning" | "info" | "off";

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

interface SDDStats {
	specs: { total: number; approved: number; draft: number };
	tasks: { total: number; done: number; inProgress: number; todo: number; withSpec: number; withoutSpec: number };
	coverage: { linked: number; total: number; percent: number };
	acCompletion: Map<string, { total: number; completed: number; percent: number }>;
}

interface SDDWarning {
	type: "task-no-spec" | "spec-broken-link" | "spec-ac-incomplete";
	entity: string;
	message: string;
}

interface SDDResult {
	stats: SDDStats;
	warnings: SDDWarning[];
	passed: string[];
}

// ============================================================================
// HELPERS
// ============================================================================

function getFileStore(): FileStore {
	const projectRoot = findProjectRoot();
	if (!projectRoot) {
		console.error(chalk.red("✗ Not a knowns project"));
		console.error(chalk.gray('  Run "knowns init" to initialize'));
		process.exit(1);
	}
	return new FileStore(projectRoot);
}

function getProjectRoot(): string {
	const projectRoot = findProjectRoot();
	if (!projectRoot) {
		console.error(chalk.red("✗ Not a knowns project"));
		console.error(chalk.gray('  Run "knowns init" to initialize'));
		process.exit(1);
	}
	return projectRoot;
}

/**
 * Load validate config from .knowns/config.json
 */
async function loadValidateConfig(projectRoot: string): Promise<ValidateConfig> {
	const config = await readConfig(projectRoot);
	return (config.validate as ValidateConfig) || {};
}

/**
 * Get configured severity for a rule
 */
function getRuleSeverity(rule: string, defaultSeverity: Severity, validateConfig: ValidateConfig): Severity | "off" {
	if (validateConfig.rules?.[rule]) {
		return validateConfig.rules[rule];
	}
	return defaultSeverity;
}

/**
 * Check if entity should be ignored
 */
function shouldIgnore(entity: string, validateConfig: ValidateConfig): boolean {
	if (!validateConfig.ignore) return false;

	for (const pattern of validateConfig.ignore) {
		// Simple glob matching - supports ** and *
		const regex = new RegExp(`^${pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`);
		if (regex.test(entity)) return true;
	}
	return false;
}

/**
 * Find similar doc names for suggestions
 */
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

	// Find best match using simple Levenshtein-like scoring
	const brokenLower = brokenRef.toLowerCase();
	let bestMatch: string | null = null;
	let bestScore = 0;

	for (const doc of allDocs) {
		const docLower = doc.toLowerCase();
		// Check if doc contains parts of broken ref or vice versa
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

	// Only suggest if there's a reasonable match
	return bestScore >= 3 ? bestMatch : null;
}

// ============================================================================
// VALIDATION RULES
// ============================================================================

/**
 * Strip trailing punctuation from a ref path
 */
function stripTrailingPunctuation(path: string): string {
	return path.replace(/[.,;:!?`'")\]]+$/, "");
}

/**
 * Extract all references from content
 */
function extractRefs(content: string): { docRefs: string[]; taskRefs: string[]; templateRefs: string[] } {
	const docRefs: string[] = [];
	const taskRefs: string[] = [];
	const templateRefs: string[] = [];

	// Match @doc/xxx refs (allow most chars, strip trailing punctuation later)
	const docRefPattern = /@docs?\/([^\s,;:!?"'()\]]+)/g;
	for (const match of content.matchAll(docRefPattern)) {
		let docPath = stripTrailingPunctuation(match[1] || "");
		docPath = docPath.replace(/\.md$/, "");
		if (docPath && !docRefs.includes(docPath)) {
			docRefs.push(docPath);
		}
	}

	// Match @task-xxx refs
	const taskRefPattern = /@task-([a-zA-Z0-9]+)/g;
	for (const match of content.matchAll(taskRefPattern)) {
		const taskId = match[1] || "";
		if (taskId && !taskRefs.includes(taskId)) {
			taskRefs.push(taskId);
		}
	}

	// Match @template/xxx refs
	const templateRefPattern = /@template\/([^\s,;:!?"'()\]]+)/g;
	for (const match of content.matchAll(templateRefPattern)) {
		const templateName = stripTrailingPunctuation(match[1] || "");
		if (templateName && !templateRefs.includes(templateName)) {
			templateRefs.push(templateName);
		}
	}

	return { docRefs, taskRefs, templateRefs };
}

/**
 * Validate all tasks
 */
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

		// Check if this task should be ignored
		if (shouldIgnore(taskRef, validateConfig)) continue;

		const content = `${task.description || ""} ${task.implementationPlan || ""} ${task.implementationNotes || ""}`;
		const { docRefs, taskRefs, templateRefs } = extractRefs(content);

		// Rule: task-no-ac
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

		// Rule: task-no-description
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

		// Rule: task-broken-doc-ref
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
							// Find the actual task file by scanning the directory
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

		// Rule: task-broken-task-ref
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

		// Rule: task-broken-template-ref
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

		// Rule: task-self-ref
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

		// Rule: task-circular-parent
		const circularSeverity = getRuleSeverity("task-circular-parent", "error", validateConfig);
		if (circularSeverity !== "off" && task.parent) {
			const visited = new Set<string>();
			let currentId: string | undefined = task.parent;
			while (currentId) {
				if (visited.has(currentId)) {
					issues.push({
						entity: taskRef,
						entityType: "task",
						rule: "task-circular-parent",
						severity: circularSeverity,
						message: "Circular parent-child relationship detected",
					});
					break;
				}
				if (currentId === task.id) {
					issues.push({
						entity: taskRef,
						entityType: "task",
						rule: "task-circular-parent",
						severity: circularSeverity,
						message: "Task is its own ancestor",
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

/**
 * Validate all docs
 */
async function validateDocs(
	projectRoot: string,
	fileStore: FileStore,
	validateConfig: ValidateConfig,
): Promise<ValidationIssue[]> {
	const issues: ValidationIssue[] = [];
	const docsDir = join(projectRoot, ".knowns", "docs");

	if (!existsSync(docsDir)) {
		return issues;
	}

	const tasks = await fileStore.getAllTasks();
	const taskIds = new Set(tasks.map((t) => t.id));

	// Collect all doc refs from tasks to check for orphans
	const referencedDocs = new Set<string>();
	for (const task of tasks) {
		const content = `${task.description || ""} ${task.implementationPlan || ""} ${task.implementationNotes || ""}`;
		const { docRefs } = extractRefs(content);
		for (const ref of docRefs) {
			referencedDocs.add(ref.toLowerCase());
		}
	}

	// Scan docs recursively
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

				// Check if this doc should be ignored
				if (shouldIgnore(docRef, validateConfig)) continue;
				if (shouldIgnore(docPath, validateConfig)) continue;

				try {
					const content = await readFile(fullPath, "utf-8");
					const { data, content: docContent } = matter(content);
					const metadata = data as DocMetadata;

					// Rule: doc-no-description
					const noDescSeverity = getRuleSeverity("doc-no-description", "warning", validateConfig);
					if (noDescSeverity !== "off" && (!metadata.description || metadata.description.trim() === "")) {
						issues.push({
							entity: docRef,
							entityType: "doc",
							rule: "doc-no-description",
							severity: noDescSeverity,
							message: "Doc has no description",
						});
					}

					// Rule: doc-orphan (info only)
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

					// Extract refs from doc content
					const { docRefs, taskRefs } = extractRefs(docContent);

					// Rule: doc-broken-doc-ref
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

					// Rule: doc-broken-task-ref
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

								// Fix: remove stale task ref (use ~task- to avoid re-detection)
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

/**
 * Validate all templates
 */
async function validateTemplates(projectRoot: string, validateConfig: ValidateConfig): Promise<ValidationIssue[]> {
	const issues: ValidationIssue[] = [];
	const templates = await listAllTemplates(projectRoot);

	for (const template of templates) {
		const templateRef = `templates/${template.ref}`;

		// Check if this template should be ignored
		if (shouldIgnore(templateRef, validateConfig)) continue;

		try {
			const config = await getTemplateConfig(template.path);

			// Rule: template-invalid-syntax
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

			// Rule: template-broken-doc-ref
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

			// Check each template file for syntax
			if (invalidSyntaxSeverity !== "off") {
				for (const action of config.actions || []) {
					if (action.type === "add" && action.template) {
						const templateFilePath = join(template.path, action.template);
						if (existsSync(templateFilePath)) {
							try {
								const templateContent = await readFile(templateFilePath, "utf-8");
								// Try to compile the template to check for syntax errors
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

			// Check for missing partials (basic check)
			const missingPartialSeverity = getRuleSeverity("template-missing-partial", "error", validateConfig);
			if (missingPartialSeverity !== "off") {
				const templatesDir = template.path;
				if (existsSync(templatesDir)) {
					const files = await readdir(templatesDir);
					const hbsFiles = files.filter((f) => f.endsWith(".hbs"));

					for (const hbsFile of hbsFiles) {
						const content = await readFile(join(templatesDir, hbsFile), "utf-8");
						// Look for partial references like {{> partialName}}
						const partialPattern = /\{\{>\s*([^\s}]+)\s*\}\}/g;
						for (const match of content.matchAll(partialPattern)) {
							const partialName = match[1];
							// Check if partial file exists (simple check)
							const partialPath = join(templatesDir, `_${partialName}.hbs`);
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

/**
 * Run SDD (Spec-Driven Development) validation
 * Checks spec coverage, AC completion, and task-spec linkage
 */
async function runSDDValidation(projectRoot: string, fileStore: FileStore): Promise<SDDResult> {
	const tasks = await fileStore.getAllTasks();
	const docsDir = join(projectRoot, ".knowns", "docs");

	// Initialize stats
	const stats: SDDStats = {
		specs: { total: 0, approved: 0, draft: 0 },
		tasks: { total: tasks.length, done: 0, inProgress: 0, todo: 0, withSpec: 0, withoutSpec: 0 },
		coverage: { linked: 0, total: tasks.length, percent: 0 },
		acCompletion: new Map(),
	};

	const warnings: SDDWarning[] = [];
	const passed: string[] = [];

	// Count task statuses
	for (const task of tasks) {
		if (task.status === "done") stats.tasks.done++;
		else if (task.status === "in-progress") stats.tasks.inProgress++;
		else stats.tasks.todo++;

		if (task.spec) {
			stats.tasks.withSpec++;
		} else {
			stats.tasks.withoutSpec++;
			warnings.push({
				type: "task-no-spec",
				entity: `task-${task.id}`,
				message: `${task.title} has no spec reference`,
			});
		}
	}

	stats.coverage.linked = stats.tasks.withSpec;
	stats.coverage.percent = stats.tasks.total > 0 ? Math.round((stats.tasks.withSpec / stats.tasks.total) * 100) : 0;

	// Scan specs folder for spec documents
	const specsDir = join(docsDir, "specs");
	if (existsSync(specsDir)) {
		async function scanSpecs(dir: string, relativePath: string) {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					await scanSpecs(join(dir, entry.name), entryRelPath);
				} else if (entry.name.endsWith(".md")) {
					stats.specs.total++;
					const specPath = `specs/${entryRelPath.replace(/\.md$/, "")}`;

					try {
						const content = await readFile(join(dir, entry.name), "utf-8");
						const { data } = matter(content);

						// Check spec status (draft vs approved)
						if (data.status === "approved" || data.status === "implemented") {
							stats.specs.approved++;
						} else {
							stats.specs.draft++;
						}

						// Calculate AC completion for tasks linked to this spec
						const linkedTasks = tasks.filter((t) => t.spec === specPath);
						if (linkedTasks.length > 0) {
							let totalAC = 0;
							let completedAC = 0;
							for (const task of linkedTasks) {
								totalAC += task.acceptanceCriteria.length;
								completedAC += task.acceptanceCriteria.filter((ac) => ac.completed).length;
							}
							const percent = totalAC > 0 ? Math.round((completedAC / totalAC) * 100) : 100;
							stats.acCompletion.set(specPath, { total: totalAC, completed: completedAC, percent });

							if (percent < 100 && totalAC > 0) {
								warnings.push({
									type: "spec-ac-incomplete",
									entity: specPath,
									message: `${completedAC}/${totalAC} ACs complete (${percent}%)`,
								});
							}
						}
					} catch {
						// Skip files that can't be parsed
					}
				}
			}
		}
		await scanSpecs(specsDir, "");
	}

	// Validate spec links in tasks
	for (const task of tasks) {
		if (task.spec) {
			const specDocPath = join(docsDir, `${task.spec}.md`);
			if (!existsSync(specDocPath)) {
				warnings.push({
					type: "spec-broken-link",
					entity: `task-${task.id}`,
					message: `Broken spec reference: @doc/${task.spec}`,
				});
			}
		}
	}

	// Generate passed messages
	if (warnings.filter((w) => w.type === "spec-broken-link").length === 0) {
		passed.push("All spec references resolve");
	}

	// Check for fully implemented specs
	for (const [specPath, completion] of stats.acCompletion) {
		if (completion.percent === 100) {
			passed.push(`${specPath}: fully implemented`);
		}
	}

	return { stats, warnings, passed };
}

/**
 * Format SDD validation report
 */
function formatSDDReport(result: SDDResult, plain: boolean): void {
	const { stats, warnings, passed } = result;

	if (plain) {
		console.log("\nSDD Status Report");
		console.log("=".repeat(50));
		console.log(`Specs:    ${stats.specs.total} total | ${stats.specs.approved} approved | ${stats.specs.draft} draft`);
		console.log(
			`Tasks:    ${stats.tasks.total} total | ${stats.tasks.done} done | ${stats.tasks.inProgress} in-progress | ${stats.tasks.todo} todo`,
		);
		console.log(
			`Coverage: ${stats.coverage.linked}/${stats.coverage.total} tasks linked to specs (${stats.coverage.percent}%)`,
		);

		if (warnings.length > 0) {
			console.log("\nWarnings:");
			for (const w of warnings) {
				console.log(`  - ${w.entity}: ${w.message}`);
			}
		}

		if (passed.length > 0) {
			console.log("\nPassed:");
			for (const p of passed) {
				console.log(`  - ${p}`);
			}
		}
	} else {
		console.log(chalk.bold("\n📋 SDD Status Report"));
		console.log(chalk.gray("═".repeat(50)));
		console.log(
			`${chalk.gray("Specs:")}    ${stats.specs.total} total | ${chalk.green(`${stats.specs.approved} approved`)} | ${chalk.yellow(`${stats.specs.draft} draft`)}`,
		);
		console.log(
			`${chalk.gray("Tasks:")}    ${stats.tasks.total} total | ${chalk.green(`${stats.tasks.done} done`)} | ${chalk.yellow(`${stats.tasks.inProgress} in-progress`)} | ${chalk.gray(`${stats.tasks.todo} todo`)}`,
		);
		console.log(
			`${chalk.gray("Coverage:")} ${stats.coverage.linked}/${stats.coverage.total} tasks linked to specs (${stats.coverage.percent >= 75 ? chalk.green(`${stats.coverage.percent}%`) : chalk.yellow(`${stats.coverage.percent}%`)})`,
		);

		if (warnings.length > 0) {
			console.log(chalk.bold.yellow("\n⚠️ Warnings:"));
			for (const w of warnings) {
				console.log(`  ${chalk.yellow("•")} ${chalk.bold(w.entity)}: ${w.message}`);
			}
		}

		if (passed.length > 0) {
			console.log(chalk.bold.green("\n✅ Passed:"));
			for (const p of passed) {
				console.log(`  ${chalk.green("•")} ${p}`);
			}
		}
	}
}

/**
 * Run all validations
 */
async function runValidation(options: {
	type?: string;
	strict?: boolean;
}): Promise<ValidationResult> {
	const projectRoot = getProjectRoot();
	const fileStore = getFileStore();
	const validateConfig = await loadValidateConfig(projectRoot);

	const allIssues: ValidationIssue[] = [];
	const stats = { tasks: 0, docs: 0, templates: 0 };

	// Validate tasks
	if (!options.type || options.type === "task") {
		const tasks = await fileStore.getAllTasks();
		stats.tasks = tasks.length;
		const taskIssues = await validateTasks(projectRoot, fileStore, validateConfig);
		allIssues.push(...taskIssues);
	}

	// Validate docs
	if (!options.type || options.type === "doc") {
		const docsDir = join(projectRoot, ".knowns", "docs");
		if (existsSync(docsDir)) {
			// Count docs
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
	if (!options.type || options.type === "template") {
		const templates = await listAllTemplates(projectRoot);
		stats.templates = templates.length;
		const templateIssues = await validateTemplates(projectRoot, validateConfig);
		allIssues.push(...templateIssues);
	}

	// In strict mode, elevate warnings to errors
	if (options.strict) {
		for (const issue of allIssues) {
			if (issue.severity === "warning") {
				issue.severity = "error";
			}
		}
	}

	return { issues: allIssues, stats };
}

/**
 * Apply fixes for fixable issues
 */
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

// ============================================================================
// OUTPUT FORMATTING
// ============================================================================

function formatIssues(issues: ValidationIssue[], plain: boolean): void {
	const errors = issues.filter((i) => i.severity === "error");
	const warnings = issues.filter((i) => i.severity === "warning");
	const infos = issues.filter((i) => i.severity === "info");

	if (plain) {
		if (errors.length > 0) {
			console.log("\nErrors:");
			for (const issue of errors) {
				console.log(`  ${issue.entity}: [${issue.rule}] ${issue.message}`);
			}
		}
		if (warnings.length > 0) {
			console.log("\nWarnings:");
			for (const issue of warnings) {
				console.log(`  ${issue.entity}: [${issue.rule}] ${issue.message}`);
			}
		}
		if (infos.length > 0) {
			console.log("\nInfo:");
			for (const issue of infos) {
				console.log(`  ${issue.entity}: [${issue.rule}] ${issue.message}`);
			}
		}
	} else {
		if (errors.length > 0) {
			console.log(chalk.bold.red("\n✗ Errors:"));
			for (const issue of errors) {
				console.log(
					`  ${chalk.red("•")} ${chalk.bold(issue.entity)}: ${chalk.gray(`[${issue.rule}]`)} ${issue.message}`,
				);
			}
		}
		if (warnings.length > 0) {
			console.log(chalk.bold.yellow("\n⚠ Warnings:"));
			for (const issue of warnings) {
				console.log(
					`  ${chalk.yellow("•")} ${chalk.bold(issue.entity)}: ${chalk.gray(`[${issue.rule}]`)} ${issue.message}`,
				);
			}
		}
		if (infos.length > 0) {
			console.log(chalk.bold.blue("\nℹ Info:"));
			for (const issue of infos) {
				console.log(
					`  ${chalk.blue("•")} ${chalk.bold(issue.entity)}: ${chalk.gray(`[${issue.rule}]`)} ${issue.message}`,
				);
			}
		}
	}
}

function formatJson(result: ValidationResult): void {
	const output = {
		valid: result.issues.filter((i) => i.severity === "error").length === 0,
		stats: result.stats,
		summary: {
			errors: result.issues.filter((i) => i.severity === "error").length,
			warnings: result.issues.filter((i) => i.severity === "warning").length,
			info: result.issues.filter((i) => i.severity === "info").length,
		},
		issues: result.issues.map((i) => ({
			entity: i.entity,
			entityType: i.entityType,
			rule: i.rule,
			severity: i.severity,
			message: i.message,
		})),
	};
	console.log(JSON.stringify(output, null, 2));
}

// ============================================================================
// CLI COMMAND
// ============================================================================

export const validateCommand = new Command("validate")
	.description("Validate tasks, docs, and templates for quality and reference integrity")
	.option("--type <type>", "Entity type to validate: task, doc, template")
	.option("--strict", "Treat warnings as errors")
	.option("--json", "Output results as JSON")
	.option("--fix", "Auto-fix supported issues (doc renames, stale refs)")
	.option("--sdd", "Run SDD (Spec-Driven Development) validation checks")
	.option("--plain", "Plain text output for AI")
	.action(
		async (options: {
			type?: string;
			strict?: boolean;
			json?: boolean;
			fix?: boolean;
			sdd?: boolean;
			plain?: boolean;
		}) => {
			try {
				// Validate type option
				if (options.type && !["task", "doc", "template"].includes(options.type)) {
					console.error(chalk.red(`✗ Invalid type: ${options.type}`));
					console.error(chalk.gray("  Valid types: task, doc, template"));
					process.exit(1);
				}

				const projectRoot = getProjectRoot();
				const fileStore = getFileStore();
				const startTime = Date.now();

				// SDD validation mode
				if (options.sdd) {
					const sddResult = await runSDDValidation(projectRoot, fileStore);
					const elapsed = Date.now() - startTime;

					if (options.json) {
						const jsonOutput = {
							mode: "sdd",
							stats: {
								specs: sddResult.stats.specs,
								tasks: sddResult.stats.tasks,
								coverage: sddResult.stats.coverage,
								acCompletion: Object.fromEntries(sddResult.stats.acCompletion),
							},
							warnings: sddResult.warnings,
							passed: sddResult.passed,
							elapsed,
						};
						console.log(JSON.stringify(jsonOutput, null, 2));
					} else {
						formatSDDReport(sddResult, !!options.plain);
						console.log(options.plain ? `\nTime: ${elapsed}ms` : chalk.gray(`\nTime: ${elapsed}ms`));
					}

					// SDD always exits 0 (warn, never block)
					process.exit(0);
				}

				const result = await runValidation({
					type: options.type,
					strict: options.strict,
				});

				const elapsed = Date.now() - startTime;

				// Apply fixes if requested
				let fixResults: FixResult[] = [];
				if (options.fix) {
					fixResults = await applyFixes(result.issues);
				}

				const errors = result.issues.filter((i) => i.severity === "error");
				const warnings = result.issues.filter((i) => i.severity === "warning");
				const fixableCount = result.issues.filter((i) => i.fixable).length;

				// JSON output
				if (options.json) {
					const jsonOutput = {
						valid: errors.length === 0,
						stats: result.stats,
						summary: {
							errors: errors.length,
							warnings: warnings.length,
							info: result.issues.filter((i) => i.severity === "info").length,
						},
						issues: result.issues.map((i) => ({
							entity: i.entity,
							entityType: i.entityType,
							rule: i.rule,
							severity: i.severity,
							message: i.message,
							fixable: i.fixable || false,
						})),
						elapsed,
						...(options.fix && fixResults.length > 0 ? { fixes: fixResults } : {}),
					};
					console.log(JSON.stringify(jsonOutput, null, 2));
					process.exit(errors.length > 0 ? 1 : 0);
				}

				// Normal output
				const isPlain = options.plain;

				if (isPlain) {
					console.log("Validating...");
					console.log(`  Tasks: ${result.stats.tasks} checked`);
					console.log(`  Docs: ${result.stats.docs} checked`);
					console.log(`  Templates: ${result.stats.templates} checked`);
					console.log(`  Time: ${elapsed}ms`);
				} else {
					console.log(chalk.bold("\n🔍 Validating..."));
					console.log(`  ${chalk.gray("Tasks:")} ${result.stats.tasks} checked`);
					console.log(`  ${chalk.gray("Docs:")} ${result.stats.docs} checked`);
					console.log(`  ${chalk.gray("Templates:")} ${result.stats.templates} checked`);
					console.log(`  ${chalk.gray("Time:")} ${elapsed}ms`);
				}

				// Show fix results if --fix was used
				if (options.fix && fixResults.length > 0) {
					if (isPlain) {
						console.log(`\nFixed ${fixResults.filter((r) => r.success).length} issue(s):`);
						for (const fix of fixResults) {
							console.log(`  ${fix.success ? "✓" : "✗"} ${fix.entity}: ${fix.action}`);
						}
					} else {
						console.log(chalk.bold.green(`\n✓ Fixed ${fixResults.filter((r) => r.success).length} issue(s):`));
						for (const fix of fixResults) {
							if (fix.success) {
								console.log(`  ${chalk.green("✓")} ${chalk.bold(fix.entity)}: ${fix.action}`);
							} else {
								console.log(`  ${chalk.red("✗")} ${chalk.bold(fix.entity)}: ${fix.action}`);
							}
						}
					}
				}

				if (result.issues.length === 0) {
					if (isPlain) {
						console.log("\n✓ All validations passed");
					} else {
						console.log(chalk.green("\n✓ All validations passed"));
					}
					process.exit(0);
				}

				// Show summary
				if (isPlain) {
					console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
					if (fixableCount > 0 && !options.fix) {
						console.log(`  ${fixableCount} issue(s) can be auto-fixed with --fix`);
					}
				} else {
					const summaryParts = [];
					if (errors.length > 0) {
						summaryParts.push(chalk.red(`${errors.length} error(s)`));
					}
					if (warnings.length > 0) {
						summaryParts.push(chalk.yellow(`${warnings.length} warning(s)`));
					}
					console.log(`\n${summaryParts.join(", ")}`);
					if (fixableCount > 0 && !options.fix) {
						console.log(chalk.gray(`  ${fixableCount} issue(s) can be auto-fixed with --fix`));
					}
				}

				// Show issues
				formatIssues(result.issues, !!isPlain);

				// Exit with error code if there are errors
				process.exit(errors.length > 0 ? 1 : 0);
			} catch (error) {
				console.error(chalk.red("✗ Validation failed"));
				if (error instanceof Error) {
					console.error(chalk.red(`  ${error.message}`));
				}
				process.exit(1);
			}
		},
	);
