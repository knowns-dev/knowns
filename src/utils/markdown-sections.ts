/**
 * Utility functions for handling markdown section markers (CLI version)
 * Format: <!-- SECTION:NAME:BEGIN --> content <!-- SECTION:NAME:END -->
 */

export interface SectionMarkers {
	description?: { begin: string; end: string };
	plan?: { begin: string; end: string };
	notes?: { begin: string; end: string };
	ac?: { begin: string; end: string };
}

export const DEFAULT_MARKERS: SectionMarkers = {
	description: {
		begin: "<!-- SECTION:DESCRIPTION:BEGIN -->",
		end: "<!-- SECTION:DESCRIPTION:END -->",
	},
	plan: {
		begin: "<!-- SECTION:PLAN:BEGIN -->",
		end: "<!-- SECTION:PLAN:END -->",
	},
	notes: {
		begin: "<!-- SECTION:NOTES:BEGIN -->",
		end: "<!-- SECTION:NOTES:END -->",
	},
	ac: {
		begin: "<!-- AC:BEGIN -->",
		end: "<!-- AC:END -->",
	},
};

/**
 * Extract content between section markers
 */
export function extractSectionContent(markdown: string, sectionType: keyof SectionMarkers): string {
	const markers = DEFAULT_MARKERS[sectionType];
	if (!markers) return markdown;

	const beginIndex = markdown.indexOf(markers.begin);
	const endIndex = markdown.indexOf(markers.end);

	if (beginIndex === -1 || endIndex === -1) {
		return markdown; // No markers found, return as is
	}

	const content = markdown.substring(beginIndex + markers.begin.length, endIndex);
	return content.trim();
}

/**
 * Wrap content with section markers
 */
export function wrapSectionContent(content: string, sectionType: keyof SectionMarkers): string {
	const markers = DEFAULT_MARKERS[sectionType];
	if (!markers) return content;

	if (!content || content.trim() === "") {
		return "";
	}

	return `${markers.begin}\n${content.trim()}\n${markers.end}`;
}

/**
 * Check if markdown has section markers
 */
export function hasSectionMarkers(markdown: string, sectionType: keyof SectionMarkers): boolean {
	const markers = DEFAULT_MARKERS[sectionType];
	if (!markers) return false;

	return markdown.includes(markers.begin) && markdown.includes(markers.end);
}

/**
 * Format acceptance criteria with markers
 */
export function formatAcceptanceCriteria(criteria: Array<{ text: string; completed: boolean }>): string {
	if (criteria.length === 0) return "";

	const items = criteria.map((ac, index) => `- [${ac.completed ? "x" : " "}] #${index + 1} ${ac.text}`).join("\n");

	return wrapSectionContent(items, "ac");
}

/**
 * Parse acceptance criteria from markdown with markers
 */
export function parseAcceptanceCriteria(markdown: string): Array<{ text: string; completed: boolean }> {
	const content = hasSectionMarkers(markdown, "ac") ? extractSectionContent(markdown, "ac") : markdown;

	const lines = content.split("\n");
	const criteria: Array<{ text: string; completed: boolean }> = [];

	for (const line of lines) {
		const match = line.match(/^-\s+\[([x\s])\]\s+#?\d*\s*(.+)$/i);
		if (match) {
			criteria.push({
				completed: match[1].toLowerCase() === "x",
				text: match[2].trim(),
			});
		}
	}

	return criteria;
}
