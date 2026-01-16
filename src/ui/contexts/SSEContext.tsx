/**
 * SSE (Server-Sent Events) Context
 * Provides centralized real-time event handling for all components
 *
 * Benefits over previous WebSocket approach:
 * - Single connection per browser tab (instead of 5+ per component)
 * - Auto-reconnection built into EventSource API
 * - HTTP/2 compatible, firewall friendly
 * - Native browser API, no external dependencies
 */

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import type { Task } from "../../models/task";
import type { ActiveTimer } from "../api/client";
import { toast } from "../components/ui/sonner";

// Event types that can be received from server
export type SSEEventType =
	| "connected"
	| "tasks:updated"
	| "tasks:refresh"
	| "tasks:archived"
	| "tasks:unarchived"
	| "tasks:batch-archived"
	| "time:updated"
	| "time:refresh"
	| "docs:updated"
	| "docs:refresh";

// Event payload types
export interface SSEEventPayloads {
	connected: { timestamp: number };
	"tasks:updated": { task: Task };
	"tasks:refresh": Record<string, never>;
	"tasks:archived": { task: Task };
	"tasks:unarchived": { task: Task };
	"tasks:batch-archived": { tasks: Task[] };
	"time:updated": { active: ActiveTimer | null };
	"time:refresh": Record<string, never>;
	"docs:updated": { docPath: string };
	"docs:refresh": Record<string, never>;
}

// Callback type for event listeners
type SSEEventCallback<T extends SSEEventType> = (data: SSEEventPayloads[T]) => void;

interface SSEContextType {
	isConnected: boolean;
	subscribe: <T extends SSEEventType>(event: T, callback: SSEEventCallback<T>) => () => void;
}

const SSEContext = createContext<SSEContextType | undefined>(undefined);

// Use env vars from Vite, fallback to relative paths for production
const API_BASE = import.meta.env.API_URL || "";

// Parse task DTO dates
function parseTaskDTO(dto: Record<string, unknown>): Task {
	return {
		...dto,
		status: dto.status as Task["status"],
		priority: dto.priority as Task["priority"],
		createdAt: new Date(dto.createdAt as string),
		updatedAt: new Date(dto.updatedAt as string),
		timeEntries: ((dto.timeEntries as Array<Record<string, unknown>>) || []).map((entry) => ({
			...entry,
			startedAt: new Date(entry.startedAt as string),
			endedAt: entry.endedAt ? new Date(entry.endedAt as string) : undefined,
		})),
	} as Task;
}

