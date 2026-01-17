import { describe, expect, test } from "vitest";
import {
	calculateDocStats,
	extractSection,
	extractSectionByIndex,
	extractToc,
	formatToc,
	replaceSection,
	replaceSectionByIndex,
} from "./markdown-toc";

const sampleMarkdown = `# Document Title

Introduction paragraph.

## Section 1

Content for section 1.

### Subsection 1.1

Nested content.

## Section 2

Content for section 2.

## Section 3

Content for section 3.
`;

describe("extractToc", () => {
	test("extracts all headings with correct levels", () => {
		const toc = extractToc(sampleMarkdown);
		expect(toc).toHaveLength(5);
		expect(toc[0]).toMatchObject({ level: 1, title: "Document Title" });
		expect(toc[1]).toMatchObject({ level: 2, title: "Section 1" });
		expect(toc[2]).toMatchObject({ level: 3, title: "Subsection 1.1" });
		expect(toc[3]).toMatchObject({ level: 2, title: "Section 2" });
		expect(toc[4]).toMatchObject({ level: 2, title: "Section 3" });
	});

	test("returns empty array for content without headings", () => {
		const toc = extractToc("Just some text without headings.");
		expect(toc).toHaveLength(0);
	});
});

describe("extractSection", () => {
	test("extracts section with content until next same-level heading", () => {
		const section = extractSection(sampleMarkdown, "Section 1");
		expect(section).toContain("## Section 1");
		expect(section).toContain("Content for section 1");
		expect(section).toContain("### Subsection 1.1");
		expect(section).not.toContain("## Section 2");
	});

	test("extracts section until end if last section", () => {
		const section = extractSection(sampleMarkdown, "Section 3");
		expect(section).toContain("## Section 3");
		expect(section).toContain("Content for section 3");
	});

	test("returns null for non-existent section", () => {
		const section = extractSection(sampleMarkdown, "Non-existent");
		expect(section).toBeNull();
	});
});

describe("extractSectionByIndex", () => {
	test("extracts section by 1-based index", () => {
		const section = extractSectionByIndex(sampleMarkdown, 2);
		expect(section).toContain("## Section 1");
	});

	test("returns null for out-of-range index", () => {
		expect(extractSectionByIndex(sampleMarkdown, 0)).toBeNull();
		expect(extractSectionByIndex(sampleMarkdown, 100)).toBeNull();
	});
});

describe("replaceSection", () => {
	test("replaces section content without heading in new content", () => {
		const result = replaceSection(sampleMarkdown, "Section 2", "New content here");
		expect(result).not.toBeNull();
		expect(result).toContain("## Section 2");
		expect(result).toContain("New content here");
		expect(result).not.toContain("Content for section 2");
		// Original heading should appear exactly once
		expect(result?.match(/## Section 2/g)).toHaveLength(1);
	});

	test("replaces section without duplicating heading when content includes heading", () => {
		const result = replaceSection(sampleMarkdown, "Section 2", "## Section 2\n\nUpdated content");
		expect(result).not.toBeNull();
		expect(result).toContain("Updated content");
		// Heading should appear exactly once (not duplicated)
		expect(result?.match(/## Section 2/g)).toHaveLength(1);
	});

	test("allows changing heading when content has different heading", () => {
		const result = replaceSection(sampleMarkdown, "Section 2", "### Renamed Section\n\nNew content");
		expect(result).not.toBeNull();
		expect(result).toContain("### Renamed Section");
		expect(result).not.toContain("## Section 2");
	});

	test("returns null for non-existent section", () => {
		const result = replaceSection(sampleMarkdown, "Non-existent", "Content");
		expect(result).toBeNull();
	});

	test("preserves surrounding sections", () => {
		const result = replaceSection(sampleMarkdown, "Section 2", "Replaced");
		expect(result).toContain("## Section 1");
		expect(result).toContain("## Section 3");
	});
});

// Markdown with duplicate headings for testing replaceSectionByIndex
const duplicateHeadingsMarkdown = `# Doc Title

## Section A

First A content.

## Other Section

Other content.

## Section A

Second A content.

## Final Section

Final content.
`;

describe("replaceSectionByIndex", () => {
	test("replaces first occurrence by index", () => {
		const result = replaceSectionByIndex(duplicateHeadingsMarkdown, 2, "REPLACED FIRST");
		expect(result).not.toBeNull();
		expect(result).toContain("REPLACED FIRST");
		expect(result).toContain("Second A content"); // Second Section A should be unchanged
	});

	test("replaces second occurrence by index (duplicate heading)", () => {
		const result = replaceSectionByIndex(duplicateHeadingsMarkdown, 4, "REPLACED SECOND");
		expect(result).not.toBeNull();
		expect(result).toContain("First A content"); // First Section A should be unchanged
		expect(result).toContain("REPLACED SECOND");
		expect(result).not.toContain("Second A content");
	});

	test("returns null for out-of-range index", () => {
		expect(replaceSectionByIndex(duplicateHeadingsMarkdown, 0, "Content")).toBeNull();
		expect(replaceSectionByIndex(duplicateHeadingsMarkdown, 100, "Content")).toBeNull();
	});

	test("handles content with heading (no duplication)", () => {
		const result = replaceSectionByIndex(duplicateHeadingsMarkdown, 2, "## Section A\n\nNew content");
		expect(result).not.toBeNull();
		// Should have exactly 2 "## Section A" (index 2 and index 4)
		expect(result?.match(/## Section A/g)).toHaveLength(2);
	});

	test("preserves other sections", () => {
		const result = replaceSectionByIndex(duplicateHeadingsMarkdown, 3, "REPLACED OTHER");
		expect(result).toContain("First A content");
		expect(result).toContain("Second A content");
		expect(result).toContain("REPLACED OTHER");
		expect(result).toContain("Final content");
	});
});

describe("formatToc", () => {
	test("formats TOC with indentation", () => {
		const toc = extractToc(sampleMarkdown);
		const formatted = formatToc(toc, { indent: true });
		expect(formatted).toContain("- Document Title");
		expect(formatted).toContain("  - Section 1");
		expect(formatted).toContain("    - Subsection 1.1");
	});
});

describe("calculateDocStats", () => {
	test("calculates basic statistics", () => {
		const stats = calculateDocStats(sampleMarkdown);
		expect(stats.chars).toBeGreaterThan(0);
		expect(stats.words).toBeGreaterThan(0);
		expect(stats.lines).toBeGreaterThan(0);
		expect(stats.headingCount).toBe(5);
		expect(stats.estimatedTokens).toBeGreaterThan(0);
	});
});
