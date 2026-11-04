// Port of the REST client in internal/search/qdrant_client.go. It talks to an already reachable
// Qdrant over HTTP (managed local or external); installation and ownership live elsewhere.
// Every response is a boundary and is parsed with zod.
import { z } from "zod";
import { float32ArrayJson, goJson } from "../json.ts";
import { goTransportError } from "../neterror.ts";
import { byteSlicePrefix } from "../text.ts";
import type { Chunk, ChunkType, ScoredChunk } from "../types.ts";
import {
  chunkFromQdrantPayload,
  PAYLOAD_SOURCE_ID,
  PAYLOAD_TYPE,
  type QdrantPayload,
  qdrantPayloadFromChunk,
  qdrantPointIdForChunkId,
} from "./payload.ts";
import {
  type QdrantHitValidationContext,
  type QdrantHitValidationSummary,
  type QdrantScoredPayload,
  validateQdrantPayloads,
} from "./validation.ts";

export const QDRANT_REST_DISTANCE_COSINE = "Cosine";
/** Keeps generation requests comfortably below Qdrant's default 32 MiB JSON payload limit. */
export const QDRANT_UPSERT_BATCH_SIZE = 256;
const DEFAULT_TIMEOUT_MS = 15_000;

/** ErrQdrantNotFound: Qdrant reported a missing resource. */
export class QdrantNotFoundError extends Error {
  override name = "QdrantNotFoundError";
  constructor() {
    super("qdrant resource not found");
  }
}

export interface QdrantClientConfig {
  url: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface QdrantCollectionInfo {
  name: string;
  exists: boolean;
  dimensions: number;
  distance: string;
  status: string;
  pointsCount: number;
}

export interface QdrantPoint {
  id: string;
  vector: Float32Array;
  payload?: QdrantPayload;
}

export interface QdrantFilterCondition {
  key: string;
  value: unknown;
}

export interface QdrantQueryOptions {
  topK: number;
  threshold: number;
  chunkType?: ChunkType | "";
  filters?: QdrantFilterCondition[];
}

/** The backend contract; tests and the generation builder provide fakes without a live Qdrant. */
export interface QdrantClient {
  createCollection(name: string, dimensions: number): Promise<void>;
  collectionExists(name: string): Promise<boolean>;
  inspectCollection(name: string): Promise<QdrantCollectionInfo>;
  countPoints(name: string): Promise<number>;
  upsertPoints(name: string, points: QdrantPoint[]): Promise<void>;
  query(name: string, queryVec: Float32Array, opts: QdrantQueryOptions): Promise<ScoredChunk[]>;
  queryValidated(
    name: string,
    queryVec: Float32Array,
    opts: QdrantQueryOptions,
    validation: QdrantHitValidationContext,
  ): Promise<{ chunks: ScoredChunk[]; summary: QdrantHitValidationSummary }>;
  deletePoints(name: string, pointIds: string[]): Promise<void>;
  deleteCollection(name: string): Promise<void>;
}

const existsSchema = z.object({ result: z.object({ exists: z.boolean().default(false) }) });
const vectorParamsSchema = z.object({
  size: z.number().default(0),
  distance: z.string().default(""),
});
const collectionSchema = z.object({
  result: z.object({
    status: z.string().default(""),
    points_count: z.number().nullable().default(0),
    config: z
      .object({ params: z.object({ vectors: z.unknown().optional() }).default({}) })
      .default({ params: {} }),
  }),
});
const countSchema = z.object({ result: z.object({ count: z.number().default(0) }) });
const searchSchema = z.object({
  result: z
    .array(
      z.object({
        id: z.unknown().optional(),
        score: z.number(),
        payload: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    )
    .nullable()
    .default([]),
});

/** url.PathEscape: unreserved characters and "$&+=:@" stay, everything else is percent-encoded. */
export function pathEscape(part: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(part)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~$&+=:@]/.test(ch)) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function parseVectorsConfig(raw: unknown): { dimensions: number; distance: string } {
  const direct = vectorParamsSchema.safeParse(raw);
  if (direct.success && direct.data.size > 0 && raw && typeof raw === "object" && "size" in raw) {
    return { dimensions: direct.data.size, distance: direct.data.distance.toLowerCase() };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const value of Object.values(raw)) {
      const named = vectorParamsSchema.safeParse(value);
      if (named.success && named.data.size > 0) {
        return { dimensions: named.data.size, distance: named.data.distance.toLowerCase() };
      }
    }
  }
  return { dimensions: 0, distance: "" };
}

export class QdrantHttpClient implements QdrantClient {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(cfg: QdrantClientConfig) {
    const base = cfg.url.trim().replace(/\/+$/, "");
    if (base === "") throw new Error("qdrant url is required");
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch (err) {
      throw new Error(`parse qdrant url: ${(err as Error).message}`);
    }
    if (parsed.protocol === "" || parsed.host === "") {
      throw new Error("qdrant url must include scheme and host");
    }
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("qdrant url must not contain credentials, query secrets, or fragments");
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    const scheme = parsed.protocol.replace(/:$/, "");
    if (scheme !== "https" && !(scheme === "http" && loopback)) {
      throw new Error("non-loopback Qdrant endpoints require HTTPS");
    }
    this.baseURL = base;
    this.apiKey = cfg.apiKey ?? "";
    this.fetchImpl = cfg.fetch ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async createCollection(name: string, dimensions: number): Promise<void> {
    if (name.trim() === "") throw new Error("collection name is required");
    if (dimensions <= 0) throw new Error("collection dimensions must be positive");
    await this.doJSON("PUT", ["collections", name], {
      vectors: { size: dimensions, distance: QDRANT_REST_DISTANCE_COSINE },
    });
  }

