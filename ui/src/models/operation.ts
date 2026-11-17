// Wire types of the Activity Tray (spec specs/2026-11-17/activity-tray, "Event and snapshot
// contract"). Mirrors cli/src/runtime/operation-types.ts; keep the two in step.

export type OperationSource = "web" | "daemon";

export type OperationState = "queued" | "running" | "cancelling" | "done" | "failed" | "cancelled";

export interface OperationProgress {
	done: number;
	total: number;
}

export interface Operation {
	/** `op_*` for web operations, `job:<jobId>` for daemon jobs. Rows are keyed by this. */
	id: string;
	source: OperationSource;
	kind: string;
	title: string;
	project: string | null;
	projectRoot: string | null;
	state: OperationState;
	/** null: indeterminate. */
	progress: OperationProgress | null;
	cancellable: boolean;
	retryable: boolean;
	/** One line, only when failed. */
	error: string | null;
	/** Display text, e.g. "125 archived, 375 left". */
	message: string | null;
	startedAt: number;
	updatedAt: number;
	finishedAt: number | null;
}

export interface OperationSnapshot {
	seq: number;
	operations: Operation[];
}

export interface OperationEvent {
	seq: number;
	operation: Operation;
}

export interface OperationRemovedEvent {
	seq: number;
	id: string;
}

export const isTerminalOperation = (op: Pick<Operation, "state">): boolean =>
	op.state === "done" || op.state === "failed" || op.state === "cancelled";
