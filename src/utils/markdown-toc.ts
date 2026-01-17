/**
 * Utility functions for extracting TOC and sections from markdown
 */

export interface TocEntry {
	level: number;
	title: string;
	slug: string;
	line: number;
}

/**
 * Extract Table of Contents from markdown
 * Returns list of headings with their levels and line numbers
 */
export function extractToc(markdown: string): TocEntry[] {
	const lines = markdown.split("\n");
	const toc: TocEntry[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Match ATX-style headings: # Heading, ## Heading, etc.
		const match = line.match(/^(#{1,6})\s+(.+)$/);
		if (match) {
			const level = match[1].length;
			const title = match[2].trim();
			const slug = slugify(title);
			toc.push({ level, title, slug, line: i + 1 });
		}
	}

	return toc;
}

/**
 * Format TOC as readable string
 */
export function formatToc(toc: TocEntry[], options?: { indent?: boolean; showLine?: boolean }): string {
	const { indent = true, showLine = false } = options || {};

	return toc
		.map((entry) => {
			const indentation = indent ? "  ".repeat(entry.level - 1) : "";
			const prefix = indent ? "- " : `${"#".repeat(entry.level)} `;
			const lineInfo = showLine ? ` (line ${entry.line})` : "";
			return `${indentation}${prefix}${entry.title}${lineInfo}`;
		})
		.join("\n");
}

/**
 * Extract a specific section from markdown by heading title
 * Returns content from the heading until the next heading of same or higher level
 */
export function extractSection(markdown: string, sectionTitle: string): string | null {
	const lines = markdown.split("\n");
	const normalizedTarget = normalizeTitle(sectionTitle);

	let startLine = -1;
	let startLevel = 0;
	let endLine = lines.length;

	// Find the section start
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^(#{1,6})\s+(.+)$/);
		if (match) {
			const level = match[1].length;
			const title = match[2].trim();

			if (startLine === -1) {
				// Looking for start
				if (normalizeTitle(title) === normalizedTarget || matchesPartial(title, sectionTitle)) {
					startLine = i;
					startLevel = level;
				}
			} else {
				// Looking for end (next heading of same or higher level)
				if (level <= startLevel) {
					endLine = i;
					break;
				}
			}
		}
	}

	if (startLine === -1) {
		return null;
	}

	return lines.slice(startLine, endLine).join("\n").trim();
}

/**
 * Extract section by index (1-based)
 */
export function extractSectionByIndex(markdown: string, index: number): string | null {
	const toc = extractToc(markdown);
	if (index < 1 || index > toc.length) {
		return null;
	}

	return extractSection(markdown, toc[index - 1].title);
}

/**
 * Replace a specific section in markdown with new content
 * Returns the modified markdown or null if section not found
 */
export function replaceSection(markdown: string, sectionTitle: string, newContent: string): string | null {
	const lines = markdown.split("\n");
	const normalizedTarget = normalizeTitle(sectionTitle);

	let startLine = -1;
	let startLevel = 0;
	let endLine = lines.length;
	let originalHeading = "";

	// Find the section start and end
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^(#{1,6})\s+(.+)$/);
		if (match) {
			const level = match[1].length;
			const title = match[2].trim();

			if (startLine === -1) {
				// Looking for start
				if (normalizeTitle(title) === normalizedTarget || matchesPartial(title, sectionTitle)) {
					startLine = i;
					startLevel = level;
					originalHeading = line; // Preserve original heading
				}
			} else {
				// Looking for end (next heading of same or higher level)
				if (level <= startLevel) {
					endLine = i;
					break;
				}
			}
		}
	}

	if (startLine === -1) {
		return null;
	}

	// Build new content with original heading
	const beforeSection = lines.slice(0, startLine);
	const afterSection = lines.slice(endLine);

	// Check if newContent already starts with a heading
	const trimmedContent = newContent.trim();
	const contentStartsWithHeading = /^#{1,6}\s+/.test(trimmedContent);

	// Construct new section: only prepend heading if content doesn't already have one
	const newSection = contentStartsWithHeading ? trimmedContent : `${originalHeading}\n\n${trimmedContent}`;

	return [...beforeSection, newSection, ...afterSection].join("\n");
}

/**
 * Replace section by index (1-based)
 * Useful when there are multiple headings with the same title
 */
export function replaceSectionByIndex(markdown: string, index: number, newContent: string): string | null {
	const toc = extractToc(markdown);
	if (index < 1 || index > toc.length) {
		return null;
	}

	const lines = markdown.split("\n");
	const targetEntry = toc[index - 1];
	const startLine = targetEntry.line - 1; // Convert to 0-based
	const startLevel = targetEntry.level;
	const originalHeading = lines[startLine];

	// Find end line (next heading of same or higher level)
	let endLine = lines.length;
	for (let i = index; i < toc.length; i++) {
		if (toc[i].level <= startLevel) {
			endLine = toc[i].line - 1; // Convert to 0-based
			break;
		}
	}

	// Build new content
	const beforeSection = lines.slice(0, startLine);
	const afterSection = lines.slice(endLine);

	// Check if newContent already starts with a heading
	const trimmedContent = newContent.trim();
	const contentStartsWithHeading = /^#{1,6}\s+/.test(trimmedContent);

	// Construct new section: only prepend heading if content doesn't already have one
	const newSection = contentStartsWithHeading ? trimmedContent : `${originalHeading}\n\n${trimmedContent}`;

	return [...beforeSection, newSection, ...afterSection].join("\n");
}

/**
 * Create slug from title (for linking)
 */
function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^\w\s-]/g, "") // Remove special chars
		.replace(/\s+/g, "-") // Replace spaces with dashes
		.replace(/-+/g, "-") // Remove duplicate dashes
		.trim();
}

