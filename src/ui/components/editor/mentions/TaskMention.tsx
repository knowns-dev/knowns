import { createReactInlineContentSpec } from "@blocknote/react";
import { useState, useEffect } from "react";
import { ClipboardCheck } from "lucide-react";
import { getTask } from "../../../api/client";
import { MentionToolbar } from "./MentionToolbar";
import { Badge } from "../../ui/badge";
import { cn } from "@/ui/lib/utils";
import type { Task } from "../../../../models/task";

// Status indicator styles
const STATUS_STYLES: Record<string, string> = {
	todo: "bg-muted-foreground/50",
	"in-progress": "bg-yellow-500",
	"in-review": "bg-purple-500",
	blocked: "bg-destructive",
	done: "bg-green-500",
};

interface TaskMentionComponentProps {
	taskId: string;
	isEditable?: boolean;
	onDelete?: () => void;
	onReplace?: (type: "task" | "doc", id: string) => void;
	onClick?: (taskId: string) => void;
}

/**
 * Task mention badge component that fetches and displays task data
 * Uses shadcn Badge for consistent styling
 */
function TaskMentionComponent({
	taskId,
	isEditable = false,
	onDelete,
	onReplace,
	onClick,
}: TaskMentionComponentProps) {
	const [task, setTask] = useState<Task | null>(null);
	const [loading, setLoading] = useState(true);

	const taskNumber = taskId.replace("task-", "");

	useEffect(() => {
		let cancelled = false;

		getTask(taskNumber)
			.then((fetchedTask) => {
				if (!cancelled) {
					setTask(fetchedTask);
					setLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setTask(null);
					setLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [taskNumber]);

	const handleClick = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();

		// Don't navigate in edit mode - use toolbar's Open button instead
		if (isEditable) return;

		if (onClick) {
			onClick(taskNumber);
		} else {
			window.location.hash = `/kanban/${taskNumber}`;
		}
	};

	const handlePreview = () => {
		window.location.hash = `/kanban/${taskNumber}`;
	};

	const statusStyle = task?.status ? STATUS_STYLES[task.status] : STATUS_STYLES.todo;

	const badge = (
		<Badge
			variant="outline"
			className={cn(
				"mention-badge cursor-pointer select-none gap-1.5 font-medium",
				"border-green-500/30 bg-green-500/10 text-green-700 hover:bg-green-500/20",
				"dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-400 dark:hover:bg-green-500/20",
				"transition-colors"
			)}
			data-task-id={taskNumber}
			onClick={handleClick}
			onMouseDown={(e) => {
				// Prevent BlockNote from capturing the event
				e.stopPropagation();
				// Navigate on mousedown for better responsiveness in contenteditable
				handleClick(e);
			}}
		>
			<ClipboardCheck className="w-3.5 h-3.5 shrink-0" />
			{loading ? (
				<span className="opacity-70">#{taskNumber}</span>
			) : task ? (
				<>
					<span className="max-w-[200px] truncate">
						#{taskNumber}: {task.title}
					</span>
					<span className={cn("w-2 h-2 rounded-full shrink-0", statusStyle)} />
				</>
			) : (
				<span>#{taskNumber}</span>
			)}
		</Badge>
	);

	// Preview content for toolbar
	const previewContent = task ? (
		<div className="space-y-1.5">
			<div className="font-medium text-sm leading-tight">{task.title}</div>
			{task.description && (
				<div className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
					{task.description}
				</div>
			)}
			<div className="flex items-center gap-2 text-xs">
				<span className="inline-flex items-center gap-1">
					<span className={cn("w-1.5 h-1.5 rounded-full", statusStyle)} />
					<span className="capitalize">{task.status}</span>
				</span>
				<span className="text-muted-foreground">•</span>
				<span className="text-muted-foreground capitalize">{task.priority}</span>
			</div>
		</div>
	) : null;

	return (
		<MentionToolbar
			isEditable={isEditable}
			onPreview={handlePreview}
			onReplace={onReplace || (() => {})}
			onDelete={onDelete || (() => {})}
			previewContent={previewContent}
			type="task"
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
 * BlockNote inline content spec for task mentions
 * Format: @task-{id}
 */
export const TaskMention = createReactInlineContentSpec(
	{
		type: "taskMention",
		propSchema: {
			taskId: {
				default: "",
			},
		},
		content: "none",
	},
	{
		render: (props) => {
			const taskId = props.inlineContent.props.taskId;
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
									const inline = item as { type?: string; props?: { taskId?: string } };
									return !(inline.type === "taskMention" && inline.props?.taskId === taskId);
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
							const inline = item as { type?: string; props?: { taskId?: string } };
							return !(inline.type === "taskMention" && inline.props?.taskId === taskId);
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
									const inline = item as { type?: string; props?: { taskId?: string } };
									if (inline.type === "taskMention" && inline.props?.taskId === taskId) {
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
							const inline = item as { type?: string; props?: { taskId?: string } };
							if (inline.type === "taskMention" && inline.props?.taskId === taskId) {
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
				<TaskMentionComponent
					taskId={taskId}
					isEditable={isEditable}
					onDelete={handleDelete}
					onReplace={handleReplace}
				/>
			);
		},
	},
);

export default TaskMention;
