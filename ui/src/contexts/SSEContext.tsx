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
import type { Task } from "@/ui/models/task";
import type { ChatSession, ChatMessage } from "@/ui/models/chat";
import type { ActiveTimer } from "../api/client";
import type { TaskLifecycleEvent } from "../models/taskLifecycle";
import { toast } from "../components/ui/sonner";

// Event types that can be received from server
export type SSEEventType =
	| "connected"
	| "tasks:updated"
	| "tasks:refresh"
	| "tasks:archived"
	| "tasks:unarchived"
	| "tasks:batch-archived"
	| "tasks:lifecycle"
	| "tasks:lifecycle-sweep"
	| "time:updated"
	| "time:refresh"
	| "docs:updated"
	| "docs:refresh"
	| "refresh"
	| "chats:created"
	| "chats:updated"
	| "chats:deleted"
	| "chats:message"
	| "opencode:event"
	| "opencode:status";

// Event payload types
export interface SSEEventPayloads {
	connected: { timestamp: number };
	"tasks:updated": { task: Task };
	"tasks:refresh": Record<string, never>;
	"tasks:archived": { task: Task };
	"tasks:unarchived": { task: Task };
	"tasks:batch-archived": { tasks: Task[] };
	"tasks:lifecycle": { event: TaskLifecycleEvent };
	"tasks:lifecycle-sweep": { result?: unknown; error?: string };
	"time:updated": { active: ActiveTimer[] };
	"time:refresh": Record<string, never>;
	"docs:updated": { docPath: string };
	"docs:refresh": Record<string, never>;
	"refresh": { full?: boolean; reason?: string };
	"chats:created": { session: ChatSession };
	"chats:updated": { session: ChatSession };
	"chats:deleted": { chatId: string };
	"chats:message": { chatId: string; message: ChatMessage };
	"opencode:event": Record<string, unknown>;
	"opencode:status": Record<string, unknown>;
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
		labels: (dto.labels as string[]) || [],
		subtasks: (dto.subtasks as string[]) || [],
		acceptanceCriteria: (dto.acceptanceCriteria as Task["acceptanceCriteria"]) || [],
		fulfills: (dto.fulfills as string[]) || [],
		createdAt: new Date(dto.createdAt as string),
		updatedAt: new Date(dto.updatedAt as string),
		completedAt: dto.completedAt ? new Date(dto.completedAt as string) : undefined,
		archivedAt: dto.archivedAt ? new Date(dto.archivedAt as string) : undefined,
		archived: (dto.archived as boolean) ?? dto.lifecycleState === "archived",
		lifecycleState: dto.lifecycleState as Task["lifecycleState"],
		timeEntries: ((dto.timeEntries as Array<Record<string, unknown>>) || []).map((entry) => ({
			...entry,
			startedAt: new Date(entry.startedAt as string),
			endedAt: entry.endedAt ? new Date(entry.endedAt as string) : undefined,
		})),
	} as Task;
}

// Threshold for showing reload confirmation (30 seconds)
const LONG_DISCONNECT_THRESHOLD_MS = 30 * 1000;

