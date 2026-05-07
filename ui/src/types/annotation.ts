/** Inline annotation on rendered doc text. */
export interface Annotation {
	/** Unique identifier (nanoid-style). */
	id: string;
	/** Knowns doc path, e.g. "specs/agent-workspace". */
	docPath: string;
	/** The exact text that was selected. */
	selectedText: string;
	/** Annotation action type. */
	type: "comment" | "replace" | "delete";
	/** Comment text, replacement text, or delete reason. */
	content: string;
	/** Unix timestamp (ms). */
	createdAt: number;
	/** ~30 chars before the selection for re-anchoring. */
	contextBefore: string;
	/** ~30 chars after the selection for re-anchoring. */
	contextAfter: string;
	/** 1-based line number in raw markdown where selection starts. */
	startLine: number;
	/** 0-based character offset within startLine. */
	startChar: number;
	/** 1-based line number in raw markdown where selection ends. */
	endLine: number;
	/** 0-based character offset within endLine. */
	endChar: number;
}

/** Annotation type metadata for display. */
export const ANNOTATION_TYPE_META: Record<
	Annotation["type"],
	{ icon: string; label: string; color: string; bgClass: string }
> = {
	comment: { icon: "💬", label: "Comment", color: "text-yellow-600 dark:text-yellow-400", bgClass: "bg-yellow-200/40 dark:bg-yellow-500/20" },
	replace: { icon: "✏️", label: "Replace", color: "text-blue-600 dark:text-blue-400", bgClass: "bg-blue-200/40 dark:bg-blue-500/20" },
	delete: { icon: "🗑️", label: "Delete", color: "text-red-600 dark:text-red-400", bgClass: "bg-red-200/40 dark:bg-red-500/20" },
};
