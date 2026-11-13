// One entity index action against the legacy SQLite store (Go: session.IndexService(store) for a
// non-Qdrant backend). Shared by the in-process best-effort indexer and the runtime daemon's
// index-* / remove-* jobs, so both write the same rows.
import type { SearchEnvironment } from "../../search/config.ts";
import type { Storage } from "../../storage/adapters.ts";
import type { IndexService } from "./index-service.ts";
import type { LegacySemantic } from "./init-semantic.ts";

/** InitSemanticRuntimeSession for the SQLite backend; throws what Go's session init returns. */
export async function openSqliteSemantic(
  storage: Storage,
  env: SearchEnvironment,
): Promise<LegacySemantic> {
  const { initSemanticSqlite } = await import("./init-semantic.ts");
  return initSemanticSqlite(storage, env);
}

/** Runs one index action against an opened SQLite session, then closes it. */
export async function applySqliteIndexAction(
  storage: Storage,
  sem: LegacySemantic,
  action: string,
  target: string,
): Promise<void> {
  const { IndexService } = await import("./index-service.ts");
  try {
    await applyIndexAction(new IndexService(storage, sem.embedder, sem.store), action, target);
  } finally {
    sem.embedder.close();
    sem.store.close();
  }
}

async function applyIndexAction(svc: IndexService, action: string, target: string): Promise<void> {
  switch (action) {
    case "index-task":
      return await svc.indexTask(target);
    case "remove-task":
      return await svc.removeTask(target);
    case "index-doc":
      return await svc.indexDoc(target);
    case "remove-doc":
      return svc.removeDoc(target);
    case "index-memory":
      return await svc.indexMemory(target);
    case "remove-memory":
      return svc.removeMemory(target);
    case "index-decision":
      return await svc.indexDecision(target);
    case "remove-decision":
      return svc.removeDecision(target);
  }
}

export async function runSqliteIndexAction(
  storage: Storage,
  action: string,
  target: string,
  env: SearchEnvironment,
): Promise<void> {
  return applySqliteIndexAction(storage, await openSqliteSemantic(storage, env), action, target);
}
