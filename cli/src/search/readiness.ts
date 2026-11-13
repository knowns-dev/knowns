// Backend-neutral semantic index readiness (semantic_readiness.go). The runtime preflight asks the
// configured vector store whether it can answer before any network call is made: Qdrant readiness
// is pointer metadata plus per-entity watermarks, and a legacy SQLite index only counts while no
// Qdrant pointer exists yet.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  SEMANTIC_VECTOR_BACKEND_NONE,
  SEMANTIC_VECTOR_BACKEND_QDRANT,
  SEMANTIC_VECTOR_BACKEND_SQLITE,
} from "../models/config.ts";
import type { Storage } from "../storage/adapters.ts";
import {
  loadSemanticRuntimeConfig,
  resolveEffectiveVectorStore,
  type SearchEnvironment,
} from "./config.ts";
import {
  loadQdrantPointer,
  QDRANT_POINTER_SCHEMA_VERSION,
  storeRootFingerprint,
} from "./qdrant/pointer.ts";
import { compareStrings, goTrimSpace } from "./text.ts";
import { CHUNK_VERSION, type ChunkType } from "./types.ts";

export interface QdrantEntityReadiness {
  entityType: string;
  entityId: string;
  canonicalHash?: string;
  indexedHash?: string;
  revision?: number;
  indexedRevision?: number;
  path?: string;
  indexedPath?: string;
  stale: boolean;
}

export interface SemanticIndexReadiness {
  enabled: boolean;
  optedOut?: boolean;
  backend?: string;
  mode?: string;
  ready: boolean;
  stale?: boolean;
  degraded?: boolean;
  model?: string;
  dimensions?: number;
  chunkVersion?: number;
  chunkCount?: number;
  indexedAt?: string;
  reason?: string;
  entities?: QdrantEntityReadiness[];
  entityStaleCount?: number;
  entitiesOnlyStale?: boolean;
}

export interface SemanticIndexExpectation {
  model: string;
  dimensions: number;
}

// --- watermarks and manifest ------------------------------------------------------------------------

const watermarkSchema = z.object({
  entityType: z.string().default(""),
  entityId: z.string().default(""),
  canonicalHash: z.string().default(""),
  indexedHash: z.string().default(""),
  revision: z.number().default(0),
  path: z.string().default(""),
  indexedRevision: z.number().default(0),
  indexedPath: z.string().default(""),
  stale: z.boolean().default(false),
  removed: z.boolean().default(false),
  pendingRemoval: z.boolean().default(false),
});
export type QdrantIndexWatermark = z.infer<typeof watermarkSchema>;

const manifestEntrySchema = z.object({
  entityType: z.string().default(""),
  entityId: z.string().default(""),
  path: z.string().default(""),
  hash: z.string().default(""),
  revision: z.number().default(0),
});

const manifestSchema = z.object({
  entries: z.record(z.string(), manifestEntrySchema).nullable().default({}),
});

export const qdrantWatermarkPath = (storeRoot: string) =>
  join(storeRoot, "history", "state", "qdrant-index-watermarks.json");

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function loadQdrantWatermarks(storeRoot: string): Map<string, QdrantIndexWatermark> {
  const data = readOptional(qdrantWatermarkPath(storeRoot));
  const out = new Map<string, QdrantIndexWatermark>();
  if (data === undefined) return out;
  let values: Record<string, QdrantIndexWatermark>;
  try {
    values = z.record(z.string(), watermarkSchema).nullable().parse(JSON.parse(data)) ?? {};
  } catch (err) {
    throw new Error(`parse qdrant index watermarks: ${(err as Error).message}`);
  }
  for (const [key, value] of Object.entries(values)) {
    // Older records stored only the desired revision and path.
    if (value.indexedHash !== "" && value.indexedRevision === 0) {
      value.indexedRevision = value.revision;
      value.indexedPath = value.path;
    }
    out.set(key, value);
  }
  return out;
}

