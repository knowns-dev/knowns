// How Go marshals models.MemoryEntry and the memoryreview Result: declared field order and
// omitempty rules. The stores return plain objects, so every --json / journal write goes through here.
import type { MemoryEntry } from "../../models/memory.ts";
import { type JsonObject, type Spec, shapeStruct } from "../../storage/stores/go-shape.ts";

const GO_ZERO_TIME = "0001-01-01T00:00:00Z";

const MEMORY_SPEC: Spec = [
  ["id", { req: "" }],
  ["title", { req: "" }],
  ["key", "str"],
  ["layer", { req: "" }],
  ["category", "str"],
  ["content", "str"],
  ["status", "str"],
  ["confidence", "str"],
  ["lastVerified", { req: GO_ZERO_TIME }],
  ["ttlDays", "int"],
  ["sources", "list"],
  ["mergedInto", "str"],
  ["rejectedReason", "str"],
  ["tags", "list"],
  ["metadata", "map"],
  ["createdAt", { req: GO_ZERO_TIME }],
  ["updatedAt", { req: GO_ZERO_TIME }],
  ["lifecycleMetadataMissing", "list"],
];

/** The JSON object Go would marshal for a MemoryEntry. */
export function memoryJson(entry: MemoryEntry): JsonObject {
  return shapeStruct(entry as unknown as JsonObject, MEMORY_SPEC);
}

const MATCH_SPEC: Spec = [
  ["id", { req: "" }],
  ["title", { req: "" }],
  ["layer", { req: "" }],
  ["category", "str"],
  ["status", "str"],
  ["score", { req: 0 }],
  ["matchedBy", "list"],
  ["snippet", "str"],
  ["tags", "list"],
];

export interface MemoryMatch {
  id: string;
  title: string;
  layer: string;
  category?: string;
  status?: string;
  score: number;
  matchedBy?: string[];
  snippet?: string;
  tags?: string[];
}

export type MemoryReviewStatus = "created" | "review_required" | "resolved";

export interface MemoryReviewResult {
  status: MemoryReviewStatus;
  resolution?: string;
  candidate?: MemoryEntry;
  matches?: MemoryMatch[];
  allowedResolutions?: string[];
  memory?: MemoryEntry;
  changedIds?: string[];
}

/** The JSON object Go would marshal for a memoryreview.Result. */
export function memoryResultJson(r: MemoryReviewResult): JsonObject {
  const out: JsonObject = { status: r.status };
  if (r.resolution) out.resolution = r.resolution;
  if (r.candidate) out.candidate = memoryJson(r.candidate);
  if (r.matches && r.matches.length > 0) {
    out.matches = r.matches.map((m) => shapeStruct(m as unknown as JsonObject, MATCH_SPEC));
  }
  if (r.allowedResolutions && r.allowedResolutions.length > 0) {
    out.allowedResolutions = r.allowedResolutions;
  }
  if (r.memory) out.memory = memoryJson(r.memory);
  if (r.changedIds && r.changedIds.length > 0) out.changedIds = r.changedIds;
  return out;
}
