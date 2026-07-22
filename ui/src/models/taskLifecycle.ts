import type { TaskLifecycleState } from "./task";

export type TaskLifecycleOperation =
	| "archive"
	| "reopen"
	| "batch_archive"
	| "batch_unarchive"
	| "hard_delete";

export type TaskLifecycleReasonCode =
	| "not_done"
	| "already_archived"
	| "already_active"
	| "already_deleted"
	| "invalid_request"
	| "auto_archive_disabled"
	| "completed_at_missing"
	| "retention_pending"
	| "active_timer"
	| "unfinished_descendant"
	| "confirmation_required"
	| "delete_reason_required"
	| "permission_required"
	| "tombstone_conflict"
	| "not_found"
	| "operation_failed";

export type TaskLifecycleWarningCode = "durable_knowledge_review" | "event_delivery_failed";

export interface TaskLifecycleReason {
	code: TaskLifecycleReasonCode;
	message: string;
	relatedTaskId?: string;
	deadline?: Date;
}

export interface TaskLifecycleWarning {
	code: TaskLifecycleWarningCode;
	message: string;
	references?: string[];
}

export interface TaskLifecycleEvent {
	id: string;
	type: TaskLifecycleOperation;
	taskId: string;
	at: Date;
	actor?: string;
	reason?: string;
	from: TaskLifecycleState;
	to: TaskLifecycleState;
	automatic?: boolean;
}

export interface TaskLifecycleResult {
	taskId: string;
	operation: TaskLifecycleOperation;
	changed: boolean;
	eligible: boolean;
	before: TaskLifecycleState;
	after: TaskLifecycleState;
	reasons: TaskLifecycleReason[];
	warnings?: TaskLifecycleWarning[];
	event?: TaskLifecycleEvent;
	completedAt?: Date;
	archivedAt?: Date;
	deadline?: Date;
}

export interface TaskLifecycleResponse {
	operation: TaskLifecycleOperation;
	execute: boolean;
	completed: boolean;
	processed: number;
	changed: number;
	failedTaskId?: string;
	items: TaskLifecycleResult[];
}

export interface TaskLifecycleRequest {
	operation: TaskLifecycleOperation;
	taskId?: string;
	ids?: string[];
	execute: boolean;
	actor?: string;
	reason?: string;
	confirmed?: boolean;
	status?: string;
	minimumAgeMs?: number;
}

export interface TaskLifecycleSettings {
	excludeDoneFromDefaultRetrieval: boolean;
	autoArchive: boolean;
	archiveAfter: string;
	purgeAfter: string | null;
}

export const DEFAULT_TASK_LIFECYCLE_SETTINGS: TaskLifecycleSettings = {
	excludeDoneFromDefaultRetrieval: true,
	autoArchive: true,
	archiveAfter: "30d",
	purgeAfter: null,
};

export const TASK_LIFECYCLE_REASON_LABELS: Record<TaskLifecycleReasonCode, string> = {
	not_done: "Task is not done",
	already_archived: "Already archived",
	already_active: "Already active",
	already_deleted: "Already deleted",
	invalid_request: "Invalid request",
	auto_archive_disabled: "Auto-archive is disabled",
	completed_at_missing: "Completion time is missing",
	retention_pending: "Retention period has not elapsed",
	active_timer: "Timer is still active",
	unfinished_descendant: "A descendant task is unfinished",
	confirmation_required: "Confirmation is required",
	delete_reason_required: "A deletion reason is required",
	permission_required: "Permission is required",
	tombstone_conflict: "Deletion record conflicts",
	not_found: "Task was not found",
	operation_failed: "Operation failed",
};

export function formatLifecycleState(state: TaskLifecycleState): string {
	return state.charAt(0).toUpperCase() + state.slice(1);
}
