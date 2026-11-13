// Port of internal/search/qdrant_pointer.go. A project store keeps only metadata pointers under
// <storeRoot>/.search/: qdrant.json (the active collection) and qdrant-generations.jsonl (swap
// history). Vectors live in the Qdrant runtime, never under the project directory. The files are
// read and written in the exact shape Go uses, so either binary can open the other's index.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { z } from "zod";
import { contentHash } from "../hash.ts";
import { goJson } from "../json.ts";
import { goTimeString } from "../time.ts";
import { CHUNK_VERSION } from "../types.ts";

export const QDRANT_POINTER_SCHEMA_VERSION = 1;
export const QDRANT_POINTER_FILE_NAME = "qdrant.json";
export const QDRANT_GENERATIONS_FILE_NAME = "qdrant-generations.jsonl";
/** Prepended to the dash-free collection UUID to form the Qdrant collection name. */
export const QDRANT_COLLECTION_NAME_PREFIX = "kn_";
export const QDRANT_DEFAULT_DISTANCE = "cosine";

export const QDRANT_GENERATION_STATUS_ACTIVE = "active";
export const QDRANT_GENERATION_STATUS_INACTIVE = "inactive";
export const QDRANT_GENERATION_STATUS_DELETED = "deleted";

const embeddingSchema = z.object({
  provider: z.string().default(""),
  model: z.string().default(""),
  dimensions: z.number().default(0),
  distance: z.string().optional(),
});
const ownerSchema = z.object({
  projectId: z.string().optional(),
  storeRootFingerprint: z.string().optional(),
});

export const qdrantPointerSchema = z.object({
  backend: z.string().default(""),
  collectionUUID: z.string().default(""),
  collectionName: z.string().default(""),
  schemaVersion: z.number().default(0),
  chunkVersion: z.number().default(0),
  embedding: embeddingSchema.default({ provider: "", model: "", dimensions: 0 }),
  owner: ownerSchema.default({}),
  lastIndexedAt: z.string().nullable().default(null),
  chunkCount: z.number().default(0),
});
export type QdrantEmbeddingPointer = z.infer<typeof embeddingSchema>;
export type QdrantOwnerPointer = z.infer<typeof ownerSchema>;
export type QdrantPointer = z.infer<typeof qdrantPointerSchema>;

export const qdrantGenerationRecordSchema = z.object({
  generation: z.number(),
  collectionUUID: z.string(),
  collectionName: z.string(),
  schemaVersion: z.number().default(0),
  chunkVersion: z.number().default(0),
  embedding: embeddingSchema.default({ provider: "", model: "", dimensions: 0 }),
  owner: ownerSchema.default({}),
  status: z.string(),
  chunkCount: z.number().default(0),
  createdAt: z.string(),
  swappedAt: z.string().optional(),
  retiredAt: z.string().nullable().optional(),
});
export type QdrantGenerationRecord = z.infer<typeof qdrantGenerationRecordSchema>;

/** A random UUIDv4: the stable ownership key of a collection (never a project path). */
export function newCollectionUUID(): string {
  return randomUUID();
}

/** "kn_" + dash-free UUID, e.g. "kn_8f2c6a7b91d44f6ab9f72ef84d72a9c1". */
export function collectionNameFromUUID(collectionUUID: string): string {
  return QDRANT_COLLECTION_NAME_PREFIX + collectionUUID.replaceAll("-", "");
}

/** filepath.Clean for the host separator. */
export function goClean(p: string): string {
  if (p === "") return ".";
  const n = normalize(p);
  if (n.length > 1 && n.endsWith(sep) && !/^[A-Za-z]:\\$/.test(n)) return n.slice(0, -1);
  return n;
}

/** "sha256:" + hex of the cleaned store root; a copied pointer from another store never matches. */
export function storeRootFingerprint(storeRoot: string): string {
  return `sha256:${contentHash(goClean(storeRoot))}`;
}

export function newQdrantPointer(
  storeRoot: string,
  projectId: string,
  embedding: QdrantEmbeddingPointer,
): QdrantPointer {
  const collectionUUID = newCollectionUUID();
  return {
    backend: "qdrant",
    collectionUUID,
    collectionName: collectionNameFromUUID(collectionUUID),
    schemaVersion: QDRANT_POINTER_SCHEMA_VERSION,
    chunkVersion: CHUNK_VERSION,
    embedding: { ...embedding, distance: embedding.distance || QDRANT_DEFAULT_DISTANCE },
    owner: { projectId, storeRootFingerprint: storeRootFingerprint(storeRoot) },
    lastIndexedAt: null,
    chunkCount: 0,
  };
}

export const qdrantPointerPath = (storeRoot: string) =>
  join(storeRoot, ".search", QDRANT_POINTER_FILE_NAME);
