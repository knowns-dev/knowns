import { useEffect, useState, useRef, useCallback, type ReactNode } from "react";
import { MessageSquare, Replace, Trash2, X, Check } from "lucide-react";
import { cn } from "../../lib/utils";
import type { Annotation } from "../../types/annotation";

interface ToolbarPosition {
	top: number;
	left: number;
	placement: "above" | "below";
}

interface AnnotationSelectionToolbarProps {
	/** Container element to scope selection detection to. */
	containerRef: React.RefObject<HTMLElement | null>;
	/** Whether annotation mode is active. */
	active: boolean;
	/** Raw markdown content for computing line/char positions. */
	docContent: string;
	/** Called when user creates an annotation. */
	onAnnotate: (
		selectedText: string,
		type: Annotation["type"],
		content: string,
		contextBefore: string,
		contextAfter: string,
		startLine: number,
		startChar: number,
		endLine: number,
		endChar: number,
	) => void;
}

/**
 * Floating toolbar that appears when user selects text in annotation mode.
 * Shows Comment, Replace, Delete buttons. Medium/Notion-style.
 */
export function AnnotationSelectionToolbar({ containerRef, active, docContent, onAnnotate }: AnnotationSelectionToolbarProps) {
	const [position, setPosition] = useState<ToolbarPosition | null>(null);
	const [selectedText, setSelectedText] = useState("");
	const [contextBefore, setContextBefore] = useState("");
	const [contextAfter, setContextAfter] = useState("");
	const [inputMode, setInputMode] = useState<"comment" | "replace" | null>(null);
	const [inputValue, setInputValue] = useState("");
	const toolbarRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const resetState = useCallback(() => {
		setPosition(null);
		setSelectedText("");
		setContextBefore("");
		setContextAfter("");
		setInputMode(null);
		setInputValue("");
	}, []);

	// Extract context around selection
	const extractContext = useCallback((range: Range): { before: string; after: string } => {
		const container = containerRef.current;
		if (!container) return { before: "", after: "" };

		const fullText = container.textContent || "";
		const rangeText = range.toString();
		const idx = fullText.indexOf(rangeText);
		if (idx === -1) return { before: "", after: "" };

		return {
			before: fullText.slice(Math.max(0, idx - 30), idx),
			after: fullText.slice(idx + rangeText.length, idx + rangeText.length + 30),
		};
	}, [containerRef]);

	// Listen for selection changes
	useEffect(() => {
		const handleSelectionChange = () => {
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed || !sel.rangeCount) {
				// Don't reset if we're in input mode (user clicked into textarea)
				if (!inputMode) setPosition(null);
				return;
			}

			const range = sel.getRangeAt(0);
			const container = containerRef.current;
			if (!container || !container.contains(range.commonAncestorContainer)) {
				if (!inputMode) setPosition(null);
				return;
			}

			const text = sel.toString().trim();
			if (!text) {
				if (!inputMode) setPosition(null);
				return;
			}

			const rect = range.getBoundingClientRect();
			const containerRect = container.getBoundingClientRect();
			const TOOLBAR_HEIGHT = 44;
			const GAP = 8;

			// Position above selection by default, below if not enough space
			const spaceAbove = rect.top - containerRect.top;
			const placement = spaceAbove > TOOLBAR_HEIGHT + GAP ? "above" : "below";

			const top = placement === "above"
				? rect.top - containerRect.top - TOOLBAR_HEIGHT - GAP + container.scrollTop
				: rect.bottom - containerRect.top + GAP + container.scrollTop;

			const left = Math.max(0, rect.left - containerRect.left + rect.width / 2);

			setPosition({ top, left, placement });
			setSelectedText(text);

			const ctx = extractContext(range);
			setContextBefore(ctx.before);
			setContextAfter(ctx.after);
		};

		document.addEventListener("selectionchange", handleSelectionChange);
		return () => document.removeEventListener("selectionchange", handleSelectionChange);
	}, [containerRef, extractContext, inputMode, resetState]);

	// Focus textarea when input mode opens
	useEffect(() => {
		if (inputMode && textareaRef.current) {
			textareaRef.current.focus();
		}
	}, [inputMode]);

	// Compute line/char position of selectedText in raw markdown
	const computePosition = useCallback((text: string, ctxBefore: string): { startLine: number; startChar: number; endLine: number; endChar: number } => {
		if (!docContent || !text) return { startLine: 0, startChar: 0, endLine: 0, endChar: 0 };

		// Find the best match using context
		let offset = -1;
		if (ctxBefore) {
			const needle = ctxBefore.slice(-20) + text;
			const idx = docContent.indexOf(needle);
			if (idx !== -1) offset = idx + ctxBefore.slice(-20).length;
		}
		if (offset === -1) offset = docContent.indexOf(text);
		if (offset === -1) return { startLine: 0, startChar: 0, endLine: 0, endChar: 0 };

		const beforeStart = docContent.slice(0, offset);
		const startLine = (beforeStart.match(/\n/g) || []).length + 1;
		const lastNewline = beforeStart.lastIndexOf("\n");
		const startChar = lastNewline === -1 ? offset : offset - lastNewline - 1;

		const endOffset = offset + text.length;
		const beforeEnd = docContent.slice(0, endOffset);
		const endLine = (beforeEnd.match(/\n/g) || []).length + 1;
		const lastNewlineEnd = beforeEnd.lastIndexOf("\n");
		const endChar = lastNewlineEnd === -1 ? endOffset : endOffset - lastNewlineEnd - 1;

		return { startLine, startChar, endLine, endChar };
	}, [docContent]);

	const handleAction = useCallback((type: Annotation["type"]) => {
		if (type === "delete") {
			const pos = computePosition(selectedText, contextBefore);
			onAnnotate(selectedText, "delete", "", contextBefore, contextAfter, pos.startLine, pos.startChar, pos.endLine, pos.endChar);
			resetState();
			window.getSelection()?.removeAllRanges();
			return;
		}
		setInputMode(type);
		setInputValue("");
	}, [selectedText, contextBefore, contextAfter, onAnnotate, resetState, computePosition]);

	const handleSubmit = useCallback(() => {
		if (!inputMode || !inputValue.trim()) return;
		const pos = computePosition(selectedText, contextBefore);
		onAnnotate(selectedText, inputMode, inputValue.trim(), contextBefore, contextAfter, pos.startLine, pos.startChar, pos.endLine, pos.endChar);
		resetState();
		window.getSelection()?.removeAllRanges();
	}, [inputMode, inputValue, selectedText, contextBefore, contextAfter, onAnnotate, resetState, computePosition]);

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			setInputMode(null);
			setInputValue("");
			return;
		}
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			handleSubmit();
		}
	}, [handleSubmit]);

	if (!position) return null;

	return (
		<div
			ref={toolbarRef}
			className="absolute z-50 animate-in fade-in-0 zoom-in-95 duration-100"
			style={{
				top: position.top,
				left: position.left,
				transform: "translateX(-50%)",
			}}
		>
			{!inputMode ? (
				<ToolbarButtons onAction={handleAction} />
			) : (
				<div className="bg-popover border border-border rounded-lg shadow-lg p-3 w-72">
					<div className="flex items-center gap-2 mb-2">
						{inputMode === "comment" ? (
							<MessageSquare className="w-3.5 h-3.5 text-yellow-500" />
						) : (
							<Replace className="w-3.5 h-3.5 text-blue-500" />
						)}
						<span className="text-xs font-medium text-muted-foreground">
							{inputMode === "comment" ? "Comment" : "Replace with"}
						</span>
					</div>
					<textarea
						ref={textareaRef}
						value={inputValue}
						onChange={(e) => setInputValue(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={inputMode === "comment" ? "Add your comment..." : "Replacement text..."}
						className="w-full min-h-[60px] max-h-[120px] resize-y rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						rows={2}
					/>
					<div className="flex items-center justify-between mt-2">
						<span className="text-[10px] text-muted-foreground">⌘+Enter to save · Esc to cancel</span>
						<div className="flex gap-1">
							<button
								type="button"
								onClick={() => { setInputMode(null); setInputValue(""); }}
								className="p-1 rounded hover:bg-muted text-muted-foreground"
							>
								<X className="w-3.5 h-3.5" />
							</button>
							<button
								type="button"
								onClick={handleSubmit}
								disabled={!inputValue.trim()}
								className="p-1 rounded hover:bg-muted text-primary disabled:opacity-40"
							>
								<Check className="w-3.5 h-3.5" />
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function ToolbarButtons({ onAction }: { onAction: (type: Annotation["type"]) => void }) {
	return (
		<div className="flex items-center gap-0.5 bg-popover border border-border rounded-lg shadow-lg px-1 py-1">
			<ToolbarButton onClick={() => onAction("comment")} title="Comment">
				<MessageSquare className="w-4 h-4" />
			</ToolbarButton>
			<ToolbarButton onClick={() => onAction("replace")} title="Replace">
				<Replace className="w-4 h-4" />
			</ToolbarButton>
			<div className="w-px h-5 bg-border mx-0.5" />
			<ToolbarButton onClick={() => onAction("delete")} title="Delete" variant="destructive">
				<Trash2 className="w-4 h-4" />
			</ToolbarButton>
		</div>
	);
}

function ToolbarButton({
	children,
	onClick,
	title,
	variant,
}: {
	children: ReactNode;
	onClick: () => void;
	title: string;
	variant?: "destructive";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			className={cn(
				"p-1.5 rounded-md transition-colors",
				variant === "destructive"
					? "text-muted-foreground hover:text-red-500 hover:bg-red-500/10"
					: "text-muted-foreground hover:text-foreground hover:bg-muted",
			)}
		>
			{children}
		</button>
	);
}
