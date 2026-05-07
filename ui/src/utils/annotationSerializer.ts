import type { Annotation } from "../types/annotation";

/**
 * Serialize annotations into structured markdown grouped by doc path.
 * Output is designed to be pasted into an AI agent as feedback.
 * Format is explicit and machine-readable: line ranges, action types with clear semantics.
 */
export function serializeAnnotations(annotations: Annotation[]): string {
	if (annotations.length === 0) return "";

	// Group by doc path, preserving insertion order
	const grouped = new Map<string, Annotation[]>();
	for (const a of annotations) {
		const list = grouped.get(a.docPath) ?? [];
		list.push(a);
		grouped.set(a.docPath, list);
	}

	// Metadata header with legend
	const now = new Date().toISOString().slice(0, 16).replace("T", " ");
	const docCount = grouped.size;
	const header = [
		`# Annotations (${annotations.length} total across ${docCount} doc${docCount > 1 ? "s" : ""}) — exported ${now}`,
		"",
		"**Legend:**",
		"- **Comment**: A note/feedback about the selected text. The text should remain, but the comment provides context or suggestions.",
		"- **Replace**: The selected text should be replaced with the provided replacement text.",
		"- **Delete**: The selected text should be removed from the document.",
		"- **Location**: `Lines X–Y` refers to line numbers in the raw markdown source.",
		"",
	].join("\n");

	const sections: string[] = [header];

	for (const [docPath, items] of grouped) {
		const lines: string[] = [`## @doc/${docPath}`, ""];

		for (let i = 0; i < items.length; i++) {
			const item = items[i]!;
			const num = i + 1;
			const loc = item.startLine > 0
				? item.startLine === item.endLine
					? `Line ${item.startLine}`
					: `Lines ${item.startLine}–${item.endLine}`
				: "Location unknown";

			switch (item.type) {
				case "comment":
					lines.push(`### ${num}. Comment (${loc})`);
					lines.push(`**Selected text:** "${item.selectedText}"`);
					lines.push(`**Feedback:** ${item.content || "(no comment)"}`);
					break;
				case "replace":
					lines.push(`### ${num}. Replace (${loc})`);
					lines.push(`**Original text:** "${item.selectedText}"`);
					lines.push(`**Replace with:** "${item.content}"`);
					break;
				case "delete":
					lines.push(`### ${num}. Delete (${loc})`);
					lines.push(`**Text to remove:** "${item.selectedText}"`);
					if (item.content) lines.push(`**Reason:** ${item.content}`);
					break;
			}
			lines.push("");
		}

		sections.push(lines.join("\n"));
	}

	return sections.join("\n---\n\n");
}

/**
 * Check if an annotation's selected text can still be found in the doc content.
 * Uses contextBefore + selectedText + contextAfter for fuzzy matching.
 */
export function isAnnotationOrphaned(annotation: Annotation, docContent: string): boolean {
	if (!docContent) return true;

	// Direct match
	if (docContent.includes(annotation.selectedText)) return false;

	// Try with surrounding context (partial match)
	const needle = annotation.contextBefore.slice(-15) + annotation.selectedText + annotation.contextAfter.slice(0, 15);
	if (needle.length > annotation.selectedText.length && docContent.includes(needle)) return false;

	return true;
}
