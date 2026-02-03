import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { timeApi, type ActiveTimer } from "../api/client";
import { useSSEEvent } from "./SSEContext";

interface TimeTrackerContextType {
	activeTimers: ActiveTimer[];
	elapsedMap: Map<string, number>;
	loading: boolean;
	error: string | null;
	start: (taskId: string) => Promise<void>;
	stop: (taskId?: string, all?: boolean) => Promise<void>;
	pause: (taskId?: string, all?: boolean) => Promise<void>;
	resume: (taskId?: string, all?: boolean) => Promise<void>;
	refetch: () => Promise<void>;
	// Helper methods
	getTimerForTask: (taskId: string) => ActiveTimer | undefined;
	isTaskRunning: (taskId: string) => boolean;
	isTaskPaused: (taskId: string) => boolean;
	getElapsedForTask: (taskId: string) => number;
}

const TimeTrackerContext = createContext<TimeTrackerContextType | undefined>(undefined);

export function TimeTrackerProvider({ children }: { children: ReactNode }) {
	const [activeTimers, setActiveTimers] = useState<ActiveTimer[]>([]);
	const [elapsedMap, setElapsedMap] = useState<Map<string, number>>(new Map());
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const intervalRef = useRef<number | null>(null);

	// Calculate elapsed time for a single timer
	const calculateElapsed = useCallback((timer: ActiveTimer): number => {
		const startTime = new Date(timer.startedAt).getTime();
		const currentTime = timer.pausedAt
			? new Date(timer.pausedAt).getTime()
			: Date.now();
		return currentTime - startTime - timer.totalPausedMs;
	}, []);

	// Update elapsed times for all active timers
	const updateAllElapsed = useCallback((timers: ActiveTimer[]) => {
		const newMap = new Map<string, number>();
		for (const timer of timers) {
			newMap.set(timer.taskId, calculateElapsed(timer));
		}
		setElapsedMap(newMap);
	}, [calculateElapsed]);

	// Fetch status
	const fetchStatus = useCallback(async () => {
		try {
			setError(null);
			const { active } = await timeApi.getStatus();
			setActiveTimers(active);
			updateAllElapsed(active);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to fetch status");
		} finally {
			setLoading(false);
		}
	}, [updateAllElapsed]);

	// Initial fetch
	useEffect(() => {
		fetchStatus();
	}, [fetchStatus]);

	// Timer tick - update elapsed for all running (non-paused) timers
	useEffect(() => {
		const hasRunningTimers = activeTimers.some(t => !t.pausedAt);

		if (hasRunningTimers) {
			intervalRef.current = window.setInterval(() => {
				updateAllElapsed(activeTimers);
			}, 1000);
		} else if (intervalRef.current) {
			clearInterval(intervalRef.current);
			intervalRef.current = null;
		}

		return () => {
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
			}
		};
	}, [activeTimers, updateAllElapsed]);

	// Listen for SSE time updates
	useSSEEvent("time:updated", ({ active }) => {
		setActiveTimers(active);
		updateAllElapsed(active);
	}, [updateAllElapsed]);

	// Listen for SSE reconnection to refetch timer state
	useSSEEvent("time:refresh", () => {
		fetchStatus();
	}, [fetchStatus]);

	const start = useCallback(async (taskId: string) => {
		try {
			setError(null);
			const { active } = await timeApi.start(taskId);
			setActiveTimers(active);
			updateAllElapsed(active);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to start timer";
			setError(message);
			throw err;
		}
	}, [updateAllElapsed]);

	const stop = useCallback(async (taskId?: string, all?: boolean) => {
		try {
			setError(null);
			const { active } = await timeApi.stop(taskId, all);
			setActiveTimers(active);
			updateAllElapsed(active);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to stop timer";
			setError(message);
			throw err;
		}
	}, [updateAllElapsed]);

	const pause = useCallback(async (taskId?: string, all?: boolean) => {
		try {
			setError(null);
			const { active } = await timeApi.pause(taskId, all);
			setActiveTimers(active);
			updateAllElapsed(active);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to pause timer";
			setError(message);
			throw err;
		}
	}, [updateAllElapsed]);

	const resume = useCallback(async (taskId?: string, all?: boolean) => {
		try {
			setError(null);
			const { active } = await timeApi.resume(taskId, all);
			setActiveTimers(active);
			updateAllElapsed(active);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to resume timer";
			setError(message);
			throw err;
		}
	}, [updateAllElapsed]);

	// Helper methods
	const getTimerForTask = useCallback((taskId: string) => {
		return activeTimers.find(t => t.taskId === taskId);
	}, [activeTimers]);

	const isTaskRunning = useCallback((taskId: string) => {
		return activeTimers.some(t => t.taskId === taskId);
	}, [activeTimers]);

	const isTaskPaused = useCallback((taskId: string) => {
		const timer = activeTimers.find(t => t.taskId === taskId);
		return timer?.pausedAt !== null && timer?.pausedAt !== undefined;
	}, [activeTimers]);

	const getElapsedForTask = useCallback((taskId: string) => {
		return elapsedMap.get(taskId) || 0;
	}, [elapsedMap]);

	return (
		<TimeTrackerContext.Provider
			value={{
				activeTimers,
				elapsedMap,
				loading,
				error,
				start,
				stop,
				pause,
				resume,
				refetch: fetchStatus,
				getTimerForTask,
				isTaskRunning,
				isTaskPaused,
				getElapsedForTask,
			}}
		>
			{children}
		</TimeTrackerContext.Provider>
	);
}

export function useTimeTracker() {
	const context = useContext(TimeTrackerContext);
	if (context === undefined) {
		throw new Error("useTimeTracker must be used within a TimeTrackerProvider");
	}
	return context;
}
