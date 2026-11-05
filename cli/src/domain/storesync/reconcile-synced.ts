// reconcileSynced (internal/cli/runtime.go): records entities that arrived through store sync in
// local history and queues their reindexing, through the same reconciler the knowledge watcher
// uses for any external file change (store spec FR-20, D9).
import { join } from "node:path";
import { goLogf } from "../../runtime/queue.ts";
import { DEFAULT_LIFECYCLE_BATCH_LIMIT } from "../reconcile/types.ts";

export async function reconcileSynced(
  _signal: AbortSignal,
  knowledgeRoot: string,
  relPaths: string[],
): Promise<void> {
  const now = new Date();
  const hints: { path: string; at: Date }[] = [];
  for (const raw of relPaths) {
    const rel = raw.replaceAll("\\", "/");
    if (!rel.startsWith("tasks/") && !rel.startsWith("archive/") && !rel.startsWith("docs/"))
      continue;
    hints.push({ path: join(knowledgeRoot, ...rel.split("/")), at: now });
  }
  if (hints.length === 0) return;
  try {
    const { FilesystemReconciler } = await import("../reconcile/reconciler.ts");
    const { runtimeIndexEnqueuer } = await import("../../runtime/executor.ts");
    const reconciler = new FilesystemReconciler(knowledgeRoot, {
      index: runtimeIndexEnqueuer(knowledgeRoot),
    });
    await reconciler.reconcileLifecycleBatchWithOptions(
      { source: "sync", hints, limit: DEFAULT_LIFECYCLE_BATCH_LIMIT },
      true,
      true,
    );
  } catch (e) {
    goLogf(`[storesync] reconcile ${knowledgeRoot}: ${(e as Error).message}`);
  }
}
