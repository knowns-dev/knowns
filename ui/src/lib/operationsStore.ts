// Pure state of the Activity Tray. The server keeps the truth; the UI takes one snapshot per SSE
// `connect` and applies events whose seq is newer than that snapshot.
//
// Events can arrive while a snapshot request is in flight (or before the first one): they are kept
// in a buffer, and replayed after the snapshot lands if they are newer than it. A snapshot response
// that belongs to an older request than the latest one is ignored, so two snapshots resolving out of
// order cannot bring back an older picture.

import type {
	Operation,
	OperationEvent,
	OperationRemovedEvent,
	OperationSnapshot,
} from "@/ui/models/operation";
import { isTerminalOperation } from "@/ui/models/operation";

type Buffered = ({ kind: "event" } & OperationEvent) | ({ kind: "removed" } & OperationRemovedEvent);

export interface OperationsState {
	/** The snapshot seq, then the highest seq applied. */
	seq: number;
	byId: Record<string, Operation>;
	/** True once a snapshot has been applied. */
	ready: boolean;
	/** The id of the latest snapshot request, 0 before any. A response for another id is stale. */
	request: number;
	/** True while the latest request is unanswered: events wait in `buffer`. */
	loading: boolean;
	/** Events seen since the latest snapshot request started. */
	buffer: Buffered[];
	/** Rows hidden in this tab only (a finished row that aged out). Cleared when the row runs again. */
	hidden: Record<string, true>;
}

export const emptyOperations: OperationsState = {
	seq: 0,
	byId: {},
	ready: false,
	request: 0,
	loading: false,
	buffer: [],
	hidden: {},
};

/** done and cancelled rows older than this are not shown at all (the stack's timer is for the fresh ones). */
export const SHOW_FINISHED_FOR_MS = 4000;

/**
 * A snapshot is about to be requested (the caller numbers its requests, 1, 2, 3...): later events
 * are kept until it is answered, and an answer for an older number is ignored.
 */
export function beginSnapshot(state: OperationsState, request: number): OperationsState {
	return { ...state, request, loading: true, buffer: [] };
}

function put(state: OperationsState, op: Operation): OperationsState {
	const hidden = isTerminalOperation(op) || !(op.id in state.hidden) ? state.hidden : withoutKey(state.hidden, op.id);
	return { ...state, byId: { ...state.byId, [op.id]: op }, hidden };
}

function withoutKey<T extends Record<string, unknown>>(rec: T, key: string): T {
	const { [key]: _gone, ...rest } = rec;
	return rest as T;
}

function applyBuffered(state: OperationsState, e: Buffered): OperationsState {
	if (e.seq <= state.seq) return state;
	if (e.kind === "event") return { ...put(state, e.operation), seq: e.seq };
	return { ...state, seq: e.seq, byId: withoutKey(state.byId, e.id), hidden: withoutKey(state.hidden, e.id) };
}

/**
 * The snapshot answered. Returns the state unchanged when it answers an older request. `now` decides
 * which finished rows are already too old to show.
 */
export function applySnapshot(
	state: OperationsState,
	request: number,
	snapshot: OperationSnapshot,
	now: number,
): OperationsState {
	if (request !== state.request) return state;
	const byId: Record<string, Operation> = {};
	const hidden: Record<string, true> = {};
	for (const op of snapshot.operations) {
		byId[op.id] = op;
		if (isStaleFinished(op, now)) hidden[op.id] = true;
	}
	let next: OperationsState = { ...state, seq: snapshot.seq, byId, hidden, ready: true, loading: false };
	for (const e of state.buffer) next = applyBuffered(next, e);
	return { ...next, buffer: [] };
}

/** The snapshot request failed: stop waiting, apply what was buffered on top of what we had. */
export function failSnapshot(state: OperationsState, request: number): OperationsState {
	if (request !== state.request) return state;
	let next: OperationsState = { ...state, loading: false };
	if (next.ready) for (const e of state.buffer) next = applyBuffered(next, e);
	return { ...next, buffer: [] };
}

/** started, updated and finished carry the whole operation. */
export function applyOperationEvent(state: OperationsState, event: OperationEvent): OperationsState {
	if (state.loading || !state.ready) {
		// Before the first snapshot, or while one is in flight: keep it for the replay.
		return { ...state, buffer: [...state.buffer, { kind: "event", ...event }] };
	}
	return applyBuffered(state, { kind: "event", ...event });
}

export function applyRemoved(state: OperationsState, event: OperationRemovedEvent): OperationsState {
	if (state.loading || !state.ready) {
		return { ...state, buffer: [...state.buffer, { kind: "removed", ...event }] };
	}
	return applyBuffered(state, { kind: "removed", ...event });
}

/** An action returned this operation (a web retry gets a new id): show it without waiting for the event. */
export function adoptOperation(state: OperationsState, op: Operation): OperationsState {
	const have = state.byId[op.id];
	if (have && have.updatedAt >= op.updatedAt) return state;
	return put(state, op);
}

export function forgetOperation(state: OperationsState, id: string): OperationsState {
	if (!(id in state.byId)) return state;
	return { ...state, byId: withoutKey(state.byId, id), hidden: withoutKey(state.hidden, id) };
}

/** Hide a row in this tab only. */
export function hideOperation(state: OperationsState, id: string): OperationsState {
	return id in state.hidden ? state : { ...state, hidden: { ...state.hidden, [id]: true } };
}

/**
 * Whether the stack's own timer should end this row: a done row, or a cancelled one with nothing
 * left to run again. A cancelled row that can be run again stays until it is dismissed.
 */
export function agesOut(op: Operation): boolean {
	return op.state === "done" || (op.state === "cancelled" && !op.retryable);
}

/** A finished row that finished longer ago than it should still be shown (loaded after the fact). */
function isStaleFinished(op: Operation, now: number): boolean {
	return agesOut(op) && now - (op.finishedAt ?? op.updatedAt) >= SHOW_FINISHED_FOR_MS;
}

/**
 * What the tray lists, newest first. A failed row, and a cancelled one that can run again, stay until
 * dismissed; the rest are hidden in this tab by the stack's single timer.
 */
export function visibleOperations(state: OperationsState): Operation[] {
	return Object.values(state.byId)
		.filter((op) => !(op.id in state.hidden))
		.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
}
