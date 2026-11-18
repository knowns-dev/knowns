import { forwardRef, useImperativeHandle, useCallback, useEffect, useMemo, useState } from "react";
import MdEditor from "react-markdown-editor-lite";
import "react-markdown-editor-lite/lib/index.css";
import { marked } from "marked";
import { getHljs, loadHljs } from "../../lib/hljs";
import { useTheme } from "../../App";

// Configure marked to use highlight.js
marked.setOptions({
	highlight: (code: string, lang: string) => {
		const hljs = getHljs();
		if (!hljs) return code; // plain until highlight.js has loaded (the editor re-renders then)
		if (lang && hljs.getLanguage(lang)) {
			try {
				return hljs.highlight(code, { language: lang }).value;
			} catch {
				// Fall through to auto-detection
			}
		}
		// Auto-detect language
		try {
			return hljs.highlightAuto(code).value;
		} catch {
			return code;
		}
	},
});

interface MDEditorComponentProps {
	markdown: string;
	onChange: (markdown: string) => void;
	placeholder?: string;
	readOnly?: boolean;
	className?: string;
	height?: number | string;
	/** Preview mode: "edit" (no preview), "live" (split), "preview" (read-only) */
	preview?: "edit" | "live" | "preview";
}

export interface MDEditorRef {
	setMarkdown: (md: string) => void;
	getMarkdown: () => string;
}

const MDEditorComponent = forwardRef<MDEditorRef, MDEditorComponentProps>(
	(
		{
			markdown,
			onChange,
			placeholder = "Write your content here...",
			readOnly = false,
			className = "",
			height = 400,
			preview: previewMode,
		},
		ref,
	) => {
		const { isDark } = useTheme();
		const [hljsReady, setHljsReady] = useState(() => getHljs() !== null);
		useEffect(() => {
			if (hljsReady) return;
			let live = true;
			loadHljs().then(() => live && setHljsReady(true)).catch(() => {});
			return () => {
				live = false;
			};
		}, [hljsReady]);

		// Markdown renderer using marked
		const renderHTML = useCallback((text: string) => {
			return marked.parse(text, { async: false }) as string;
		}, [hljsReady]); // biome-ignore lint/correctness/useExhaustiveDependencies: a new renderer re-renders the preview once colours exist

		const handleEditorChange = useCallback(
			({ text }: { text: string }) => {
				onChange(text);
			},
			[onChange],
		);

		// Expose ref methods
		useImperativeHandle(
			ref,
			() => ({
				setMarkdown: (md: string) => {
					onChange(md);
				},
				getMarkdown: () => markdown,
			}),
			[markdown, onChange],
		);

		// Map preview mode to react-markdown-editor-lite view
		// "edit" = editor only, "live" = split, "preview" = preview only
		const view = useMemo(() => {
			if (readOnly || previewMode === "preview") {
				return { menu: false, md: false, html: true };
			}
			if (previewMode === "live") {
				return { menu: true, md: true, html: true };
			}
			// Default: edit only (no preview)
			return { menu: true, md: true, html: false };
		}, [readOnly, previewMode]);

		// Handle height - support both pixel values and percentage/full height
		const isFullHeight = height === "100%" || height === "full";
		const editorStyle = isFullHeight
			? { height: "100%" }
			: { height: typeof height === "number" ? height : 400 };

		return (
			<div
				className={`md-editor-lite-wrapper ${className} ${isDark ? "dark-mode" : ""} ${isFullHeight ? "h-full" : ""}`}
				data-color-mode={isDark ? "dark" : "light"}
			>
				<MdEditor
					value={markdown}
					onChange={handleEditorChange}
					renderHTML={renderHTML}
					placeholder={placeholder}
					readOnly={readOnly}
					view={view}
					canView={{ menu: !readOnly, md: true, html: false, both: false, fullScreen: true, hideMenu: false }}
					style={editorStyle}
				/>
			</div>
		);
	},
);

MDEditorComponent.displayName = "MDEditor";

export default MDEditorComponent;
