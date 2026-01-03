import { forwardRef, useImperativeHandle, useRef, useMemo, useState, useEffect, type ReactNode } from "react";
import MDEditor from "@uiw/react-md-editor";
import { ClipboardCheck, FileText } from "lucide-react";
import { useTheme } from "../../App";
import { getTask, getDoc } from "../../api/client";

export interface MDRenderRef {
	getElement: () => HTMLElement | null;
}

interface MDRenderProps {
	markdown: string;
	className?: string;
	onDocLinkClick?: (path: string) => void;
	onTaskLinkClick?: (taskId: string) => void;
}

// Regex patterns for mentions
// Task: supports subtask IDs like task-42.1
const TASK_MENTION_REGEX = /@(task-\d+(?:\.\d+)?)/g;
// Doc: excludes trailing punctuation (comma, semicolon, colon, etc.)
const DOC_MENTION_REGEX = /@docs?\/([^\s,;:!?"'()]+)/g;

/**
 * Normalize doc path - ensure .md extension
 */
function normalizeDocPath(path: string): string {
	return path.endsWith(".md") ? path : `${path}.md`;
}

/**
 * Transform mention patterns into markdown links
 * These will then be styled via the custom link component
 */
function transformMentions(content: string): string {
	// Transform @task-123 to [@@task-123](#/tasks/task-123)
	let transformed = content.replace(TASK_MENTION_REGEX, "[@@$1](#/tasks/$1)");

	// Transform @doc/path or @docs/path to [@@doc/path.md](#/docs/path.md)
	transformed = transformed.replace(DOC_MENTION_REGEX, (_match, docPath) => {
		// Strip trailing dot if not part of extension (e.g., "@doc/api." → "api")
		let cleanPath = docPath;
		if (cleanPath.endsWith(".") && !cleanPath.match(/\.\w+$/)) {
			cleanPath = cleanPath.slice(0, -1);
		}
		const normalizedPath = normalizeDocPath(cleanPath);
		return `[@@doc/${normalizedPath}](#/docs/${normalizedPath})`;
	});

	return transformed;
}

// Status colors for task badges
const STATUS_COLORS: Record<string, { dot: string; text: string }> = {
	todo: { dot: "bg-gray-400", text: "text-gray-500" },
	"in-progress": { dot: "bg-yellow-400", text: "text-yellow-600" },
	"in-review": { dot: "bg-purple-400", text: "text-purple-600" },
	blocked: { dot: "bg-red-400", text: "text-red-600" },
	done: { dot: "bg-green-400", text: "text-green-600" },
};

// Badge classes with dark: variants
const taskBadgeClass =
	"inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-sm font-medium transition-all bg-green-100/50 border border-green-500/30 text-green-700 hover:bg-green-100 hover:border-green-500/50 dark:bg-green-900/20 dark:text-green-300 dark:hover:bg-green-900/30";

const docBadgeClass =
	"inline-flex items-center gap-1 px-1 py-1 rounded-md text-sm font-medium transition-all hover:scale-105 bg-blue-100/50 border border-blue-500/30 text-blue-700 hover:bg-blue-100 hover:border-blue-500/50 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/30";

/**
 * Task mention badge that fetches and displays the task title and status
 */
function TaskMentionBadge({
	taskId,
	onTaskLinkClick,
}: {
	taskId: string;
	onTaskLinkClick?: (taskId: string) => void;
}) {
	const [title, setTitle] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const taskNumber = taskId.replace("task-", "");

	const hashHref = `#/kanban/${taskNumber}`;

	// Extract task number from taskId (e.g., "task-33" -> "33")


	useEffect(() => {
		let cancelled = false;

		// API uses just the number, not "task-33"
		getTask(taskNumber)
			.then((task) => {
				if (!cancelled) {
					setTitle(task.title);
					setStatus(task.status);
					setLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setTitle(null);
					setStatus(null);
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
		if (onTaskLinkClick) {
			onTaskLinkClick(taskNumber);
		} else {
			window.location.hash = `/kanban/${taskNumber}`;
		}
	};
	const statusColors = status ? STATUS_COLORS[status] || STATUS_COLORS.todo : null;

	return (
		<a href={hashHref} className={taskBadgeClass} data-task-id={taskNumber} onClick={handleClick}>
			<ClipboardCheck className="w-4 h-4 shrink-0" />
			{loading ? (
				<span className="opacity-70">#{taskNumber}</span>
			) : title ? (
				<>
					<span>#{taskNumber}: {title}</span>
					{status && statusColors && (
						<span className={`inline-flex items-center gap-1 ${statusColors.text}`}>
							<span className={`w-2 h-2 rounded-full ${statusColors.dot}`} />
						</span>
					)}
				</>
			) : (
				<span>#{taskNumber}</span>
			)}
		</a>
	);
}

/**
 * Doc mention badge that fetches and displays the doc title
 */
function DocMentionBadge({
	docPath,
	onDocLinkClick,
}: {
	docPath: string;
	onDocLinkClick?: (path: string) => void;
}) {
	const [title, setTitle] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const hashHref = `#/docs/${docPath}`;

	useEffect(() => {
		let cancelled = false;

		getDoc(docPath)
			.then((doc) => {
				if (!cancelled && doc) {
					setTitle(doc.title || null);
					setLoading(false);
				} else if (!cancelled) {
					setLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setTitle(null);
					setLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [docPath]);

	const handleClick = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (onDocLinkClick) {
			onDocLinkClick(docPath);
		} else {
			window.location.hash = `/docs/${docPath}`;
		}
	};

	// Display filename without extension for shorter display
	const shortPath = docPath.replace(/\.md$/, "").split("/").pop() || docPath;

	return (
		<a href={hashHref} className={docBadgeClass} data-doc-path={docPath} onClick={handleClick}>
			<FileText className="w-4 h-4 shrink-0" />
			{loading ? (
				<span className="opacity-70">{shortPath}</span>
			) : title ? (
				<span>{title}</span>
			) : (
				<span>{shortPath}</span>
			)}
		</a>
	);
}

/**
 * Read-only markdown renderer with mention badge support
 */
const MDRender = forwardRef<MDRenderRef, MDRenderProps>(
	({ markdown, className = "", onDocLinkClick, onTaskLinkClick }, ref) => {
		const { isDark } = useTheme();
		const containerRef = useRef<HTMLDivElement>(null);

		// Transform mentions in the markdown content
		const transformedMarkdown = useMemo(() => {
			return transformMentions(markdown || "");
		}, [markdown]);

		// Expose ref methods
		useImperativeHandle(ref, () => ({
			getElement: () => containerRef.current,
		}));

		// Custom link component that renders mention badges
		const CustomLink = useMemo(() => {
			return function CustomLinkComponent({
				href,
				children,
			}: {
				href?: string;
				children?: ReactNode;
			}) {
				const text = String(children);

				// Check if this is a task mention (starts with @@task-)
				if (text.startsWith("@@task-")) {
					const taskId = text.slice(2); // Remove @@
					return <TaskMentionBadge taskId={taskId} onTaskLinkClick={onTaskLinkClick} />;
				}

				// Check if this is a doc mention (starts with @@doc/)
				if (text.startsWith("@@doc/")) {
					const docPath = text.slice(6); // Remove @@doc/
					return <DocMentionBadge docPath={docPath} onDocLinkClick={onDocLinkClick} />;
				}

				// Regular link
				return <a href={href}>{children}</a>;
			};
		}, [onDocLinkClick, onTaskLinkClick]);

		if (!markdown) return null;

		return (
			<div ref={containerRef} className={`md-render-wrapper ${className}`} data-color-mode={isDark ? "dark" : "light"}>
				<MDEditor.Markdown
					source={transformedMarkdown}
					style={{
						backgroundColor: "transparent",
						padding: 0,
					}}
					components={{
						a: CustomLink,
					}}
				/>
			</div>
		);
	}
);

MDRender.displayName = "MDRender";

export default MDRender;