/**
 * Normalize title for comparison
 */
function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^\w\s]/g, "") // Remove special chars except spaces
		.replace(/\s+/g, " ") // Normalize spaces
		.trim();
}

/**
 * Document statistics for context optimization
 */
export interface DocStats {
	chars: number;
	words: number;
	lines: number;
	estimatedTokens: number;
	headingCount: number;
}

/**
 * Calculate document statistics
 * Token estimation uses ~4 chars per token (average for English text)
 */
export function calculateDocStats(markdown: string): DocStats {
	const chars = markdown.length;
	const words = markdown.split(/\s+/).filter((w) => w.length > 0).length;
	const lines = markdown.split("\n").length;
	const toc = extractToc(markdown);
	const headingCount = toc.length;

	// Estimate tokens: ~4 chars per token for English, ~2-3 for code-heavy content
	// We use 3.5 as a balanced estimate
	const estimatedTokens = Math.ceil(chars / 3.5);

	return {
		chars,
		words,
		lines,
		estimatedTokens,
		headingCount,
	};
}

/**
 * Format stats for display
 */
export function formatDocStats(stats: DocStats, title: string): string {
	const lines = [
		`Document: ${title}`,
		"=".repeat(50),
		"",
		`Size: ${stats.chars.toLocaleString()} chars (~${stats.estimatedTokens.toLocaleString()} tokens)`,
		`Words: ${stats.words.toLocaleString()}`,
		`Lines: ${stats.lines.toLocaleString()}`,
		`Headings: ${stats.headingCount}`,
		"",
	];

	// Add recommendation based on token count
	if (stats.estimatedTokens > 4000) {
		lines.push("Recommendation: Document is large. Use --toc first, then --section.");
	} else if (stats.estimatedTokens > 2000) {
		lines.push("Recommendation: Consider using --toc and --section for specific info.");
	} else {
		lines.push("Recommendation: Document is small enough to read directly.");
	}

	return lines.join("\n");
}

/**
 * Check if title matches partial search (e.g., "5. Sync" matches "5. Sync System")
 */
function matchesPartial(title: string, search: string): boolean {
	const normalizedTitle = normalizeTitle(title);
	const normalizedSearch = normalizeTitle(search);

	// Exact match
	if (normalizedTitle === normalizedSearch) return true;

	// Starts with match (e.g., "5 sync" matches "5 sync system cli integration")
	if (normalizedTitle.startsWith(normalizedSearch)) return true;

	// Number prefix match (e.g., "5" matches "5. Sync System")
	const numMatch = search.match(/^(\d+)\.?\s*(.*)$/);
	if (numMatch) {
		const [, num, rest] = numMatch;
		const titleNumMatch = title.match(/^(\d+)\.?\s*(.*)$/);
		if (titleNumMatch && titleNumMatch[1] === num) {
			if (!rest || normalizeTitle(titleNumMatch[2]).startsWith(normalizeTitle(rest))) {
				return true;
			}
		}
	}

	return false;
}
