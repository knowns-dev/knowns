// Port of internal/memoryreview: duplicate review and resolution for new memories. A library: no
// CLI imports. Callers (CLI, MCP, server) hand it a wired Storage and, optionally, a search
// environment for the semantic leg.
import {
  MEMORY_LAYER_PROJECT,
  type MemoryEntry,
  memoryCurrentForDefaultRetrieval,
  validateNewMemoryCategory,
  validMemoryConfidence,
  validMemoryStatus,
  validPersistentMemoryLayer,
} from "../../models/memory.ts";
import type { SearchResult } from "../../models/search.ts";
import type { SearchEnvironment } from "../../search/config.ts";
import { searchWithRuntime } from "../../search/runtime.ts";
import { stableSort } from "../../search/text.ts";
import type { Storage } from "../../storage/adapters.ts";
import {
  type MemoryMatch,
  type MemoryReviewResult,
  memoryJson,
  memoryResultJson,
} from "./shape.ts";
import {
  appendUnique,
  firstNonEmpty,
  goTrimSpace,
  normalizedText,
  tokenSimilarity,
  truncateTrimmed,
} from "./text.ts";

export type { MemoryMatch, MemoryReviewResult };
export { memoryJson, memoryResultJson };

export const RESULT_CREATED = "created";
export const RESULT_REVIEW_REQUIRED = "review_required";
export const RESULT_RESOLVED = "resolved";

export const RESOLUTION_UPDATE_EXISTING = "update_existing";
export const RESOLUTION_ARCHIVE_EXISTING_CREATE_NEW = "archive_existing_create_new";
export const RESOLUTION_CREATE_PROPOSED = "create_proposed";
export const RESOLUTION_REJECT_NEW = "reject_new";
export const RESOLUTION_MERGE_EXISTING = "merge_existing";

const DEFAULT_REVIEW_LIMIT = 5;
const DEFAULT_REVIEW_THRESHOLD = 0.72;

export const ALLOWED_RESOLUTIONS: readonly string[] = [
  RESOLUTION_UPDATE_EXISTING,
  RESOLUTION_ARCHIVE_EXISTING_CREATE_NEW,
  RESOLUTION_CREATE_PROPOSED,
  RESOLUTION_REJECT_NEW,
  RESOLUTION_MERGE_EXISTING,
];

export type SemanticSearchFunc = (
  candidate: MemoryEntry,
  limit: number,
) => Promise<MemoryMatch[]> | MemoryMatch[];

export interface MemoryReviewOptions {
  now?: () => Date;
  /** Overrides the default semantic leg. Without it and without `searchEnv` there is no semantic leg. */
  semanticSearch?: SemanticSearchFunc;
  /** Enables the default semantic leg (searchWithRuntime, mode semantic, type memory). */
  searchEnv?: SearchEnvironment;
  reviewThreshold?: number;
  reviewLimit?: number;
  /** Pre-listed persistent entries, reused instead of listing from disk. */
  entries?: MemoryEntry[];
}

export interface AddOptions {
  skipReview?: boolean;
  status?: string;
}

export interface ResolveOptions {
  resolution: string;
  targetId?: string;
  status?: string;
  rejectedReason?: string;
}

export function cloneMemory(entry: MemoryEntry): MemoryEntry;
export function cloneMemory(entry: MemoryEntry | null | undefined): MemoryEntry | undefined;
export function cloneMemory(entry: MemoryEntry | null | undefined): MemoryEntry | undefined {
  if (!entry) return undefined;
  const clone: MemoryEntry = { ...entry };
  if (entry.tags) clone.tags = [...entry.tags];
  if (entry.sources) clone.sources = [...entry.sources];
  if (entry.lifecycleMetadataMissing) {
    clone.lifecycleMetadataMissing = [...entry.lifecycleMetadataMissing];
  }
  if (entry.metadata) clone.metadata = { ...entry.metadata };
  return clone;
}

export function candidateSearchText(entry: MemoryEntry | undefined): string {
  if (!entry) return "";
  return goTrimSpace(
    [entry.title, entry.category ?? "", (entry.tags ?? []).join(" "), entry.content ?? ""].join(
      "\n",
    ),
  );
}

export class MemoryReviewService {
  constructor(
    readonly storage: Storage,
    private readonly opts: MemoryReviewOptions = {},
  ) {}

  async add(candidate: MemoryEntry, opts: AddOptions = {}): Promise<MemoryReviewResult> {
    const entry = this.normalizeCandidate(candidate, firstNonEmpty(opts.status ?? "", "proposed"));
    if (!opts.skipReview) {
      const review = await this.review(entry);
      if (review && (review.matches?.length ?? 0) > 0) return review;
    }
    return this.create(entry, RESULT_CREATED, "");
  }

