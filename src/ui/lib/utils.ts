import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Path utilities for cross-platform compatibility
 */

/**
 * Normalize path to use forward slashes (web-friendly format)
 * Converts Windows backslashes to forward slashes
 */
export function normalizePath(path: string): string {
	if (!path) return path;
	return path.replace(/\\/g, "/");
}

/**
 * Convert path to display format
 * On web, we always use forward slashes for URLs and display
 */
export function toDisplayPath(path: string): string {
	return normalizePath(path);
}

/**
 * Detect if running on Windows (server-side hint from path)
 * Returns true if path contains backslashes
 */
export function isWindowsPath(path: string): boolean {
	return path.includes("\\");
}

/**
 * Normalize path for API requests
 * Always sends forward slashes to server, server handles OS-specific conversion
 */
export function normalizePathForAPI(path: string): string {
	return normalizePath(path);
}

/**
 * Spec detection utilities for SDD (Spec-Driven Development)
 */

export interface DocMetadata {
	title: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
	tags?: string[];
	type?: string; // 'spec', 'guide', etc.
	status?: string; // 'draft', 'approved', 'implemented'
}

export interface Doc {
	filename: string;
	path: string;
	folder: string;
	metadata: DocMetadata;
	content: string;
	isImported?: boolean;
	source?: string;
}

/**
 * Check if a document is a spec document
 * A doc is considered a spec if:
 * - It's in the specs/ folder
 * - It has 'spec' tag
 * - It has type: 'spec' in frontmatter
 */
export function isSpec(doc: Doc): boolean {
	const normalizedPath = normalizePath(doc.path);
	return normalizedPath.startsWith("specs/") || doc.metadata.tags?.includes("spec") || doc.metadata.type === "spec";
}

/**
 * Get spec status from doc metadata
 * Returns 'draft' | 'approved' | 'implemented' | undefined
 */
export function getSpecStatus(doc: Doc): string | undefined {
	if (!isSpec(doc)) return undefined;
	return doc.metadata.status;
}

/**
 * Parse acceptance criteria progress from markdown content
 * Only counts `- [ ]` (unchecked) and `- [x]` (checked) patterns
 * within the "Acceptance Criteria" section
 */
export function parseACProgress(content: string): { total: number; completed: number } {
	// Find the Acceptance Criteria section
	const acSectionMatch = content.match(/##\s*Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s|\n---|\Z|$)/i);
	if (!acSectionMatch) {
		return { total: 0, completed: 0 };
	}

	const acSection = acSectionMatch[1];
	const uncheckedPattern = /- \[ \]/g;
	const checkedPattern = /- \[x\]/gi;

	const unchecked = (acSection.match(uncheckedPattern) || []).length;
	const checked = (acSection.match(checkedPattern) || []).length;

	return {
		total: unchecked + checked,
		completed: checked,
	};
}

/**
 * Get sort order for spec status
 * draft=0, approved=1, implemented=2
 */
export function getSpecStatusOrder(doc: Doc): number {
	const status = getSpecStatus(doc);
	switch (status) {
		case "draft":
			return 0;
		case "approved":
			return 1;
		case "implemented":
			return 2;
		default:
			return 0; // Unknown status treated as draft
	}
}
