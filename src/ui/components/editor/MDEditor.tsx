import { forwardRef, useImperativeHandle, useCallback } from "react";
import MDEditor from "@uiw/react-md-editor";
import { useTheme } from "../../App";

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

		const handleChange = useCallback(
			(value?: string) => {
				onChange(value || "");
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

		// Determine preview mode
		const preview = previewMode ?? (readOnly ? "preview" : "edit");

		return (
			<div
				className={`md-editor-wrapper ${className}`}
				data-color-mode={isDark ? "dark" : "light"}
			>
				<MDEditor
					value={markdown}
					onChange={handleChange}
					preview={preview}
					hideToolbar={readOnly}
					textareaProps={{
						placeholder,
					}}
					height={typeof height === "number" ? height : "100%"}
					visibleDragbar={!readOnly}
				/>
			</div>
		);
	},
);

MDEditorComponent.displayName = "MDEditor";

export default MDEditorComponent;