  /** Review: the persisted entries that look like the candidate, or undefined when none do. */
  async review(candidate: MemoryEntry): Promise<MemoryReviewResult | undefined> {
    const entry = this.normalizeCandidate(candidate, "proposed");
    let matches: MemoryMatch[] = [];
    try {
      matches = matches.concat(await this.semanticMatches(entry));
    } catch {
      // the semantic leg is best effort: a failure leaves the lexical leg
    }
    matches = matches.concat(this.lexicalMatches(entry));
    matches = mergeMatches(matches, this.threshold());
    if (matches.length === 0) return undefined;
    if (matches.length > this.limit()) matches = matches.slice(0, this.limit());
    return {
      status: RESULT_REVIEW_REQUIRED,
      candidate: entry,
      matches,
      allowedResolutions: [...ALLOWED_RESOLUTIONS],
    };
  }

  async resolve(
    candidate: MemoryEntry | undefined,
    opts: ResolveOptions,
  ): Promise<MemoryReviewResult> {
    if (!opts.resolution) throw new Error("resolution is required");
    switch (opts.resolution) {
      case RESOLUTION_UPDATE_EXISTING:
        return this.updateExisting(candidate, opts);
      case RESOLUTION_ARCHIVE_EXISTING_CREATE_NEW:
        return this.archiveExistingCreateNew(candidate, opts);
      case RESOLUTION_CREATE_PROPOSED: {
        const input = cloneMemory(candidate) ?? blankMemory();
        input.status = "proposed";
        return this.create(
          this.normalizeCandidate(input, "proposed"),
          RESULT_RESOLVED,
          opts.resolution,
        );
      }
      case RESOLUTION_REJECT_NEW: {
        const input = cloneMemory(candidate) ?? blankMemory();
        input.status = "rejected";
        const entry = this.normalizeCandidate(input, "rejected");
        if (opts.rejectedReason) entry.rejectedReason = opts.rejectedReason;
        if (!entry.rejectedReason) entry.rejectedReason = "rejected_by_review";
        return this.create(entry, RESULT_RESOLVED, opts.resolution);
      }
      case RESOLUTION_MERGE_EXISTING:
        return this.mergeExisting(candidate, opts);
      default:
        throw new Error(`unsupported memory review resolution: ${opts.resolution}`);
    }
  }

  private async updateExisting(
    candidate: MemoryEntry | undefined,
    opts: ResolveOptions,
  ): Promise<MemoryReviewResult> {
    if (!opts.targetId) throw new Error(`targetId is required for ${opts.resolution}`);
    if (candidate) {
      if (candidate.confidence && !validMemoryConfidence(candidate.confidence)) {
        throw new Error(`invalid memory confidence: "${candidate.confidence}"`);
      }
      if ((candidate.ttlDays ?? 0) < 0) throw new Error("ttlDays must be non-negative");
    }
    const existing = this.storage.memory.get(opts.targetId);
    const updated = cloneMemory(existing);
    if (candidate) {
      if (candidate.title) updated.title = candidate.title;
      if (candidate.category) updated.category = candidate.category;
      if (candidate.content) updated.content = candidate.content;
      if (candidate.tags !== undefined) updated.tags = [...candidate.tags];
      if (candidate.confidence) updated.confidence = candidate.confidence;
      if (candidate.sources !== undefined) updated.sources = [...candidate.sources];
      if ((candidate.ttlDays ?? 0) > 0) updated.ttlDays = candidate.ttlDays as number;
    }
    if (opts.status) {
      if (!validMemoryStatus(opts.status))
        throw new Error(`invalid memory status: "${opts.status}"`);
      updated.status = opts.status;
    }
    const now = this.now().toISOString();
    updated.lastVerified = now;
    updated.updatedAt = now;
    await this.storage.memory.update(updated);
    return {
      status: RESULT_RESOLVED,
      resolution: opts.resolution,
      memory: updated,
      changedIds: [updated.id],
    };
  }

  private async archiveExistingCreateNew(
    candidate: MemoryEntry | undefined,
    opts: ResolveOptions,
  ): Promise<MemoryReviewResult> {
    if (!opts.targetId) throw new Error(`targetId is required for ${opts.resolution}`);
    const status = firstNonEmpty(opts.status ?? "", "proposed");
    const input = cloneMemory(candidate) ?? blankMemory();
    input.status = status;
    const replacement = this.normalizeCandidate(input, status);
    const existing = this.storage.memory.get(opts.targetId);
    const archived = cloneMemory(existing);
    archived.status = "archived";
    archived.updatedAt = this.now().toISOString();
    await this.storage.memory.update(archived);
    if (replacement.id === archived.id) replacement.id = "";
    const created = await this.create(replacement, RESULT_RESOLVED, opts.resolution);
    created.changedIds = [archived.id, ...(created.changedIds ?? [])];
    return created;
  }

