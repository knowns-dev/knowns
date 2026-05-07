import { useEffect, useRef, useState, useCallback } from "react";
import { Pencil, Trash2, AlertTriangle } from "lucide-react";
import { cn } from "../../lib/utils";
import type { Annotation } from "../../types/annotation";
import { ANNOTATION_TYPE_META } from "../../types/annotation";
import { isAnnotationOrphaned } from "../../utils/annotationSerializer";

interface AnnotationHighlighterProps {
	/** The container element whose text nodes will be highlighted. */
	containerRef: React.RefObject<HTMLElement | null>;
	/** Annotations for the current doc. */
	annotations: Annotation[];
	/** Raw doc content for orphan detection. */
	docContent: string;
	/** Whether annotation mode is active (show highlights). */
	active: boolean;
	/** Called when user edits an annotation inline. */
	onEdit: (annotation: Annotation, changes: Partial<Pick<Annotation, "content" | "type">>) => void;
	/** Called when user wants to remove an annotation. */
	onRemove: (id: string) => void;
}

interface HighlightInfo {
	annotation: Annotation;
	index: number; // 1-based global index for numbered marker
	orphaned: boolean;
	confidence: "high" | "low"; // match confidence
}

/**
 * Applies colored highlight overlays on rendered doc text for existing annotations.
 * Uses DOM TreeWalker to find text nodes matching annotation selectedText.
 */
