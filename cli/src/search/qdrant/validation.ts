// Port of internal/search/qdrant_validation.go: a pointer-only hit is used only when its pointer
// metadata is current and its canonical source still hashes to what was indexed. Stale hits are
// dropped and counted so callers can recommend a reindex.
import type { Storage } from "../../storage/adapters.ts";
import { contentHash, decisionContentForHash, taskContentForHash } from "../hash.ts";
import { CHUNK_VERSION, type Chunk, type ScoredChunk } from "../types.ts";
import {
  chunkFromQdrantPayload,
  PAYLOAD_CHUNK_VERSION,
  PAYLOAD_CONTENT_HASH,
  PAYLOAD_SOURCE_ID,
  payloadInt,
  payloadString,
  type QdrantPayload,
} from "./payload.ts";
import type { QdrantPointer } from "./pointer.ts";

export interface QdrantHitValidationContext {
  storage: Storage | undefined;
  pointer: QdrantPointer | undefined;
  expectedModel: string;
  expectedDimensions: number;
}

export interface QdrantHitValidationResult {
  valid: boolean;
  stale: boolean;
  reasons: string[];
  reindexRecommended: boolean;
}

export interface QdrantHitValidationSummary {
  checked: number;
  dropped: number;
  reindexRecommended: boolean;
  reasons: string[];
}

export interface QdrantScoredPayload {
  score: number;
  payload: QdrantPayload;
}

/** Validates one payload against the pointer and the canonical source. */
export function validateQdrantHitPayload(
  ctx: QdrantHitValidationContext,
  payload: QdrantPayload,
): { chunk: Chunk; result: QdrantHitValidationResult } {
  const chunk = chunkFromQdrantPayload(payload);
  const result: QdrantHitValidationResult = {
    valid: true,
    stale: false,
    reasons: [],
    reindexRecommended: false,
  };
  const fail = (reason: string) => {
    result.valid = false;
    result.stale = true;
    result.reindexRecommended = true;
    result.reasons.push(reason);
  };
  if (chunk.id === "") fail("missing chunk_id");
  if (payloadString(payload, PAYLOAD_SOURCE_ID) === "") fail("missing source_id");
  const payloadVersion = payloadInt(payload, PAYLOAD_CHUNK_VERSION);
  if (payloadVersion !== 0 && payloadVersion !== CHUNK_VERSION) {
    fail(`payload chunk_version ${payloadVersion} != current ${CHUNK_VERSION}`);
  }
  const { pointer } = ctx;
  if (!pointer) {
    fail("missing qdrant pointer");
  } else {
    if (pointer.chunkVersion !== CHUNK_VERSION) {
      fail(`pointer chunk version ${pointer.chunkVersion} != current ${CHUNK_VERSION}`);
    }
    if (
      ctx.expectedModel !== "" &&
      pointer.embedding.model !== "" &&
      pointer.embedding.model !== ctx.expectedModel
    ) {
      fail(
        `pointer model ${goQuote(pointer.embedding.model)} != expected ${goQuote(ctx.expectedModel)}`,
      );
    }
    if (
      ctx.expectedDimensions > 0 &&
      pointer.embedding.dimensions > 0 &&
      pointer.embedding.dimensions !== ctx.expectedDimensions
    ) {
      fail(
        `pointer dimensions ${pointer.embedding.dimensions} != expected ${ctx.expectedDimensions}`,
      );
    }
  }
  if (!ctx.storage) {
    fail("missing canonical store");
    return { chunk, result };
  }
  let canonical: { hash: string; found: boolean };
  try {
    canonical = canonicalContentHashForChunk(ctx.storage, chunk);
  } catch (err) {
    fail((err as Error).message);
    return { chunk, result };
  }
  const payloadHash = payloadString(payload, PAYLOAD_CONTENT_HASH);
  if (!canonical.found) fail("canonical source does not exist");
  else if (payloadHash !== "" && canonical.hash !== payloadHash) fail("content hash mismatch");
  return { chunk, result };
}

/** Validates and maps raw payloads, dropping stale hits. */
export function validateQdrantPayloads(
  ctx: QdrantHitValidationContext,
  scored: QdrantScoredPayload[],
): { chunks: ScoredChunk[]; summary: QdrantHitValidationSummary } {
  const summary: QdrantHitValidationSummary = {
    checked: scored.length,
    dropped: 0,
    reindexRecommended: false,
    reasons: [],
  };
  const seen = new Set<string>();
  const chunks: ScoredChunk[] = [];
  for (const hit of scored) {
    const { chunk, result } = validateQdrantHitPayload(ctx, hit.payload);
    if (!result.valid) {
      summary.dropped++;
      if (result.reindexRecommended) summary.reindexRecommended = true;
      for (const reason of result.reasons) {
        if (!seen.has(reason)) {
          seen.add(reason);
          summary.reasons.push(reason);
        }
      }
      continue;
    }
    chunks.push({ ...chunk, score: hit.score });
  }
  return { chunks, summary };
}

function canonicalContentHashForChunk(
  storage: Storage,
  chunk: Chunk,
): { hash: string; found: boolean } {
  const missing = { hash: "", found: false };
  switch (chunk.type) {
    case "doc": {
      if (!chunk.docPath) return missing;
      try {
        const doc = storage.docs.get(chunk.docPath);
        return {
          hash: contentHash(`${doc.title}\n${doc.description ?? ""}\n${doc.content ?? ""}`),
          found: true,
        };
      } catch {
        return missing;
      }
    }
    case "task": {
      if (!chunk.taskId) return missing;
      try {
        return {
          hash: contentHash(taskContentForHash(storage.tasks.get(chunk.taskId))),
          found: true,
        };
      } catch {
        return missing;
      }
    }
    case "memory": {
      if (!chunk.memoryId) throw new Error("memory_id is required");
      try {
        const entry = chunk.memoryLayer
          ? storage.memory.getInLayer(chunk.memoryId, chunk.memoryLayer)
          : storage.memory.get(chunk.memoryId);
        return {
          hash: contentHash(`${entry.title}\n${entry.category ?? ""}\n${entry.content ?? ""}`),
          found: true,
        };
      } catch {
        return missing;
      }
    }
    case "decision": {
      if (!chunk.decisionId) return missing;
      try {
        return {
          hash: contentHash(decisionContentForHash(storage.decisions.get(chunk.decisionId))),
          found: true,
        };
      } catch {
        return missing;
      }
    }
    default:
      throw new Error(`unsupported qdrant hit type ${goQuote(chunk.type)}`);
  }
}

/** %q for the strings that appear in reasons (identifiers; quotes and backslashes escaped). */
function goQuote(s: string): string {
  return JSON.stringify(s);
}
