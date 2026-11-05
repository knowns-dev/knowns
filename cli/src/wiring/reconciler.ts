// Seam wiring for the automatic reconciler (TSR-MBTAN6). Startup calls installReconciler() once;
// it fills the seams the ported commands and the runtime leave open:
//
//   docHooks.hardDelete                    `knowns doc hard-delete` (FilesystemReconciler.HardDelete)
//   taskLifecycleSeams.purgeReconciler     `knowns task hard-delete` (PurgeTaskLifecycle)
//   runtimeSeams.reconcileKnowledge        the `reconcile-knowledge` runtime job
//                                          (internal/search/runtime_jobs.go JobReconcileKnowledge)
//
// It deliberately leaves the indexing seams alone: those belong to the search runtime wiring.
import { docHooks } from "../cli/commands/doc-hooks.ts";
import { taskLifecycleSeams } from "../cli/commands/task-lifecycle.ts";
import { createTaskPurgeReconciler, hardDeleteDoc } from "../domain/reconcile/purge.ts";
import { runtimeSeams } from "../runtime/executor.ts";

export function installReconciler(): void {
  docHooks.hardDelete = (req) => hardDeleteDoc(req);
  taskLifecycleSeams.purgeReconciler = createTaskPurgeReconciler();
  runtimeSeams.reconcileKnowledge ??= async (storage, onChanged) => {
    const { FilesystemReconciler } = await import("../domain/reconcile/reconciler.ts");
    const reconciler = new FilesystemReconciler(storage.store.root, {
      index: (result) => onChanged(result),
    });
    await reconciler.reconcileLifecycleWithOptions(true, { source: "runtime-job", wait: true });
  };
}