export function SSEProvider({ children }: { children: ReactNode }) {
	const [isConnected, setIsConnected] = useState(false);
	const eventSourceRef = useRef<EventSource | null>(null);
	const listenersRef = useRef<Map<SSEEventType, Set<SSEEventCallback<SSEEventType>>>>(new Map());
	// Track if we've been connected before (to detect reconnects vs initial connect)
	const wasConnectedRef = useRef(false);
	// Track disconnect toast ID so we can dismiss it on reconnect
	const disconnectToastIdRef = useRef<string | number | null>(null);
	// Track when disconnect started
	const disconnectStartTimeRef = useRef<number | null>(null);
	const seenLifecycleEventIDsRef = useRef<Set<string>>(new Set());

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
		const token = sessionStorage.getItem("knowns_auth_token");
		const sseUrl = token
			? `${API_BASE}/api/events?token=${encodeURIComponent(token)}`
			: `${API_BASE}/api/events`;

		// Store named handler references for proper cleanup
		const handlers: Array<{ event: string; handler: (e: MessageEvent) => void }> = [];

		const addHandler = (eventSource: EventSource, event: string, handler: (e: MessageEvent) => void) => {
			eventSource.addEventListener(event, handler);
			handlers.push({ event, handler });
		};

		const removeAllHandlers = (eventSource: EventSource) => {
			for (const { event, handler } of handlers) {
				eventSource.removeEventListener(event, handler);
			}
			handlers.length = 0;
		};

		const connect = () => {
			const eventSource = new EventSource(sseUrl);
			eventSourceRef.current = eventSource;

			eventSource.onopen = () => {
				setIsConnected(true);

				// If we were connected before, this is a RECONNECT
				// Trigger refresh events so components can refetch data they may have missed
				if (wasConnectedRef.current) {
					console.log("[SSE] Reconnected - triggering data refresh");

					// Calculate disconnect duration
					const disconnectDuration = disconnectStartTimeRef.current
						? Date.now() - disconnectStartTimeRef.current
						: 0;
					disconnectStartTimeRef.current = null;

					// Dismiss disconnect toast
					if (disconnectToastIdRef.current) {
						toast.dismiss(disconnectToastIdRef.current);
						disconnectToastIdRef.current = null;
					}

					// If disconnected for too long, ask user if they want to reload
					if (disconnectDuration > LONG_DISCONNECT_THRESHOLD_MS) {
						const durationSecs = Math.round(disconnectDuration / 1000);
						toast("Back online", {
							description: `You were offline for ${durationSecs}s. Reload to ensure all data is up to date?`,
							duration: 10000,
							position: "top-center",
							className: "bg-emerald-50 dark:bg-emerald-950 border-emerald-200 dark:border-emerald-800",
							action: {
								label: "Reload",
								onClick: () => {
									window.location.reload();
								},
							},
							icon: (
								<svg className="w-4 h-4 text-emerald-600 dark:text-emerald-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M12 20h.01" />
									<path d="M2 8.82a15 15 0 0 1 20 0" />
									<path d="M5 12.859a10 10 0 0 1 14 0" />
									<path d="M8.5 16.429a5 5 0 0 1 7 0" />
								</svg>
							),
						});
					}
					// Short disconnects: silently reconnect without notification

					// Always do soft refresh (refetch data)
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

				// Track when disconnect started (only set once per disconnect)
				if (disconnectStartTimeRef.current === null) {
					disconnectStartTimeRef.current = Date.now();
				}

				// Show disconnect toast only once (when we have been connected before)
				// wasConnectedRef tracks if we've ever connected, preventing toast on initial failure
				// EventSource will auto-reconnect automatically
			};

			// Register all event handlers with proper tracking for cleanup
			addHandler(eventSource, "connected", (e) => {
				const data = JSON.parse(e.data);
				emit("connected", data);
			});

			addHandler(eventSource, "tasks:updated", (e) => {
				const data = JSON.parse(e.data);
				if (data.task) {
					emit("tasks:updated", { task: parseTaskDTO(data.task) });
				} else {
					// Fallback: server sent only ID, trigger full refresh.
					emit("tasks:refresh", {});
				}
			});

			addHandler(eventSource, "tasks:refresh", (e) => {
				const data = JSON.parse(e.data);
				emit("tasks:refresh", data);
			});

			addHandler(eventSource, "tasks:archived", (e) => {
				const data = JSON.parse(e.data);
				if (data.task) {
					emit("tasks:archived", { task: parseTaskDTO(data.task) });
				} else {
					emit("tasks:refresh", {});
				}
			});

			addHandler(eventSource, "tasks:unarchived", (e) => {
				const data = JSON.parse(e.data);
				if (data.task) {
					emit("tasks:unarchived", { task: parseTaskDTO(data.task) });
				} else {
					emit("tasks:refresh", {});
				}
			});

			addHandler(eventSource, "tasks:batch-archived", (e) => {
				const data = JSON.parse(e.data);
				emit("tasks:batch-archived", {
					tasks: data.tasks.map(parseTaskDTO),
				});
			});

			addHandler(eventSource, "tasks:lifecycle", (e) => {
				const data = JSON.parse(e.data) as Omit<TaskLifecycleEvent, "at"> & { at: string };
				if (!data.id || seenLifecycleEventIDsRef.current.has(data.id)) return;
				seenLifecycleEventIDsRef.current.add(data.id);
				if (seenLifecycleEventIDsRef.current.size > 512) {
					const oldest = seenLifecycleEventIDsRef.current.values().next().value;
					if (oldest) seenLifecycleEventIDsRef.current.delete(oldest);
				}
				emit("tasks:lifecycle", { event: { ...data, at: new Date(data.at) } });
				emit("tasks:refresh", {});
			});

			addHandler(eventSource, "tasks:lifecycle-sweep", (e) => {
				emit("tasks:lifecycle-sweep", JSON.parse(e.data));
			});

			addHandler(eventSource, "time:updated", (e) => {
				const data = JSON.parse(e.data);
				emit("time:updated", data);
			});

			addHandler(eventSource, "docs:updated", (e) => {
				const data = JSON.parse(e.data);
				emit("docs:updated", data);
			});

			addHandler(eventSource, "docs:refresh", (e) => {
				const data = JSON.parse(e.data);
				emit("docs:refresh", data);
			});

			addHandler(eventSource, "refresh", () => {
				emit("tasks:refresh", {});
				emit("time:refresh", {});
				emit("docs:refresh", {});
			});

			addHandler(eventSource, "chats:created", (e) => {
				const data = JSON.parse(e.data);
				emit("chats:created", data);
			});

			addHandler(eventSource, "chats:updated", (e) => {
				const data = JSON.parse(e.data);
				emit("chats:updated", data);
			});

			addHandler(eventSource, "chats:deleted", (e) => {
				const data = JSON.parse(e.data);
				emit("chats:deleted", data);
			});

			addHandler(eventSource, "chats:message", (e) => {
				const data = JSON.parse(e.data);
				emit("chats:message", data);
			});

			addHandler(eventSource, "opencode:event", (e) => {
				const data = JSON.parse(e.data);
				emit("opencode:event", data);
			});

			addHandler(eventSource, "opencode:status", (e) => {
				const data = JSON.parse(e.data);
				emit("opencode:status", data);
			});
		};

		connect();

		return () => {
			if (eventSourceRef.current) {
				removeAllHandlers(eventSourceRef.current);
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