export function SSEProvider({ children }: { children: ReactNode }) {
	const [isConnected, setIsConnected] = useState(false);
	const eventSourceRef = useRef<EventSource | null>(null);
	const listenersRef = useRef<Map<SSEEventType, Set<SSEEventCallback<SSEEventType>>>>(new Map());
	// Track if we've been connected before (to detect reconnects vs initial connect)
	const wasConnectedRef = useRef(false);
	// Track disconnect toast ID so we can dismiss it on reconnect
	const disconnectToastIdRef = useRef<string | number | null>(null);

	// Subscribe to an event type
	const subscribe = useCallback(<T extends SSEEventType>(
		event: T,
		callback: SSEEventCallback<T>
	): (() => void) => {
		if (!listenersRef.current.has(event)) {
			listenersRef.current.set(event, new Set());
		}
		const listeners = listenersRef.current.get(event)!;
		listeners.add(callback as SSEEventCallback<SSEEventType>);

		// Return unsubscribe function
		return () => {
			listeners.delete(callback as SSEEventCallback<SSEEventType>);
		};
	}, []);

	// Emit event to all listeners
	const emit = useCallback(<T extends SSEEventType>(event: T, data: SSEEventPayloads[T]) => {
		const listeners = listenersRef.current.get(event);
		if (listeners) {
			for (const callback of listeners) {
				try {
					callback(data);
				} catch (error) {
					console.error(`Error in SSE event listener for ${event}:`, error);
				}
			}
		}
	}, []);

	// Setup SSE connection
	useEffect(() => {
		const sseUrl = `${API_BASE}/api/events`;

		const connect = () => {
			const eventSource = new EventSource(sseUrl);
			eventSourceRef.current = eventSource;

			eventSource.onopen = () => {
				setIsConnected(true);

				// If we were connected before, this is a RECONNECT
				// Trigger refresh events so components can refetch data they may have missed
				if (wasConnectedRef.current) {
					console.log("[SSE] Reconnected - triggering data refresh");
					// Dismiss disconnect toast and show success toast
					if (disconnectToastIdRef.current) {
						toast.dismiss(disconnectToastIdRef.current);
						disconnectToastIdRef.current = null;
					}
					toast("Back online", {
						description: "Connection restored",
						duration: 2000,
						position: "top-center",
						className: "bg-emerald-50 dark:bg-emerald-950 border-emerald-200 dark:border-emerald-800",
						icon: (
							<svg className="w-4 h-4 text-emerald-600 dark:text-emerald-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M12 20h.01" />
								<path d="M2 8.82a15 15 0 0 1 20 0" />
								<path d="M5 12.859a10 10 0 0 1 14 0" />
								<path d="M8.5 16.429a5 5 0 0 1 7 0" />
							</svg>
						),
					});
					// Small delay to ensure connection is stable
					setTimeout(() => {
						emit("tasks:refresh", {});
						emit("time:refresh", {});
						emit("docs:refresh", {});
					}, 100);
				}
				wasConnectedRef.current = true;
			};

			eventSource.onerror = () => {
				setIsConnected(false);
				console.log("[SSE] Connection lost - will auto-reconnect");

				// Show disconnect toast only once (when we have been connected before)
				// wasConnectedRef tracks if we've ever connected, preventing toast on initial failure
				if (wasConnectedRef.current && !disconnectToastIdRef.current) {
					disconnectToastIdRef.current = toast("Offline", {
						description: "Reconnecting...",
						duration: Number.POSITIVE_INFINITY,
						position: "top-center",
						className: "bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800",
						icon: (
							<svg className="w-4 h-4 text-amber-600 dark:text-amber-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M12 20h.01" />
								<path d="M8.5 16.429a5 5 0 0 1 7 0" />
								<path d="M5 12.859a10 10 0 0 1 5.17-2.69" />
								<path d="M13.83 10.17A10 10 0 0 1 19 12.859" />
								<path d="M2 8.82a15 15 0 0 1 4.17-2.65" />
								<path d="M10.66 5a15 15 0 0 1 11.34 3.82" />
								<path d="m2 2 20 20" />
							</svg>
						),
					});
				}
				// EventSource will auto-reconnect automatically
			};

			// Handle connected event
			eventSource.addEventListener("connected", (e) => {
				const data = JSON.parse(e.data);
				emit("connected", data);
			});

			// Handle task events
			eventSource.addEventListener("tasks:updated", (e) => {
				const data = JSON.parse(e.data);
				emit("tasks:updated", { task: parseTaskDTO(data.task) });
			});

			eventSource.addEventListener("tasks:refresh", (e) => {
				const data = JSON.parse(e.data);
				emit("tasks:refresh", data);
			});

			eventSource.addEventListener("tasks:archived", (e) => {
				const data = JSON.parse(e.data);
				emit("tasks:archived", { task: parseTaskDTO(data.task) });
			});

			eventSource.addEventListener("tasks:unarchived", (e) => {
				const data = JSON.parse(e.data);
				emit("tasks:unarchived", { task: parseTaskDTO(data.task) });
			});

			eventSource.addEventListener("tasks:batch-archived", (e) => {
				const data = JSON.parse(e.data);
				emit("tasks:batch-archived", {
					tasks: data.tasks.map(parseTaskDTO),
				});
			});

			// Handle time events
			eventSource.addEventListener("time:updated", (e) => {
				const data = JSON.parse(e.data);
				emit("time:updated", data);
			});

			// Handle docs events
			eventSource.addEventListener("docs:updated", (e) => {
				const data = JSON.parse(e.data);
				emit("docs:updated", data);
			});

			eventSource.addEventListener("docs:refresh", (e) => {
				const data = JSON.parse(e.data);
				emit("docs:refresh", data);
			});
		};

		connect();

		return () => {
			if (eventSourceRef.current) {
				eventSourceRef.current.close();
				eventSourceRef.current = null;
			}
		};
	}, [emit]);

	return (
		<SSEContext.Provider value={{ isConnected, subscribe }}>
			{children}
		</SSEContext.Provider>
	);
}

/**
 * Hook to access SSE context
 */
export function useSSE() {
	const context = useContext(SSEContext);
	if (context === undefined) {
		throw new Error("useSSE must be used within an SSEProvider");
	}
	return context;
}

/**
 * Hook to subscribe to a specific SSE event
 * Automatically unsubscribes on unmount
 */
export function useSSEEvent<T extends SSEEventType>(
	event: T,
	callback: SSEEventCallback<T>,
	deps: React.DependencyList = []
) {
	const { subscribe } = useSSE();

	useEffect(() => {
		const unsubscribe = subscribe(event, callback);
		return unsubscribe;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [subscribe, event, ...deps]);
}
