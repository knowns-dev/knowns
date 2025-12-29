/**
 * Mention Reference Transformer
 * Transforms @task-{id} and @doc/{path} mentions into Claude-readable file references
 */

import type { Task } from "@models/index";

// Regex patterns for mentions (input format)
const TASK_MENTION_REGEX = /@task-(\d+)/g;
const DOC_MENTION_REGEX = /@docs?\/([^\s|)]+)/g;

// Regex patterns for output format (need to normalize back to input format)
// Matches: @.knowns/tasks/task-55 - Title.md or @.knowns/tasks/task-55.md
const OUTPUT_TASK_REGEX = /@\.knowns\/tasks\/task-(\d+)(?:\s*-\s*[^@\n]+?\.md|\.md)/g;
// Matches: @.knowns/docs/path/to/doc.md or @.knowns/docs/README.md - Description
const OUTPUT_DOC_REGEX = /@\.knowns\/docs\/([^\s@]+?)\.md(?:\s*-\s*[^@\n]+)?/g;

/**
 * Sanitize title for filename (same logic as file-store)
 */
function sanitizeTitle(title: string): string {
	return title
		.replace(/[<>:"/\\|?*]/g, "") // Remove invalid chars
		.replace(/\s+/g, " ") // Normalize spaces
		.trim()
		.slice(0, 50); // Limit length
}

/**
 * Transform task mention to file reference
 * @task-44 -> @.knowns/tasks/task-44 - Task-Title.md
 */
function transformTaskMention(taskId: string, tasks: Map<string, Task>): string {
	const task = tasks.get(taskId);
	if (task) {
		const sanitizedTitle = sanitizeTitle(task.title);
		return `@.knowns/tasks/task-${taskId} - ${sanitizedTitle}.md`;
	}
	// Fallback if task not found
	return `@.knowns/tasks/task-${taskId}.md`;
}

/**
 * Transform doc mention to file reference
 * @doc/README.md -> @.knowns/docs/README.md
 */
function transformDocMention(docPath: string): string {
	// Ensure .md extension
	const normalizedPath = docPath.endsWith(".md") ? docPath : `${docPath}.md`;
	return `@.knowns/docs/${normalizedPath}`;
}

/**
 * Transform all mentions in text to Claude-readable file references
 * Used for --plain output to help Claude understand file references
 */
export function transformMentionsToRefs(text: string, tasks: Map<string, Task>): string {
	let result = text;

	// Transform @task-{id} mentions
	result = result.replace(TASK_MENTION_REGEX, (match, taskId) => {
		return transformTaskMention(taskId, tasks);
	});

	// Transform @doc/{path} mentions
	result = result.replace(DOC_MENTION_REGEX, (match, docPath) => {
		return transformDocMention(docPath);
	});

	return result;
}

/**
 * Build a task lookup map from task array
 */
export function buildTaskMap(tasks: Task[]): Map<string, Task> {
	const map = new Map<string, Task>();
	for (const task of tasks) {
		map.set(task.id, task);
	}
	return map;
}

/**
 * Extract task IDs referenced in text
 */
export function extractTaskIds(text: string): string[] {
	const ids: string[] = [];
	let match: RegExpExecArray | null;
	const regex = new RegExp(TASK_MENTION_REGEX.source, "g");

	// biome-ignore lint/suspicious/noAssignInExpressions: Standard regex iteration
	while ((match = regex.exec(text)) !== null) {
		ids.push(match[1]);
	}

	return [...new Set(ids)]; // Dedupe
}

/**
 * Extract doc paths referenced in text
 */
export function extractDocPaths(text: string): string[] {
	const paths: string[] = [];
	let match: RegExpExecArray | null;
	const regex = new RegExp(DOC_MENTION_REGEX.source, "g");

	// biome-ignore lint/suspicious/noAssignInExpressions: Standard regex iteration
	while ((match = regex.exec(text)) !== null) {
		paths.push(match[1]);
	}

	return [...new Set(paths)]; // Dedupe
}

/**
 * Normalize refs from output format back to input format
 * This is used when saving content to ensure consistent storage format
 *
 * Converts:
 * - @.knowns/tasks/task-55 - Some Title.md → @task-55
 * - @.knowns/docs/README.md → @doc/README
 * - @.knowns/docs/folder/doc.md - Description → @doc/folder/doc
 */
export function normalizeRefs(text: string): string {
	let result = text;

	// Normalize task refs: @.knowns/tasks/task-{id} - Title.md → @task-{id}
	result = result.replace(new RegExp(OUTPUT_TASK_REGEX.source, "g"), (match, taskId) => `@task-${taskId}`);

	// Normalize doc refs: @.knowns/docs/{path}.md → @doc/{path}
	result = result.replace(new RegExp(OUTPUT_DOC_REGEX.source, "g"), (match, docPath) => `@doc/${docPath}`);

	return result;
}

/**
 * Check if text contains any output-format refs that should be normalized
 */
export function hasOutputFormatRefs(text: string): boolean {
	const taskRegex = new RegExp(OUTPUT_TASK_REGEX.source);
	const docRegex = new RegExp(OUTPUT_DOC_REGEX.source);
	return taskRegex.test(text) || docRegex.test(text);
}
