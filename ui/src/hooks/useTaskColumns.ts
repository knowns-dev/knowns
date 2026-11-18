import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@/ui/models/task";
import { api, type TaskFilters } from "../api/client";
import { useSSEEvent } from "../contexts/SSEContext";
import { appendPage, applyUpdate, type FeedSort } from "../lib/taskFeed";

export type ColumnStatus = "loading" | "ready" | "loadingMore" | "error";

export interface ColumnState {
	items: Task[];
	/** Server count under the column's filters, from the page responses (kept current by counts()). */
	total: number;
	hasMore: boolean;
	status: ColumnStatus;
	error: string | null;
}

interface Internal extends ColumnState {
	cursor?: string;
	exhausted: boolean;
}

const EMPTY: Internal = { items: [], total: 0, hasMore: true, status: "loading", error: null, exhausted: false };

interface Options {
	/** One list per key: a Kanban status, a status group of the list view, or "" for a single flat list. */
	keys: readonly string[];
	/** The filters of one list; its identity (by value) restarts that list. */
	filtersFor: (key: string) => TaskFilters;
	sort?: FeedSort | string;
	pageSize?: number;
	enabled?: boolean;
}

export interface TaskColumns {
	column: (key: string) => ColumnState;
	loadMore: (key: string) => void;
	retry: (key: string) => void;
	/** Refetches every list's first page and folds it in (a bulk change happened on the server). */
	refresh: () => void;
	/** Folds a changed task in: replaced in place, moved between lists, inserted or dropped. */
	patch: (task: Task) => void;
	/** Local reorder inside or between lists (a drag): the task takes `index` of `to`'s loaded items. */
	place: (task: Task, to: string, index: number) => void;
	remove: (id: string) => void;
	/** Every loaded task across the lists, for lookups (the open card, people on the board). */
	all: Task[];
}

/**
 * Server-paged task lists, one per key. Each loads its first page when the filters change and further
 * pages through loadMore (keyset cursor), with at most one request in flight per list, nothing after
 * the cursor is exhausted, ids deduplicated across pages, and live SSE updates folded in without
 * resetting what was scrolled.
 */
