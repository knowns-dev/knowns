/**
 * Mention Reference Utilities
 * Handles normalization of refs from output format back to input format
 */

// Regex patterns for output format (need to normalize back to input format)
// Matches: @.knowns/tasks/task-{id} - Title.md or @.knowns/tasks/task-{id}.md
// Supports both numeric (55) and alphanumeric (pdyd2e) task IDs
const OUTPUT_TASK_REGEX = /@\.knowns\/tasks\/task-([a-zA-Z0-9]+)(?:\s*-\s*[^@\n]+?\.md|\.md)/g;
// Matches: @.knowns/docs/path/to/doc.md or @.knowns/docs/README.md - Description
const OUTPUT_DOC_REGEX = /@\.knowns\/docs\/([^\s@]+?)\.md(?:\s*-\s*[^@\n]+)?/g;

/**
 * Normalize refs from output format back to input format
 * This is used when saving content to ensure consistent storage format
 *
 * Converts:
 * - @.knowns/tasks/task-55 - Some Title.md -> @task-55
 * - @.knowns/tasks/task-pdyd2e.md -> @task-pdyd2e
 * - @.knowns/docs/README.md -> @doc/README
 * - @.knowns/docs/folder/doc.md - Description -> @doc/folder/doc
 */
export function normalizeRefs(text: string): string {
	let result = text;

	// Parse escape sequences (for AI agents that pass literal \n instead of actual newlines)
	result = parseEscapeSequences(result);

	// Normalize task refs: @.knowns/tasks/task-{id} - Title.md -> @task-{id}
	result = result.replace(new RegExp(OUTPUT_TASK_REGEX.source, "g"), (_match, taskId) => `@task-${taskId}`);

	// Normalize doc refs: @.knowns/docs/{path}.md -> @doc/{path}
	result = result.replace(new RegExp(OUTPUT_DOC_REGEX.source, "g"), (_match, docPath) => `@doc/${docPath}`);

	return result;
}

/**
 * Parse common escape sequences in text
 * Converts literal \n, \t, etc. to actual characters
 * This helps AI agents that pass "line1\nline2" instead of $'line1\nline2'
 */
export function parseEscapeSequences(text: string): string {
	return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
}