export const qdrantGenerationsPath = (storeRoot: string) =>
  join(storeRoot, ".search", QDRANT_GENERATIONS_FILE_NAME);

/** Reads the active pointer; undefined when no pointer file exists yet. */
export function loadQdrantPointer(storeRoot: string): QdrantPointer | undefined {
  const path = qdrantPointerPath(storeRoot);
  let data: string;
  try {
    data = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`read qdrant pointer: ${(err as Error).message}`);
  }
  try {
    return qdrantPointerSchema.parse(JSON.parse(data));
  } catch (err) {
    throw new Error(`parse qdrant pointer ${path}: ${(err as Error).message}`);
  }
}

function pointerJson(p: QdrantPointer): unknown {
  return {
    backend: p.backend,
    collectionUUID: p.collectionUUID,
    collectionName: p.collectionName,
    schemaVersion: p.schemaVersion,
    chunkVersion: p.chunkVersion,
    embedding: embeddingJson(p.embedding),
    owner: ownerJson(p.owner),
    lastIndexedAt: p.lastIndexedAt === null ? null : goTimeString(p.lastIndexedAt),
    chunkCount: p.chunkCount,
  };
}

function embeddingJson(e: QdrantEmbeddingPointer): unknown {
  return {
    provider: e.provider,
    model: e.model,
    dimensions: e.dimensions,
    ...(e.distance ? { distance: e.distance } : {}),
  };
}

function ownerJson(o: QdrantOwnerPointer): unknown {
  return {
    ...(o.projectId ? { projectId: o.projectId } : {}),
    ...(o.storeRootFingerprint ? { storeRootFingerprint: o.storeRootFingerprint } : {}),
  };
}

/** Atomically writes the active pointer, filling the name, backend, schema and distance defaults. */
export function saveQdrantPointer(storeRoot: string, input: QdrantPointer): void {
  if (input.collectionUUID.trim() === "") {
    throw new Error("save qdrant pointer: collectionUUID is required");
  }
  const p: QdrantPointer = { ...input, embedding: { ...input.embedding } };
  if (p.collectionName === "") p.collectionName = collectionNameFromUUID(p.collectionUUID);
  if (p.backend === "") p.backend = "qdrant";
  if (p.schemaVersion === 0) p.schemaVersion = QDRANT_POINTER_SCHEMA_VERSION;
  if (!p.embedding.distance) p.embedding.distance = QDRANT_DEFAULT_DISTANCE;
  atomicWriteSearchFile(qdrantPointerPath(storeRoot), goJson(pointerJson(p), { indent: 2 }));
}

function generationJson(r: QdrantGenerationRecord): unknown {
  return {
    generation: r.generation,
    collectionUUID: r.collectionUUID,
    collectionName: r.collectionName,
    schemaVersion: r.schemaVersion,
    chunkVersion: r.chunkVersion,
    embedding: embeddingJson(r.embedding),
    owner: ownerJson(r.owner),
    status: r.status,
    chunkCount: r.chunkCount,
    createdAt: goTimeString(r.createdAt),
    // time.Time with omitempty is never omitted: the zero time is written out.
    swappedAt: goTimeString(r.swappedAt ?? "0001-01-01T00:00:00Z"),
    ...(r.retiredAt ? { retiredAt: goTimeString(r.retiredAt) } : {}),
  };
}

/** Appends one JSON line to qdrant-generations.jsonl. */
export function appendQdrantGeneration(storeRoot: string, rec: QdrantGenerationRecord): void {
  const path = qdrantGenerationsPath(storeRoot);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a", 0o644);
  try {
    writeFileSync(fd, `${goJson(generationJson(rec))}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Atomically replaces the generation history with one durable snapshot. */
export function saveQdrantGenerations(storeRoot: string, records: QdrantGenerationRecord[]): void {
  const data = records.map((r) => `${goJson(generationJson(r))}\n`).join("");
  atomicWriteSearchFile(qdrantGenerationsPath(storeRoot), data);
}

/** Reads the full history; a missing file is an empty list. */
export function loadQdrantGenerations(storeRoot: string): QdrantGenerationRecord[] {
  const path = qdrantGenerationsPath(storeRoot);
  let data: string;
  try {
    data = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`read qdrant generations: ${(err as Error).message}`);
  }
  const records: QdrantGenerationRecord[] = [];
  for (const line of data.trim().split("\n")) {
    if (line === "") continue;
    try {
      records.push(qdrantGenerationRecordSchema.parse(JSON.parse(line)));
    } catch (err) {
      throw new Error(`parse qdrant generation line: ${(err as Error).message}`);
    }
  }
  return records;
}

/** Write to a temp file in the same directory, fsync, and rename over the destination. */
function atomicWriteSearchFile(dst: string, data: string): void {
  const dir = dirname(dst);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-qdrant-${randomUUID()}`);
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, dst);
  } catch (err) {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
    throw err;
  }
}
