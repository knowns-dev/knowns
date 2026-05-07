import { useState, useCallback, useEffect } from "react";
import type { Annotation } from "../types/annotation";

const STORAGE_KEY = "knowns-annotations-v1";
const MAX_ANNOTATIONS = 500;

/** Generate a short random id. */
function nanoid(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function loadAnnotations(): Annotation[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) return JSON.parse(raw) as Annotation[];
	} catch {
		// ignore
	}
	return [];
}

function saveAnnotations(annotations: Annotation[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(annotations));
	} catch {
		// ignore
	}
}

/**
 * Core annotation CRUD hook backed by LocalStorage.
 * Max 500 annotations — oldest auto-pruned when exceeded.
 * Syncs across tabs via storage event.
 */
export function useAnnotations() {
	const [annotations, setAnnotations] = useState<Annotation[]>(loadAnnotations);

	// Cross-tab sync: listen for storage changes from other tabs
	useEffect(() => {
		const handleStorage = (e: StorageEvent) => {
			if (e.key === STORAGE_KEY) {
				setAnnotations(loadAnnotations());
			}
		};
		window.addEventListener("storage", handleStorage);
		return () => window.removeEventListener("storage", handleStorage);
	}, []);

	const persist = useCallback((next: Annotation[]) => {
		// Enforce cap — prune oldest first
		const capped = next.length > MAX_ANNOTATIONS
			? next.slice(next.length - MAX_ANNOTATIONS)
			: next;
		saveAnnotations(capped);
		setAnnotations(capped);
	}, []);

	const add = useCallback(
		(
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
		): Annotation => {
			const annotation: Annotation = {
				id: nanoid(),
				docPath,
				selectedText,
				type,
				content,
				createdAt: Date.now(),
				contextBefore,
				contextAfter,
				startLine,
				startChar,
				endLine,
				endChar,
			};
			setAnnotations((prev) => {
				const next = [...prev, annotation];
				persist(next);
				return next.length > MAX_ANNOTATIONS ? next.slice(next.length - MAX_ANNOTATIONS) : next;
			});
			return annotation;
		},
		[persist],
	);

	const update = useCallback(
		(id: string, changes: Partial<Pick<Annotation, "content" | "type">>) => {
			setAnnotations((prev) => {
				const next = prev.map((a) => (a.id === id ? { ...a, ...changes } : a));
				persist(next);
				return next;
			});
		},
		[persist],
	);

	const remove = useCallback(
		(id: string) => {
			setAnnotations((prev) => {
				const next = prev.filter((a) => a.id !== id);
				persist(next);
				return next;
			});
		},
		[persist],
	);

	const clearAll = useCallback(() => {
		persist([]);
	}, [persist]);

	const getByDoc = useCallback(
		(docPath: string): Annotation[] => {
			return annotations.filter((a) => a.docPath === docPath);
		},
		[annotations],
	);

	const docPaths = useCallback((): string[] => {
		return [...new Set(annotations.map((a) => a.docPath))];
	}, [annotations]);

	return { annotations, add, update, remove, clearAll, getByDoc, docPaths };
}
