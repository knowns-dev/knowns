import { marked } from "marked";
import { forwardRef, useMemo } from "react";
import { useTheme } from "../App";
import type { SectionMarkers } from "../utils/markdown-sections";
import { prepareMarkdownForEdit, stripHtmlComments } from "../utils/markdown-sections";

interface MarkdownRendererProps {
	markdown: string;
	className?: string;
	sectionType?: keyof SectionMarkers;
	enableGFM?: boolean;
	onDocLinkClick?: (path: string) => void;
}

const MarkdownRenderer = forwardRef<HTMLDivElement, MarkdownRendererProps>(
	({ markdown, className = "", sectionType, enableGFM = false, onDocLinkClick }, ref) => {
		const { isDark } = useTheme();

		const html = useMemo(() => {
			if (!markdown) return "";

			// Custom renderer for links
			const renderer = new marked.Renderer();
			const originalLink = renderer.link.bind(renderer);

			renderer.link = ({ href, title, tokens }) => {
				// Check if it's a task reference (task-123 or task-123.md)
				if (href && /^task-\d+(.md)?$/.test(href)) {
					// Extract task ID
					const taskId = href.replace(".md", "");

					// Get display text from link text (tokens)
					let displayText = "";
					if (tokens && tokens.length > 0) {
						displayText = tokens.map((t: any) => t.raw || t.text || "").join("");
					}

					// If no text, use task ID as display
					if (!displayText || displayText === href) {
						displayText = taskId
							.split("-")
							.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
							.join(" ");
					}

					// SVG icon for task (checkbox)
					const icon = `<svg class="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
					</svg>`;

					return `<a href="${href}" class="task-link-badge inline-flex items-center gap-1 px-3 py-1 rounded-md text-sm font-medium transition-all hover:scale-105" data-task-id="${taskId}">${icon}${displayText}</a>`;
				}

				// Check if it's a .md file link (document)
				if (href && (href.endsWith(".md") || href.includes(".md#"))) {
					// Extract just the filename for display
					const parts = href.split("/");
					const filename = parts[parts.length - 1].replace(".md", "");

					// Get display text from link text
					let displayText = "";
					if (tokens && tokens.length > 0) {
						displayText = tokens.map((t: any) => t.raw || t.text || "").join("");
					}

					// If no text or text is same as href, use formatted filename
					if (!displayText || displayText === href) {
						displayText = filename
							.split(/[-_]/)
							.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
							.join(" ");
					}

					// SVG icon for file
					const icon = `<svg class="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
					</svg>`;

					return `<a href="${href}" class="doc-link-badge inline-flex items-center gap-1 px-3 py-1 rounded-md text-sm font-medium transition-all hover:scale-105" data-doc-path="${href}">${icon}${displayText}</a>`;
				}

				// For regular links, use default renderer
				return originalLink({ href, title: title || "", tokens });
			};

			// Extract content from section markers if present
			const content = prepareMarkdownForEdit(markdown, sectionType);

			// Parse markdown to HTML with custom renderer
			const parsedHtml = marked.parse(content, {
				async: false,
				gfm: enableGFM,
				breaks: enableGFM,
				renderer,
			}) as string;

			// Strip HTML comments from rendered content
			return stripHtmlComments(parsedHtml);
		}, [markdown, sectionType, enableGFM]);

		return (
			<>
				<style>{`
					/* Document link badges */
					.doc-link-badge {
						background: ${isDark ? "rgba(59, 130, 246, 0.1)" : "rgba(59, 130, 246, 0.1)"};
						border: 1px solid ${isDark ? "rgba(59, 130, 246, 0.3)" : "rgba(59, 130, 246, 0.3)"};
						color: ${isDark ? "#93c5fd" : "#2563eb"};
					}
					.doc-link-badge:hover {
						background: ${isDark ? "rgba(59, 130, 246, 0.2)" : "rgba(59, 130, 246, 0.2)"};
						border-color: ${isDark ? "rgba(59, 130, 246, 0.5)" : "rgba(59, 130, 246, 0.5)"};
						box-shadow: 0 0 0 3px ${isDark ? "rgba(59, 130, 246, 0.1)" : "rgba(59, 130, 246, 0.1)"};
					}

					/* Task link badges */
					.task-link-badge {
						background: ${isDark ? "rgba(34, 197, 94, 0.1)" : "rgba(34, 197, 94, 0.1)"};
						border: 1px solid ${isDark ? "rgba(34, 197, 94, 0.3)" : "rgba(34, 197, 94, 0.3)"};
						color: ${isDark ? "#86efac" : "#16a34a"};
					}
					.task-link-badge:hover {
						background: ${isDark ? "rgba(34, 197, 94, 0.2)" : "rgba(34, 197, 94, 0.2)"};
						border-color: ${isDark ? "rgba(34, 197, 94, 0.5)" : "rgba(34, 197, 94, 0.5)"};
						box-shadow: 0 0 0 3px ${isDark ? "rgba(34, 197, 94, 0.1)" : "rgba(34, 197, 94, 0.1)"};
					}

					/* Table styling */
					.prose table {
						width: 100%;
						border-collapse: collapse;
						margin: 1.5em 0;
					}
					.prose th {
						background: ${isDark ? "#374151" : "#f3f4f6"};
						color: ${isDark ? "#f9fafb" : "#111827"};
						font-weight: 600;
						padding: 0.75rem 1rem;
						text-align: left;
						border: 1px solid ${isDark ? "#4b5563" : "#e5e7eb"};
					}
					.prose td {
						padding: 0.75rem 1rem;
						border: 1px solid ${isDark ? "#4b5563" : "#e5e7eb"};
						color: ${isDark ? "#e5e7eb" : "#374151"};
					}
					.prose tbody tr:nth-child(even) {
						background: ${isDark ? "#1f2937" : "#f9fafb"};
					}
					.prose tbody tr:hover {
						background: ${isDark ? "#374151" : "#f3f4f6"};
					}
				`}</style>
				<div
					ref={ref}
					className={`prose prose-sm max-w-none ${isDark ? "prose-invert" : ""} ${className}`}
					style={{
						// Custom table styles for better dark mode support
						...(isDark
							? {
									"--tw-prose-th-borders": "#374151",
									"--tw-prose-td-borders": "#374151",
								}
							: {
									"--tw-prose-th-borders": "#e5e7eb",
									"--tw-prose-td-borders": "#e5e7eb",
								}),
					}}
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			</>
		);
	}
);

MarkdownRenderer.displayName = "MarkdownRenderer";

export default MarkdownRenderer;
