// The hard-delete coordinators: the phased task purge (internal/storage/task_lifecycle_purge.go)
// and the document purge (internal/cli/doc.go `doc hard-delete`). Both drive FilesystemReconciler.
import { join } from "node:path";
import type { Storage } from "../../storage/adapters.ts";
import type { TaskPurgeReconciler } from "../../storage/history/lifecycle-tx.ts";
import { LIFECYCLE_OPERATION_HARD_DELETE } from "../../storage/history/records.ts";
import { FilesystemReconciler } from "./reconciler.ts";

/** The reconciler behind `taskLifecycleSeams.purgeReconciler`. */
export function createTaskPurgeReconciler(): TaskPurgeReconciler {
  const bootstrapBatch = async (
    {
      root,
      relPath,
      absPath,
      taskId,
    }: { root: string; relPath: string; absPath: string; taskId: string },
    execute: boolean,
  ) => {
    // The bootstrap carries no index callback: it only records the target into the history.
    const bootstrap = new FilesystemReconciler(root, { allowArchive: true });
    if (execute) {
      // D12 (TSR-481DH6), beyond 0.34.1: a Task whose only history is the legacy path-keyed
      // versions/task-<id>.json (written by 0.25.x and older) is converted to its id-keyed stream
      // here, before the batch. Otherwise the batch migrates it through VersionStore.saveVersion,
      // which refuses because hard-delete already reserved the ID (tombstone saved in phase 1):
      // 0.34.1 then fails with `cannot save version for hard-deleted Task`, and every retry fails
      // the same way, leaving the Task visible but frozen (no edit, no timer). Converting history
      // the Task already has is not a new version, so the reservation is not bypassed for writes.
      // A no-op when the Task already has a stream or no legacy file; idempotent on retry.
      await bootstrap.storage.versions.migrateLegacyTask(taskId);
    }
    const results = await bootstrap.reconcileLifecycleBatch(
      {
        source: "task-hard-delete-bootstrap",
        limit: 4,
        exactEntityType: "task",
        exactEntityId: taskId,
        exactPath: relPath,
        hints: [{ path: absPath, event: "hard_delete", entityType: "task", entityId: taskId }],
      },
      execute,
    );
    return results.map((r) => (r.diagnostic !== "" ? { diagnostic: r.diagnostic } : {}));
  };
  return {
    bootstrapTask: (args) => bootstrapBatch(args, true),
    preflightTask: (args) => bootstrapBatch(args, false),
    async hardDelete({ root, taskId, relPath, reason, actor, expectedHash, remove }) {
      const handoff = remove
        ? async (result: { operation: string; entityId: string }) => {
            if (result.operation !== LIFECYCLE_OPERATION_HARD_DELETE) return;
            await remove(result.entityId);
          }
        : undefined;
      const purge = new FilesystemReconciler(root, {
        allowArchive: true,
        ...(handoff && { index: handoff }),
      });
      await purge.hardDelete("task", taskId, {
        trusted: true,
        confirmed: true,
        reason,
        actor,
        path: relPath,
        expectedHash,
      });
    },
  };
}

export interface DocHardDeleteArgs {
  storage: Storage;
  docID: string;
  canonicalPath: string;
  reason: string;
  expectedHash: string;
  actor: string;
}

/**
 * `knowns doc hard-delete` after its capability, confirmation and hash checks: bootstrap the exact
 * doc into the filesystem history, then run the phased purge.
 */
export async function hardDeleteDoc(args: DocHardDeleteArgs): Promise<void> {
  const root = args.storage.store.root;
  const r = new FilesystemReconciler(root);
  try {
    await r.reconcileLifecycleBatch(
      {
        source: "cli-doc-hard-delete",
        limit: 1,
        exactEntityType: "doc",
        exactEntityId: args.docID,
        exactPath: args.canonicalPath,
        hints: [{ path: join(root, ...args.canonicalPath.split("/")), event: "hard_delete" }],
      },
      true,
    );
  } catch (e) {
    throw new DocReconcileError(e as Error);
  }
  await r.hardDelete("doc", args.docID, {
    trusted: true,
    confirmed: true,
    reason: args.reason,
    actor: args.actor,
    path: args.canonicalPath,
    expectedHash: args.expectedHash,
  });
}

/** Go prints "doc hard-delete reconcile: <err>" for a bootstrap failure. */
export class DocReconcileError extends Error {
  override readonly name = "DocReconcileError";
  constructor(cause: Error) {
    super(`reconcile: ${cause.message}`, { cause });
  }
}
