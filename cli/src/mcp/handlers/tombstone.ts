// Port of internal/mcp/handlers/tombstone_restore.go.
import { docHooks } from "../../cli/commands/doc-hooks.ts";
import { taskLifecycleSeams } from "../../cli/commands/task-lifecycle.ts";
import { errFailed } from "../args.ts";
import { marshalIndent } from "../gojson.ts";
import { notifyDocUpdated, notifyTaskUpdated } from "../notify.ts";
import type { Project } from "../state.ts";
import { type CallToolResult, errorResult, textResult } from "../tool.ts";

export async function tombstoneRestoreResult(
  project: Project,
  entityType: "task" | "doc",
  ref: string,
  execute: boolean,
): Promise<CallToolResult> {
  const { planTombstoneRestore, restoreTombstoned } = await import(
    "../../domain/reconcile/restore.ts"
  );
  const { NotTombstonedError } = await import("../../domain/reconcile/fs-util.ts");
  const { storage, store } = project;
  let plan: Awaited<ReturnType<typeof planTombstoneRestore>>;
  try {
    plan = await planTombstoneRestore(storage, entityType, ref);
  } catch (e) {
    return errFailed("plan restore", e);
  }
  const planJson: Record<string, unknown> = {
    entityType: plan.entityType,
    entityId: plan.entityId,
    ...(plan.docPath ? { docPath: plan.docPath } : {}),
    path: plan.path,
    tombstoned: plan.tombstoned,
    filePresent: plan.filePresent,
    revision: plan.revision,
    hash: plan.hash,
  };
  if (!execute) return textResult(marshalIndent({ execute: false, plan: planJson }));
  let result: Awaited<ReturnType<typeof restoreTombstoned>>;
  try {
    result = await restoreTombstoned(storage, plan, "mcp");
  } catch (e) {
    if (e instanceof NotTombstonedError && entityType === "doc") {
      return errorResult(
        `${e.message}; pass revision to restore an earlier revision of a live document`,
      );
    }
    return errFailed(`restore ${entityType}`, e);
  }
  if (entityType === "task") {
    try {
      await taskLifecycleSeams.indexTask?.(storage, plan.entityId);
    } catch {
      // best effort
    }
    notifyTaskUpdated(store, plan.entityId);
  } else {
    docHooks.indexDoc(storage, plan.docPath ?? "");
    notifyDocUpdated(store, plan.docPath ?? "");
  }
  return textResult(
    marshalIndent({
      execute: true,
      restored: result.changed,
      plan: planJson,
      revision: result.revision,
      hash: result.newHash,
    }),
  );
}
