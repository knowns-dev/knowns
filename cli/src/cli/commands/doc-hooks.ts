// Seams the doc commands call after a mutation. Defaults are inert: the background search indexer
// (internal/search BestEffort*) and the lifecycle reconciler (FilesystemReconciler.HardDelete) are
// owned by other subtasks (search runtime queue, reconciler) and plug in here without this module
// importing them.
import type { Storage } from "../../storage/adapters.ts";

export interface DocHardDeleteRequest {
  storage: Storage;
  docID: string;
  docPath: string;
  /** `docs/<path>.md`, relative to the knowledge root. */
  canonicalPath: string;
  reason: string;
  expectedHash: string;
  actor: string;
}

export interface DocHooks {
  /** search.BestEffortIndexDoc. */
  indexDoc(storage: Storage, docPath: string): void;
  /** search.BestEffortRemoveDocID. */
  removeDocID(storage: Storage, docID: string, docPath: string): void;
  /** search.BestEffortRenameDoc. */
  renameDoc(storage: Storage, docID: string, oldPath: string, newPath: string): void;
  /** Bootstraps the doc into the filesystem history and purges it; absent until the reconciler lands. */
  hardDelete: ((req: DocHardDeleteRequest) => Promise<void>) | undefined;
}

export const docHooks: DocHooks = {
  indexDoc: () => {},
  removeDocID: () => {},
  renameDoc: () => {},
  hardDelete: undefined,
};
