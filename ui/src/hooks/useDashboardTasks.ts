import { useEffect, useRef, useState } from "react";
import type { Task } from "@/ui/models/task";
import { api } from "../api/client";
import { useSSEEvent } from "../contexts/SSEContext";

const PAGE = 200;
const DAY_MS = 86_400_000;

export interface DashboardTasks {
	tasks: Task[];
	/** The first page has arrived. */
	ready: boolean;
	/** More pages are still being walked. */
	walking: boolean;
	/** True when the walk stopped at its page cap with tasks it did not read. */
	truncated: boolean;
}

/**
 * The Tasks a dashboard computes from, read newest-update first and only as far as needed: the walk
 * stops once a page is older than `windowDays` (a task cannot have been completed, or need attention
 * for being recent, before it was last updated), or after `maxPages`. The Overview reads a bounded
 * window (the headline numbers come from /api/tasks/counts); Analytics asks for every page.
 */
export function useDashboardTasks({ enabled, windowDays, maxPages }: { enabled: boolean; windowDays: number; maxPages: number }): DashboardTasks {
	const [state, setState] = useState<DashboardTasks>({ tasks: [], ready: false, walking: false, truncated: false });
	const [tick, setTick] = useState(0);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-walk after task events
	useEffect(() => {
		if (!enabled) return;
		const ctl = new AbortController();
		const since = Date.now() - windowDays * DAY_MS;
		(async () => {
			let cursor: string | undefined;
			let pages = 0;
			const seen = new Map<string, Task>();
			setState((s) => ({ ...s, walking: true }));
			for (;;) {
				const page = await api.getTasksPage({ lifecycle: "current", sort: "updated-desc", limit: PAGE, ...(cursor ? { cursor } : {}), signal: ctl.signal });
				pages += 1;
				for (const t of page.tasks) seen.set(t.id, t);
				cursor = page.nextCursor;
				const oldest = page.tasks[page.tasks.length - 1];
				const reachedWindow = oldest ? oldest.updatedAt.getTime() < since : true;
				const done = !cursor || reachedWindow || pages >= maxPages;
				setState({ tasks: [...seen.values()], ready: true, walking: !done, truncated: done && !!cursor && !reachedWindow });
				if (done) return;
			}
		})().catch(() => {
			if (!ctl.signal.aborted) setState((s) => ({ ...s, ready: true, walking: false }));
		});
		return () => ctl.abort();
	}, [enabled, windowDays, maxPages, tick]);

	const refresh = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setTick((n) => n + 1), 600);
	};
	useEffect(() => () => {
		if (timer.current) clearTimeout(timer.current);
	}, []);
	useSSEEvent("tasks:updated", refresh);
	useSSEEvent("tasks:refresh", refresh);
	useSSEEvent("tasks:lifecycle", refresh);

	return state;
}
