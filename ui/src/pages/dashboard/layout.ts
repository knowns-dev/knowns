// Which Overview widgets a viewer shows, and in what order. Kept per browser in localStorage: it is
// a viewing preference, not project data, so it never reaches .knowns/ or other people.
import { useCallback, useEffect, useState } from "react";

export type MainWidgetId = "continue" | "attention" | "progress";
export type SideWidgetId = "review" | "activity" | "problems";
export type WidgetId = "summary" | MainWidgetId | SideWidgetId;

export interface DashboardLayout {
	main: MainWidgetId[];
	side: SideWidgetId[];
	hidden: WidgetId[];
}

export const WIDGETS: Record<WidgetId, { label: string; hint: string }> = {
	summary: { label: "Summary", hint: "In progress, waiting for review, blocked, done this week" },
	continue: { label: "Continue working", hint: "Tasks in progress, with criteria progress" },
	attention: { label: "Needs your attention", hint: "Blocked, review-bound or stale important tasks" },
	progress: { label: "Progress", hint: "Tasks finished and added over time" },
	review: { label: "Waiting for you", hint: "Memories and decisions to confirm" },
	activity: { label: "Recent activity", hint: "What changed lately" },
	problems: { label: "Problems", hint: "Runtime and tool errors" },
};

export const DEFAULT_LAYOUT: DashboardLayout = {
	main: ["continue", "attention", "progress"],
	side: ["review", "activity", "problems"],
	hidden: [],
};

// v2: the Overview redesign replaced every v1 widget id, so a v1 layout is ignored.
const STORAGE_KEY = "knowns.dashboard.layout.v2";

/** Keeps known ids once each, appends widgets added after the layout was saved, drops unknown ones. */
export function normalizeLayout(raw: unknown): DashboardLayout {
	if (!raw || typeof raw !== "object") return DEFAULT_LAYOUT;
	const r = raw as Partial<Record<keyof DashboardLayout, unknown>>;
	const pick = <T extends string>(value: unknown, allowed: readonly T[]): T[] => {
		const list = Array.isArray(value) ? value.filter((v): v is T => allowed.includes(v as T)) : [];
		const unique = [...new Set(list)];
		return [...unique, ...allowed.filter((id) => !unique.includes(id))];
	};
	const allIds = Object.keys(WIDGETS) as WidgetId[];
	return {
		main: pick(r.main, DEFAULT_LAYOUT.main),
		side: pick(r.side, DEFAULT_LAYOUT.side),
		hidden: Array.isArray(r.hidden)
			? [...new Set(r.hidden.filter((v): v is WidgetId => allIds.includes(v as WidgetId)))]
			: [],
	};
}

export function isDefaultLayout(layout: DashboardLayout): boolean {
	return (
		layout.hidden.length === 0 &&
		layout.main.join() === DEFAULT_LAYOUT.main.join() &&
		layout.side.join() === DEFAULT_LAYOUT.side.join()
	);
}

function load(): DashboardLayout {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? normalizeLayout(JSON.parse(raw)) : DEFAULT_LAYOUT;
	} catch {
		return DEFAULT_LAYOUT;
	}
}

export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
	const target = index + delta;
	if (target < 0 || target >= list.length) return [...list];
	const next = [...list];
	[next[index], next[target]] = [next[target] as T, next[index] as T];
	return next;
}

export function useDashboardLayout() {
	const [layout, setLayout] = useState<DashboardLayout>(load);

	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
		} catch {
			// Private windows and blocked storage: the layout still works for this visit.
		}
	}, [layout]);

	const isVisible = useCallback((id: WidgetId) => !layout.hidden.includes(id), [layout.hidden]);

	const toggle = useCallback((id: WidgetId) => {
		setLayout((prev) => ({
			...prev,
			hidden: prev.hidden.includes(id) ? prev.hidden.filter((h) => h !== id) : [...prev.hidden, id],
		}));
	}, []);

	const move = useCallback((zone: "main" | "side", index: number, delta: -1 | 1) => {
		setLayout((prev) =>
			zone === "main"
				? { ...prev, main: moveItem(prev.main, index, delta) }
				: { ...prev, side: moveItem(prev.side, index, delta) },
		);
	}, []);

	const reset = useCallback(() => setLayout(DEFAULT_LAYOUT), []);

	return { layout, isVisible, toggle, move, reset };
}
