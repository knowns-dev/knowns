// The daemon job source of the Activity Tray (contract: specs/2026-11-17/activity-tray, "Daemon job
// source"). This is the empty stand-in the server builds against; the daemon job events task
// (KN-7H0YXB) replaces it with the real queue-backed implementation.
import type { JobCancelResult, Operation } from "./operation-types.ts";

export function listJobOperations(): Operation[] {
  return [];
}

export function onJobOperation(_cb: (op: Operation) => void): () => void {
  return () => {};
}

export async function cancelJobOperation(
  _projectRoot: string,
  _jobId: string,
): Promise<JobCancelResult> {
  return "gone";
}

export async function retryJobOperation(_projectRoot: string, _jobId: string): Promise<boolean> {
  return false;
}