/** Compares canonical manifest hashes with indexed watermarks without loading entity content. */
export function qdrantEntityReadinessForStore(storeRoot: string): QdrantEntityReadiness[] {
  const watermarks = loadQdrantWatermarks(storeRoot);
  const data = readOptional(join(storeRoot, "history", "state", "manifest.json"));
  const entries = new Map<string, z.infer<typeof manifestEntrySchema>>();
  if (data !== undefined && data.length > 0) {
    const manifest = manifestSchema.parse(JSON.parse(data));
    for (const [k, v] of Object.entries(manifest.entries ?? {})) entries.set(k, v);
  }
  const keys = new Set<string>(entries.keys());
  for (const [key, wm] of watermarks) {
    const entry = entries.get(key);
    if (wm.removed && entry && wm.revision >= entry.revision) {
      keys.delete(key);
      continue;
    }
    if (!wm.removed && wm.entityType !== "" && wm.entityId !== "") keys.add(key);
  }
  const sorted = [...keys].sort(compareStrings);
  const empty = { entityType: "", entityId: "", path: "", hash: "", revision: 0 };
  const emptyWm = watermarkSchema.parse({});
  const out: QdrantEntityReadiness[] = [];
  for (const key of sorted) {
    let entry = entries.get(key);
    let fromManifest = entry !== undefined;
    const wm = watermarks.get(key) ?? emptyWm;
    let e = entry ? { ...entry } : { ...empty };
    if (fromManifest && wm.entityId !== "") {
      if (wm.revision > e.revision) {
        e = {
          entityType: wm.entityType,
          entityId: wm.entityId,
          path: wm.path,
          hash: wm.canonicalHash,
          revision: wm.revision,
        };
        fromManifest = false;
      } else if (
        wm.revision === e.revision &&
        wm.canonicalHash !== "" &&
        e.hash !== "" &&
        wm.canonicalHash !== e.hash
      ) {
        throw new Error(
          `qdrant readiness conflicting canonical hashes for ${key} revision ${e.revision}`,
        );
      }
    }
    if (!fromManifest) {
      e = {
        entityType: wm.entityType,
        entityId: wm.entityId,
        path: wm.path,
        hash: wm.canonicalHash,
        revision: wm.revision,
      };
    }
    entry = e;
    // An indexed revision that was never recorded is unknown, not a mismatch.
    const revisionRecorded = wm.indexedRevision !== 0;
    const stale =
      wm.stale ||
      wm.pendingRemoval ||
      e.hash === "" ||
      wm.indexedHash !== e.hash ||
      wm.indexedPath !== e.path ||
      (revisionRecorded && wm.indexedRevision !== e.revision);
    out.push(
      stripEmpty({
        entityType: e.entityType,
        entityId: e.entityId,
        canonicalHash: e.hash,
        indexedHash: wm.indexedHash,
        revision: e.revision,
        indexedRevision: wm.indexedRevision,
        path: e.path,
        indexedPath: wm.indexedPath,
        stale,
      }) as QdrantEntityReadiness,
    );
  }
  return out;
}

function stripEmpty<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "entityType" || k === "entityId" || k === "stale" || (v !== "" && v !== 0))
      out[k] = v;
  }
  return out as Partial<T>;
}

// --- expectation and readiness ----------------------------------------------------------------------

export function semanticIndexExpectationForStore(
  storage: Storage,
  env: SearchEnvironment,
): SemanticIndexExpectation {
  try {
    const cfg = loadSemanticRuntimeConfig(storage, env);
    return { model: cfg.modelId, dimensions: cfg.dimensions };
  } catch {
    // fall back to the raw project settings
  }
  try {
    const ss = storage.config.load().settings.semanticSearch;
    if (ss) return { model: ss.model, dimensions: ss.dimensions ?? 0 };
  } catch {
    // none
  }
  return { model: "", dimensions: 0 };
}

/**
 * semanticIndexReadinessQdrant: pointer metadata only, no network. With no pointer yet the legacy
 * SQLite index is the only readiness source and the state is reported as degraded.
 */
