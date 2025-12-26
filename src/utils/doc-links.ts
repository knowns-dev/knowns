/**
 * Document Link Parser
 * Detects markdown links to documentation files
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface DocReference {
	text: string; // Link text
	filename: string; // Original link target
	resolvedPath: string; // Full path to doc file
	exists: boolean; // Whether file exists
}

/**
 * Parse markdown links from text
 * Matches: [text](filename) or [text](path/to/file.md)
 */
export function parseMarkdownLinks(text: string): Array<{ text: string; target: string }> {
	const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
	const links: Array<{ text: string; target: string }> = [];

	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: Standard regex iteration pattern
	while ((match = linkPattern.exec(text)) !== null) {
		links.push({
			text: match[1],
			target: match[2],
		});
	}

	return links;
}

/**
 * Resolve doc references from task content
 * Converts markdown links to @.knowns/docs/... format
 */
export function resolveDocReferences(content: string, projectRoot: string): DocReference[] {
	const links = parseMarkdownLinks(content);
	const docReferences: DocReference[] = [];
	const docsDir = join(projectRoot, ".knowns", "docs");

	for (const link of links) {
		// Skip external URLs
		if (link.target.startsWith("http://") || link.target.startsWith("https://")) {
			continue;
		}

		// Skip relative paths that go outside docs
		if (link.target.startsWith("../")) {
			continue;
		}

		// Skip task references (task-123, task-123.md, 123, 123.md)
		if (/^(task-)?\d+(\.md)?$/.test(link.target)) {
			continue;
		}

		// Normalize filename
		let filename = link.target;
		// Remove leading ./ if present
		filename = filename.replace(/^\.\//, "");
		if (!filename.endsWith(".md")) {
			filename = `${filename}.md`;
		}

		// Resolve path
		const resolvedPath = join(docsDir, filename);
		const exists = existsSync(resolvedPath);

		docReferences.push({
			text: link.text,
			filename: link.target,
			resolvedPath: `@.knowns/docs/${filename}`,
			exists,
		});
	}

	return docReferences;
}

/**
 * Format doc references for display
 */
export function formatDocReferences(references: DocReference[], options: { plain?: boolean } = {}): string {
	if (references.length === 0) {
		return "";
	}

	if (options.plain) {
		return references.map((ref) => ref.resolvedPath).join(",");
	}

	// Formatted output
	const lines = ["", "Related Documentation:"];
	for (const ref of references) {
		const status = ref.exists ? "📄" : "⚠️";
		lines.push(`  ${status} ${ref.text}: ${ref.resolvedPath}`);
		if (!ref.exists) {
			lines.push(`     (Not found - create with: knowns doc create "${ref.text}")`);
		}
	}
	return lines.join("\n");
}

/**
 * Extract all @.knowns/docs/... references from text
 * Used by MCP server to auto-fetch docs
 */
export function extractDocPaths(text: string): string[] {
	const pattern = /@\.knowns\/docs\/([a-z0-9-]+\.md)/g;
	const paths: string[] = [];

	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: Standard regex iteration pattern
	while ((match = pattern.exec(text)) !== null) {
		paths.push(match[0].replace("@", ""));
	}

	return paths;
}