export function useTaskColumns({ keys, filtersFor, sort = "updated-desc", pageSize = 50, enabled = true }: Options): TaskColumns {
	const filtersJson = useMemo(() => JSON.stringify(keys.map((k) => [k, filtersFor(k)])), [keys, filtersFor]);
	const restartKey = `${filtersJson}|${sort}|${pageSize}|${enabled}`;
	const filtersForRef = useRef(filtersFor);
	filtersForRef.current = filtersFor;
	const sortRef = useRef(sort);
	sortRef.current = sort;

	const [state, setState] = useState<Record<string, Internal>>({});
	const stateRef = useRef(state);
	stateRef.current = state;
	const generation = useRef(0);
	const inFlight = useRef(new Set<string>());
	const controllers = useRef(new Set<AbortController>());

	const setCol = useCallback((key: string, fn: (c: Internal) => Internal) => {
		setState((prev) => ({ ...prev, [key]: fn(prev[key] ?? EMPTY) }));
	}, []);

	const fetchPage = useCallback(
		async (key: string, mode: "first" | "next" | "head") => {
			if (mode !== "head" && inFlight.current.has(key)) return;
			const gen = generation.current;
			const ctl = new AbortController();
			controllers.current.add(ctl);
			if (mode !== "head") {
				inFlight.current.add(key);
				setCol(key, (c) => ({ ...c, error: null, status: mode === "first" ? "loading" : "loadingMore" }));
			}
			try {
				const cursor = mode === "next" ? stateRef.current[key]?.cursor : undefined;
				const page = await api.getTasksPage({
					...filtersForRef.current(key),
					sort: sortRef.current as FeedSort,
					limit: pageSize,
					...(cursor ? { cursor } : {}),
					signal: ctl.signal,
				});
				if (gen !== generation.current) return;
				setCol(key, (c) => {
					if (mode === "first") return { ...c, items: appendPage([], page.tasks), total: page.total, cursor: page.nextCursor, exhausted: !page.nextCursor, hasMore: !!page.nextCursor, status: "ready", error: null };
					if (mode === "next") return { ...c, items: appendPage(c.items, page.tasks), total: page.total, cursor: page.nextCursor, exhausted: !page.nextCursor, hasMore: !!page.nextCursor, status: "ready", error: null };
					// head: the freshest page leads, what was scrolled past it follows (deduplicated), cursor kept
					return { ...c, items: appendPage(page.tasks, c.items), total: page.total };
				});
			} catch (e) {
				if (e instanceof DOMException && e.name === "AbortError") return;
				if (gen !== generation.current || mode === "head") return;
				setCol(key, (c) => ({ ...c, status: "error", error: e instanceof Error ? e.message : "Tasks could not be loaded." }));
			} finally {
				controllers.current.delete(ctl);
				if (mode !== "head" && gen === generation.current) inFlight.current.delete(key);
			}
		},
		[pageSize, setCol],
	);

	// New filters, sort or page size: every list starts over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: restartKey stands for keys, filters, sort, size and enabled
	useEffect(() => {
		generation.current += 1;
		for (const c of controllers.current) c.abort();
		controllers.current.clear();
		inFlight.current.clear();
		setState(Object.fromEntries(keys.map((k) => [k, { ...EMPTY, status: enabled ? "loading" : "ready", hasMore: enabled }])));
		if (!enabled) return;
		for (const k of keys) void fetchPage(k, "first");
		return () => {
			for (const c of controllers.current) c.abort();
		};
	}, [restartKey, fetchPage]);

	const loadMore = useCallback(
		(key: string) => {
			const c = stateRef.current[key];
			if (!enabled || !c || c.exhausted || c.status === "error" || inFlight.current.has(key)) return;
			void fetchPage(key, "next");
		},
		[enabled, fetchPage],
	);
	const retry = useCallback(
		(key: string) => {
			const c = stateRef.current[key];
			void fetchPage(key, c && c.items.length > 0 && c.cursor ? "next" : "first");
		},
		[fetchPage],
	);
	const refresh = useCallback(() => {
		if (!enabled) return;
		for (const k of keys) void fetchPage(k, "head");
	}, [enabled, keys, fetchPage]);

	const patch = useCallback(
		(task: Task) => {
			setState((prev) => {
				const next: Record<string, Internal> = {};
				for (const k of keys) {
					const c = prev[k] ?? EMPTY;
					const items = applyUpdate(c.items, task, filtersForRef.current(k), sortRef.current as FeedSort, c.exhausted);
					next[k] = items === c.items ? c : { ...c, items, total: c.total + (items.length - c.items.length) };
				}
				return next;
			});
		},
		[keys],
	);

	const place = useCallback(
		(task: Task, to: string, index: number) => {
			setState((prev) => {
				const next: Record<string, Internal> = {};
				for (const k of keys) {
					const c = prev[k] ?? EMPTY;
					const without = c.items.filter((t) => t.id !== task.id);
					if (k !== to) {
						next[k] = without.length === c.items.length ? c : { ...c, items: without, total: Math.max(0, c.total - 1) };
						continue;
					}
					const at = Math.max(0, Math.min(index, without.length));
					const items = [...without.slice(0, at), task, ...without.slice(at)];
					next[k] = { ...c, items, total: c.items.length === without.length ? c.total + 1 : c.total };
				}
				return next;
			});
		},
		[keys],
	);

	const remove = useCallback((id: string) => {
		setState((prev) => {
			const next: Record<string, Internal> = {};
			for (const [k, c] of Object.entries(prev)) {
				const items = c.items.filter((t) => t.id !== id);
				next[k] = items.length === c.items.length ? c : { ...c, items, total: Math.max(0, c.total - 1) };
			}
			return next;
		});
	}, []);

	useSSEEvent("tasks:updated", ({ task }) => patch(task), [patch]);
	useSSEEvent("tasks:refresh", refresh, [refresh]);
	useSSEEvent("tasks:archived", refresh, [refresh]);
	useSSEEvent("tasks:unarchived", refresh, [refresh]);
	useSSEEvent("tasks:batch-archived", refresh, [refresh]);

	const column = useCallback(
		(key: string): ColumnState => {
			const c = state[key] ?? EMPTY;
			return { items: c.items, total: c.total, hasMore: enabled && !c.exhausted, status: c.status, error: c.error };
		},
		[state, enabled],
	);
	const all = useMemo(() => Object.values(state).flatMap((c) => c.items), [state]);

	return { column, loadMore, retry, refresh, patch, place, remove, all };
}