export function AnnotationHighlighter({
	containerRef,
	annotations,
	docContent,
	active,
	onEdit,
	onRemove,
}: AnnotationHighlighterProps) {
	const [activePopover, setActivePopover] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	const markerRefs = useRef<Map<string, HTMLElement>>(new Map());
	const popoverRef = useRef<HTMLDivElement>(null);
	const editTextareaRef = useRef<HTMLTextAreaElement>(null);

	// Focus edit textarea when entering edit mode
	useEffect(() => {
		if (editingId && editTextareaRef.current) {
			editTextareaRef.current.focus();
			editTextareaRef.current.select();
		}
	}, [editingId]);

	// Close popover on outside click
	useEffect(() => {
		if (!activePopover) return;
		const handleClick = (e: MouseEvent) => {
			if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
				setActivePopover(null);
				setEditingId(null);
			}
		};
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [activePopover]);

	// Apply highlights to DOM and attach click listeners
	useEffect(() => {
		const container = containerRef.current;
		if (!container || annotations.length === 0) {
			cleanupMarks(container);
			markerRefs.current.clear();
			return;
		}

		// Clean previous marks first
		cleanupMarks(container);
		markerRefs.current.clear();

		// Build highlight info with confidence scoring
		const highlights: HighlightInfo[] = annotations.map((a, i) => {
			const orphaned = isAnnotationOrphaned(a, docContent);
			// Confidence: high if context matches well or text is unique in doc
			let confidence: "high" | "low" = "high";
			if (!orphaned) {
				const fullText = containerRef.current?.textContent || "";
				const occurrences = fullText.split(a.selectedText).length - 1;
				const hasGoodContext = a.contextBefore.length >= 10 || a.contextAfter.length >= 10;
				if (occurrences > 1 && !hasGoodContext) {
					confidence = "low";
				}
			}
			return { annotation: a, index: i + 1, orphaned, confidence };
		});

		// Apply marks via DOM manipulation
		for (const h of highlights) {
			if (h.orphaned) continue;
			applyMark(container, h);
		}

		// Attach click listeners to all marks and store refs
		const marks = container.querySelectorAll<HTMLElement>(`mark[${MARK_ATTR}]`);
		const clickHandlers: Array<{ el: HTMLElement; handler: (e: MouseEvent) => void }> = [];

		marks.forEach((mark) => {
			const annId = mark.getAttribute(MARK_ATTR);
			if (annId) {
				markerRefs.current.set(annId, mark);
				const handler = (e: MouseEvent) => {
					e.stopPropagation();
					setActivePopover((prev) => (prev === annId ? null : annId));
				};
				mark.addEventListener("click", handler);
				clickHandlers.push({ el: mark, handler });
			}
		});

		return () => {
			clickHandlers.forEach(({ el, handler }) => el.removeEventListener("click", handler));
		};
	}, [containerRef, annotations, docContent]);

	if (annotations.length === 0) return null;

	// Render orphaned annotations as floating warnings
	const orphaned = annotations
		.map((a, i) => ({ annotation: a, index: i + 1, orphaned: isAnnotationOrphaned(a, docContent) }))
		.filter((h) => h.orphaned);

	return (
		<>
			{/* Popover for clicked annotation */}
			{activePopover && (() => {
				const ann = annotations.find((a) => a.id === activePopover);
				if (!ann) return null;
				const markerEl = markerRefs.current.get(activePopover);
				if (!markerEl) return null;
				const rect = markerEl.getBoundingClientRect();
				const containerRect = containerRef.current?.getBoundingClientRect();
				if (!containerRect) return null;

				const isEditing = editingId === ann.id;

				return (
					<div
						ref={popoverRef}
						className="absolute z-50 bg-popover border border-border rounded-lg shadow-lg p-3 w-72 animate-in fade-in-0 zoom-in-95"
						style={{
							top: rect.bottom - containerRect.top + (containerRef.current?.scrollTop ?? 0) + 4,
							left: rect.left - containerRect.left + rect.width / 2,
							transform: "translateX(-50%)",
						}}
					>
						<div className="flex items-center gap-2 mb-2">
							<span>{ANNOTATION_TYPE_META[ann.type].icon}</span>
							<span className="text-xs font-medium text-muted-foreground">{ANNOTATION_TYPE_META[ann.type].label}</span>
						</div>
						<p className="text-xs text-muted-foreground mb-1 italic">"{ann.selectedText.slice(0, 60)}{ann.selectedText.length > 60 ? "…" : ""}"</p>

						{isEditing ? (
							<div className="mt-2">
								<textarea
									ref={editTextareaRef}
									value={editValue}
									onChange={(e) => setEditValue(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Escape") {
											setEditingId(null);
										} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
											e.preventDefault();
											onEdit(ann, { content: editValue.trim() });
											setEditingId(null);
											setActivePopover(null);
										}
									}}
									placeholder={ann.type === "comment" ? "Comment..." : "Replacement text..."}
									className="w-full min-h-[50px] max-h-[100px] resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									rows={2}
								/>
								<div className="flex items-center justify-between mt-1.5">
									<span className="text-[10px] text-muted-foreground">⌘+Enter save · Esc cancel</span>
									<div className="flex gap-1">
										<button
											type="button"
											onClick={() => setEditingId(null)}
											className="text-xs px-2 py-0.5 rounded hover:bg-muted text-muted-foreground"
										>
											Cancel
										</button>
										<button
											type="button"
											onClick={() => {
												onEdit(ann, { content: editValue.trim() });
												setEditingId(null);
												setActivePopover(null);
											}}
											className="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
										>
											Save
										</button>
									</div>
								</div>
							</div>
						) : (
							<>
								{ann.content && (
									<p className="text-sm mt-1">
										{ann.type === "replace" ? `→ "${ann.content}"` : ann.content}
									</p>
								)}
								<div className="flex gap-1 mt-2 pt-2 border-t border-border">
									<button
										type="button"
										onClick={() => {
											setEditingId(ann.id);
											setEditValue(ann.content);
										}}
										className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted text-muted-foreground hover:text-foreground"
									>
										<Pencil className="w-3 h-3" /> Edit
									</button>
									<button
										type="button"
										onClick={() => { setActivePopover(null); onRemove(ann.id); }}
										className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-500"
									>
										<Trash2 className="w-3 h-3" /> Remove
									</button>
								</div>
							</>
						)}
					</div>
				);
			})()}

			{/* Orphaned annotation warnings */}
			{orphaned.length > 0 && (
				<div className="mt-4 space-y-2">
					{orphaned.map((h) => (
						<div
							key={h.annotation.id}
							className="flex items-start gap-2 p-2 rounded-md bg-yellow-500/10 border border-yellow-500/20 text-xs"
						>
							<AlertTriangle className="w-3.5 h-3.5 text-yellow-500 mt-0.5 shrink-0" />
							<div className="min-w-0">
								<span className="font-medium text-yellow-600 dark:text-yellow-400">Orphaned annotation #{h.index}</span>
								<p className="text-muted-foreground mt-0.5 truncate">
									{ANNOTATION_TYPE_META[h.annotation.type].icon} "{h.annotation.selectedText.slice(0, 50)}…"
								</p>
								<div className="flex gap-1 mt-1">
									<button
										type="button"
										onClick={() => onRemove(h.annotation.id)}
										className="text-[10px] text-red-500 hover:underline"
									>
										Remove
									</button>
								</div>
							</div>
						</div>
					))}
				</div>
			)}
		</>
	);
}

// --- DOM helpers ---

const MARK_ATTR = "data-knowns-annotation";

function cleanupMarks(container: HTMLElement | null) {
	if (!container) return;
	const marks = container.querySelectorAll(`mark[${MARK_ATTR}]`);
	marks.forEach((mark) => {
		const parent = mark.parentNode;
		if (parent) {
			while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
			parent.removeChild(mark);
			parent.normalize();
		}
	});
}

