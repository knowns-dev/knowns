import { forwardRef, useImperativeHandle, useCallback, useEffect, useMemo, useRef, Component, type ReactNode } from "react";
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
	prepareBlocksForSerialization,
	serializeMentionsInMarkdown,
} from "./mentions";

/**
 * Error boundary to catch BlockNote rendering errors
 * Particularly for index out of range errors in tables with custom inline content
 */
class EditorErrorBoundary extends Component<
	{ children: ReactNode; fallback?: ReactNode; onError?: (error: Error) => void },
	{ hasError: boolean; error: Error | null }
> {
	constructor(props: { children: ReactNode; fallback?: ReactNode; onError?: (error: Error) => void }) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error) {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		console.error("BlockNote Editor Error:", error, errorInfo);
		this.props.onError?.(error);
	}

	render() {
		if (this.state.hasError) {
			if (this.props.fallback) {
				return this.props.fallback;
			}
			// Default fallback with retry option
			return (
				<div className="flex flex-col items-center justify-center h-full p-4 text-muted-foreground">
					<p className="text-sm">Editor encountered an error</p>
					<button
						type="button"
						className="mt-2 text-xs underline hover:text-foreground"
						onClick={() => this.setState({ hasError: false, error: null })}
					>
						Try again
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}

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
				// Prepare blocks by replacing mentions with placeholders
				const preparedBlocks = prepareBlocksForSerialization(editor.document);

				// Convert blocks to markdown (placeholders will be in the output)
				const md = await editor.blocksToMarkdownLossy(preparedBlocks);

				// Convert placeholders to @ format (@task-X, @doc/path)
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
			<EditorErrorBoundary>
				<div className={wrapperClass} style={{ height: "100%", display: "flex", flexDirection: "column" }}>
					<BlockNoteView
						editor={editor}
						editable={!readOnly}
						onChange={handleChange}
						theme={isDark ? "dark" : "light"}
						data-placeholder={placeholder}
					>
						{!readOnly && (
							<EditorErrorBoundary>
								<MentionSuggestionMenu editor={editor} />
							</EditorErrorBoundary>
						)}
					</BlockNoteView>
				</div>
			</EditorErrorBoundary>
		);
	},
);

BlockNoteEditor.displayName = "BlockNoteEditor";

export default BlockNoteEditor;
