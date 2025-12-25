import { marked } from "marked";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTheme } from "../App";
import type { SectionMarkers } from "../utils/markdown-sections";
import { prepareMarkdownForEdit, prepareMarkdownForSave } from "../utils/markdown-sections";

interface MarkdownEditorProps {
	markdown: string;
	onChange: (markdown: string) => void;
	placeholder?: string;
	readOnly?: boolean;
	sectionType?: keyof SectionMarkers;
}

export interface MarkdownEditorRef {
	setMarkdown: (markdown: string) => void;
	getMarkdown: () => string;
}

const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(
	({ markdown, onChange, placeholder, readOnly = false, sectionType }, ref) => {
		const { isDark } = useTheme();
		const textareaRef = useRef<HTMLTextAreaElement>(null);
		const [showPreview, setShowPreview] = useState(false);
		const [content, setContent] = useState(() => prepareMarkdownForEdit(markdown, sectionType));

		// Sync content when markdown prop changes
		const editableContent = prepareMarkdownForEdit(markdown, sectionType);

		useEffect(() => {
			setContent(editableContent);
		}, [editableContent]);

		const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const newContent = e.target.value;
			setContent(newContent);
			const finalMarkdown = prepareMarkdownForSave(newContent, markdown, sectionType);
			onChange(finalMarkdown);
		};

		useImperativeHandle(
			ref,
			() => ({
				setMarkdown: (md: string) => {
					const content = prepareMarkdownForEdit(md, sectionType);
					if (textareaRef.current) {
						textareaRef.current.value = content;
					}
				},
				getMarkdown: () => {
					const content = textareaRef.current?.value || "";
					return prepareMarkdownForSave(content, markdown, sectionType);
				},
			}),
			[markdown, sectionType]
		);

		const renderPreview = () => {
			const html = marked.parse(content || "", { async: false }) as string;
			return { __html: html };
		};

		return (
			<div
				className={`rounded-lg border transition-colors ${
					isDark ? "border-gray-700 bg-gray-800" : "border-gray-300 bg-white"
				}`}
			>
				{/* Toolbar */}
				<div
					className={`flex items-center justify-between px-3 py-2 border-b ${
						isDark ? "border-gray-700" : "border-gray-300"
					}`}
				>
					<div className={`text-xs ${isDark ? "text-gray-400" : "text-gray-500"}`}>
						Markdown supported
					</div>
					<button
						type="button"
						onClick={() => setShowPreview(!showPreview)}
						className={`text-xs px-2 py-1 rounded ${
							showPreview
								? isDark
									? "bg-blue-600 text-white"
									: "bg-blue-500 text-white"
								: isDark
									? "bg-gray-700 text-gray-300 hover:bg-gray-600"
									: "bg-gray-200 text-gray-700 hover:bg-gray-300"
						}`}
					>
						{showPreview ? "Edit" : "Preview"}
					</button>
				</div>

				{/* Content */}
				{showPreview ? (
					<div
						className={`p-4 min-h-[150px] prose prose-sm max-w-none ${
							isDark ? "prose-invert" : ""
						}`}
						dangerouslySetInnerHTML={renderPreview()}
					/>
				) : (
					<textarea
						ref={textareaRef}
						value={content}
						onChange={handleChange}
						placeholder={placeholder || "Type markdown here..."}
						readOnly={readOnly}
						className={`w-full p-4 min-h-[150px] resize-y focus:outline-none font-mono text-sm ${
							isDark
								? "bg-gray-800 text-gray-200 placeholder-gray-500"
								: "bg-white text-gray-900 placeholder-gray-400"
						}`}
					/>
				)}

				<style>{`
					.prose h1 {
						font-size: 2em;
						font-weight: bold;
						margin: 0.67em 0;
					}

					.prose h2 {
						font-size: 1.5em;
						font-weight: bold;
						margin: 0.75em 0;
					}

					.prose h3 {
						font-size: 1.17em;
						font-weight: bold;
						margin: 0.83em 0;
					}

					.prose ul,
					.prose ol {
						padding-left: 1.5em;
						margin: 0.75em 0;
					}

					.prose li {
						margin: 0.25em 0;
					}

					.prose blockquote {
						border-left: 3px solid ${isDark ? "#60a5fa" : "#3b82f6"};
						padding-left: 1em;
						margin: 1em 0;
						color: ${isDark ? "#9ca3af" : "#6b7280"};
					}

					.prose code {
						background-color: ${isDark ? "#374151" : "#f3f4f6"};
						color: ${isDark ? "#60a5fa" : "#ef4444"};
						padding: 0.2em 0.4em;
						border-radius: 0.25rem;
						font-family: "Courier New", Courier, monospace;
						font-size: 0.9em;
					}

					.prose pre {
						background-color: ${isDark ? "#1f2937" : "#f9fafb"};
						border: 1px solid ${isDark ? "#374151" : "#e5e7eb"};
						padding: 0.75em 1em;
						border-radius: 0.375rem;
						overflow-x: auto;
						margin: 1em 0;
					}

					.prose pre code {
						background-color: transparent;
						padding: 0;
						color: ${isDark ? "#e5e7eb" : "#1f2937"};
						font-size: 0.875em;
					}

					.prose hr {
						border: none;
						border-top: 2px solid ${isDark ? "#374151" : "#e5e7eb"};
						margin: 2em 0;
					}

					.prose a {
						color: ${isDark ? "#60a5fa" : "#3b82f6"};
						text-decoration: underline;
					}

					.prose strong {
						font-weight: 600;
					}

					.prose em {
						font-style: italic;
					}
				`}</style>
			</div>
		);
	}
);

MarkdownEditor.displayName = "MarkdownEditor";

export default MarkdownEditor;