function applyMark(container: HTMLElement, info: HighlightInfo) {
	const { annotation, index, confidence } = info;
	const textToFind = annotation.selectedText;

	// Walk text nodes to build full text content
	const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
	let accumulated = "";
	const textNodes: { node: Text; start: number }[] = [];

	let node: Text | null;
	while ((node = walker.nextNode() as Text | null)) {
		textNodes.push({ node, start: accumulated.length });
		accumulated += node.textContent || "";
	}

	// Find the correct occurrence using context for disambiguation
	let matchIdx = -1;
	const ctxBefore = annotation.contextBefore;
	const ctxAfter = annotation.contextAfter;

	if (ctxBefore || ctxAfter) {
		// Build a needle with surrounding context for precise matching
		const needle = ctxBefore.slice(-20) + textToFind + ctxAfter.slice(0, 20);
		const needleIdx = accumulated.indexOf(needle);
		if (needleIdx !== -1) {
			matchIdx = needleIdx + ctxBefore.slice(-20).length;
		}
	}

	// Fallback: try all occurrences and pick the one with best context match
	if (matchIdx === -1) {
		let searchFrom = 0;
		let bestIdx = -1;
		let bestScore = -1;

		while (true) {
			const idx = accumulated.indexOf(textToFind, searchFrom);
			if (idx === -1) break;

			let score = 0;
			// Score based on how much context matches
			if (ctxBefore) {
				const actualBefore = accumulated.slice(Math.max(0, idx - ctxBefore.length), idx);
				for (let i = 0; i < Math.min(actualBefore.length, ctxBefore.length); i++) {
					if (actualBefore[actualBefore.length - 1 - i] === ctxBefore[ctxBefore.length - 1 - i]) score++;
					else break;
				}
			}
			if (ctxAfter) {
				const end = idx + textToFind.length;
				const actualAfter = accumulated.slice(end, end + ctxAfter.length);
				for (let i = 0; i < Math.min(actualAfter.length, ctxAfter.length); i++) {
					if (actualAfter[i] === ctxAfter[i]) score++;
					else break;
				}
			}

			if (score > bestScore) {
				bestScore = score;
				bestIdx = idx;
			}
			searchFrom = idx + 1;
		}

		matchIdx = bestIdx;
	}

	// Final fallback: first occurrence
	if (matchIdx === -1) {
		matchIdx = accumulated.indexOf(textToFind);
	}

	if (matchIdx === -1) return;

	// Find which text nodes span this range
	const matchEnd = matchIdx + textToFind.length;

	for (const tn of textNodes) {
		const nodeText = tn.node.textContent || "";
		const nodeStart = tn.start;
		const nodeEnd = nodeStart + nodeText.length;

		// Check overlap
		if (nodeEnd <= matchIdx || nodeStart >= matchEnd) continue;

		const overlapStart = Math.max(matchIdx, nodeStart) - nodeStart;
		const overlapEnd = Math.min(matchEnd, nodeEnd) - nodeStart;

		if (overlapStart === 0 && overlapEnd === nodeText.length) {
			// Entire node is within match — wrap it
			wrapTextNode(tn.node, annotation, index, confidence);
		} else {
			// Partial — split and wrap
			const before = nodeText.slice(0, overlapStart);
			const matched = nodeText.slice(overlapStart, overlapEnd);
			const after = nodeText.slice(overlapEnd);

			const parent = tn.node.parentNode;
			if (!parent) continue;

			if (before) parent.insertBefore(document.createTextNode(before), tn.node);

			const mark = createMark(annotation, index, confidence);
			mark.textContent = matched;
			parent.insertBefore(mark, tn.node);

			if (after) parent.insertBefore(document.createTextNode(after), tn.node);

			parent.removeChild(tn.node);
		}

		// Only mark the first occurrence
		break;
	}
}

function wrapTextNode(textNode: Text, annotation: Annotation, index: number, confidence: "high" | "low") {
	const mark = createMark(annotation, index, confidence);
	const parent = textNode.parentNode;
	if (!parent) return;
	parent.insertBefore(mark, textNode);
	mark.appendChild(textNode);
}

function createMark(annotation: Annotation, index: number, confidence: "high" | "low" = "high"): HTMLElement {
	const mark = document.createElement("mark");
	mark.setAttribute(MARK_ATTR, annotation.id);
	mark.setAttribute("data-annotation-type", annotation.type);

	const meta = ANNOTATION_TYPE_META[annotation.type];

	// Base styles — dashed border for low confidence
	mark.className = cn(
		"relative cursor-pointer rounded-sm px-0.5 -mx-0.5 transition-colors",
		meta.bgClass,
		annotation.type === "delete" && "line-through decoration-red-500/60",
		confidence === "low" && "border border-dashed border-yellow-500/50",
	);

	// Numbered marker badge
	const badge = document.createElement("span");
	badge.className =
		"absolute -top-3 -right-1 inline-flex items-center justify-center w-4 h-4 text-[9px] font-bold rounded-full bg-primary text-primary-foreground shadow-sm pointer-events-none";
	badge.textContent = String(index);
	mark.appendChild(badge);

	// Low confidence indicator
	if (confidence === "low") {
		mark.title = "Match may be imprecise — text appears multiple times in this document";
	}

	return mark;
}
