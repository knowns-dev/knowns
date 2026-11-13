// Pointer-only Qdrant payloads and deterministic point ids (qdrant_client.go). A point holds ids,
// offsets and hashes, never content: text is read back from the canonical Knowns files. The point
// id and payload keys written by Go 0.34.1 are what a TypeScript query must understand.
import { createHash } from "node:crypto";
import { contentHash } from "../hash.ts";
import { CHUNK_VERSION, type Chunk, type ChunkType } from "../types.ts";

export const PAYLOAD_CHUNK_ID = "chunk_id";
export const PAYLOAD_SOURCE_ID = "source_id";
export const PAYLOAD_TYPE = "type";
export const PAYLOAD_TOKEN_COUNT = "token_count";
export const PAYLOAD_POSITION = "position";
export const PAYLOAD_OFFSET = "offset";
export const PAYLOAD_CHUNK_VERSION = "chunk_version";
export const PAYLOAD_CHUNK_HASH = "chunk_hash";
export const PAYLOAD_CONTENT_HASH = "content_hash";

export type QdrantPayload = Record<string, unknown>;

// uuid.NameSpaceOID
const NAMESPACE_OID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

/** uuid.NewSHA1(namespace, name): a version 5 UUID. */
export function uuidV5(name: string, namespace: string = NAMESPACE_OID): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = ((b[6] as number) & 0x0f) | 0x50;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The stable point id for a chunk id; Qdrant ids cannot be arbitrary strings like "doc:a:chunk:3". */
export function qdrantPointIdForChunkId(chunkId: string): string {
  return uuidV5(`knowns:qdrant:chunk:${chunkId}`);
}

export function sourceIdFromChunkId(id: string): string {
  if (id === "") return "";
  if (id.startsWith("code::")) {
    const parts = id.split("::");
    if (parts.length >= 2) return `code:${parts[1]}`;
  }
  const idx = id.lastIndexOf(":");
  if (idx <= 0) return id;
  return id.slice(0, idx);
}

/** The canonical source pointer for a chunk. */
export function sourceIdForChunk(chunk: Chunk): string {
  switch (chunk.type) {
    case "doc":
      if (chunk.docPath) return `doc:${chunk.docPath}`;
      break;
    case "task":
      if (chunk.taskId) return `task:${chunk.taskId}`;
      break;
    case "memory":
      if (chunk.memoryId) return `memory:${chunk.memoryId}`;
      break;
    case "decision":
      if (chunk.decisionId) return `decision:${chunk.decisionId}`;
      break;
    case "code":
      if (chunk.docPath) return `code:${chunk.docPath}`;
      break;
  }
  return sourceIdFromChunkId(chunk.id);
}

/** The v1 pointer-only payload for a chunk. Keys are written sorted by the encoder, as in Go. */
export function qdrantPayloadFromChunk(chunk: Chunk, sourceContentHash: string): QdrantPayload {
  const payload: QdrantPayload = {
    [PAYLOAD_CHUNK_ID]: chunk.id,
    [PAYLOAD_SOURCE_ID]: sourceIdForChunk(chunk),
    [PAYLOAD_TYPE]: chunk.type,
    [PAYLOAD_TOKEN_COUNT]: chunk.tokenCount,
    [PAYLOAD_POSITION]: chunk.position ?? 0,
    [PAYLOAD_OFFSET]: chunk.position ?? 0,
    [PAYLOAD_CHUNK_VERSION]: CHUNK_VERSION,
  };
  if (chunk.content !== "") payload[PAYLOAD_CHUNK_HASH] = contentHash(chunk.content);
  if (sourceContentHash !== "") payload[PAYLOAD_CONTENT_HASH] = sourceContentHash;
  const putString = (key: string, value: string | undefined) => {
    if (value) payload[key] = value;
  };
  const putInt = (key: string, value: number | undefined) => {
    if (value) payload[key] = value;
  };
  putString("doc_path", chunk.docPath);
  putString("section", chunk.section);
  putInt("heading_level", chunk.headingLevel);
  putString("header_path", chunk.headerPath);
  putString("task_id", chunk.taskId);
  putString("field", chunk.field);
  putString("status", chunk.status);
  putString("priority", chunk.priority);
  if (chunk.labels && chunk.labels.length > 0) payload.labels = [...chunk.labels];
  putString("memory_id", chunk.memoryId);
  putString("memory_layer", chunk.memoryLayer);
  putString("memory_store", chunk.memoryStore);
  putString("decision_id", chunk.decisionId);
  putString("name", chunk.name);
  putString("signature", chunk.signature);
  putString("visibility", chunk.visibility);
  putString("detail", chunk.detail);
  return payload;
}

export function payloadString(payload: QdrantPayload | undefined, key: string): string {
  const v = payload?.[key];
  return typeof v === "string" ? v : "";
}

export function payloadInt(payload: QdrantPayload | undefined, key: string): number {
  const v = payload?.[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}

function payloadStringSlice(payload: QdrantPayload | undefined, key: string): string[] | undefined {
  const v = payload?.[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

/** Chunk metadata from a payload; content is empty and comes from canonical sources. */
export function chunkFromQdrantPayload(payload: QdrantPayload | undefined): Chunk {
  const chunk: Chunk = {
    id: payloadString(payload, PAYLOAD_CHUNK_ID),
    type: payloadString(payload, PAYLOAD_TYPE) as ChunkType | "",
    content: "",
    tokenCount: payloadInt(payload, PAYLOAD_TOKEN_COUNT),
    docPath: payloadString(payload, "doc_path"),
    section: payloadString(payload, "section"),
    headingLevel: payloadInt(payload, "heading_level"),
    headerPath: payloadString(payload, "header_path"),
    position: payloadInt(payload, PAYLOAD_POSITION),
    taskId: payloadString(payload, "task_id"),
    field: payloadString(payload, "field"),
    status: payloadString(payload, "status"),
    priority: payloadString(payload, "priority"),
    labels: payloadStringSlice(payload, "labels"),
    memoryId: payloadString(payload, "memory_id"),
    memoryLayer: payloadString(payload, "memory_layer"),
    memoryStore: payloadString(payload, "memory_store"),
    decisionId: payloadString(payload, "decision_id"),
    name: payloadString(payload, "name"),
    signature: payloadString(payload, "signature"),
    visibility: payloadString(payload, "visibility"),
    detail: payloadString(payload, "detail"),
  };
  if (chunk.position === 0) chunk.position = payloadInt(payload, PAYLOAD_OFFSET);
  return chunk;
}
