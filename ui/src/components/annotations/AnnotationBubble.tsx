import { useRef, useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { Highlighter, Copy, Trash2, X, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import { useAnnotationContext } from "../../contexts/AnnotationContext";
import { ANNOTATION_TYPE_META } from "../../types/annotation";
import type { Annotation } from "../../types/annotation";

interface AnnotationBubbleProps {
	/** Constrain bubble drag within this element. */
	containerRef: React.RefObject<HTMLElement | null>;
	/** Navigate to a doc path. */
	onNavigateToDoc?: (docPath: string) => void;
}

/**
 * Agentation-style draggable bubble with expandable annotation panel.
 * Fixed position within the doc viewer, defaults to bottom-right.
 */
export function AnnotationBubble({ containerRef, onNavigateToDoc }: AnnotationBubbleProps) {
	const {
		annotations,
		panelOpen,
		setPanelOpen,
		bubblePosition,
		setBubblePosition,
		copyAllToClipboard,
		clearAll,
		remove,
		docPaths,
		getByDoc,
	} = useAnnotationContext();

	const bubbleRef = useRef<HTMLDivElement>(null);
	const [showClearConfirm, setShowClearConfirm] = useState(false);
	const [copied, setCopied] = useState(false);
	const dragState = useRef<{ dragging: boolean; didDrag: boolean; startX: number; startY: number; offsetX: number; offsetY: number }>({
		dragging: false, didDrag: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0,
	});

	const count = annotations.length;

	// Resolve position — default to bottom-right of container
	const pos = (() => {
		if (bubblePosition.x >= 0 && bubblePosition.y >= 0) return bubblePosition;
		return { x: -1, y: -1 }; // sentinel: use CSS right/bottom instead
	})();
	const useDefaultPos = pos.x < 0 || pos.y < 0;

	// --- Drag handling via document mouse events ---
	const handleMouseDown = useCallback((e: React.MouseEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const bubble = bubbleRef.current;
		if (!bubble) return;

		const rect = bubble.getBoundingClientRect();

		// If using default position (right/bottom), convert to left/top first
		if (bubblePosition.x < 0 || bubblePosition.y < 0) {
			setBubblePosition({ x: rect.left, y: rect.top });
		}

		dragState.current = {
			dragging: true,
			didDrag: false,
			startX: e.clientX,
			startY: e.clientY,
			offsetX: e.clientX - rect.left,
			offsetY: e.clientY - rect.top,
		};

		const handleMouseMove = (ev: MouseEvent) => {
			const ds = dragState.current;
			if (!ds.dragging) return;

			const dx = ev.clientX - ds.startX;
			const dy = ev.clientY - ds.startY;
			if (!ds.didDrag && Math.sqrt(dx * dx + dy * dy) < 5) return;
			ds.didDrag = true;

			// Fixed positioning — use viewport coordinates directly
			const x = ev.clientX - ds.offsetX;
			const y = ev.clientY - ds.offsetY;

			const clampedX = Math.max(0, Math.min(x, window.innerWidth - 48));
			const clampedY = Math.max(0, Math.min(y, window.innerHeight - 48));

			setBubblePosition({ x: clampedX, y: clampedY });
		};

		const handleMouseUp = () => {
			const wasDrag = dragState.current.didDrag;
			dragState.current.dragging = false;
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);

			if (!wasDrag) {
				setPanelOpen(!panelOpen);
			}
		};

		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
	}, [containerRef, setBubblePosition, panelOpen, setPanelOpen]);

	// Copy all
	const handleCopy = useCallback(async () => {
		const ok = await copyAllToClipboard();
		if (ok) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	}, [copyAllToClipboard]);

	// Clear all
	const handleClear = useCallback(() => {
		clearAll();
		setShowClearConfirm(false);
		setPanelOpen(false);
	}, [clearAll, setPanelOpen]);

	// Hide bubble entirely when no annotations and panel is closed
	if (count === 0 && !panelOpen) return null;

	// Always show bubble on docs page — render via portal to avoid transform context issues
	return createPortal(
		<div
			ref={bubbleRef}
			className="fixed z-[9999]"
			style={useDefaultPos
				? { right: 24, bottom: 24 }
				: { left: pos.x, top: pos.y }
			}
		>
			{/* Bubble button */}
			<button
				type="button"
				onMouseDown={handleMouseDown}
				className={cn(
					"relative w-11 h-11 rounded-full flex items-center justify-center shadow-lg transition-all select-none",
					"bg-popover border border-border hover:shadow-xl cursor-grab",
				)}
			>
				<Highlighter className="w-5 h-5 text-muted-foreground" />

				{/* Count badge */}
				{count > 0 && (
					<span className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold rounded-full bg-primary text-primary-foreground shadow">
						{count > 99 ? "99+" : count}
					</span>
				)}
			</button>

			{/* Expanded panel */}
			{panelOpen && (
				<div className="absolute bottom-14 right-0 w-80 max-h-96 bg-popover border border-border rounded-xl shadow-2xl animate-in fade-in-0 slide-in-from-bottom-2 duration-150 overflow-hidden">
					{/* Header */}
					<div className="flex items-center justify-between px-3 py-2 border-b border-border">
						<span className="text-sm font-medium">
							Annotations
							{count > 0 && <span className="text-muted-foreground ml-1">({count})</span>}
						</span>
						<div className="flex items-center gap-1">
							{count > 0 && (
								<>
									<button
										type="button"
										onClick={handleCopy}
										className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
										title="Copy all annotations"
									>
										<Copy className={cn("w-3.5 h-3.5", copied && "text-green-500")} />
									</button>
									<button
										type="button"
										onClick={() => setShowClearConfirm(true)}
										className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-500"
										title="Clear all annotations"
									>
										<Trash2 className="w-3.5 h-3.5" />
									</button>
								</>
							)}
							<button
								type="button"
								onClick={() => setPanelOpen(false)}
								className="p-1 rounded hover:bg-muted text-muted-foreground"
							>
								<X className="w-3.5 h-3.5" />
							</button>
						</div>
					</div>

					{/* Clear confirmation */}
					{showClearConfirm && (
						<div className="px-3 py-2 bg-red-500/5 border-b border-red-500/20 flex items-center justify-between">
							<span className="text-xs text-red-600 dark:text-red-400">Clear all {count} annotations?</span>
							<div className="flex gap-1">
								<button type="button" onClick={() => setShowClearConfirm(false)} className="text-xs px-2 py-0.5 rounded hover:bg-muted">Cancel</button>
								<button type="button" onClick={handleClear} className="text-xs px-2 py-0.5 rounded bg-red-500 text-white hover:bg-red-600">Clear</button>
							</div>
						</div>
					)}

					{/* Annotation list */}
					<div className="overflow-y-auto max-h-72 divide-y divide-border/50">
						{count === 0 ? (
							<div className="px-3 py-6 text-center text-sm text-muted-foreground">
								<Highlighter className="w-8 h-8 mx-auto mb-2 opacity-30" />
								<p>No annotations yet</p>
								<p className="text-xs mt-1">Select text in a doc to annotate</p>
							</div>
						) : (
							docPaths().map((docPath) => (
								<div key={docPath}>
									{/* Doc group header */}
									<button
										type="button"
										onClick={() => onNavigateToDoc?.(docPath)}
										className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
									>
										<ChevronRight className="w-3 h-3" />
										<span className="truncate">@doc/{docPath}</span>
										<span className="ml-auto text-[10px] opacity-60">{getByDoc(docPath).length}</span>
									</button>

									{/* Annotations in this doc */}
									{getByDoc(docPath).map((ann, i) => (
										<AnnotationPanelItem
											key={ann.id}
											annotation={ann}
											index={annotations.indexOf(ann) + 1}
											onRemove={remove}
											onNavigate={() => onNavigateToDoc?.(docPath)}
										/>
									))}
								</div>
							))
						)}
					</div>

					{/* Footer with copy hint */}
					{count > 0 && (
						<div className="px-3 py-1.5 border-t border-border bg-muted/30">
							<p className="text-[10px] text-muted-foreground text-center">
								{copied ? "✓ Copied to clipboard!" : "Copy all → paste into your agent"}
							</p>
						</div>
					)}
				</div>
			)}
		</div>,
		document.body,
	);
}

function AnnotationPanelItem({
	annotation,
	index,
	onRemove,
	onNavigate,
}: {
	annotation: Annotation;
	index: number;
	onRemove: (id: string) => void;
	onNavigate: () => void;
}) {
	const meta = ANNOTATION_TYPE_META[annotation.type];

	return (
		<div className="group flex items-start gap-2 px-3 py-2 hover:bg-muted/30 transition-colors">
			{/* Number */}
			<span className="shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center mt-0.5">
				{index}
			</span>

			{/* Content */}
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1">
					<span className="text-xs">{meta.icon}</span>
					<span className={cn("text-[10px] font-medium", meta.color)}>{meta.label}</span>
				</div>
				<p className="text-xs text-muted-foreground truncate mt-0.5">
					"{annotation.selectedText.slice(0, 40)}{annotation.selectedText.length > 40 ? "…" : ""}"
				</p>
				{annotation.content && (
					<p className="text-xs mt-0.5 truncate">
						{annotation.type === "replace" ? `→ "${annotation.content.slice(0, 30)}…"` : annotation.content.slice(0, 40)}
					</p>
				)}
			</div>

			{/* Remove */}
			<button
				type="button"
				onClick={(e) => { e.stopPropagation(); onRemove(annotation.id); }}
				className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-opacity"
				title="Remove annotation"
			>
				<X className="w-3 h-3" />
			</button>
		</div>
	);
}
