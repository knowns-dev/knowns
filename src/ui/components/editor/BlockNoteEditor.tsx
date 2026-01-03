import { forwardRef, useImperativeHandle, useCallback, useEffect, useMemo, useRef } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";
import { useTheme } from "../../App";
import {
	schema,
	MentionSuggestionMenu,
	preprocessMarkdown,
	postprocessBlocks,
	serializeMentionsInMarkdown,
} from "./mentions";

interface BlockNoteEditorProps {
	markdown: string;
	onChange: (markdown: string) => void;
	placeholder?: string;
	readOnly?: boolean;
	className?: string;
}

export interface BlockNoteEditorRef {
	setMarkdown: (md: string) => void;
	getMarkdown: () => string;
}

const BlockNoteEditor = forwardRef<BlockNoteEditorRef, BlockNoteEditorProps>(
	({ markdown, onChange, placeholder = "Write your content here...", readOnly = false, className = "" }, ref) => {
		const { isDark } = useTheme();
		const initialContentRef = useRef<boolean>(false);
		const isInternalUpdate = useRef<boolean>(false);

		// Create the editor with our custom schema
		const editor = useCreateBlockNote({
			schema,
		});

		// Load initial content from markdown
		useEffect(() => {
			if (editor && markdown && !initialContentRef.current) {
				initialContentRef.current = true;
				loadMarkdown(markdown);
			}
		}, [editor, markdown]);

		// Function to load markdown into the editor
		const loadMarkdown = useCallback(
			async (md: string) => {
				if (!editor || !md) return;

				try {
					isInternalUpdate.current = true;

					// Preprocess to convert @mentions to placeholders
					const preprocessed = preprocessMarkdown(md);

					// Parse markdown to blocks
					const blocks = await editor.tryParseMarkdownToBlocks(preprocessed);

					// Postprocess to convert placeholders to mention inline content
					const processedBlocks = postprocessBlocks(blocks);

					// Replace editor content
					editor.replaceBlocks(editor.document, processedBlocks);
				} catch (error) {
					console.error("Failed to load markdown:", error);
				} finally {
					isInternalUpdate.current = false;
				}
			},
			[editor],
		);

		// Handle content changes
		const handleChange = useCallback(async () => {
			if (!editor || isInternalUpdate.current) return;

			try {
				// Convert blocks to markdown
				const md = await editor.blocksToMarkdownLossy(editor.document);

				// Serialize mentions back to @ format
				const finalMarkdown = serializeMentionsInMarkdown(md, editor.document);

				onChange(finalMarkdown);
			} catch (error) {
				console.error("Failed to convert to markdown:", error);
			}
		}, [editor, onChange]);

		// Expose ref methods
		useImperativeHandle(
			ref,
			() => ({
				setMarkdown: (md: string) => {
					loadMarkdown(md);
				},
				getMarkdown: () => {
					return markdown;
				},
			}),
			[markdown, loadMarkdown],
		);

		// Memoize the wrapper class
		const wrapperClass = useMemo(() => {
			return `blocknote-editor-wrapper ${className} ${isDark ? "dark" : ""}`.trim();
		}, [className, isDark]);

		return (
			<div className={wrapperClass} style={{ height: "100%", display: "flex", flexDirection: "column" }}>
				<BlockNoteView
					editor={editor}
					editable={!readOnly}
					onChange={handleChange}
					theme={isDark ? "dark" : "light"}
					data-placeholder={placeholder}
				>
					{!readOnly && <MentionSuggestionMenu editor={editor} />}
				</BlockNoteView>
			</div>
		);
	},
);

BlockNoteEditor.displayName = "BlockNoteEditor";

export default BlockNoteEditor;
