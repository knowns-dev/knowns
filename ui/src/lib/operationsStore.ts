// Pure state of the Activity Tray. The server keeps the truth; the UI takes a snapshot on every SSE
// `connected` and then applies events only when their seq is newer than the snapshot, so a late
// event of an older state can never overwrite a newer one.

import {
	isTerminalOperation,
	type Operation,
	type OperationEvent,
	type OperationRemovedEvent,
	type OperationSnapshot,
} from "@/ui/models/operation";

export interface OperationsState {
	/** The snapshot seq, then the highest seq applied. */
	seq: number;
	byId: Record<string, Operation>;
	/** True once a snapshot has been taken. Events before it are held back by the caller. */
	ready: boolean;
}

/** done and cancelled rows are hidden after this long (the server removes them after 15 s). */
export const HIDE_FINISHED_AFTER_MS = 4000;

export const emptyOperations: OperationsState = { seq: 0, byId: {}, ready: false };

export function applySnapshot(snapshot: OperationSnapshot): OperationsState {
	const byId: Record<string, Operation> = {};
	for (const op of snapshot.operations) byId[op.id] = op;
	return { seq: snapshot.seq, byId, ready: true };
}

/** started, updated and finished carry the whole operation. */
export function applyOperationEvent(state: OperationsState, event: OperationEvent): OperationsState {
	if (!state.ready || event.seq <= state.seq) return state;
	return { ...state, seq: event.seq, byId: { ...state.byId, [event.operation.id]: event.operation } };
}

export function applyRemoved(state: OperationsState, event: OperationRemovedEvent): OperationsState {
	if (!state.ready || event.seq <= state.seq) return state;
	if (!(event.id in state.byId)) return { ...state, seq: event.seq };
	const { [event.id]: _gone, ...rest } = state.byId;
	return { ...state, seq: event.seq, byId: rest };
}

/** An action returned this operation (a web retry gets a new id): show it without waiting for the event. */
export function adoptOperation(state: OperationsState, op: Operation): OperationsState {
	const have = state.byId[op.id];
	if (have && have.updatedAt >= op.updatedAt) return state;
	return { ...state, byId: { ...state.byId, [op.id]: op } };
}

export function forgetOperation(state: OperationsState, id: string): OperationsState {
	if (!(id in state.byId)) return state;
	const { [id]: _gone, ...rest } = state.byId;
	return { ...state, byId: rest };
}

/**
 * What the tray lists, newest activity first. A done or cancelled row stays HIDE_FINISHED_AFTER_MS
 * after it finished; a failed one stays until it is dismissed.
 */
export function visibleOperations(state: OperationsState, now: number): Operation[] {
	return Object.values(state.byId)
		.filter((op) => {
			if (op.state === "failed" || !isTerminalOperation(op)) return true;
			return now - (op.finishedAt ?? op.updatedAt) < HIDE_FINISHED_AFTER_MS;
		})
		.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
}

/** When a finished row should disappear next, or null. Lets the caller schedule one timer. */
export function nextHideAt(state: OperationsState, now: number): number | null {
	let next: number | null = null;
	for (const op of Object.values(state.byId)) {
		if (op.state !== "done" && op.state !== "cancelled") continue;
		const at = (op.finishedAt ?? op.updatedAt) + HIDE_FINISHED_AFTER_MS;
		if (at > now && (next === null || at < next)) next = at;
	}
	return next;
}
