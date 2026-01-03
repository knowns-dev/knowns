import { forwardRef } from "react";
import { ClipboardCheck, FileText } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SectionMarkers } from "../../utils/markdown-sections";
import { prepareMarkdownForEdit, stripHtmlComments } from "../../utils/markdown-sections";

interface MarkdownRendererProps {
	markdown: string;
	className?: string;
	sectionType?: keyof SectionMarkers;
	enableGFM?: boolean;
	onDocLinkClick?: (path: string) => void;
}

// Tailwind classes for badges with dark: prefix
const taskBadgeClass =
	"inline-flex items-center gap-1 px-1 py-1 rounded-md text-sm font-medium transition-all hover:scale-105 bg-green-100/50 border border-green-500/30 text-green-700 hover:bg-green-100 hover:border-green-500/50 dark:bg-green-900/20 dark:text-green-300 dark:hover:bg-green-900/30";

const docBadgeClass =
	"inline-flex items-center gap-1 px-1 py-1 rounded-md text-sm font-medium transition-all hover:scale-105 bg-blue-100/50 border border-blue-500/30 text-blue-700 hover:bg-blue-100 hover:border-blue-500/50 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/30";

const MarkdownRenderer = forwardRef<HTMLDivElement, MarkdownRendererProps>(
	({ markdown, className = "", sectionType, enableGFM = true, onDocLinkClick }, ref) => {
		if (!markdown) return null;

		// Extract content from section markers if present
		const content = stripHtmlComments(prepareMarkdownForEdit(markdown, sectionType));

		// Custom link component
		const LinkComponent = ({
			href,
			children,
		}: {
			href?: string;
			children?: React.ReactNode;
		}) => {
			// Check if it's a task reference (task-123, task-123.1, task-123.md, 123, 123.1, or 123.md)
			if (href && /^(task-)?\d+(\.\d+)?(\.md)?$/.test(href)) {
				const taskId = href.replace(/^task-/, "").replace(/\.md$/, "");
				const hashHref = `#/tasks/${taskId}`;
				return (
					<a href={hashHref} className={taskBadgeClass} data-task-id={taskId}>
						<ClipboardCheck className="w-4 h-4 shrink-0" />
						{children}
					</a>
				);
			}

			// Check if it's a .md file link (document)
			if (href && (href.endsWith(".md") || href.includes(".md#"))) {
				// Clean up path: remove ./ prefix and construct hash route
				const cleanPath = href.replace(/^\.\//, "");
				const hashHref = `#/docs/${cleanPath}`;
				return (
					<a
						href={hashHref}
						className={docBadgeClass}
						data-doc-path={cleanPath}
						onClick={(e) => {
							if (onDocLinkClick) {
								e.preventDefault();
								onDocLinkClick(cleanPath);
							}
						}}
					>
						<FileText className="w-4 h-4 shrink-0" />
						{children}
					</a>
				);
			}

			// Regular external link
			return (
				<a
					href={href}
					target="_blank"
					rel="noopener noreferrer"
					className="text-blue-500 hover:text-blue-600 underline"
				>
					{children}
				</a>
			);
		};

		return (
			<div
				ref={ref}
				className={`prose prose-sm max-w-none dark:prose-invert ${className}`}
			>
					<Markdown
						remarkPlugins={enableGFM ? [remarkGfm] : []}
						components={{
							a: LinkComponent,
							// Better code block styling
							code: ({ className, children, ...props }) => {
								const isInline = !className;
								if (isInline) {
									return (
										<code
											className="px-1.5 py-0.5 rounded text-sm bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200"
											{...props}
										>
											{children}
										</code>
									);
								}
								return (
									<code className={className} {...props}>
										{children}
									</code>
								);
							},
							// Better pre styling for code blocks
							pre: ({ children }) => (
								<pre className="overflow-x-auto rounded-lg p-4 text-sm bg-gray-100 dark:bg-gray-900">
									{children}
								</pre>
							),
							// Table styling
							table: ({ children }) => (
								<div className="overflow-x-auto my-4">
									<table className="min-w-full border-collapse">{children}</table>
								</div>
							),
							th: ({ children }) => (
								<th className="px-4 py-2 text-left font-semibold border bg-gray-100 text-gray-900 border-gray-200 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600">
									{children}
								</th>
							),
							td: ({ children }) => (
								<td className="px-4 py-2 border border-gray-200 text-gray-700 dark:border-gray-600 dark:text-gray-200">
									{children}
								</td>
							),
							// Checkbox styling for task lists
							input: ({ type, checked, ...props }) => {
								if (type === "checkbox") {
									return (
										<input
											type="checkbox"
											checked={checked}
											readOnly
											className="mr-2 accent-blue-600"
											{...props}
										/>
									);
								}
								return <input type={type} {...props} />;
							},
						}}
					>
						{content}
					</Markdown>
				</div>
		);
	}
);

MarkdownRenderer.displayName = "MarkdownRenderer";

export default MarkdownRenderer;
