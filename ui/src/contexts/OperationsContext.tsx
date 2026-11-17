/**
 * Activity Tray state: what is running, queued or just finished, from the web server and the daemon.
 * On every SSE `connected` it takes GET /api/operations, then applies operation events whose seq is
 * newer than that snapshot (see lib/operationsStore.ts).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { OperationAPIError, operationsApi } from "../api/client";
import {
	adoptOperation,
	applyOperationEvent,
	applyRemoved,
	applySnapshot,
	emptyOperations,
	forgetOperation,
	nextHideAt,
	visibleOperations,
	type OperationsState,
} from "../lib/operationsStore";
import type { Operation, OperationSnapshot } from "../models/operation";
import { useSSEEvent } from "./SSEContext";

type Action =
	| { type: "snapshot"; snapshot: OperationSnapshot }
	| { type: "event"; seq: number; operation: Operation }
	| { type: "removed"; seq: number; id: string }
	| { type: "adopt"; operation: Operation }
	| { type: "forget"; id: string };

function reduce(state: OperationsState, action: Action): OperationsState {
	switch (action.type) {
		case "snapshot":
			return applySnapshot(action.snapshot);
		case "event":
			return applyOperationEvent(state, { seq: action.seq, operation: action.operation });
		case "removed":
			return applyRemoved(state, { seq: action.seq, id: action.id });
		case "adopt":
			return adoptOperation(state, action.operation);
		case "forget":
			return forgetOperation(state, action.id);
	}
}

interface OperationsContextType {
	/** Newest first. Done and cancelled rows leave a few seconds after they finish. */
	operations: Operation[];
	cancel: (id: string) => Promise<void>;
	/** Web operations come back under a new id; daemon jobs keep theirs. */
	retry: (id: string) => Promise<void>;
	dismiss: (id: string) => Promise<void>;
}

const OperationsContext = createContext<OperationsContextType | undefined>(undefined);

export function OperationsProvider({ children }: { children: ReactNode }) {
	const [state, dispatch] = useReducer(reduce, emptyOperations);
	const [now, setNow] = useState(() => Date.now());

	const loadSnapshot = useCallback(() => {
		operationsApi
			.snapshot()
			.then((snapshot) => dispatch({ type: "snapshot", snapshot }))
			.catch(() => {
				// The next `connected` takes a fresh snapshot.
			});
	}, []);

	useEffect(loadSnapshot, [loadSnapshot]);
	useSSEEvent("connected", loadSnapshot, [loadSnapshot]);
	useSSEEvent("operation:started", (e) => dispatch({ type: "event", seq: e.seq, operation: e.operation }));
	useSSEEvent("operation:updated", (e) => dispatch({ type: "event", seq: e.seq, operation: e.operation }));
	useSSEEvent("operation:finished", (e) => dispatch({ type: "event", seq: e.seq, operation: e.operation }));
	useSSEEvent("operation:removed", (e) => dispatch({ type: "removed", seq: e.seq, id: e.id }));

	// One timer, for the next done or cancelled row that is about to leave.
	useEffect(() => {
		const at = nextHideAt(state, Date.now());
		if (at === null) return;
		const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()) + 1);
		return () => clearTimeout(timer);
	}, [state]);

	const operations = useMemo(() => visibleOperations(state, now), [state, now]);

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

	const value = useMemo(() => ({ operations, cancel, retry, dismiss }), [operations, cancel, retry, dismiss]);
	return <OperationsContext.Provider value={value}>{children}</OperationsContext.Provider>;
}

export function useOperations(): OperationsContextType {
	const ctx = useContext(OperationsContext);
	if (!ctx) throw new Error("useOperations must be used within an OperationsProvider");
	return ctx;
}
