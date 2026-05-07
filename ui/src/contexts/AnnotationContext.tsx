import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { useAnnotations } from "../hooks/useAnnotations";
import type { Annotation } from "../types/annotation";
import { serializeAnnotations } from "../utils/annotationSerializer";

const BUBBLE_POS_KEY = "knowns-annotation-bubble-pos";

interface BubblePosition {
	x: number;
	y: number;
}

interface AnnotationContextType {
	// Data
	annotations: Annotation[];
	add: (
		docPath: string,
		selectedText: string,
		type: Annotation["type"],
		content: string,
		contextBefore: string,
		contextAfter: string,
		startLine: number,
		startChar: number,
		endLine: number,
		endChar: number,
	) => Annotation;
	update: (id: string, changes: Partial<Pick<Annotation, "content" | "type">>) => void;
	remove: (id: string) => void;
	clearAll: () => void;
	getByDoc: (docPath: string) => Annotation[];
	docPaths: () => string[];

	// Mode
	annotationMode: boolean;
	toggleAnnotationMode: () => void;

	// Bubble panel
	panelOpen: boolean;
	setPanelOpen: (open: boolean) => void;

	// Bubble position (draggable)
	bubblePosition: BubblePosition;
	setBubblePosition: (pos: BubblePosition) => void;

	// Serialization
	copyAllToClipboard: () => Promise<boolean>;
}

const AnnotationContext = createContext<AnnotationContextType | undefined>(undefined);

function loadBubblePosition(): BubblePosition {
	try {
		const raw = localStorage.getItem(BUBBLE_POS_KEY);
		if (raw) return JSON.parse(raw) as BubblePosition;
	} catch {
		// ignore
	}
	// Default: bottom-right (will be resolved relative to container)
	return { x: -1, y: -1 };
}

function saveBubblePosition(pos: BubblePosition): void {
	try {
		localStorage.setItem(BUBBLE_POS_KEY, JSON.stringify(pos));
	} catch {
		// ignore
	}
}

export function AnnotationProvider({ children }: { children: ReactNode }) {
	const store = useAnnotations();
	const [annotationMode, setAnnotationMode] = useState(false);
	const [panelOpen, setPanelOpen] = useState(false);
	const [bubblePosition, setBubblePositionState] = useState<BubblePosition>(loadBubblePosition);

	const toggleAnnotationMode = useCallback(() => {
		setAnnotationMode((prev) => !prev);
	}, []);

	const setBubblePosition = useCallback((pos: BubblePosition) => {
		setBubblePositionState(pos);
		saveBubblePosition(pos);
	}, []);

	const copyAllToClipboard = useCallback(async (): Promise<boolean> => {
		const md = serializeAnnotations(store.annotations);
		if (!md) return false;
		try {
			await navigator.clipboard.writeText(md);
			return true;
		} catch {
			return false;
		}
	}, [store.annotations]);

	return (
		<AnnotationContext.Provider
			value={{
				...store,
				annotationMode,
				toggleAnnotationMode,
				panelOpen,
				setPanelOpen,
				bubblePosition,
				setBubblePosition,
				copyAllToClipboard,
			}}
		>
			{children}
		</AnnotationContext.Provider>
	);
}

export function useAnnotationContext() {
	const ctx = useContext(AnnotationContext);
	if (!ctx) throw new Error("useAnnotationContext must be used within AnnotationProvider");
	return ctx;
}
