import { useEffect, useMemo, useRef, useState } from "react";
import { api, type TaskCounts, type TaskFilters } from "../api/client";
import { useSSEEvent } from "../contexts/SSEContext";

/**
 * Counts per status from the server (GET /api/tasks/counts), under the same filters as the lists but
 * without the status. Refetched shortly after any task event so the badges follow the lists.
 */
export function useTaskCounts(filters: TaskFilters, enabled = true): { counts: TaskCounts | null; refresh: () => void } {
	const key = useMemo(() => JSON.stringify(filters), [filters]);
	const [counts, setCounts] = useState<TaskCounts | null>(null);
	const [tick, setTick] = useState(0);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: key stands for filters; tick forces a refetch
	useEffect(() => {
		if (!enabled) return;
		const ctl = new AbortController();
		api
			.getTaskCounts({ ...filters, signal: ctl.signal })
			.then(setCounts)
			.catch(() => {});
		return () => ctl.abort();
	}, [key, enabled, tick]);

	const refresh = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setTick((n) => n + 1), 300);
	};
	useEffect(() => () => {
		if (timer.current) clearTimeout(timer.current);
	}, []);
	useSSEEvent("tasks:updated", refresh);
	useSSEEvent("tasks:refresh", refresh);
	useSSEEvent("tasks:archived", refresh);
	useSSEEvent("tasks:unarchived", refresh);
	useSSEEvent("tasks:batch-archived", refresh);

	return { counts, refresh };
}
