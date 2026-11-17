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
	/** Newest first. A done or cancelled row stays until the tray asks to hide it (hideHere). */
	operations: Operation[];
	/** Hide a row in THIS tab only (no request): the tray's one timer calls it for done and cancelled rows. */
	hideHere: (id: string) => void;
	cancel: (id: string) => Promise<void>;
	/** Web operations come back under a new id; daemon jobs keep theirs. */
	retry: (id: string) => Promise<void>;
	dismiss: (id: string) => Promise<void>;
}

const OperationsContext = createContext<OperationsContextType | undefined>(undefined);

export function OperationsProvider({ children }: { children: ReactNode }) {
	const [state, dispatch] = useReducer(reduce, emptyOperations);
	const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());

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

	const operations = useMemo(() => visibleOperations(state, hidden), [state, hidden]);
	const hideHere = useCallback((id: string) => setHidden((prev) => new Set(prev).add(id)), []);

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