export function semanticIndexReadinessQdrant(
  storage: Storage,
  expectation: SemanticIndexExpectation,
  chunkTypes: ChunkType[],
): SemanticIndexReadiness {
  const root = storage.store.root;
  const r: SemanticIndexReadiness = {
    backend: SEMANTIC_VECTOR_BACKEND_QDRANT,
    enabled: true,
    ready: false,
  };
  let entities: QdrantEntityReadiness[];
  try {
    entities = qdrantEntityReadinessForStore(root);
  } catch {
    r.degraded = true;
    r.ready = false;
    r.reason = "qdrant entity watermark state is corrupt or unreadable";
    return r;
  }
  r.entities = entities;
  r.entityStaleCount = entities.filter((e) => e.stale).length;

  let pointer: ReturnType<typeof loadQdrantPointer>;
  try {
    pointer = loadQdrantPointer(root);
  } catch (err) {
    throw new Error(`read qdrant pointer: ${(err as Error).message}`);
  }
  if (!pointer) {
    const legacy = semanticIndexReadinessSqlite(storage, expectation, chunkTypes);
    legacy.backend = SEMANTIC_VECTOR_BACKEND_QDRANT;
    legacy.degraded = true;
    legacy.entities = r.entities;
    legacy.entityStaleCount = r.entityStaleCount;
    legacy.reason = legacy.reason
      ? `no qdrant pointer; ${legacy.reason}`
      : "no qdrant pointer; using legacy sqlite index during migration";
    return legacy;
  }

  r.model = pointer.embedding.model;
  r.dimensions = pointer.embedding.dimensions;
  r.chunkVersion = pointer.chunkVersion;
  r.chunkCount = pointer.chunkCount;
  if (pointer.lastIndexedAt !== null) r.indexedAt = pointer.lastIndexedAt;

  if (goTrimSpace(pointer.collectionUUID) === "") {
    r.degraded = true;
    r.reason = "qdrant pointer is missing collectionUUID";
  } else if (pointer.backend !== "" && pointer.backend !== SEMANTIC_VECTOR_BACKEND_QDRANT) {
    r.stale = true;
    r.reason = `qdrant pointer backend = ${JSON.stringify(pointer.backend)}, want ${JSON.stringify(SEMANTIC_VECTOR_BACKEND_QDRANT)}`;
  } else if (pointer.schemaVersion !== QDRANT_POINTER_SCHEMA_VERSION) {
    r.stale = true;
    r.reason = `qdrant pointer schema version = ${pointer.schemaVersion}, want ${QDRANT_POINTER_SCHEMA_VERSION}`;
  } else if (storeRootFingerprint(root) !== (pointer.owner.storeRootFingerprint ?? "")) {
    r.stale = true;
    r.reason = "qdrant pointer owner fingerprint mismatch (pointer belongs to a different store)";
  } else if (expectation.model !== "" && pointer.embedding.model !== expectation.model) {
    r.stale = true;
    r.reason = `qdrant pointer model ${JSON.stringify(pointer.embedding.model)} != configured model ${JSON.stringify(expectation.model)}`;
  } else if (
    expectation.dimensions > 0 &&
    pointer.embedding.dimensions !== expectation.dimensions
  ) {
    r.stale = true;
    r.reason = `qdrant pointer dimensions ${pointer.embedding.dimensions} != configured dimensions ${expectation.dimensions}`;
  } else if (pointer.chunkVersion !== CHUNK_VERSION) {
    r.stale = true;
    r.reason = `qdrant pointer chunk version ${pointer.chunkVersion} != current chunk version ${CHUNK_VERSION}`;
  } else if (pointer.chunkCount <= 0) {
    r.degraded = true;
    r.reason = "qdrant pointer exists but chunk count is zero (never indexed)";
  }
  if ((r.entityStaleCount ?? 0) > 0 && !r.stale && !r.degraded) {
    r.stale = true;
    r.entitiesOnlyStale = true;
    r.reason = `${r.entityStaleCount} canonical Task/Doc entities are not indexed at their current hash`;
  }
  if (r.stale || r.degraded) {
    r.ready = false;
    if (!r.reason) r.reason = "qdrant semantic index is not ready";
    return r;
  }
  r.ready = true;
  return r;
}

/**
 * Legacy readiness (spec D4/FR-14). Only the "no index.db" outcome is decided here; an existing
 * SQLite index needs the SQLite vector store, which is not part of this port, so it is reported as
 * a degraded index instead of being trusted.
 */
