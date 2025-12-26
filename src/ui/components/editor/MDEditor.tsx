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
}

export interface MDEditorRef {
	setMarkdown: (md: string) => void;
	getMarkdown: () => string;
}

const MDEditorComponent = forwardRef<MDEditorRef, MDEditorComponentProps>(
	({ markdown, onChange, placeholder = "Write your content here...", readOnly = false, className = "", height = 400 }, ref) => {
		const { isDark } = useTheme();

		const handleChange = useCallback(
			(value?: string) => {
				onChange(value || "");
			},
			[onChange]
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
			[markdown, onChange]
		);

		return (
			<div
				className={`md-editor-wrapper ${className}`}
				data-color-mode={isDark ? "dark" : "light"}
				style={{ height: typeof height === "string" ? height : undefined }}
			>
				<MDEditor
					value={markdown}
					onChange={handleChange}
					preview={readOnly ? "preview" : "live"}
					hideToolbar={readOnly}
					textareaProps={{
						placeholder,
					}}
					height={typeof height === "number" ? height : "100%"}
					visibleDragbar={!readOnly}
				/>
			</div>
		);
	}
);

MDEditorComponent.displayName = "MDEditor";

export default MDEditorComponent;
