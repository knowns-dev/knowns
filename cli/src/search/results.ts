// Go's encoding/json output shape for search results: struct field order, and `omitempty` for
// empty strings, zero numbers, false, nil/empty slices and nil pointers. The engine builds results
// loosely (an unset string is "" or undefined); these normalizers produce the exact shape Go
// marshals so `JSON.stringify` of a result matches `knowns search --json` byte for byte.
import type {
  Citation,
  ContextItem,
  RetrievalCandidate,
  SearchResult,
  SourceRecord,
} from "../models/search.ts";
import { cloneTime } from "./time.ts";

function empty(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    v === "" ||
    v === 0 ||
    v === false ||
    (Array.isArray(v) && v.length === 0)
  );
}

/** Copy `src` in `order`, dropping omitempty-empty values (keys in `required` always stay). */
function shape<T extends object>(
  src: Record<string, unknown>,
  order: readonly string[],
  required: readonly string[] = [],
): T {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    const v = src[key];
    if (required.includes(key)) out[key] = v;
    else if (!empty(v)) out[key] = v;
  }
  return out as T;
}

const TIME_FIELDS = ["completedAt", "archivedAt", "updatedAt"] as const;

function withTimes(obj: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...obj };
  for (const f of TIME_FIELDS) {
    if (typeof copy[f] === "string") copy[f] = cloneTime(copy[f] as string);
  }
  return copy;
}

const SEARCH_RESULT_ORDER = [
  "type",
  "id",
  "title",
  "score",
  "semanticScore",
  "snippet",
  "matchedBy",
  "status",
  "priority",
  "lifecycleState",
  "completedAt",
  "archivedAt",
  "path",
  "tags",
  "memoryLayer",
  "category",
  "memoryStore",
  "name",
  "signature",
  "_runtime",
] as const;

export function shapeSearchResult(r: SearchResult): SearchResult {
  const copy = withTimes(r as Record<string, unknown>);
  if (copy._runtime) {
    copy._runtime = shape(copy._runtime as Record<string, unknown>, RUNTIME_ORDER);
  }
  return shape<SearchResult>(copy, SEARCH_RESULT_ORDER, ["type", "id", "title", "score"]);
}

const RUNTIME_ORDER = [
  "degraded",
  "warming",
  "bootstrapQueued",
  "mode",
  "reason",
  "message",
] as const;

export function shapeRuntime<T extends object>(r: T): T {
  return shape<T>(r as Record<string, unknown>, RUNTIME_ORDER);
}

const CITATION_ORDER = ["type", "id", "path", "section"] as const;
export function shapeCitation(c: Citation): Citation {
  return shape<Citation>(c as Record<string, unknown>, CITATION_ORDER, ["type", "id"]);
}

const SOURCE_RECORD_ORDER = [
  "type",
  "id",
  "path",
  "tags",
  "status",
  "priority",
  "lifecycleState",
  "completedAt",
  "archivedAt",
  "memoryLayer",
  "category",
  "memoryStore",
  "updatedAt",
  "imported",
  "source",
] as const;
export function shapeSourceRecord(r: SourceRecord): SourceRecord {
  return shape<SourceRecord>(withTimes(r as Record<string, unknown>), SOURCE_RECORD_ORDER, [
    "type",
    "id",
  ]);
}

const CANDIDATE_ORDER = [
  "type",
  "id",
  "title",
  "path",
  "score",
  "matchedBy",
  "snippet",
  "citation",
  "directMatch",
  "expandedFrom",
  "status",
  "priority",
  "lifecycleState",
  "completedAt",
  "archivedAt",
  "tags",
  "memoryLayer",
  "category",
  "memoryStore",
  "sourcePreference",
  "updatedAt",
  "metadata",
] as const;
export function shapeCandidate(c: RetrievalCandidate): RetrievalCandidate {
  const copy = withTimes(c as Record<string, unknown>);
  copy.citation = shapeCitation(c.citation);
  copy.metadata = shapeSourceRecord(c.metadata);
  return shape<RetrievalCandidate>(copy, CANDIDATE_ORDER, [
    "type",
    "id",
    "title",
    "score",
    "citation",
    "directMatch",
    "sourcePreference",
    "metadata",
  ]);
}

const CONTEXT_ITEM_ORDER = [
  "type",
  "id",
  "title",
  "content",
  "snippet",
  "directMatch",
  "expandedFrom",
  "citation",
  "lifecycleState",
  "completedAt",
  "archivedAt",
  "metadata",
] as const;
export function shapeContextItem(c: ContextItem): ContextItem {
  const copy = withTimes(c as Record<string, unknown>);
  copy.citation = shapeCitation(c.citation);
  copy.metadata = shapeSourceRecord(c.metadata);
  return shape<ContextItem>(copy, CONTEXT_ITEM_ORDER, [
    "type",
    "id",
    "title",
    "content",
    "directMatch",
    "citation",
    "metadata",
  ]);
}
