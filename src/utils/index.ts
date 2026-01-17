/**
 * Utilities
 * Helper functions
 */

export { findProjectRoot } from "./find-project-root";
export { normalizeRefs, parseEscapeSequences } from "./mention-refs";

/**
 * Normalize file path to use forward slashes (cross-platform)
 * Windows uses backslash (\), but we want consistent forward slash (/)
 */
export function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

// Future exports:
// - generateId
// - formatDuration
// - parseDate
// - logger
