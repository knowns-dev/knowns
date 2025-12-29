/**
 * Utility functions for handling markdown section markers
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
 * Strip all HTML comments from content
 */
export function stripHtmlComments(content: string): string {
	return content.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Prepare markdown for editing (extract content from markers)
 */
export function prepareMarkdownForEdit(markdown: string, sectionType?: keyof SectionMarkers): string {
	if (!markdown) return "";
	if (!sectionType) return markdown;

	return hasSectionMarkers(markdown, sectionType) ? extractSectionContent(markdown, sectionType) : markdown;
}

/**
 * Prepare markdown for saving (wrap with markers if needed)
 */
export function prepareMarkdownForSave(
	content: string,
	originalMarkdown: string,
	sectionType?: keyof SectionMarkers,
): string {
	if (!content) return "";
	if (!sectionType) return content;

	// If original markdown had markers, preserve them
	if (hasSectionMarkers(originalMarkdown, sectionType)) {
		return wrapSectionContent(content, sectionType);
	}

	return content;
}
