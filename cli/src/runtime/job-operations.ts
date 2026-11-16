// The daemon job source of the Activity Tray (spec specs/2026-11-17/activity-tray, "Event and
// snapshot contract"): the queue's jobs seen as Operations.
//
// Nothing here polls. `observeJobs` is called by the daemon loop on a tick it was already
// running (a queue file changed, a job started or ended) and only while someone subscribed; it
// diffs the queues against what it reported last and calls the subscribers. The queue format is
// untouched, so 0.34.x reads the same files.
import { basename, dirname } from "node:path";
import { cancelRequested, isCancellableKind, requestJobCancel } from "./job-cancel.ts";
import type { JobCancelResult, Operation, OperationState } from "./operation-types.ts";
import {
  enqueueReindex,
  isReleasableDeadLetter,
  type Job,
  type JobKind,
  type JobResult,
  loadQueueCached,
  registeredProjects,
  retryJob,
  updateQueue,
} from "./queue.ts";

const TITLES: Record<string, string> = {
  "reindex-search": "Rebuilding the search index",
  "reconcile-qdrant": "Syncing the Qdrant index",
  "reconcile-knowledge": "Checking edited knowledge files",
  "semantic-search": "Running a semantic search",
  "index-task": "Indexing a task",
  "remove-task": "Removing a task from the index",
  "index-doc": "Indexing a doc",
  "remove-doc": "Removing a doc from the index",
  "index-memory": "Indexing a memory",
  "remove-memory": "Removing a memory from the index",
  "index-decision": "Indexing a decision",
  "remove-decision": "Removing a decision from the index",
  "index-all-files": "Indexing files",
  "index-file": "Indexing a file",
  "remove-file": "Removing a file from the index",
};

export const jobTitle = (kind: string): string => TITLES[kind] ?? kind;

/** The folder name that holds `.knowns`, or the store folder's own name. */
export function projectName(root: string): string {
  const base = basename(root);
  return base === ".knowns" ? basename(dirname(root)) : base;
}

const ms = (v: string | null | undefined): number => {
  const t = v ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : Date.now();
};

const progressOf = (j: { processed?: number; total?: number; details?: unknown }) => {
  const d = (j.details ?? {}) as { processed?: number; total?: number };
  const total = j.total ?? d.total ?? 0;
  const done = j.processed ?? d.processed ?? 0;
  return total > 0 ? { done: Math.min(done, total), total } : null;
};

function jobOperation(root: string, job: Job, cancelling: boolean): Operation {
  const running = !!job.startedAt;
  const dead = job.deadLetter === true;
  let state: OperationState = running ? "running" : "queued";
  if (dead) state = "failed";
  else if (running && cancelling) state = "cancelling";
  return {
    id: `job:${job.id}`,
    source: "daemon",
    kind: job.kind,
    title: jobTitle(job.kind),
    project: projectName(root),
    projectRoot: root,
    state,
    progress: running ? progressOf(job) : null,
    cancellable: !dead && (running ? isCancellableKind(job.kind) && !cancelling : true),
    retryable: dead && isReleasableDeadLetter(job),
    error: job.lastError ? job.lastError : null,
    message: job.phase && running ? job.phase : null,
    startedAt: ms(job.startedAt ?? job.requestedAt),
    updatedAt: Date.now(),
    finishedAt: null,
  };
}

function resultOperation(root: string, r: JobResult): Operation {
  const cancelled = (r as { cancelled?: boolean }).cancelled === true;
  const state: OperationState = cancelled ? "cancelled" : r.success ? "done" : "failed";
  const finished = ms(r.completedAt);
  return {
    id: `job:${r.jobId}`,
    source: "daemon",
    kind: r.kind,
    title: jobTitle(r.kind),
    project: projectName(root),
    projectRoot: root,
    state,
    progress: progressOf(r),
    cancellable: false,
    retryable: state !== "done" && r.kind === "reindex-search",
    error: state === "failed" && r.error ? r.error : null,
    message: cancelled ? "Stopped; the next run continues from the saved work" : null,
    startedAt: ms(r.startedAt),
    updatedAt: finished,
    finishedAt: finished,
  };
}

const KNOWN = (j: Job): boolean => typeof j.kind === "string" && j.kind in TITLES;

function readProjects(): string[] {
  try {
    return registeredProjects();
  } catch {
    return [];
  }
}

/** Queued, running and dead-lettered jobs of the registered projects. */
export function listJobOperations(projects: string[] = readProjects()): Operation[] {
  const out: Operation[] = [];
  for (const root of projects) {
    let jobs: Job[];
    try {
      jobs = loadQueueCached(root).jobs;
    } catch {
      continue;
    }
    for (const j of jobs) if (KNOWN(j)) out.push(jobOperation(root, j, cancelRequested(j.id)));
  }
  return out;
}

// --- subscription and diff ----------------------------------------------------------------------