  private async mergeExisting(
    candidate: MemoryEntry | undefined,
    opts: ResolveOptions,
  ): Promise<MemoryReviewResult> {
    if (!opts.targetId) throw new Error(`targetId is required for ${opts.resolution}`);
    this.storage.memory.get(opts.targetId);
    if (candidate && candidate.id !== "") {
      let existing: MemoryEntry | undefined;
      try {
        existing = this.storage.memory.get(candidate.id);
      } catch {
        existing = undefined;
      }
      if (existing) {
        const merged = cloneMemory(existing);
        merged.status = "merged";
        merged.mergedInto = opts.targetId;
        merged.lastVerified = this.now().toISOString();
        await this.storage.memory.update(merged);
        return {
          status: RESULT_RESOLVED,
          resolution: opts.resolution,
          memory: merged,
          changedIds: [merged.id],
        };
      }
    }
    const input = cloneMemory(candidate) ?? blankMemory();
    input.status = "merged";
    const tombstone = this.normalizeCandidate(input, "merged");
    tombstone.mergedInto = opts.targetId;
    tombstone.lastVerified = this.now().toISOString();
    return this.create(tombstone, RESULT_RESOLVED, opts.resolution);
  }

  private async create(
    entry: MemoryEntry,
    status: "created" | "resolved",
    resolution: string,
  ): Promise<MemoryReviewResult> {
    await this.storage.memory.create(entry);
    const result: MemoryReviewResult = { status, memory: entry, changedIds: [entry.id] };
    if (resolution) result.resolution = resolution;
    return result;
  }

  private normalizeCandidate(
    candidate: MemoryEntry | undefined,
    defaultStatus: string,
  ): MemoryEntry {
    const entry = cloneMemory(candidate) ?? blankMemory();
    entry.title = goTrimSpace(entry.title);
    entry.content = goTrimSpace(entry.content ?? "");
    entry.category = goTrimSpace(entry.category ?? "");
    validateNewMemoryCategory(entry.category);
    entry.layer = goTrimSpace(entry.layer);
    if (entry.layer === "") entry.layer = MEMORY_LAYER_PROJECT;
    if (!validPersistentMemoryLayer(entry.layer)) {
      throw new Error(`invalid memory layer: "${entry.layer}"`);
    }
    if (!entry.status) entry.status = defaultStatus;
    if (entry.status && !validMemoryStatus(entry.status)) {
      throw new Error(`invalid memory status: "${entry.status}"`);
    }
    if (entry.confidence && !validMemoryConfidence(entry.confidence)) {
      throw new Error(`invalid memory confidence: "${entry.confidence}"`);
    }
    if ((entry.ttlDays ?? 0) < 0) throw new Error("ttlDays must be non-negative");
    if (entry.tags === undefined) entry.tags = [];
    const now = this.now().toISOString();
    if (isZero(entry.createdAt)) entry.createdAt = now;
    if (isZero(entry.updatedAt)) entry.updatedAt = now;
    return entry;
  }

  private async semanticMatches(candidate: MemoryEntry): Promise<MemoryMatch[]> {
    if (this.opts.semanticSearch) return this.opts.semanticSearch(candidate, this.limit());
    const env = this.opts.searchEnv;
    if (!env) return [];
    const response = await searchWithRuntime(this.storage, env, {
      query: candidateSearchText(candidate),
      type: "memory",
      mode: "semantic",
      limit: this.limit(),
    });
    const matches: MemoryMatch[] = [];
    for (const result of response.results) {
      if (result.id === "" || result.id === candidate.id) continue;
      if (!(result.matchedBy ?? []).includes("semantic")) continue;
      if (result.score < this.threshold()) continue;
      let entry: MemoryEntry;
      try {
        entry = this.memoryEntryForResult(result);
      } catch {
        continue;
      }
      if (!memoryCurrentForDefaultRetrieval(entry)) continue;
      matches.push(
        matchFromEntry(entry, result.score, [...(result.matchedBy ?? [])], result.snippet ?? ""),
      );
    }
    return matches;
  }

  private memoryEntryForResult(result: SearchResult): MemoryEntry {
    let layer = result.memoryLayer ?? "";
    if (layer === "" && result.memoryStore === "global-store") layer = "global";
    if (layer === "global") return this.storage.memory.getInLayer(result.id, "global");
    return this.storage.memory.get(result.id);
  }