export function semanticIndexReadinessSqlite(
  storage: Storage,
  expectation: SemanticIndexExpectation,
  chunkTypes: ChunkType[],
): SemanticIndexReadiness {
  const r: SemanticIndexReadiness = {
    backend: SEMANTIC_VECTOR_BACKEND_SQLITE,
    enabled: true,
    ready: false,
  };
  const dbPath = join(storage.store.root, ".search", "index.db");
  if (!existsSync(dbPath)) {
    r.degraded = true;
    r.reason = "no legacy sqlite semantic index";
    return r;
  }
  // Read-only, waiting briefly for a writer (the daemon may be opening or migrating it).
  // A WAL database with no -shm file cannot be opened read-only by bun:sqlite; open it without
  // create and never write.
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    db.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
  } catch {
    // Close the read-only handle before reopening, or every preflight leaks one on index.db.
    db?.close();
    db = new Database(dbPath, { readwrite: true, create: false });
  }
  try {
    db.run("PRAGMA busy_timeout=5000");
    const noTable = (err: unknown) => String((err as Error).message).includes("no such table");
    let rows: { key: string; value: string }[];
    try {
      rows = db
        .query(
          "SELECT key, value FROM metadata WHERE key IN ('model', 'dimensions', 'chunkVersion', 'indexedAt', 'chunkCount')",
        )
        .all() as { key: string; value: string }[];
    } catch (err) {
      if (!noTable(err)) throw err;
      rows = [];
    }
    let model = "";
    let dimensions = 0;
    let chunkVersion = 0;
    const atoi = (v: string) => (/^[+-]?\d+$/.test(v) ? Number.parseInt(v, 10) : 0);
    for (const row of rows) {
      switch (row.key) {
        case "model":
          model = row.value;
          break;
        case "dimensions":
          dimensions = atoi(row.value);
          break;
        case "chunkVersion":
          chunkVersion = atoi(row.value);
          break;
        case "indexedAt":
          if (!Number.isNaN(Date.parse(row.value))) r.indexedAt = row.value;
          break;
        case "chunkCount":
          r.chunkCount = atoi(row.value);
          break;
      }
    }
    r.model = model;
    r.dimensions = dimensions;
    r.chunkVersion = chunkVersion;
    r.chunkCount ??= 0;
    if (rows.length === 0) {
      r.degraded = true;
      r.reason = "sqlite index is empty or missing metadata";
      return r;
    }
    let count: number;
    try {
      let sql = "SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL";
      if (chunkTypes.length > 0) sql += ` AND type IN (${chunkTypes.map(() => "?").join(",")})`;
      count = (db.query(sql).get(...chunkTypes) as { n: number }).n;
    } catch (err) {
      if (!noTable(err)) throw err;
      r.degraded = true;
      r.reason = "sqlite index is empty or missing tables";
      return r;
    }
    r.chunkCount = count;
    if (expectation.model !== "" && model !== "" && model !== expectation.model) {
      r.stale = true;
      r.reason = `sqlite index model ${JSON.stringify(model)} != configured model ${JSON.stringify(expectation.model)}`;
    } else if (
      expectation.dimensions > 0 &&
      dimensions > 0 &&
      dimensions !== expectation.dimensions
    ) {
      r.stale = true;
      r.reason = `sqlite index dimensions ${dimensions} != configured dimensions ${expectation.dimensions}`;
    } else if (chunkVersion !== CHUNK_VERSION) {
      r.stale = true;
      r.reason = `sqlite index chunk version ${chunkVersion} != current chunk version ${CHUNK_VERSION}`;
    } else if (count <= 0) {
      r.degraded = true;
      r.reason = "sqlite semantic index has no indexed chunks";
    }
    if (r.stale || r.degraded) {
      r.ready = false;
      if (!r.reason) r.reason = "sqlite semantic index is not ready";
      return r;
    }
    r.ready = true;
    return r;
  } finally {
    db.close();
  }
}

export function resolveSemanticIndexReadiness(
  storage: Storage,
  env: SearchEnvironment,
): SemanticIndexReadiness {
  const res = resolveEffectiveVectorStore(storage, env);
  const base: SemanticIndexReadiness = {
    enabled: res.enabled,
    optedOut: res.optedOut || undefined,
    backend: res.backend,
    mode: res.mode,
    ready: false,
  };
  if (!res.enabled || res.backend === SEMANTIC_VECTOR_BACKEND_NONE) {
    base.reason =
      res.backend === SEMANTIC_VECTOR_BACKEND_NONE
        ? "semantic vector search disabled (backend none)"
        : res.optedOut
          ? "semantic vector search disabled"
          : "semantic vector search not configured";
    return base;
  }
  const expectation = semanticIndexExpectationForStore(storage, env);
  let r: SemanticIndexReadiness;
  try {
    switch (res.backend) {
      case SEMANTIC_VECTOR_BACKEND_QDRANT:
        r = semanticIndexReadinessQdrant(storage, expectation, []);
        break;
      case SEMANTIC_VECTOR_BACKEND_SQLITE:
        r = semanticIndexReadinessSqlite(storage, expectation, []);
        break;
      default:
        base.reason = `unsupported semantic backend ${JSON.stringify(res.backend)}`;
        return base;
    }
  } catch (err) {
    r = { ...base, ready: false, degraded: true, reason: (err as Error).message };
  }
  r.enabled = base.enabled;
  r.optedOut = base.optedOut;
  r.backend = base.backend;
  r.mode = base.mode;
  return r;
}