  async collectionExists(name: string): Promise<boolean> {
    try {
      const resp = await this.doJSON(
        "GET",
        ["collections", name, "exists"],
        undefined,
        existsSchema,
      );
      return resp.result.exists;
    } catch (err) {
      if (err instanceof QdrantNotFoundError) return false;
      throw err;
    }
  }

  async inspectCollection(name: string): Promise<QdrantCollectionInfo> {
    const info: QdrantCollectionInfo = {
      name,
      exists: false,
      dimensions: 0,
      distance: "",
      status: "",
      pointsCount: 0,
    };
    info.exists = await this.collectionExists(name);
    if (!info.exists) return info;
    try {
      const resp = await this.doJSON("GET", ["collections", name], undefined, collectionSchema);
      info.status = resp.result.status;
      info.pointsCount = resp.result.points_count ?? 0;
      const vectors = parseVectorsConfig(resp.result.config.params.vectors);
      info.dimensions = vectors.dimensions;
      info.distance = vectors.distance;
    } catch (err) {
      if (err instanceof QdrantNotFoundError) {
        info.exists = false;
        return info;
      }
      throw err;
    }
    return info;
  }

  async countPoints(name: string): Promise<number> {
    const resp = await this.doJSON(
      "POST",
      ["collections", name, "points", "count"],
      { exact: true },
      countSchema,
    );
    return resp.result.count;
  }

