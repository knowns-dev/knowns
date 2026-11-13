// Port of internal/storage/sync_provenance.go: remembers which files last changed through store
// sync, so a stale-hash conflict on such a file can say who changed it and when (FR-12, FR-13).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Doc } from "../../models/doc.ts";
import { writeJson } from "../core/util.ts";
import { asMutationConflict, MutationConflictError } from "./conflicts.ts";
import { normalizeDocPath } from "./entities.ts";
import { type AnyMap, goTime } from "./go-json.ts";

/**
 * SyncArrival records that a file of a store-linked project last changed through store sync: who
 * wrote it and when it arrived here. It lives in the machine-local history state, never synced.
 */
export interface SyncArrival {
  /** Relative to the knowledge root, slash-separated. */
  path: string;
  author: string;
  commit?: string;
  arrivedAt: string;
  /** SHA-256 of the file as it arrived; a later local write no longer matches it. */
  contentSha: string;
}

export function syncArrivalsPath(knowledgeRoot: string): string {
  return join(knowledgeRoot, "history", "state", "sync-arrivals.json");
}

function fileSha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readArrivals(root: string): Record<string, SyncArrival> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(syncArrivalsPath(root), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Go marshals the map sorted by key and each arrival in struct order. */
function arrivalsOut(known: Record<string, SyncArrival>): AnyMap {
  const out: AnyMap = {};
  for (const key of Object.keys(known).sort()) {
    const a = known[key] as SyncArrival;
    const entry: AnyMap = { path: a.path, author: a.author };
    if (a.commit) entry.commit = a.commit;
    entry.arrivedAt = goTime(a.arrivedAt);
    entry.contentSha = a.contentSha;
    out[key] = entry;
  }
  return out;
}

/**
 * RecordSyncArrivals remembers files that just arrived through sync. The content hash is taken
 * from the file on disk when not supplied; a path that no longer exists is forgotten.
 */
export function recordSyncArrivals(
  knowledgeRoot: string,
  arrivals: readonly (Omit<SyncArrival, "contentSha"> & { contentSha?: string })[],
): void {
  if (arrivals.length === 0) return;
  const known = readArrivals(knowledgeRoot) ?? {};
  for (const input of arrivals) {
    const a: SyncArrival = {
      ...input,
      path: input.path.replaceAll("\\", "/"),
      contentSha: input.contentSha ?? "",
    };
    if (a.contentSha === "") {
      try {
        a.contentSha = fileSha(join(knowledgeRoot, ...a.path.split("/")));
      } catch {
        delete known[a.path];
        continue;
      }
    }
    known[a.path] = a;
  }
  writeJson(syncArrivalsPath(knowledgeRoot), arrivalsOut(known));
}

/** The arrival that explains the current content of `rel`, if it is still exactly what arrived. */
export function syncArrivalFor(root: string, rel: string): SyncArrival | undefined {
  const known = readArrivals(root);
  if (!known) return undefined;
  const key = rel.replaceAll("\\", "/");
  const a = known[key];
  if (!a) return undefined;
  try {
    if (fileSha(join(root, ...key.split("/"))) !== a.contentSha) return undefined;
  } catch {
    return undefined;
  }
  return a;
}

/**
 * SyncConflictError is a stale write whose current state arrived through store sync. Its message
 * tells the caller everything needed to recover without another diagnostic call.
 */
export class SyncConflictError extends MutationConflictError {
  override readonly name: string = "SyncConflictError";
  constructor(
    conflict: MutationConflictError,
    readonly path: string,
    readonly author: string,
    readonly arrivedAt: string,
  ) {
    super(conflict.entityType, conflict.entityId, conflict.expectedHash, conflict.currentHash);
    const noun = this.entityType;
    const stamp = new Date(arrivedAt).toISOString().replace(/\.\d+Z$/, "Z");
    this.message = `${noun} ${JSON.stringify(this.label())} was changed by ${author} and arrived through store sync at ${stamp}, after the version your write was based on. Nothing was written. Reread the ${noun} and apply your change to the version you just read.`;
    this.cause = conflict;
  }

  /** Names the entity the way its caller addressed it: a Doc by its path, a task by its ID. */
  label(): string {
    if (this.entityType === "doc" && this.path.startsWith("docs/")) {
      return this.path.slice("docs/".length).replace(/\.md$/, "");
    }
    return this.entityId;
  }
}

/** The lookups explainConflict needs from the entity stores. */
export interface SyncConflictResolver {
  root: string;
  taskCanonicalPath(id: string): Promise<string | undefined> | string | undefined;
  listDocs(): Promise<Doc[] | undefined> | Doc[] | undefined;
}

/** conflictPaths: files, relative to the knowledge root, that may hold the entity of a conflict. */
async function conflictPaths(r: SyncConflictResolver, c: MutationConflictError): Promise<string[]> {
  if (c.entityType === "task") {
    const abs = await r.taskCanonicalPath(c.entityId);
    if (abs === undefined) return [];
    return [relative(r.root, abs).split(sep).join("/")];
  }
  if (c.entityType === "doc") {
    const id = normalizeDocPath(c.entityId);
    const paths = [`docs/${id}.md`];
    let exists = true;
    try {
      readFileSync(join(r.root, "docs", ...`${id}.md`.split("/")));
    } catch {
      exists = false;
    }
    if (!exists) {
      const docs = await r.listDocs();
      for (const d of docs ?? []) {
        if (d.id === c.entityId) paths.push(`docs/${d.path.replace(/\.md$/, "")}.md`);
      }
    }
    return paths;
  }
  return [];
}

/**
 * explainConflict turns a stale-hash conflict into a SyncConflictError when the entity's current
 * state is exactly what store sync delivered. Any other error is returned unchanged.
 */
export async function explainConflict(r: SyncConflictResolver, err: unknown): Promise<unknown> {
  const conflict = asMutationConflict(err);
  if (err === null || err === undefined || !conflict) return err;
  if (conflict instanceof SyncConflictError) return err;
  for (const rel of await conflictPaths(r, conflict)) {
    const a = syncArrivalFor(r.root, rel);
    if (a) return new SyncConflictError(conflict, rel, a.author || "a teammate", a.arrivedAt);
  }
  return err;
}
