// Port of the intent and watermark half of internal/search/qdrant_reconcile.go: building a
// content-free Qdrant intent from canonical state, proving it against the durable history, and the
// per-entity index watermarks (history/state/qdrant-index-watermarks.json).
//
// Everything here is synchronous (history reads use the lock-free `readPreview`), so the public
// mutation hooks (BestEffort*) can stay fire-and-forget like Go's.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import type { HistoryRecord } from "../../models/version.ts";
import { qdrantWatermarkPath } from "../../search/readiness.ts";
import type { Storage } from "../../storage/adapters.ts";
import { tryAcquireFileLock } from "../../storage/core/file-lock.ts";
import { qdrantWatermarkLockPath } from "../../storage/core/locks.ts";
import { canonicalDocHash, canonicalTaskHash } from "../../storage/history/entities.ts";
import { type QdrantIntent, sleepSync } from "../queue.ts";

export const ZERO_TIME = "0001-01-01T00:00:00Z";

export interface Watermark {
  entityType: string;
  entityId: string;
  canonicalHash?: string;
  indexedHash?: string;
  revision?: number;
  path?: string;
  indexedRevision?: number;
  indexedPath?: string;
  /** time.Time: never omitted (zero time when unset). */
  indexedAt?: string;
  stale?: boolean;
  removed?: boolean;
  pendingRemoval?: boolean;
}

export type Watermarks = Record<string, Watermark>;

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function watermarkJson(w: Watermark): unknown {
  return {
    entityType: w.entityType ?? "",
    entityId: w.entityId ?? "",
    ...(w.canonicalHash ? { canonicalHash: w.canonicalHash } : {}),
    ...(w.indexedHash ? { indexedHash: w.indexedHash } : {}),
    ...(w.revision ? { revision: w.revision } : {}),
    ...(w.path ? { path: w.path } : {}),
    ...(w.indexedRevision ? { indexedRevision: w.indexedRevision } : {}),
    ...(w.indexedPath ? { indexedPath: w.indexedPath } : {}),
    indexedAt: w.indexedAt || ZERO_TIME,
    ...(w.stale ? { stale: true } : {}),
    ...(w.removed ? { removed: true } : {}),
    ...(w.pendingRemoval ? { pendingRemoval: true } : {}),
  };
}

