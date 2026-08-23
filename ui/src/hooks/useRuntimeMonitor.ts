import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRuntimePs, type RuntimeStatusResponse } from "@/ui/api/client";

export function useRuntimeMonitor() {
	const [data, setData] = useState<RuntimeStatusResponse | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
	const inFlight = useRef(false);
	const mounted = useRef(true);

	const refresh = useCallback(async () => {
		if (inFlight.current) return;
		inFlight.current = true;
		setIsRefreshing(true);
		try {
			const next = await getRuntimePs();
			if (mounted.current) {
				setData(next);
				setError(null);
				setLastUpdatedAt(new Date().toISOString());
			}
		} catch (error) {
			console.error("Failed to load runtime monitor:", error);
			if (mounted.current) {
				setError(
					error instanceof Error
						? error.message
						: "Runtime status could not be loaded.",
				);
			}
		} finally {
			inFlight.current = false;
			if (mounted.current) {
				setIsLoading(false);
				setIsRefreshing(false);
			}
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void refresh();
		const interval = window.setInterval(refresh, 3000);

		return () => {
			mounted.current = false;
			window.clearInterval(interval);
		};
	}, [refresh]);

	const totalActive = useMemo(
		() => data?.projects?.reduce((total, project) => total + (project.running?.length ?? 0) + (project.queued?.length ?? 0), 0) ?? 0,
		[data],
	);

	return {
		data,
		error,
		isLoading,
		isRefreshing,
		lastUpdatedAt,
		refresh,
		totalActive,
	};
}
