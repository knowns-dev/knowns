/**
 * ID Normalization Utilities
 * Support both short format (e.g., "42") and full format (e.g., "task-42")
 */

/**
 * Normalize task ID - strip "task-" prefix if present
 * Supports: "42", "task-42", "TASK-42"
 *
 * @example
 * normalizeTaskId("42") // => "42"
 * normalizeTaskId("task-42") // => "42"
 * normalizeTaskId("TASK-42") // => "42"
 */
export function normalizeTaskId(input: string): string {
	return input.replace(/^task-/i, "");
}

/**
 * Normalize doc path - strip "doc/" or "@doc/" prefix if present
 *
 * @example
 * normalizeDocPath("readme") // => "readme"
 * normalizeDocPath("doc/readme") // => "readme"
 * normalizeDocPath("@doc/readme") // => "readme"
 */
export function normalizeDocPath(input: string): string {
	return input.replace(/^@?doc\//i, "");
}