  private lexicalMatches(candidate: MemoryEntry): MemoryMatch[] {
    let entries: MemoryEntry[];
    try {
      entries = this.opts.entries ?? this.storage.memory.listPersistent("");
    } catch {
      return [];
    }
    const matches: MemoryMatch[] = [];
    for (const entry of entries) {
      if (entry.id === candidate.id || !memoryCurrentForDefaultRetrieval(entry)) continue;
      const [score, reasons] = lexicalScore(candidate, entry);
      if (score < this.threshold()) continue;
      matches.push(matchFromEntry(entry, score, reasons, entry.content ?? ""));
    }
    sortMatches(matches);
    return matches;
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private threshold(): number {
    const t = this.opts.reviewThreshold;
    return t !== undefined && t > 0 ? t : DEFAULT_REVIEW_THRESHOLD;
  }

  private limit(): number {
    const l = this.opts.reviewLimit;
    return l !== undefined && l > 0 ? l : DEFAULT_REVIEW_LIMIT;
  }
}

function blankMemory(): MemoryEntry {
  return { id: "", title: "", layer: "", createdAt: "", updatedAt: "" };
}

function isZero(ts: string | undefined): boolean {
  return ts === undefined || ts === "" || ts === "0001-01-01T00:00:00Z";
}

/**
 * lexicalScore. Go builds the label order from a map iteration, which is random; the order here is
 * fixed (title tokens, content tokens, combined) so matchedBy is reproducible.
 */
export function lexicalScore(candidate: MemoryEntry, existing: MemoryEntry): [number, string[]] {
  const candidateTitle = normalizedText(candidate.title);
  const existingTitle = normalizedText(existing.title);
  const candidateContent = normalizedText(candidate.content ?? "");
  const existingContent = normalizedText(existing.content ?? "");
  const candidateAll = normalizedText(candidateSearchText(candidate));
  const existingAll = normalizedText(candidateSearchText(existing));

  let best = 0;
  const reasons: string[] = [];
  if (candidateTitle !== "" && candidateTitle === existingTitle) {
    best = Math.max(best, 0.98);
    reasons.push("lexical:title");
  }
  if (candidateContent !== "" && candidateContent === existingContent) {
    best = Math.max(best, 1.0);
    reasons.push("lexical:content");
  }
  const scored: [string, number][] = [
    ["lexical:title_tokens", tokenSimilarity(candidateTitle, existingTitle)],
    ["lexical:content_tokens", tokenSimilarity(candidateContent, existingContent)],
    ["lexical:combined", tokenSimilarity(candidateAll, existingAll)],
  ];
  for (const [label, score] of scored) {
    if (score > best) best = score;
    if (score >= DEFAULT_REVIEW_THRESHOLD) reasons.push(label);
  }
  if (
    candidate.category &&
    candidate.category.toLowerCase() === (existing.category ?? "").toLowerCase() &&
    best > 0
  ) {
    best = Math.min(1, best + 0.05);
    reasons.push("lexical:category");
  }
  if (reasons.length === 0 && best >= DEFAULT_REVIEW_THRESHOLD) reasons.push("lexical");
  return [best, reasons];
}

export function mergeMatches(matches: MemoryMatch[], threshold: number): MemoryMatch[] {
  const byId = new Map<string, MemoryMatch>();
  for (const raw of matches) {
    if (raw.id === "" || raw.score < threshold) continue;
    const existing = byId.get(raw.id);
    const match = { ...raw };
    if (!existing || match.score > existing.score) {
      match.matchedBy = appendUnique(existing?.matchedBy, ...(match.matchedBy ?? []));
      byId.set(match.id, match);
      continue;
    }
    existing.matchedBy = appendUnique(existing.matchedBy, ...(match.matchedBy ?? []));
  }
  const merged = [...byId.values()];
  sortMatches(merged);
  return merged;
}

export function sortMatches(matches: MemoryMatch[]): void {
  stableSort(matches, (a, b) => {
    if (a.score !== b.score) return a.score > b.score;
    return a.title < b.title;
  });
}

function matchFromEntry(
  entry: MemoryEntry,
  score: number,
  matchedBy: string[],
  snippet: string,
): MemoryMatch {
  return {
    id: entry.id,
    title: entry.title,
    layer: entry.layer,
    ...(entry.category ? { category: entry.category } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    score,
    ...(matchedBy.length > 0 ? { matchedBy } : {}),
    ...(goTrimSpace(snippet) !== "" ? { snippet: truncateTrimmed(goTrimSpace(snippet), 220) } : {}),
    ...(entry.tags && entry.tags.length > 0 ? { tags: [...entry.tags] } : {}),
  };
}
