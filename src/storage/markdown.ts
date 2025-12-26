/**
 * Markdown Parser and Serializer
 * Handles task markdown file format with YAML frontmatter
 */

import type { AcceptanceCriterion, Task } from "@models/task";
import {
	extractSectionContent,
	formatAcceptanceCriteria,
	hasSectionMarkers,
	parseAcceptanceCriteria as parseACFromMarkdown,
	wrapSectionContent,
} from "@utils/markdown-sections";
import matter from "gray-matter";

interface TaskFrontmatter {
	id: string;
	title: string;
	status: string;
	priority: string;
	assignee?: string;
	labels: string[];
	parent?: string;
	createdAt: string;
	updatedAt: string;
	timeSpent: number;
}

/**
 * Parse task markdown file content
 */
export function parseTaskMarkdown(content: string): Partial<Task> {
	const { data, content: body } = matter(content);
	const frontmatter = data as TaskFrontmatter;

	// Parse body sections
	const sections = parseBodySections(body);

	// Parse acceptance criteria from body
	const acceptanceCriteria = parseAcceptanceCriteria(sections.acceptanceCriteria || "");

	return {
		id: frontmatter.id,
		title: frontmatter.title,
		status: frontmatter.status as Task["status"],
		priority: frontmatter.priority as Task["priority"],
		assignee: frontmatter.assignee,
		labels: frontmatter.labels || [],
		parent: frontmatter.parent,
		subtasks: [], // Will be populated by FileStore
		createdAt: new Date(frontmatter.createdAt),
		updatedAt: new Date(frontmatter.updatedAt),
		timeSpent: frontmatter.timeSpent || 0,
		timeEntries: [], // Will be loaded from time.json
		description: sections.description,
		acceptanceCriteria,
		implementationPlan: sections.implementationPlan,
		implementationNotes: sections.implementationNotes,
	};
}

/**
 * Serialize task to markdown format
 */
export function serializeTaskMarkdown(task: Task): string {
	// Build frontmatter, excluding undefined values
	const frontmatter: Record<string, unknown> = {
		id: task.id,
		title: task.title,
		status: task.status,
		priority: task.priority,
		labels: task.labels || [],
		createdAt: task.createdAt.toISOString(),
		updatedAt: task.updatedAt.toISOString(),
		timeSpent: task.timeSpent ?? 0,
	};

	// Add optional fields only if defined
	if (task.assignee) frontmatter.assignee = task.assignee;
	if (task.parent) frontmatter.parent = task.parent;

	// Build body sections
	let body = "";

	// Title
	body += `# ${task.title}\n\n`;

	// Description with section markers
	if (task.description) {
		body += "## Description\n\n";
		const wrappedDescription = wrapSectionContent(task.description, "description");
		body += `${wrappedDescription}\n\n`;
	}

	// Acceptance Criteria with markers
	if (task.acceptanceCriteria.length > 0) {
		body += "## Acceptance Criteria\n";
		const formattedAC = formatAcceptanceCriteria(task.acceptanceCriteria);
		body += `${formattedAC}\n\n`;
	}

	// Implementation Plan with section markers
	if (task.implementationPlan) {
		body += "## Implementation Plan\n\n";
		const wrappedPlan = wrapSectionContent(task.implementationPlan, "plan");
		body += `${wrappedPlan}\n\n`;
	}

	// Implementation Notes with section markers
	if (task.implementationNotes) {
		body += "## Implementation Notes\n\n";
		const wrappedNotes = wrapSectionContent(task.implementationNotes, "notes");
		body += `${wrappedNotes}\n\n`;
	}

	return matter.stringify(body, frontmatter);
}

/**
 * Parse body sections from markdown content
 * Priority: Parse by markers first, fallback to headings for backward compatibility
 */
function parseBodySections(body: string): {
	description?: string;
	acceptanceCriteria?: string;
	implementationPlan?: string;
	implementationNotes?: string;
} {
	// Try to extract by markers first (preferred method)
	const description = hasSectionMarkers(body, "description") ? extractSectionContent(body, "description") : undefined;

	const implementationPlan = hasSectionMarkers(body, "plan") ? extractSectionContent(body, "plan") : undefined;

	const implementationNotes = hasSectionMarkers(body, "notes") ? extractSectionContent(body, "notes") : undefined;

	// Extract acceptance criteria section (always has markers)
	let acceptanceCriteria: string | undefined;

	// Find AC section by markers
	if (hasSectionMarkers(body, "ac")) {
		acceptanceCriteria = body.substring(
			body.indexOf("<!-- AC:BEGIN -->"),
			body.indexOf("<!-- AC:END -->") + "<!-- AC:END -->".length,
		);
	}

	// Fallback: Parse by headings for backward compatibility (for files without markers)
	const sections: Record<string, string> = {};
	const lines = body.split("\n");

	let currentSection: string | null = null;
	let sectionContent: string[] = [];
	let seenTaskTitle = false;

	for (const line of lines) {
		// Check if this is a section header
		if (line.startsWith("## ")) {
			// Save previous section
			if (currentSection && sectionContent.length > 0) {
				sections[currentSection] = sectionContent.join("\n").trim();
			}

			// Start new section
			const sectionTitle = line.replace("## ", "").trim();
			currentSection = sectionTitleToKey(sectionTitle);
			sectionContent = [];
		} else if (currentSection) {
			// Add all content to section (including markdown headings)
			sectionContent.push(line);
		} else if (line.startsWith("# ") && !seenTaskTitle) {
			// Skip only the first task title (not inside any section)
			seenTaskTitle = true;
		}
	}

	// Save last section
	if (currentSection && sectionContent.length > 0) {
		sections[currentSection] = sectionContent.join("\n").trim();
	}

	// Use heading-based parsing as fallback only if markers didn't find content
	return {
		description: description || sections.description,
		acceptanceCriteria: acceptanceCriteria || sections.acceptanceCriteria,
		implementationPlan: implementationPlan || sections.implementationPlan,
		implementationNotes: implementationNotes || sections.implementationNotes,
	};
}

/**
 * Convert section title to camelCase key
 */
function sectionTitleToKey(title: string): string {
	const map: Record<string, string> = {
		Description: "description",
		"Acceptance Criteria": "acceptanceCriteria",
		"Implementation Plan": "implementationPlan",
		"Implementation Notes": "implementationNotes",
	};
	return map[title] || title.toLowerCase().replace(/\s+/g, "");
}

/**
 * Parse acceptance criteria checkboxes
 */
function parseAcceptanceCriteria(content: string): AcceptanceCriterion[] {
	// Use utility function that handles section markers
	return parseACFromMarkdown(content);
}