  async upsertPoints(name: string, points: QdrantPoint[]): Promise<void> {
    if (points.length === 0) return;
    const batchCount = Math.ceil(points.length / QDRANT_UPSERT_BATCH_SIZE);
    let batch = 1;
    for (let start = 0; start < points.length; start += QDRANT_UPSERT_BATCH_SIZE, batch++) {
      const slice = points.slice(start, start + QDRANT_UPSERT_BATCH_SIZE);
      // Vectors need Go's float32 spelling, so the body is assembled by hand.
      const body = `{"points":[${slice.map(qdrantPointJson).join(",")}]}`;
      try {
        await this.doRaw("PUT", ["collections", name, "points"], "wait=true", body);
      } catch (err) {
        throw new Error(`upsert batch ${batch}/${batchCount}: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }
  }

  async query(
    name: string,
    queryVec: Float32Array,
    opts: QdrantQueryOptions,
  ): Promise<ScoredChunk[]> {
    const raw = await this.queryPayloads(name, queryVec, opts);
    const out: ScoredChunk[] = [];
    for (const point of raw) {
      const chunk = chunkFromQdrantPayload(point.payload);
      if (chunk.id === "") continue;
      out.push({ ...chunk, score: point.score });
    }
    return out;
  }

  /** Searches and drops stale hits before result assembly reads snippets from canonical files. */
  async queryValidated(
    name: string,
    queryVec: Float32Array,
    opts: QdrantQueryOptions,
    validation: QdrantHitValidationContext,
  ): Promise<{ chunks: ScoredChunk[]; summary: QdrantHitValidationSummary }> {
    const raw = await this.queryPayloads(name, queryVec, opts);
    const { chunks, summary } = validateQdrantPayloads(validation, raw);
    return { chunks, summary };
  }

  private async queryPayloads(
    name: string,
    queryVec: Float32Array,
    opts: QdrantQueryOptions,
  ): Promise<QdrantScoredPayload[]> {
    if (queryVec.length === 0) throw new Error("query vector is required");
    const limit = opts.topK > 0 ? opts.topK : 20;
    let body = `{"vector":${float32ArrayJson(queryVec)},"limit":${limit},"with_payload":true`;
    const filter = filterFromQueryOptions(opts);
    if (filter) body += `,"filter":${goJson(filter)}`;
    if (opts.threshold > 0) body += `,"score_threshold":${JSON.stringify(opts.threshold)}`;
    body += "}";
    const resp = await this.doRaw(
      "POST",
      ["collections", name, "points", "search"],
      "",
      body,
      searchSchema,
    );
    return (resp.result ?? []).map((p) => ({
      score: p.score,
      payload: (p.payload ?? {}) as QdrantPayload,
    }));
  }

  async deletePoints(name: string, pointIds: string[]): Promise<void> {
    if (pointIds.length === 0) return;
    await this.doRaw(
      "POST",
      ["collections", name, "points", "delete"],
      "wait=true",
      goJson({ points: pointIds }),
    );
  }

  /** Removes every point whose source_id equals sourceId; never scans or deletes a collection. */
  async deletePointsBySource(name: string, sourceId: string): Promise<void> {
    if (sourceId.trim() === "") throw new Error("qdrant source id is required");
    const body = goJson({
      filter: { must: [{ key: PAYLOAD_SOURCE_ID, match: { value: sourceId } }] },
    });
    await this.doRaw("POST", ["collections", name, "points", "delete"], "wait=true", body);
  }

  /** Missing collections count as already deleted so cleanup is idempotent. */
  async deleteCollection(name: string): Promise<void> {
    try {
      await this.doRaw("DELETE", ["collections", name], "wait=true");
    } catch (err) {
      if (err instanceof QdrantNotFoundError) return;
      throw err;
    }
  }

  private doJSON<S extends z.ZodType>(
    method: string,
    parts: string[],
    body?: unknown,
    schema?: S,
  ): Promise<S extends z.ZodType ? z.infer<S> : undefined> {
    return this.doRaw(method, parts, "", body === undefined ? undefined : goJson(body), schema);
  }

  private async doRaw<S extends z.ZodType>(
    method: string,
    parts: string[],
    query: string,
    body?: string,
    schema?: S,
  ): Promise<S extends z.ZodType ? z.infer<S> : undefined> {
    const path = `/${parts.map(pathEscape).join("/")}`;
    const url = `${this.baseURL}${path}${query ? `?${query}` : ""}`;
    const decodedPath = `/${parts.join("/")}`;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.apiKey !== "") headers["api-key"] = this.apiKey;
    let resp: Response;
    let text: string;
    try {
      resp = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await resp.text();
    } catch (err) {
      throw new Error(`qdrant ${method} ${decodedPath}: ${goTransportError(method, url, err)}`, {
        cause: err,
      });
    }
    if (resp.status === 404) throw new QdrantNotFoundError();
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        `qdrant ${method} ${decodedPath}: status ${resp.status}: ${byteSlicePrefix(text, 4096).trim()}`,
      );
    }
    if (!schema) return undefined as S extends z.ZodType ? z.infer<S> : undefined;
    try {
      return schema.parse(JSON.parse(text)) as S extends z.ZodType ? z.infer<S> : undefined;
    } catch (err) {
      throw new Error(`decode qdrant response: ${(err as Error).message}`);
    }
  }
}

interface QdrantFilter {
  must: { key: string; match: { value?: unknown; any?: unknown } }[];
}

function filterFromQueryOptions(opts: QdrantQueryOptions): QdrantFilter | undefined {
  const conditions: QdrantFilterCondition[] = [];
  if (opts.chunkType) conditions.push({ key: PAYLOAD_TYPE, value: opts.chunkType });
  conditions.push(...(opts.filters ?? []));
  const must: QdrantFilter["must"] = [];
  for (const c of conditions) {
    if (c.key.trim() === "" || c.value === undefined || c.value === null) continue;
    must.push({
      key: c.key,
      match: Array.isArray(c.value) ? { any: c.value } : { value: c.value },
    });
  }
  return must.length === 0 ? undefined : { must };
}

/** json.Marshal of a QdrantPoint: id, vector (float32 digits), then the payload with sorted keys. */
export function qdrantPointJson(p: QdrantPoint): string {
  const payload =
    p.payload && Object.keys(p.payload).length > 0
      ? `,"payload":${goJson(p.payload, { sortMaps: true })}`
      : "";
  return `{"id":${goJson(p.id)},"vector":${float32ArrayJson(p.vector)}${payload}}`;
}

/** Maps an embedded chunk to a point with a deterministic UUID id and a pointer-only payload. */
export function qdrantPointFromChunk(chunk: Chunk, sourceContentHash: string): QdrantPoint {
  return {
    id: qdrantPointIdForChunkId(chunk.id),
    vector: Float32Array.from(chunk.embedding ?? []),
    payload: qdrantPayloadFromChunk(chunk, sourceContentHash),
  };
}

/** Merges project and global collection result sets, ranked by score (collections stay separate). */
export function mergeQdrantScoredChunks(limit: number, ...sets: ScoredChunk[][]): ScoredChunk[] {
  const merged = sets.flat();
  merged.sort((a, b) => b.score - a.score);
  return limit > 0 && merged.length > limit ? merged.slice(0, limit) : merged;
}