/** loadQdrantWatermarks (raw): keeps indexedAt, back-fills the indexed revision of older records. */
export function loadWatermarks(storeRoot: string): Watermarks {
  let data: string;
  try {
    data = readFileSync(qdrantWatermarkPath(storeRoot), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let values: Watermarks | null;
  try {
    values = JSON.parse(data) as Watermarks | null;
  } catch (err) {
    throw new Error(`parse qdrant index watermarks: ${(err as Error).message}`);
  }
  if (values === null || typeof values !== "object") values = {};
  for (const [key, value] of Object.entries(values)) {
    if (value.indexedHash && !value.indexedRevision) {
      value.indexedRevision = value.revision;
      value.indexedPath = value.path;
      values[key] = value;
    }
  }
  return values;
}

export function saveWatermarks(storeRoot: string, values: Watermarks): void {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(values).sort(byteCompare)) {
    sorted[key] = watermarkJson(values[key] as Watermark);
  }
  const path = qdrantWatermarkPath(storeRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = join(dirname(path), `.qdrant-watermark-${randomBytes(6).toString("hex")}`);
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(sorted, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** storage.WithQdrantWatermarkLock, synchronously: the same flock file as the Go binary. */
function withWatermarkLock<T>(storeRoot: string, fn: () => T): T {
  const lockPath = qdrantWatermarkLockPath(storeRoot);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const held = tryAcquireFileLock(lockPath);
    if (held) {
      try {
        return fn();
      } finally {
        held.release();
      }
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`);
    sleepSync(20);
  }
}

function withQdrantWatermarks(storeRoot: string, mutate: (values: Watermarks) => void): void {
  withWatermarkLock(storeRoot, () => {
    const values = loadWatermarks(storeRoot);
    mutate(values);
    saveWatermarks(storeRoot, values);
  });
}

const isDeleteOp = (op: string) => op === "delete" || op === "hard_delete";

export function updateQdrantWatermark(
  storeRoot: string,
  intent: QdrantIntent,
  canonicalHash: string,
  now: string,
): void {
  withQdrantWatermarks(storeRoot, (values) => {
    const key = `${intent.entityType}:${intent.entityId}`;
    const current = values[key];
    if (current) {
      if ((current.revision ?? 0) > intent.revision) return;
      const desiredHash = isDeleteOp(intent.operation)
        ? (intent.canonicalHash ?? "")
        : canonicalHash;
      if (current.revision === intent.revision && current.canonicalHash) {
        if (current.canonicalHash !== desiredHash) {
          throw new Error(
            `qdrant watermark canonical hash conflict for ${key} revision ${intent.revision}`,
          );
        }
        if (intent.entityType !== "task" && current.path && current.path !== (intent.path ?? "")) {
          throw new Error(
            `qdrant watermark canonical path conflict for ${key} revision ${intent.revision}`,
          );
        }
      }
    }
    values[key] = {
      entityType: intent.entityType,
      entityId: intent.entityId,
      canonicalHash,
      indexedHash: canonicalHash,
      revision: intent.revision,
      path: intent.path ?? "",
      indexedRevision: intent.revision,
      indexedPath: intent.path ?? "",
      indexedAt: now,
      stale: false,
    };
    if (isDeleteOp(intent.operation)) {
      values[key] = {
        entityType: intent.entityType,
        entityId: intent.entityId,
        canonicalHash: intent.canonicalHash ?? "",
        revision: intent.revision,
        path: intent.path ?? "",
        indexedAt: now,
        removed: true,
      };
    }
  });
}

/** Durably exposes an accepted public intent as stale before it is queued. */
export function markQdrantIntentPending(storeRoot: string, intent: QdrantIntent): void {
  if (!intent.canonicalHash && !isDeleteOp(intent.operation)) return;
  withQdrantWatermarks(storeRoot, (values) => {
    const key = `${intent.entityType}:${intent.entityId}`;
    const current = values[key];
    if (current && (current.revision ?? 0) > intent.revision) return;
    if (
      current &&
      current.revision === intent.revision &&
      current.canonicalHash &&
      (current.canonicalHash !== (intent.canonicalHash ?? "") ||
        (current.path && current.path !== (intent.path ?? "")))
    ) {
      throw new Error(
        `qdrant watermark canonical hash conflict for ${key} revision ${intent.revision}`,
      );
    }
    values[key] = {
      entityType: intent.entityType,
      entityId: intent.entityId,
      canonicalHash: intent.canonicalHash ?? "",
      indexedHash: current?.indexedHash ?? "",
      revision: intent.revision,
      path: intent.path ?? "",
      indexedRevision: current?.indexedRevision ?? 0,
      indexedPath: current?.indexedPath ?? "",
      indexedAt: current?.indexedAt ?? ZERO_TIME,
      stale: true,
      pendingRemoval: isDeleteOp(intent.operation),
    };
  });
}

// --- manifest ---------------------------------------------------------------------------------

export interface ManifestEntry {
  entityType: string;
  entityId: string;
  path: string;
  hash: string;
  revision: number;
}

function manifestPath(storeRoot: string): string {
  return join(storeRoot, "history", "state", "manifest.json");
}

/** The manifest entries; undefined when there is no manifest file. */
export function readManifestEntries(storeRoot: string): Record<string, ManifestEntry> | undefined {
  let data: string;
  try {
    data = readFileSync(manifestPath(storeRoot), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const manifest = JSON.parse(data) as { entries?: Record<string, ManifestEntry> | null };
  return manifest.entries ?? {};
}

/** StampWatermarksFromGeneration: record the entities a full rebuild just indexed. */
export function stampWatermarksFromGeneration(
  storeRoot: string,
  indexedSourceIds: ReadonlySet<string>,
  at: string,
): number {
  if (indexedSourceIds.size === 0) return 0;
  const values = loadWatermarks(storeRoot);
  // The manifest is absent in a store used only through the CLI. Readiness still tracks those
  // entities through their watermarks, so a watermark with no manifest entry is stamped from its
  // own canonical fields (TSR-6T3JVM; Go 0.34.1 skips them and leaves them stale).
  const entries: Record<string, ManifestEntry> = { ...(readManifestEntries(storeRoot) ?? {}) };
  for (const [key, wm] of Object.entries(values)) {
    if (key in entries || wm.removed || wm.pendingRemoval) continue;
    if (!wm.entityType || !wm.entityId || !wm.canonicalHash) continue;
    entries[key] = {
      entityType: wm.entityType,
      entityId: wm.entityId,
      path: wm.path ?? "",
      hash: wm.canonicalHash,
      revision: wm.revision ?? 0,
    };
  }
  let stamped = 0;
  for (const [key, entry] of Object.entries(entries)) {
    if (!indexedSourceIds.has(sourceIdForManifestEntry(entry))) continue;
    const current: Watermark = values[key] ?? { entityType: "", entityId: "" };
    if (current.pendingRemoval) continue;
    if (current.removed && (current.revision ?? 0) >= entry.revision) continue;
    current.removed = false;
    current.entityType = entry.entityType;
    current.entityId = entry.entityId;
    current.canonicalHash = entry.hash;
    current.revision = entry.revision;
    current.path = entry.path;
    current.indexedHash = entry.hash;
    current.indexedRevision = entry.revision;
    current.indexedPath = entry.path;
    current.indexedAt = at;
    current.stale = false;
    values[key] = current;
    stamped++;
  }
  if (stamped === 0) return 0;
  saveWatermarks(storeRoot, values);
  return stamped;
}

function sourceIdForManifestEntry(entry: ManifestEntry): string {
  switch (entry.entityType) {
    case "task":
      return `task:${entry.entityId}`;
    case "doc": {
      const p = entry.path.replace(/^docs\//, "").replace(/\.md$/, "");
      return `doc:${p}`;
    }
    default:
      return "";
  }
}

// --- intent construction ----------------------------------------------------------------------

function toSlash(p: string): string {
  return sep === "\\" ? p.replaceAll("\\", "/") : p;
}

/** filepath.Clean(filepath.ToSlash(p)) on the slash form. */
function cleanSlash(p: string): string {
  return posix.normalize(toSlash(p)).replace(/(.)\/$/, "$1");
}

function head(records: readonly HistoryRecord[]): HistoryRecord | undefined {
  return records[records.length - 1];
}

function readHistory(storage: Storage, entityType: string, id: string): HistoryRecord[] {
  return storage.history.readPreview(entityType, id).records ?? [];
}

export function targetPathForIntent(entityType: string, target: string): string {
  if (entityType === "doc") {
    const path = cleanSlash(target.trim());
    if (path.startsWith("docs/")) return path;
    return `docs/${path.replace(/\.md$/, "")}.md`;
  }
  return `tasks/${target}.md`;
}

export function canonicalTaskIntentPath(storage: Storage, id: string): string {
  const path = storage.tasks.canonicalPath(id);
  return toSlash(relative(storage.store.root, path));
}

interface PurgeMarker {
  entityType?: string;
  entityId?: string;
  path?: string;
  hash?: string;
  expectedHash?: string;
  phase?: string;
}

function purgedMarkers(storeRoot: string): PurgeMarker[] | undefined {
  const dir = join(storeRoot, "history", "purged");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const out: PurgeMarker[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as PurgeMarker);
    } catch {
      // unreadable or malformed markers are skipped
    }
  }
  return out;
}

function purgeReservationForPath(
  storeRoot: string,
  path: string,
): { entityId: string; path: string; hash: string; expectedHash: string } | undefined {
  const want = cleanSlash(path);
  for (const m of purgedMarkers(storeRoot) ?? []) {
    if (m.entityType !== "doc" || m.phase !== "history_removed" || !m.entityId) continue;
    const mp = cleanSlash(m.path ?? "");
    if (mp !== want && mp.replace(/^docs\//, "") !== want.replace(/^docs\//, "")) continue;
    return {
      entityId: m.entityId,
      path: m.path ?? "",
      hash: m.hash ?? "",
      expectedHash: m.expectedHash ?? "",
    };
  }
  return undefined;
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const v of values) if (v !== undefined && v.trim() !== "") return v;
  return "";
}

export function provePurgeReservation(storeRoot: string, intent: QdrantIntent): boolean {
  for (const m of purgedMarkers(storeRoot) ?? []) {
    if (m.entityType !== intent.entityType || m.entityId !== intent.entityId) continue;
    if (
      m.phase !== "history_removed" ||
      (intent.path && m.path && cleanSlash(m.path) !== cleanSlash(intent.path))
    ) {
      continue;
    }
    if (
      intent.canonicalHash &&
      m.hash &&
      m.hash !== intent.canonicalHash &&
      m.expectedHash !== intent.canonicalHash
    ) {
      continue;
    }
    return true;
  }
  return false;
}

export function removalIntentFromHistoryOrPurge(
  storage: Storage,
  entityType: string,
  entityId: string,
  path: string,
  previousPath: string,
): QdrantIntent {
  const storeRoot = storage.store.root;
  const base: QdrantIntent = {
    entityType,
    entityId,
    revision: 0,
    operation: "hard_delete",
    generation: 0,
    ...(path ? { path } : {}),
    ...(previousPath ? { previousPath } : {}),
  };
  if (provePurgeReservation(storeRoot, base)) return base;
  if (entityType === "doc") {
    const marker = purgeReservationForPath(storeRoot, path);
    if (marker) {
      const hash = firstNonEmpty(marker.hash, marker.expectedHash);
      return {
        entityType: "doc",
        entityId: marker.entityId,
        revision: 0,
        operation: "hard_delete",
        generation: 0,
        ...(hash ? { canonicalHash: hash } : {}),
        ...(marker.path ? { path: marker.path } : {}),
      };
    }
  }
  const records = readHistory(storage, entityType, entityId);
  const h = head(records);
  if (!h || h.operation !== "delete" || !h.tombstone) {
    throw new Error(`qdrant ${entityType} removal lacks durable tombstone or purge proof`);
  }
  const p = firstNonEmpty(h.currentPath, h.previousPath, path);
  return {
    entityType,
    entityId,
    revision: h.revision,
    operation: "delete",
    generation: 0,
    ...(h.newHash ? { canonicalHash: h.newHash } : {}),
    ...(p ? { path: p } : {}),
    ...(previousPath ? { previousPath } : {}),
  };
}

/** currentPublicQdrantIntent: revision and hash come from canonical storage plus the history head. */
export function currentPublicQdrantIntent(
  storage: Storage,
  entityType: string,
  target: string,
  remove: boolean,
): QdrantIntent {
  const storeRoot = storage.store.root;
  if (entityType === "task") {
    if (remove) {
      const intent = removalIntentFromHistoryOrPurge(
        storage,
        "task",
        target,
        targetPathForIntent("task", target),
        "",
      );
      intent.batchId = "public-hook";
      return intent;
    }
    const task = storage.tasks.get(target);
    const records = readHistory(storage, "task", target);
    const h = head(records);
    if (!h) throw new Error("public task intent lacks durable history");
    const canonicalPath = canonicalTaskIntentPath(storage, target);
    return {
      entityType: "task",
      entityId: target,
      revision: h.revision,
      operation: "update",
      canonicalHash: canonicalTaskHash(task),
      path: canonicalPath,
      batchId: "public-hook",
      generation: 0,
    };
  }
  if (entityType !== "doc")
    throw new Error(`unsupported public qdrant entity type "${entityType}"`);
  let doc: ReturnType<Storage["docs"]["get"]> | undefined;
  let docErr: unknown;
  try {
    doc = storage.docs.get(target);
  } catch (err) {
    docErr = err;
  }
  if (doc?.id) {
    if (remove) {
      const intent = removalIntentFromHistoryOrPurge(
        storage,
        "doc",
        doc.id,
        `docs/${doc.path}.md`,
        "",
      );
      intent.batchId = "public-hook";
      return intent;
    }
    const records = readHistory(storage, "doc", doc.id);
    const h = head(records);
    if (!h) throw new Error("public doc intent lacks durable history");
    return {
      entityType: "doc",
      entityId: doc.id,
      revision: h.revision,
      operation: "update",
      canonicalHash: canonicalDocHash(doc),
      path: `docs/${doc.path}.md`,
      batchId: "public-hook",
      generation: 0,
    };
  }
  if (remove) {
    const intent = currentQdrantIntent(storage, "doc", target, true, "");
    intent.batchId = "public-hook";
    return intent;
  }
  throw docErr instanceof Error ? docErr : new Error(`doc "${target}" not found`);
}

/** currentQdrantIntent: manifest identity first, canonical storage plus history otherwise. */
export function currentQdrantIntent(
  storage: Storage,
  entityType: string,
  target: string,
  remove: boolean,
  previousPath: string,
): QdrantIntent {
  const storeRoot = storage.store.root;
  const entries = readManifestEntries(storeRoot) ?? {};
  let found: ManifestEntry | undefined;
  for (const entry of Object.values(entries)) {
    if (entityType === "task" && entry.entityId === target && entry.entityType === entityType) {
      found = entry;
      break;
    }
    if (
      entityType === "doc" &&
      entry.entityType === entityType &&
      (entry.path === target || entry.path === `docs/${target}.md`)
    ) {
      found = entry;
      break;
    }
  }
  if (!found || found.entityId === "") {
    if (entityType === "task") {
      let task: ReturnType<Storage["tasks"]["get"]> | undefined;
      try {
        task = storage.tasks.get(target);
      } catch {
        task = undefined;
      }
      const h = head(task ? readHistory(storage, "task", target) : []);
      if (task && h) {
        const canonicalPath = canonicalTaskIntentPath(storage, target);
        if (remove) {
          return removalIntentFromHistoryOrPurge(storage, "task", target, canonicalPath, "");
        }
        return {
          entityType: "task",
          entityId: target,
          revision: h.revision,
          operation: "update",
          canonicalHash: canonicalTaskHash(task),
          path: canonicalPath,
          batchId: "public-hook",
          generation: 0,
        };
      }
    }
    if (entityType === "doc") {
      let doc: ReturnType<Storage["docs"]["get"]> | undefined;
      try {
        doc = storage.docs.get(target);
      } catch {
        doc = undefined;
      }
      if (doc?.id) {
        const h = head(readHistory(storage, "doc", doc.id));
        if (h) {
          if (remove) {
            return removalIntentFromHistoryOrPurge(
              storage,
              "doc",
              doc.id,
              `docs/${doc.path}.md`,
              "",
            );
          }
          return {
            entityType: "doc",
            entityId: doc.id,
            revision: h.revision,
            operation: "update",
            canonicalHash: canonicalDocHash(doc),
            path: `docs/${doc.path}.md`,
            batchId: "public-hook",
            generation: 0,
          };
        }
      }
    }
    if (remove) {
      return removalIntentFromHistoryOrPurge(
        storage,
        entityType,
        target,
        targetPathForIntent(entityType, target),
        "",
      );
    }
    throw new Error(`canonical ${entityType} intent target not found`);
  }
  if (remove) {
    return removalIntentFromHistoryOrPurge(
      storage,
      found.entityType,
      found.entityId,
      found.path,
      previousPath,
    );
  }
  return {
    entityType: found.entityType,
    entityId: found.entityId,
    revision: found.revision,
    operation: "update",
    canonicalHash: found.hash,
    path: found.path,
    ...(previousPath ? { previousPath } : {}),
    generation: 0,
  };
}

// --- proof ------------------------------------------------------------------------------------

/** normalizeIntentDocPath: "docs/<path>.md" to the doc path. */
export function normalizeIntentDocPath(path: string): string {
  const raw = toSlash(path.trim());
  if (
    raw.startsWith("/") ||
    /^[A-Za-z]:/.test(raw) ||
    !raw.startsWith("docs/") ||
    !raw.endsWith(".md")
  ) {
    throw new Error("invalid canonical doc path");
  }
  const inner = cleanSlash(raw.slice("docs/".length, -".md".length));
  if (
    inner === "" ||
    inner === "." ||
    inner.startsWith("../") ||
    inner === ".." ||
    inner.includes("/../")
  ) {
    throw new Error("invalid canonical doc path");
  }
  return inner;
}

function proveHistoryRemoval(storage: Storage, intent: QdrantIntent): boolean {
  const historyPath = storage.history.entityPath(intent.entityType, intent.entityId);
  let data: string;
  try {
    data = readFileSync(historyPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const lines = data.trim().split("\n");
  let h: { revision?: number; operation?: string; newHash?: string; tombstone?: boolean } = {};
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] as string).trim() !== "") {
      h = JSON.parse(lines[i] as string);
      break;
    }
  }
  if (intent.revision > 0 && (h.revision ?? 0) !== intent.revision) return false;
  if (intent.operation === "delete" && (h.operation !== "delete" || !h.tombstone)) return false;
  if (intent.canonicalHash && h.newHash && h.newHash !== intent.canonicalHash) return false;
  return true;
}

function provePublicQdrantIntent(storage: Storage, intent: QdrantIntent): boolean {
  const records = readHistory(storage, intent.entityType, intent.entityId);
  const h = head(records);
  if (!h) return false;
  if (intent.revision > 0 && h.revision !== intent.revision) return false;
  if (intent.operation === "delete") return false;
  if (
    !(intent.canonicalHash ?? "").trim() ||
    !(h.newHash ?? "").trim() ||
    h.newHash !== intent.canonicalHash
  ) {
    return false;
  }
  let canonicalHash: string;
  if (intent.entityType === "task") {
    try {
      canonicalHash = canonicalTaskHash(storage.tasks.get(intent.entityId));
    } catch {
      return false;
    }
  } else if (intent.entityType === "doc") {
    const path = normalizeIntentDocPath(intent.path ?? "");
    try {
      canonicalHash = canonicalDocHash(storage.docs.get(path));
    } catch {
      return false;
    }
  } else {
    return false;
  }
  return canonicalHash === intent.canonicalHash;
}

/**
 * proveQdrantIntent: local durable ownership before any backend call. A superseded intent is a
 * successful no-op (false) so a stale delete never erases a restored entity.
 */
export function proveQdrantIntent(storage: Storage, intent: QdrantIntent): boolean {
  const storeRoot = storage.store.root;
  if (intent.batchId === "public-hook") {
    if (intent.operation === "delete") return proveHistoryRemoval(storage, intent);
    if (intent.operation === "hard_delete") return provePurgeReservation(storeRoot, intent);
    return provePublicQdrantIntent(storage, intent);
  }
  if (!existsSync(manifestPath(storeRoot))) {
    if (intent.operation === "hard_delete") return provePurgeReservation(storeRoot, intent);
    if (intent.operation === "delete") return proveHistoryRemoval(storage, intent);
    return false;
  }
  const entries = readManifestEntries(storeRoot) ?? {};
  const key = `${intent.entityType}:${intent.entityId}`;
  const entry = entries[key];
  if (isDeleteOp(intent.operation)) {
    if (entry) return false;
  } else {
    let path = intent.path ?? "";
    if (intent.entityType === "doc") path = cleanSlash(path);
    if (
      !entry ||
      entry.entityType !== intent.entityType ||
      entry.entityId !== intent.entityId ||
      entry.path !== path ||
      (intent.canonicalHash && entry.hash !== intent.canonicalHash) ||
      (intent.revision > 0 && entry.revision !== intent.revision)
    ) {
      return false;
    }
  }
  if (intent.operation === "hard_delete") return provePurgeReservation(storeRoot, intent);
  return proveHistoryRemoval(storage, intent);
}
