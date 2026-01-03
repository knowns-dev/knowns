import { createReactInlineContentSpec } from "@blocknote/react";
import { useState, useEffect } from "react";
import { FileText } from "lucide-react";
import { getDoc, type Doc } from "../../../api/client";
import { MentionToolbar } from "./MentionToolbar";
import { Badge } from "../../ui/badge";
import { cn } from "@/ui/lib/utils";

interface DocMentionComponentProps {
	docPath: string;
	isEditable?: boolean;
	onDelete?: () => void;
	onReplace?: (type: "task" | "doc", id: string) => void;
	onClick?: (path: string) => void;
}

/**
 * Doc mention badge component that fetches and displays doc data
 * Uses shadcn Badge for consistent styling
 */
function DocMentionComponent({
	docPath,
	isEditable = false,
	onDelete,
	onReplace,
	onClick,
}: DocMentionComponentProps) {
	const [doc, setDoc] = useState<Doc | null>(null);
	const [loading, setLoading] = useState(true);

	// Normalize path - ensure .md extension
	const normalizedPath = docPath.endsWith(".md") ? docPath : `${docPath}.md`;

	useEffect(() => {
		let cancelled = false;

		getDoc(normalizedPath)
			.then((fetchedDoc) => {
				if (!cancelled && fetchedDoc) {
					setDoc(fetchedDoc);
					setLoading(false);
				} else if (!cancelled) {
					setLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setDoc(null);
					setLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [normalizedPath]);

	const handleClick = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();

		// Don't navigate in edit mode - use toolbar's Open button instead
		if (isEditable) return;

		if (onClick) {
			onClick(normalizedPath);
		} else {
			window.location.hash = `/docs/${normalizedPath}`;
		}
	};

	const handlePreview = () => {
		window.location.hash = `/docs/${normalizedPath}`;
	};

	// Display filename without extension for shorter display
	const shortPath = docPath.replace(/\.md$/, "").split("/").pop() || docPath;

	const badge = (
		<Badge
			variant="outline"
			className={cn(
				"mention-badge cursor-pointer select-none gap-1 font-medium",
				"border-blue-500/30 bg-blue-500/10 text-blue-700 hover:bg-blue-500/20",
				"dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400 dark:hover:bg-blue-500/20",
				"transition-colors"
			)}
			data-doc-path={normalizedPath}
			onClick={handleClick}
			onMouseDown={(e) => {
				// Prevent BlockNote from capturing the event
				e.stopPropagation();
				// Navigate on mousedown for better responsiveness in contenteditable
				handleClick(e);
			}}
		>
			<FileText className="w-3.5 h-3.5 shrink-0" />
			{loading ? (
				<span className="opacity-70">{shortPath}</span>
			) : doc?.title ? (
				<span className="max-w-[200px] truncate">{doc.title}</span>
			) : (
				<span className="max-w-[200px] truncate">{shortPath}</span>
			)}
		</Badge>
	);

	// Preview content for toolbar
	const previewContent = doc ? (
		<div className="space-y-1.5">
			<div className="font-medium text-sm leading-tight">{doc.title || shortPath}</div>
			{doc.description && (
				<div className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
					{doc.description}
				</div>
			)}
			<div className="text-xs text-muted-foreground truncate">
				{normalizedPath}
			</div>
			{doc.tags && doc.tags.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{doc.tags.slice(0, 3).map((tag) => (
						<Badge key={tag} variant="secondary" className="text-[10px] px-1 py-0 h-4">
							{tag}
						</Badge>
					))}
				</div>
			)}
		</div>
	) : null;

	return (
		<MentionToolbar
			isEditable={isEditable}
			onPreview={handlePreview}
			onReplace={onReplace || (() => {})}
			onDelete={onDelete || (() => {})}
			previewContent={previewContent}
			type="doc"
		>
			{badge}
		</MentionToolbar>
	);
}

// Type for table content structure
interface TableCell {
	content?: unknown[];
}
interface TableRow {
	cells: (unknown[] | TableCell)[];
}
interface TableContent {
	type: "tableContent";
	rows: TableRow[];
}

// Helper to check if content is table content
function isTableContent(content: unknown): content is TableContent {
	return (
		typeof content === "object" &&
		content !== null &&
		"type" in content &&
		(content as TableContent).type === "tableContent" &&
		"rows" in content
	);
}

// Helper to get cell content from various formats
function getCellContent(cell: unknown[] | TableCell): unknown[] | null {
	if (Array.isArray(cell)) {
		return cell;
	}
	if (cell && typeof cell === "object" && "content" in cell && Array.isArray(cell.content)) {
		return cell.content;
	}
	return null;
}

/**
 * BlockNote inline content spec for doc mentions
 * Format: @doc/{path}
 */
export const DocMention = createReactInlineContentSpec(
	{
		type: "docMention",
		propSchema: {
			docPath: {
				default: "",
			},
		},
		content: "none",
	},
	{
		render: (props) => {
			const docPath = props.inlineContent.props.docPath;
			const editor = props.editor;
			const isEditable = editor?.isEditable ?? false;

			const handleDelete = () => {
				if (!editor) return;

				const blocks = editor.document;
				for (const block of blocks) {
					// Handle table content
					if (block.type === "table" && isTableContent(block.content)) {
						let changed = false;
						const newRows = block.content.rows.map((row) => ({
							...row,
							cells: row.cells.map((cell) => {
								const cellContent = getCellContent(cell);
								if (!cellContent) return cell;

								const newCellContent = cellContent.filter((item: unknown) => {
									const inline = item as { type?: string; props?: { docPath?: string } };
									return !(inline.type === "docMention" && inline.props?.docPath === docPath);
								});

								if (newCellContent.length !== cellContent.length) {
									changed = true;
									if (Array.isArray(cell)) {
										return newCellContent;
									}
									return { ...(cell as TableCell), content: newCellContent };
								}
								return cell;
							}),
						}));

						if (changed) {
							editor.updateBlock(block, {
								content: { ...block.content, rows: newRows } as typeof block.content,
							});
							return;
						}
					}

					// Handle regular block content
					if (Array.isArray(block.content)) {
						const newContent = (block.content as unknown[]).filter((item: unknown) => {
							const inline = item as { type?: string; props?: { docPath?: string } };
							return !(inline.type === "docMention" && inline.props?.docPath === docPath);
						});
						if (newContent.length !== (block.content as unknown[]).length) {
							editor.updateBlock(block, {
								content: newContent as typeof block.content,
							});
							return;
						}
					}
				}
			};

			const handleReplace = (type: "task" | "doc", newId: string) => {
				if (!editor) return;

				const blocks = editor.document;
				for (const block of blocks) {
					// Handle table content
					if (block.type === "table" && isTableContent(block.content)) {
						let changed = false;
						const newRows = block.content.rows.map((row) => ({
							...row,
							cells: row.cells.map((cell) => {
								const cellContent = getCellContent(cell);
								if (!cellContent) return cell;

								const newCellContent = cellContent.map((item: unknown) => {
									const inline = item as { type?: string; props?: { docPath?: string } };
									if (inline.type === "docMention" && inline.props?.docPath === docPath) {
										changed = true;
										if (type === "task") {
											return { type: "taskMention", props: { taskId: newId } };
										}
										return { type: "docMention", props: { docPath: newId } };
									}
									return item;
								});

								if (Array.isArray(cell)) {
									return newCellContent;
								}
								return { ...(cell as TableCell), content: newCellContent };
							}),
						}));

						if (changed) {
							editor.updateBlock(block, {
								content: { ...block.content, rows: newRows } as typeof block.content,
							});
							return;
						}
					}

					// Handle regular block content
					if (Array.isArray(block.content)) {
						let hasChanged = false;
						const newContent = (block.content as unknown[]).map((item: unknown) => {
							const inline = item as { type?: string; props?: { docPath?: string } };
							if (inline.type === "docMention" && inline.props?.docPath === docPath) {
								hasChanged = true;
								if (type === "task") {
									return { type: "taskMention", props: { taskId: newId } };
								}
								return { type: "docMention", props: { docPath: newId } };
							}
							return item;
						});
						if (hasChanged) {
							editor.updateBlock(block, {
								content: newContent as typeof block.content,
							});
							return;
						}
					}
				}
			};

			return (
				<DocMentionComponent
					docPath={docPath}
					isEditable={isEditable}
					onDelete={handleDelete}
					onReplace={handleReplace}
				/>
			);
		},
	},
);

export default DocMention;
