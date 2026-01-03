import { forwardRef, useImperativeHandle, useEffect, useMemo, useRef } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";
import { useTheme } from "../../App";
import { schema, preprocessMarkdown, postprocessBlocks } from "./mentions";

export interface BlockNoteRenderRef {
	getElement: () => HTMLElement | null;
}

interface BlockNoteRenderProps {
	markdown: string;
	className?: string;
	onDocLinkClick?: (path: string) => void;
	onTaskLinkClick?: (taskId: string) => void;
}

/**
 * Read-only BlockNote renderer for displaying markdown content
 * with interactive mention badges
 */
const BlockNoteRender = forwardRef<BlockNoteRenderRef, BlockNoteRenderProps>(
	({ markdown, className = "", onDocLinkClick, onTaskLinkClick }, ref) => {
		const { isDark } = useTheme();
		const containerRef = useRef<HTMLDivElement>(null);
		const lastMarkdownRef = useRef<string>("");

		// Create the editor with our custom schema (read-only mode)
		const editor = useCreateBlockNote({
			schema,
		});

		// Load markdown content when it changes
		useEffect(() => {
			if (!editor || !markdown || markdown === lastMarkdownRef.current) return;

			lastMarkdownRef.current = markdown;

			const loadContent = async () => {
				try {
					// Preprocess to convert @mentions to placeholders
					const preprocessed = preprocessMarkdown(markdown);

					// Parse markdown to blocks
					const blocks = await editor.tryParseMarkdownToBlocks(preprocessed);

					// Postprocess to convert placeholders to mention inline content
					const processedBlocks = postprocessBlocks(blocks);

					// Replace editor content
					editor.replaceBlocks(editor.document, processedBlocks);
				} catch (error) {
					console.error("Failed to render markdown:", error);
				}
			};

			loadContent();
		}, [editor, markdown]);

		// Handle click events on mention badges
		useEffect(() => {
			if (!containerRef.current) return;

			const handleClick = (e: MouseEvent) => {
				const target = e.target as HTMLElement;

				// Check for task mention click
				const taskBadge = target.closest("[data-task-id]");
				if (taskBadge) {
					const taskId = taskBadge.getAttribute("data-task-id");
					if (taskId && onTaskLinkClick) {
						e.preventDefault();
						e.stopPropagation();
						onTaskLinkClick(taskId);
					}
					return;
				}

				// Check for doc mention click
				const docBadge = target.closest("[data-doc-path]");
				if (docBadge) {
					const docPath = docBadge.getAttribute("data-doc-path");
					if (docPath && onDocLinkClick) {
						e.preventDefault();
						e.stopPropagation();
						onDocLinkClick(docPath);
					}
				}
			};

			const container = containerRef.current;
			container.addEventListener("click", handleClick);

			return () => {
				container.removeEventListener("click", handleClick);
			};
		}, [onDocLinkClick, onTaskLinkClick]);

		// Expose ref methods
		useImperativeHandle(ref, () => ({
			getElement: () => containerRef.current,
		}));

		// Memoize the wrapper class
		const wrapperClass = useMemo(() => {
			return `blocknote-render-wrapper ${className} ${isDark ? "dark" : ""}`.trim();
		}, [className, isDark]);

		if (!markdown) return null;

		return (
			<div ref={containerRef} className={wrapperClass}>
				<BlockNoteView editor={editor} editable={false} theme={isDark ? "dark" : "light"} />
			</div>
		);
	},
);

BlockNoteRender.displayName = "BlockNoteRender";

export default BlockNoteRender;
