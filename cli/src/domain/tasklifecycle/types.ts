// Port of internal/tasklifecycle/types.go. The library owns Task lifecycle policy and mutations;
// CLI, MCP and the HTTP server call it instead of composing storage operations. It has no CLI
// imports.
//
// Timestamps are RFC 3339 strings in the form Go's time.Time marshals to (UTC, trailing zeros
// trimmed), exactly as the models carry them. Durations that Go holds as time.Duration are
// milliseconds here.
import type { Task, TaskLifecycleState, TimeEntry } from "../../models/index.ts";

export type Operation = "archive" | "reopen" | "batch_archive" | "batch_unarchive" | "hard_delete";

export const OperationArchive: Operation = "archive";
export const OperationReopen: Operation = "reopen";
export const OperationBatchArchive: Operation = "batch_archive";
export const OperationBatchUnarchive: Operation = "batch_unarchive";
export const OperationHardDelete: Operation = "hard_delete";

export type ReasonCode =
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

export type WarningCode = "durable_knowledge_review" | "event_delivery_failed";

/** A stable, machine-readable explanation for an ineligible action. */
export interface Reason {
  code: ReasonCode;
  message: string;
  relatedTaskId?: string;
  deadline?: string;
}

/** Never blocks a lifecycle mutation. */
export interface Warning {
  code: WarningCode;
  message: string;
  references?: string[];
}

export interface Eligibility {
  taskId: string;
  eligible: boolean;
  lifecycle: TaskLifecycleState;
  completedAt?: string;
  archivedAt?: string;
  deadline?: string;
  reasons: Reason[];
  warnings?: Warning[];
}

/** Returned for every successful mutation so every surface can publish equivalent audit metadata. */
export interface LifecycleEvent {
  id: string;
  type: Operation;
  taskId: string;
  at: string;
  actor?: string;
  reason?: string;
  from: TaskLifecycleState;
  to: TaskLifecycleState;
  automatic?: boolean;
}

/** A lifecycle state, or "" for a Result that never observed the Task. */
export type LifecycleStateOrEmpty = TaskLifecycleState | "";

export interface Result {
  taskId: string;
  operation: Operation;
  changed: boolean;
  eligible: boolean;
  before: LifecycleStateOrEmpty;
  after: LifecycleStateOrEmpty;
  /** null where Go's slice is nil (an eligible preview): it marshals as null, not []. */
  reasons: Reason[] | null;
  warnings?: Warning[];
  event?: LifecycleEvent;
  completedAt?: string;
  archivedAt?: string;
  deadline?: string;
}

export interface ArchiveOptions {
  actor?: string;
  expectedHash?: string;
  /** Applies project auto-archive enablement and retention. */
  automatic?: boolean;
  /** A caller-selected retention threshold in ms; an explicit 0 stays distinct from "none". */
  minimumAgeMs?: number;
}

export interface ReopenOptions {
  actor?: string;
  status?: string;
  expectedHash?: string;
}

export interface HardDeleteOptions {
  actor?: string;
  reason?: string;
  confirmed?: boolean;
  expectedHash?: string;
}

export interface BatchOptions {
  ids?: string[];
  execute?: boolean;
  actor?: string;
  automatic?: boolean;
  minimumAgeMs?: number;
  expectedHashes?: Record<string, string>;
}

export interface BatchResult {
  operation: Operation;
  execute: boolean;
  completed: boolean;
  processed: number;
  changed: number;
  failedTaskId?: string;
  items: Result[];
}

/**
 * The stable public lifecycle contract shared by CLI, MCP, HTTP and WebUI adapters.
 * Authorization is intentionally absent: trusted adapters pass it separately to executePublic.
 */
export interface Request {
  operation: Operation;
  taskId?: string;
  ids?: string[];
  execute: boolean;
  actor?: string;
  reason?: string;
  confirmed?: boolean;
  status?: string;
  minimumAgeMs?: number;
  expectedHash?: string;
  expectedHashes?: Record<string, string>;
}

export interface PublicCapabilities {
  archive: boolean;
  hardDelete: boolean;
}

export interface Response {
  operation: Operation;
  execute: boolean;
  completed: boolean;
  processed: number;
  changed: number;
  failedTaskId?: string;
  items: Result[];
}

/** Keeps the caller's patch logic inside the lifecycle lock; `mutate` gets a fresh copy. */
export interface TaskUpdateOptions {
  actor?: string;
  expectedHash?: string;
  mutate?: (task: Task) => void | Promise<void>;
}

export interface ReorderItem {
  taskId: string;
  order: number;
}

export interface TimeMutationOptions {
  actor?: string;
  expectedHash?: string;
  entry: TimeEntry;
}

export interface StopTimerOptions {
  actor?: string;
  expectedHash?: string;
}

export interface StopTimersOptions {
  actor?: string;
  expectedHashes?: Record<string, string>;
}

export interface Hooks {
  indexTask?: (taskId: string) => void | Promise<void>;
  removeTask?: (taskId: string) => void | Promise<void>;
  /**
   * At-least-once across process crashes; consumers must deduplicate by `LifecycleEvent.id`.
   * Durable claims prevent concurrent normal-case delivery.
   */
  emit?: (event: LifecycleEvent) => void | Promise<void>;
}
