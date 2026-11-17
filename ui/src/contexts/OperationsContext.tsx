/**
 * Activity Tray state: what is running, queued or just finished, from the web server and the daemon.
 * One snapshot (GET /api/operations) per SSE `connected`; events that arrive before it is answered
 * are buffered and replayed if newer (see lib/operationsStore.ts).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { OperationAPIError, operationsApi } from "../api/client";
import {
	adoptOperation,
	applyOperationEvent,
	applyRemoved,
	applySnapshot,
	beginSnapshot,
	emptyOperations,
	failSnapshot,
	forgetOperation,
	hideOperation,
	visibleOperations,
	type OperationsState,
} from "../lib/operationsStore";
import type { Operation, OperationEvent, OperationRemovedEvent, OperationSnapshot } from "../models/operation";
import { useSSEEvent } from "./SSEContext";

/** Waits before the 2nd, 3rd and 4th try of a failed snapshot. */
export const SNAPSHOT_RETRY_MS = [1000, 3000, 9000];

type Action =
	| { type: "begin"; request: number; keepBuffer?: boolean }
	| { type: "snapshot"; request: number; snapshot: OperationSnapshot; now: number }
	| { type: "snapshot-failed"; request: number; giveUp: boolean }
	| ({ type: "event" } & OperationEvent)
	| ({ type: "removed" } & OperationRemovedEvent)
	| { type: "adopt"; operation: Operation }
	| { type: "forget"; id: string }
	| { type: "hide"; id: string };

function reduce(state: OperationsState, action: Action): OperationsState {
	switch (action.type) {
		case "begin":
			return beginSnapshot(state, action.request, action.keepBuffer);
		case "snapshot":
			return applySnapshot(state, action.request, action.snapshot, action.now);
		case "snapshot-failed":
			return failSnapshot(state, action.request, action.giveUp);
		case "event":
			return applyOperationEvent(state, { seq: action.seq, operation: action.operation });
		case "removed":
			return applyRemoved(state, { seq: action.seq, id: action.id });
		case "adopt":
			return adoptOperation(state, action.operation);
		case "forget":
			return forgetOperation(state, action.id);
		case "hide":
			return hideOperation(state, action.id);
	}
}

interface OperationsContextType {
	/** Newest first. */
	operations: Operation[];
	/** Hide a row in THIS tab only (no request): the stack's one timer calls it for finished rows. */
	hideHere: (id: string) => void;
	cancel: (id: string) => Promise<void>;
	/** Web operations come back under a new id; daemon jobs keep theirs. */
	retry: (id: string) => Promise<void>;
	dismiss: (id: string) => Promise<void>;
}

const OperationsContext = createContext<OperationsContextType | undefined>(undefined);

export function OperationsProvider({ children }: { children: ReactNode }) {
	const [state, dispatch] = useReducer(reduce, emptyOperations);
	const requests = useRef(0);

	const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	// A snapshot that fails is retried a few times with a growing wait (error recovery, not polling: it
	// stops at the first answer). After the last try the tray goes ready with an empty list so the
	// events that arrive from then on show.
	const loadSnapshot = useCallback((attempt = 0) => {
		clearTimeout(retryTimer.current);
		const request = ++requests.current;
		dispatch({ type: "begin", request, keepBuffer: attempt > 0 });
		operationsApi
			.snapshot()
			.then((snapshot) => dispatch({ type: "snapshot", request, snapshot, now: Date.now() }))
			.catch(() => {
				const giveUp = attempt >= SNAPSHOT_RETRY_MS.length;
				dispatch({ type: "snapshot-failed", request, giveUp });
				if (!giveUp && request === requests.current) {
					retryTimer.current = setTimeout(() => loadSnapshot(attempt + 1), SNAPSHOT_RETRY_MS[attempt]);
				}
			});
	}, []);
	useEffect(() => () => clearTimeout(retryTimer.current), []);

	// One snapshot per connect, taken on the `connected` event the server sends first on every stream
	// (both providers mount together, so the first one is not missed).
	useSSEEvent("connected", () => loadSnapshot(0), [loadSnapshot]);
	useSSEEvent("operation:started", (e) => dispatch({ type: "event", seq: e.seq, operation: e.operation }));
	useSSEEvent("operation:updated", (e) => dispatch({ type: "event", seq: e.seq, operation: e.operation }));
	useSSEEvent("operation:finished", (e) => dispatch({ type: "event", seq: e.seq, operation: e.operation }));
	useSSEEvent("operation:removed", (e) => dispatch({ type: "removed", seq: e.seq, id: e.id }));

	const operations = useMemo(() => visibleOperations(state), [state]);
	const hideHere = useCallback((id: string) => dispatch({ type: "hide", id }), []);

	const cancel = useCallback(async (id: string) => {
		try {
			dispatch({ type: "adopt", operation: await operationsApi.cancel(id) });
		} catch (error) {
			if (error instanceof OperationAPIError && error.operation) dispatch({ type: "adopt", operation: error.operation });
			else if (!(error instanceof OperationAPIError && error.status === 404)) throw error;
		}
	}, []);

	const retry = useCallback(async (id: string) => {
		const next = await operationsApi.retry(id);
		// A web retry removes the old row and returns a new id; a daemon retry keeps the id.
		if (next.id !== id) dispatch({ type: "forget", id });
		dispatch({ type: "adopt", operation: next });
	}, []);

	const dismiss = useCallback(async (id: string) => {
		await operationsApi.dismiss(id);
		dispatch({ type: "forget", id });
	}, []);

	const value = useMemo(
		() => ({ operations, hideHere, cancel, retry, dismiss }),
		[operations, hideHere, cancel, retry, dismiss],
	);
	return <OperationsContext.Provider value={value}>{children}</OperationsContext.Provider>;
}

export function useOperations(): OperationsContextType {
	const ctx = useContext(OperationsContext);
	if (!ctx) throw new Error("useOperations must be used within an OperationsProvider");
	return ctx;
}
