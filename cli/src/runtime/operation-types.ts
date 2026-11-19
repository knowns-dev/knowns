// The wire types of the Activity Tray (spec specs/2026-11-17/activity-tray, "Event and snapshot
// contract"). The server registry, the daemon job source (job-operations.ts) and the UI all import
// these; the spec text and this file must agree.

export type OperationSource = "web" | "daemon";

export type OperationState = "queued" | "running" | "cancelling" | "done" | "failed" | "cancelled";

export const TERMINAL_STATES: readonly OperationState[] = ["done", "failed", "cancelled"];

export const isTerminalState = (s: OperationState): boolean => TERMINAL_STATES.includes(s);

export interface OperationProgress {
  done: number;
  total: number;
}

export interface Operation {
  /** `op_<base36 time>_<counter>` for web operations, `job:<jobId>` for daemon jobs. */
  id: string;
  source: OperationSource;
  /** batch_archive, batch_unarchive, import, sync, reindex; daemon: the queue's job kind. */
  kind: string;
  /** Readable, written by the producer ("Archiving 240 tasks"). */
  title: string;
  /** Project display name. */
  project: string | null;
  projectRoot: string | null;
  state: OperationState;
  /** null: indeterminate. */
  progress: OperationProgress | null;
  /** True only where a cancel request does something safe right now. */
  cancellable: boolean;
  /** True only for a failed or cancelled operation whose kind can re-run the same request. */
  retryable: boolean;
  /** One-line reason when failed. */
  error: string | null;
  /** One-line outcome, e.g. "125 archived, 375 left". */
  message: string | null;
  /** Epoch milliseconds. */
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

/** SSE event names on GET /api/events. */
export type OperationEventName =
  | "operation:started"
  | "operation:updated"
  | "operation:finished"
  | "operation:removed";

export interface OperationEvent {
  seq: number;
  operation: Operation;
}

export interface OperationRemovedEvent {
  seq: number;
  id: string;
}

/** GET /api/operations */
export interface OperationSnapshot {
  seq: number;
  operations: Operation[];
  /** The project this server shows now (the daemon rows' `projectRoot` of the same project); the tray scopes to it by default. */
  currentProjectRoot?: string | null;
}

/** Cancel outcome of the daemon job source. */
export type JobCancelResult = "cancelled" | "cancelling" | "not_cancellable" | "gone";

/** The daemon job source (cli/src/runtime/job-operations.ts). */
export interface JobOperationSource {
  listJobOperations(): Operation[];
  onJobOperation(cb: (op: Operation) => void): () => void;
  cancelJobOperation(projectRoot: string, jobId: string): Promise<JobCancelResult>;
  retryJobOperation(projectRoot: string, jobId: string): Promise<boolean>;
  /** Re-reads the queues and reports what changed to the subscribers (the daemon loop calls it on its tick; a server without that loop calls it from a directory watch). */
  observeJobs?(): void;
}

export const OPERATION_EVENT_MIN_INTERVAL_MS = 250;
export const OPERATION_DONE_EXPIRY_MS = 15_000;
export const OPERATION_FAILED_CAP = 50;
/** A failed daemon job older than this is history, not a current problem: the tray does not show it. */
export const OPERATION_FAILED_MAX_AGE_MS = 24 * 3_600_000;
