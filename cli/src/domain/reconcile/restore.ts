// Port of internal/storage/tombstone_restore.go: preview and run the reactivation of a Task or Doc
// whose history head is a delete tombstone. The CLI (`knowns reconcile restore`) and, later, the
// MCP `tasks`/`docs` restore actions call these.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "../../storage/adapters.ts";
import { goTrimSpace } from "../../storage/core/util.ts";
import { normalizeDocPath } from "../../storage/history/entities.ts";
import { LIFECYCLE_OPERATION_DELETE } from "../../storage/history/records.ts";
import { NotTombstonedError, toSlash } from "./fs-util.ts";
import { FilesystemReconciler } from "./reconciler.ts";
import type { ReconcileResult } from "./types.ts";

/** TombstoneRestorePlan: a read-only preview of reactivating a tombstoned Task or Doc. */
export interface TombstoneRestorePlan {
  entityType: string;
  entityId: string;
  docPath?: string;
  path: string;
  tombstoned: boolean;
  filePresent: boolean;
  revision: number;
  hash: string;
}

/**
 * PlanTombstoneRestore resolves a Task ID or a Doc path to the entity and the canonical path a
 * restore would use, and writes nothing. A Doc whose file is gone is found through the history
 * path index.
 */
export async function planTombstoneRestore(
  storage: Storage,
  entityType: string,
  refIn: string,
): Promise<TombstoneRestorePlan> {
  const ref = goTrimSpace(refIn);
  if (ref === "") throw new Error(`restore: a ${entityType} reference is required`);
  const plan: TombstoneRestorePlan = {
    entityType,
    entityId: "",
    path: "",
    tombstoned: false,
    filePresent: false,
    revision: 0,
    hash: "",
  };
  switch (entityType) {
    case "task":
      plan.entityId = ref;
      break;
    case "doc": {
      // Normalise exactly as the history writer does, so the lookup key and the stored key cannot
      // drift apart.
      const docPath = normalizeDocPath(toSlash(ref));
      plan.docPath = docPath;
      plan.path = `docs/${docPath}.md`;
      let id = "";
      try {
        const doc = storage.docs.get(docPath);
        if (goTrimSpace(doc.id ?? "") !== "") id = doc.id as string;
      } catch {
        // fall through to the history lookup
      }
      if (id === "") {
        // The file is gone, so the stable ID comes from the history itself.
        id = (await storage.versions.historyStore().findEntityByPathMetadata("doc", docPath)) ?? "";
      }
      plan.entityId = id;
      if (plan.entityId === "") throw new Error(`restore: no history found for doc "${docPath}"`);
      break;
    }
    default:
      throw new Error(`restore: unknown entity type "${entityType}": use task or doc`);
  }
  const stream = storage.history.readPreview(entityType, plan.entityId);
  const records = stream.records ?? [];
  const head = records[records.length - 1];
  if (!head) throw new Error(`restore: ${entityType} "${plan.entityId}" has no history`);
  plan.revision = head.revision;
  plan.hash = head.newHash ?? "";
  plan.tombstoned = !!head.tombstone && head.operation === LIFECYCLE_OPERATION_DELETE;
  if (entityType === "task" && toSlash(head.currentPath ?? "").startsWith("tasks/")) {
    plan.path = toSlash(head.currentPath as string);
  }
  if (plan.path !== "" && existsSync(join(storage.store.root, ...plan.path.split("/")))) {
    plan.filePresent = true;
  }
  return plan;
}

/**
 * RestoreTombstoned reactivates the entity a plan describes. The plan's head hash is the expected
 * base, so a history that moved after the plan was made fails with a conflict instead of
 * restoring stale state. It refuses when the file on disk holds content the tombstone did not
 * record.
 */
export async function restoreTombstoned(
  storage: Storage,
  plan: TombstoneRestorePlan,
  actor: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ReconcileResult> {
  if (!plan.tombstoned) {
    throw new NotTombstonedError(`${plan.entityType} ${plan.entityId}`);
  }
  const r = new FilesystemReconciler(
    storage.store.root,
    opts.signal ? { signal: opts.signal } : {},
  );
  return r.restore(plan.entityType, plan.entityId, {
    path: plan.path,
    expectedBaseHash: plan.hash,
    actor,
  });
}
