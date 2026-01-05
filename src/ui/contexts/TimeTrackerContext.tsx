import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { timeApi, type ActiveTimer } from "../api/client";
import { useSSEEvent } from "./SSEContext";

interface TimeTrackerContextType {
	activeTimer: ActiveTimer | null;
	isRunning: boolean;
	isPaused: boolean;
	elapsedMs: number;
	loading: boolean;
	error: string | null;
	start: (taskId: string) => Promise<void>;
	stop: () => Promise<void>;
	pause: () => Promise<void>;
	resume: () => Promise<void>;
	refetch: () => Promise<void>;
}

const TimeTrackerContext = createContext<TimeTrackerContextType | undefined>(undefined);

export function TimeTrackerProvider({ children }: { children: ReactNode }) {
	const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null);
	const [elapsedMs, setElapsedMs] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const intervalRef = useRef<number | null>(null);

	const isRunning = activeTimer !== null;
	const isPaused = activeTimer?.pausedAt !== null;

	// Calculate elapsed time
	const calculateElapsed = useCallback((timer: ActiveTimer): number => {
		const startTime = new Date(timer.startedAt).getTime();
		const currentTime = timer.pausedAt
			? new Date(timer.pausedAt).getTime()
			: Date.now();
		return currentTime - startTime - timer.totalPausedMs;
	}, []);

	// Fetch status
	const fetchStatus = useCallback(async () => {
		try {
			setError(null);
			const { active } = await timeApi.getStatus();
			setActiveTimer(active);
			if (active) {
				setElapsedMs(calculateElapsed(active));
			} else {
				setElapsedMs(0);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to fetch status");
		} finally {
			setLoading(false);
		}
	}, [calculateElapsed]);

	// Initial fetch
	useEffect(() => {
		fetchStatus();
	}, [fetchStatus]);

	// Timer tick
	useEffect(() => {
		if (activeTimer && !activeTimer.pausedAt) {
			intervalRef.current = window.setInterval(() => {
				setElapsedMs(calculateElapsed(activeTimer));
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
	}, [activeTimer, calculateElapsed]);

	// Listen for SSE time updates
	useSSEEvent("time:updated", ({ active }) => {
		setActiveTimer(active || null);
		if (active) {
			setElapsedMs(calculateElapsed(active));
		} else {
			setElapsedMs(0);
		}
	}, [calculateElapsed]);

	// Listen for SSE reconnection to refetch timer state
	useSSEEvent("time:refresh", () => {
		fetchStatus();
	}, [fetchStatus]);

	const start = useCallback(async (taskId: string) => {
		try {
			setError(null);
			const { active } = await timeApi.start(taskId);
			setActiveTimer(active);
			setElapsedMs(0);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to start timer";
			setError(message);
			throw err;
		}
	}, []);

	const stop = useCallback(async () => {
		try {
			setError(null);
			await timeApi.stop();
			setActiveTimer(null);
			setElapsedMs(0);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to stop timer";
			setError(message);
			throw err;
		}
	}, []);

	const pause = useCallback(async () => {
		try {
			setError(null);
			const { active } = await timeApi.pause();
			setActiveTimer(active);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to pause timer";
			setError(message);
			throw err;
		}
	}, []);

	const resume = useCallback(async () => {
		try {
			setError(null);
			const { active } = await timeApi.resume();
			setActiveTimer(active);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to resume timer";
			setError(message);
			throw err;
		}
	}, []);

	return (
		<TimeTrackerContext.Provider
			value={{
				activeTimer,
				isRunning,
				isPaused,
				elapsedMs,
				loading,
				error,
				start,
				stop,
				pause,
				resume,
				refetch: fetchStatus,
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