const listeners = new Set<(op: Operation) => void>();
/** What was last reported per operation id, as a comparable string. */
let seen: Map<string, string> | undefined;
const reportedResults = new Set<string>();
const MAX_REPORTED = 500;

const sig = (o: Operation): string =>
  `${o.state}|${o.progress?.done ?? ""}/${o.progress?.total ?? ""}|${o.message ?? ""}|${o.error ?? ""}|${o.cancellable}`;

export function onJobOperation(cb: (op: Operation) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      seen = undefined;
      reportedResults.clear();
    }
  };
}

/** True while someone listens: the daemon loop only observes then. */
export const hasJobListeners = (): boolean => listeners.size > 0;

function emit(op: Operation): void {
  for (const cb of listeners) {
    try {
      cb(op);
    } catch {
      // a listener must not break the loop
    }
  }
}

/**
 * Reports what changed in the queues since the last call. The first call after a subscription is
 * the baseline (the subscriber has the snapshot from `listJobOperations`).
 */
export function observeJobs(projects: string[] = readProjects()): void {
  if (listeners.size === 0) return;
  const now = new Map<string, Operation>();
  const results: { root: string; r: JobResult }[] = [];
  for (const root of projects) {
    try {
      const q = loadQueueCached(root);
      for (const j of q.jobs) {
        if (KNOWN(j)) now.set(`job:${j.id}`, jobOperation(root, j, cancelRequested(j.id)));
      }
      for (const r of q.recent ?? []) results.push({ root, r });
    } catch {
      // an unreadable queue reports nothing
    }
  }
  const baseline = seen === undefined;
  const next = new Map<string, string>();
  for (const [id, op] of now) {
    const s = sig(op);
    next.set(id, s);
    if (!baseline && seen?.get(id) !== s) emit(op);
  }
  for (const { root, r } of results) {
    const id = `job:${r.jobId}`;
    if (reportedResults.has(id)) continue;
    // A result of a job that was never listed or was listed live is final.
    if (baseline) {
      reportedResults.add(id);
      continue;
    }
    if (now.has(id)) continue; // a retry copy of the same job is back in the queue
    reportedResults.add(id);
    emit(resultOperation(root, r));
  }
  if (reportedResults.size > MAX_REPORTED) {
    const keep = [...reportedResults].slice(-MAX_REPORTED / 2);
    reportedResults.clear();
    for (const k of keep) reportedResults.add(k);
  }
  seen = next;
}

// --- cancel and retry ---------------------------------------------------------------------------

/**
 * Cancels a job. A queued job is removed from the queue; a running reindex is asked to stop at its
 * next safe point; any other running job reports `not_cancellable` (its operation says so too).
 * Idempotent: a job that is gone, or already finished, answers `gone`.
 */
export async function cancelJobOperation(
  projectRoot: string,
  jobId: string,
): Promise<JobCancelResult> {
  let job: Job | undefined;
  try {
    job = loadQueueCached(projectRoot).jobs.find((j) => j.id === jobId);
  } catch {
    return "gone";
  }
  if (!job) return "gone";
  if (job.deadLetter) return "not_cancellable";
  if (job.startedAt) {
    if (!isCancellableKind(job.kind)) return "not_cancellable";
    requestJobCancel(jobId);
    observeJobs();
    return "cancelling";
  }
  let removed: Job | undefined;
  updateQueue(projectRoot, (state) => {
    const i = state.jobs.findIndex((j) => j.id === jobId && !j.startedAt);
    if (i < 0) return;
    removed = state.jobs[i];
    state.jobs.splice(i, 1);
  });
  if (!removed) {
    // It started between the read and the write: treat it as a running job.
    return cancelJobOperation(projectRoot, jobId);
  }
  // The runner may already hold it (its start mark is written late). The request makes a reindex
  // it picked up stop at its first check. A job that cannot stop runs on, and its result then
  // replaces the "cancelled" below with what really happened (done or failed): observeJobs reports
  // the result of any job it has not reported a result for.
  requestJobCancel(jobId);
  const op = jobOperation(projectRoot, removed, false);
  const t = Date.now();
  emit({
    ...op,
    state: "cancelled",
    cancellable: false,
    retryable: false,
    message: "Removed from the queue",
    updatedAt: t,
    finishedAt: t,
  });
  if (seen) seen.delete(`job:${jobId}`);
  return "cancelled";
}

/** Re-runs a failed or cancelled job: a dead-lettered Qdrant job is released, a reindex is queued again. */
export async function retryJobOperation(projectRoot: string, jobId: string): Promise<boolean> {
  try {
    const job = loadQueueCached(projectRoot).jobs.find((j) => j.id === jobId);
    if (job) {
      if (!isReleasableDeadLetter(job)) return false;
      retryJob(projectRoot, jobId);
      return true;
    }
    const r = (loadQueueCached(projectRoot).recent ?? []).find((x) => x.jobId === jobId);
    if (r && !r.success && (r.kind as JobKind) === "reindex-search") {
      enqueueReindex(projectRoot);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
