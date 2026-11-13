// Port of internal/search/engine.go: keyword, semantic and hybrid search over the wired storage,
// and mixed-source retrieval with citations. Keyword search needs no embedder or vector store;
// when the semantic leg fails operationally the search degrades to keyword results (Locked
// Decision D3 of the Go implementation) and reports why.

import { effectiveTaskLifecycle } from "../models/config.ts";
import type { MemoryEntry } from "../models/memory.ts";
import type { SemanticReference } from "../models/reference.ts";
import type {
  Citation,
  ContextItem,
  RetrievalCandidate,
  RetrievalOptions,
  RetrievalResponse,
  SearchResult,
  SourceRecord,
} from "../models/search.ts";
import { type Task, taskLifecycleState } from "../models/task.ts";
import type { Storage } from "../storage/adapters.ts";
import { decisionText } from "./chunker.ts";
import { errorChainHas, SemanticUnavailableError, semanticUnavailable } from "./errors.ts";
import { mulAdd } from "./fma.ts";
import {
  bm25Search,
  type LexicalSource,
  memoryStoreForLayer,
  phraseMatch,
  sourcePreference,
  wordBoundaryCount,
} from "./lexical.ts";
import { shapeCandidate, shapeContextItem, shapeSearchResult } from "./results.ts";
import {
  compareStrings,
  containsStr,
  goFields,
  goToLower,
  goTrimSpace,
  stableSort,
  truncateStr,
} from "./text.ts";
import { cloneTime, timeMillis, timePtr } from "./time.ts";
import type {
  ChunkType,
  EmbedderProvider,
  ScoredChunk,
  SearchOptions,
  VectorStore,
} from "./types.ts";
import {
  decisionVisibleForSearch,
  memoryVisibleForSearch,
  taskLifecycleRank,
  taskMatchesSearchFilters,
  taskVisibleForSearch,
} from "./visibility.ts";

const MEMORY_STORE_GLOBAL = "global-store";

/** SearchDegradation: the search succeeded at reduced quality because its semantic leg failed. */
export interface SearchDegradation {
  /** The classified embedder-boundary failure, suitable for a user-facing reason string. */
  err: Error;
}

/** A semantic engine for one memory layer's store (project or machine-global). */
export interface MemorySemanticStore {
  engine: Engine;
  memoryLayer: string;
  storeName: string;
  close(): Promise<void> | void;
}

export interface ReferenceExtractor {
  /** internal/references.Extract. */
  extract(content: string): SemanticReference[];
}

export interface EngineDeps {
  storage: Storage;
  /** Absent for keyword-only mode. */
  embedder?: EmbedderProvider;
  vecStore?: VectorStore;
  /** Opens the project and global memory stores for semantic memory search. */
  memorySemantic?: () => Promise<MemorySemanticStore[]>;
  /** The reference extractor (internal/references is not ported yet); needed by expandReferences. */
  references?: ReferenceExtractor;
  now?: () => number;
}

export interface SearchOutcome {
  results: SearchResult[];
  degraded?: SearchDegradation;
}

/**
 * Keyword, semantic and hybrid search over the wired storage. Construct it with an embedder and a
 * vector store for semantic modes; without them every mode behaves as keyword search.
 */
export class Engine {
  private readonly storage: Storage;
  private readonly embedder: EmbedderProvider | undefined;
  private readonly vecStore: VectorStore | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: EngineDeps) {
    this.storage = deps.storage;
    this.embedder = deps.embedder;
    this.vecStore = deps.vecStore;
    this.now = deps.now ?? Date.now;
  }

  /** True when the engine can perform semantic search. */
  semanticAvailable(): boolean {
    return this.embedder !== undefined && this.vecStore !== undefined && this.vecStore.count() > 0;
  }

  async search(opts: SearchOptions): Promise<SearchResult[]> {
    return (await this.searchWithDegradation(opts)).results;
  }

  async searchWithDegradation(input: SearchOptions): Promise<SearchOutcome> {
    let opts: SearchOptions = { ...input };
    if (!opts.limit || opts.limit <= 0) opts.limit = 20;
    if (!opts.type) opts.type = "all";
    if (!opts.mode) opts.mode = "hybrid";
    opts = this.resolveTaskVisibility(opts);

    const query = goTrimSpace(opts.query);
    if (query === "") return { results: [] };
    opts = await this.withTaskSnapshot(opts);

    let mode = opts.mode as string;
    let semanticAvailable = false;
    if (mode !== "keyword") semanticAvailable = await this.semanticAvailableForType(opts.type);
    if (mode !== "keyword" && !semanticAvailable) mode = "keyword";

    let results: SearchResult[];
    let degraded: SearchDegradation | undefined;
    switch (mode) {
      case "semantic":
        try {
          results = await this.semanticSearch(query, opts);
        } catch (err) {
          if (!errorChainHas(err, SemanticUnavailableError)) throw err;
          // Semantic mode has no keyword leg already running, so run one now.
          degraded = { err: err as Error };
          results = this.keywordSearch(query, opts);
        }
        break;
      case "hybrid": {
        const hybrid = await this.hybridSearch(query, opts);
        results = hybrid.results;
        degraded = hybrid.degraded;
        break;
      }
      default:
        results = this.keywordSearch(query, opts);
    }

    results = filterSearchResultsByType(results, opts.type);
    results = this.canonicalizeTaskResults(results, opts);

    // Keep established cross-source score ordering, then lifecycle-group the task subsequence in
    // the same result slots so an archived task never outranks an active one.
    stableSort(results, (a, b) => a.score > b.score);
    if (opts.includeHistorical) groupHistoricalTaskResults(results);
    const limit = opts.limit ?? 20;
    if (results.length > limit) results = results.slice(0, limit);
    return degraded
      ? { results: results.map(shapeSearchResult), degraded }
      : { results: results.map(shapeSearchResult) };
  }

  /** Mixed-source retrieval assembled into a context pack. */
  async retrieve(opts: RetrievalOptions): Promise<RetrievalResponse> {
    let semanticAvailable = false;
    if (opts.mode !== "keyword") {
      semanticAvailable = await this.semanticAvailableForType(
        typeFilterFromSources(opts.sourceTypes),
      );
    }
    let searchOpts: SearchOptions = {
      query: opts.query,
      mode: opts.mode,
      limit: opts.limit,
      tag: opts.tag,
      status: opts.status,
      priority: opts.priority,
      assignee: opts.assignee,
      label: opts.label,
      type: typeFilterFromSources(opts.sourceTypes),
      includeHistorical: opts.includeHistorical,
      purpose: "ai-retrieval",
    };
    searchOpts = this.resolveTaskVisibility(searchOpts);
    searchOpts = await this.withTaskSnapshot(searchOpts);

    const results = await this.search(searchOpts);
    const { candidates, items } = this.assembleRetrieval(results, opts, searchOpts);
    return {
      query: goTrimSpace(opts.query),
      mode: effectiveMode(searchOpts.mode ?? "", semanticAvailable),
      candidates,
      contextPack: { items, mode: "docs-first" },
    };
  }

  /**
   * Search results to shaped candidates and a context pack: source filter, candidate build,
   * optional reference expansion, canonicalization against the task snapshot, then the pack.
   * `limit` (when > 0) truncates the candidates before the pack is built, as the runtime path does.
   */
  assembleRetrieval(
    results: SearchResult[],
    opts: RetrievalOptions,
    searchOpts: SearchOptions,
    limit = 0,
  ): { candidates: RetrievalCandidate[]; items: ContextItem[] } {
    const filtered = filterBySourceTypes(results, opts.sourceTypes);
    let candidates = this.buildCandidates(filtered, searchOpts);
    if (opts.expandReferences) {
      const expanded = this.expandCandidateReferences(candidates, opts, searchOpts);
      candidates = mergeCandidates(candidates, expanded, opts.includeHistorical ?? false);
    }
    candidates = this.canonicalizeRetrievalCandidates(candidates, searchOpts);
    if (limit > 0 && candidates.length > limit) candidates = candidates.slice(0, limit);
    return {
      candidates: candidates.map(shapeCandidate),
      items: this.buildContextPack(candidates, searchOpts).map(shapeContextItem),
    };
  }

  // --- task snapshot and visibility -----------------------------------------------------------

  /** Resolves the lifecycle visibility the purpose implies (Search is human, Retrieve is AI). */
  resolveTaskVisibility(input: SearchOptions): SearchOptions {
    const opts = { ...input };
    // A populated snapshot is a complete query boundary: keep the policy it was captured under.
    if (opts.taskSnapshot && opts.taskVisibility) return opts;
    if (opts.includeHistorical) {
      opts.taskVisibility = "active-done-archived";
      return opts;
    }
    if (!opts.purpose) opts.purpose = "human-search";
    if (opts.purpose !== "ai-retrieval") {
      opts.taskVisibility = "active-and-done";
      return opts;
    }
    // Fail closed when project configuration is unavailable.
    let excludeDone = true;
    try {
      const project = this.storage.config.load();
      excludeDone = effectiveTaskLifecycle(project.settings).excludeDoneFromDefaultRetrieval;
    } catch {
      // keep the default
    }
    opts.taskVisibility = excludeDone ? "active-only" : "active-and-done";
    return opts;
  }

  /** Captures the tasks a query may see, under the task lifecycle lock, as one consistent view. */
  async withTaskSnapshot(input: SearchOptions): Promise<SearchOptions> {
    if (input.taskSnapshot) return input;
    const snapshot = new Map<string, Task>();
    const opts: SearchOptions = { ...input, taskSnapshot: snapshot };
    if (opts.type && opts.type !== "all" && opts.type !== "task") return opts;
    const { tasks } = this.storage;
    await this.storage.ctx.withTaskLifecycleLock(async () => {
      const active = tasks.listActive();
      if (opts.taskVisibility === "active-done-archived") {
        for (const task of tasks.listArchived()) {
          if (!tasks.isIdReserved(task.id)) snapshot.set(task.id, task);
        }
      }
      // Active storage wins over migration artifacts in both locations.
      for (const task of active) {
        if (!tasks.isIdReserved(task.id)) snapshot.set(task.id, task);
      }
    });
    return opts;
  }

  private async semanticAvailableForType(searchType: string | undefined): Promise<boolean> {
    switch (searchType) {
      case "memory":
        return this.memorySemanticAvailable();
      case "decision":
        return this.semanticAvailable();
      case "":
      case "all":
      case undefined:
        return this.semanticAvailable() || (await this.memorySemanticAvailable());
      default:
        return this.semanticAvailable();
    }
  }

  /** Public so the runtime can ask the same question the engine asks. */
  async semanticAvailableFor(searchType: string): Promise<boolean> {
    return this.semanticAvailableForType(searchType);
  }

  // --- keyword ----------------------------------------------------------------------------------

  private lexicalSource(): LexicalSource {
    const { storage } = this;
    return {
      tasks: (opts) =>
        opts.taskSnapshot ? [...opts.taskSnapshot.values()] : storage.tasks.listActive(),
      docs: () => storage.docs.list(),
      memories: () => storage.memory.list(""),
      decisions: () => storage.decisions.list(),
    };
  }

  private keywordSearch(query: string, opts: SearchOptions): SearchResult[] {
    return bm25Search(this.lexicalSource(), query, opts);
  }

  // --- semantic -----------------------------------------------------------------------------------

  private async semanticSearch(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    if (opts.type === "memory") return this.semanticMemorySearch(query, opts);
    if (!this.embedder || !this.vecStore) {
      throw semanticUnavailable("semantic search is not available");
    }
    let queryVec: Float32Array;
    try {
      queryVec = await this.embedder.embedQuery(query);
    } catch (err) {
      throw semanticUnavailable("embed query", err);
    }
    let topK = (opts.limit ?? 20) * 2;
    if (!opts.type || opts.type === "all" || opts.type === "task") {
      // Task lifecycle is canonical-file state, not trusted index metadata: scan every vector
      // candidate so stale historical chunks cannot crowd active tasks out before filtering.
      topK = this.vecStore.count();
    }
    const scored = await this.vecStore.search(queryVec, {
      topK,
      threshold: 0.3,
      chunkType: chunkTypeForSearchType(opts.type),
    });
    const searchErr = this.vecStore.lastSearchError?.();
    if (searchErr) throw semanticUnavailable("semantic vector query failed", searchErr);
    return this.scoredChunksToResults(scored, opts, "semantic", query);
  }

  private async hybridSearch(query: string, opts: SearchOptions): Promise<SearchOutcome> {
    if (opts.type === "memory") return { results: await this.hybridMemorySearch(query, opts) };
    const kwResults = this.keywordSearch(query, opts);
    let semResults: SearchResult[];
    try {
      semResults = await this.semanticSearch(query, opts);
    } catch (err) {
      if (errorChainHas(err, SemanticUnavailableError)) {
        // D3: an operational embedder failure degrades hybrid search to its keyword leg.
        return { results: kwResults, degraded: { err: err as Error } };
      }
      throw err;
    }
    const merged = mergeResults(kwResults, semResults, 0);
    return { results: this.rerank(merged, query, 0, opts) };
  }

  private async memorySemanticAvailable(): Promise<boolean> {
    if (!this.deps.memorySemantic) return false;
    let stores: MemorySemanticStore[];
    try {
      stores = await this.deps.memorySemantic();
    } catch {
      return false;
    }
    try {
      return stores.some((s) => s.engine.semanticAvailable());
    } finally {
      await closeAll(stores);
    }
  }

  private async semanticMemorySearch(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    if (!this.deps.memorySemantic) return [];
    const stores = await this.deps.memorySemantic();
    try {
      let merged: SearchResult[] = [];
      for (const s of stores) {
        if (!s.engine.semanticAvailable()) continue;
        try {
          merged = merged.concat(
            await s.engine.semanticSearchSingleStore(query, opts, s.memoryLayer, s.storeName),
          );
        } catch {
          // a store that cannot answer is skipped, as in Go
        }
      }
      return mergeStoreMemoryResults(merged, opts.limit ?? 20);
    } finally {
      await closeAll(stores);
    }
  }

  private async hybridMemorySearch(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    const kwResults = this.keywordSearch(query, opts);
    let semResults: SearchResult[];
    try {
      semResults = await this.semanticMemorySearch(query, opts);
    } catch {
      return kwResults;
    }
    const limit = opts.limit ?? 20;
    const merged = mergeResults(kwResults, semResults, limit * 2);
    return this.rerank(merged, query, limit, opts);
  }

  /** semanticSearchSingleStore: one memory store, memory chunks only. */
  async semanticSearchSingleStore(
    query: string,
    opts: SearchOptions,
    memoryLayer: string,
    memoryStore: string,
  ): Promise<SearchResult[]> {
    if (!this.embedder || !this.vecStore) {
      throw semanticUnavailable("semantic search is not available");
    }
    let queryVec: Float32Array;
    try {
      queryVec = await this.embedder.embedQuery(query);
    } catch (err) {
      throw semanticUnavailable("embed query", err);
    }
    const scored = await this.vecStore.search(queryVec, {
      topK: (opts.limit ?? 20) * 2,
      threshold: 0.3,
      chunkType: "memory",
    });
    const searchErr = this.vecStore.lastSearchError?.();
    if (searchErr) throw semanticUnavailable("semantic vector query failed", searchErr);
    const results = this.scoredChunksToResults(scored, opts, "semantic", query);
    for (const r of results) {
      r.memoryLayer = memoryLayer;
      r.memoryStore = memoryStore;
    }
    return results;
  }

  /**
   * scoredChunksToResults: vector hits back to search results. A source's score is its best chunk
   * plus a decayed bonus from up to two further chunks.
   */
  private scoredChunksToResults(
    scored: ScoredChunk[],
    opts: SearchOptions,
    method: string,
    query: string,
  ): SearchResult[] {
    interface SourceResult {
      result: SearchResult;
      scores: number[];
      bestRaw: number;
    }
    const seen = new Map<string, SourceResult>();
    const { storage } = this;

    for (const sc of scored) {
      let chunkScore = sc.score;
      const rawScore = sc.score;
      // Tree-aware scoring: boost doc chunks whose heading path matches query words.
      if (sc.type === "doc" && sc.headerPath) {
        const headerLower = goToLower(sc.headerPath);
        const queryWords = goFields(goToLower(query));
        let matchCount = 0;
        for (const w of queryWords) if (headerLower.includes(w)) matchCount++;
        if (matchCount > 0) {
          chunkScore = mulAdd(matchCount / queryWords.length, 0.15, chunkScore);
        }
      }

      let key: string;
      let result: SearchResult;
      switch (sc.type) {
        case "task": {
          key = `task:${sc.taskId ?? ""}`;
          if (opts.type && opts.type !== "all" && opts.type !== "task") continue;
          const task = opts.taskSnapshot?.get(sc.taskId ?? "");
          if (!task || !taskVisibleForSearch(task, opts) || !taskMatchesSearchFilters(task, opts)) {
            continue;
          }
          result = {
            type: "task",
            id: sc.taskId ?? "",
            title: task.title,
            score: chunkScore,
            status: task.status,
            priority: task.priority,
            matchedBy: [method],
          };
          applyTaskLifecycleToSearchResult(result, task);
          break;
        }
        case "doc": {
          const docPath = sc.docPath ?? "";
          key = `doc:${docPath}`;
          const doc = tryGet(() => storage.docs.get(docPath));
          if (opts.tag && (!doc || !containsStr(doc.tags, opts.tag))) continue;
          if (opts.type && opts.type !== "all" && opts.type !== "doc") continue;
          result = {
            type: "doc",
            id: docPath,
            title: doc ? doc.title : docPath,
            score: chunkScore,
            path: docPath,
            tags: doc ? doc.tags : undefined,
            snippet: sc.section,
            matchedBy: [method],
          };
          break;
        }
        case "memory": {
          key = `memory:${sc.memoryId ?? ""}:${sc.memoryStore ?? ""}`;
          if (opts.type && opts.type !== "all" && opts.type !== "memory") continue;
          let title = sc.memoryId ?? "";
          let memLayer = sc.memoryLayer ?? "";
          let memStore = sc.memoryStore ?? "";
          let memStatus = "";
          let category = "";
          let tags: string[] | undefined;
          const entry = this.memoryEntryForChunk(sc);
          if (entry) {
            if (!memoryVisibleForSearch(entry, opts)) continue;
            title = entry.title;
            memLayer = entry.layer;
            memStatus = entry.status ?? "";
            category = entry.category ?? "";
            tags = entry.tags;
          }
          if (memStore === "") memStore = memoryStoreForLayer(memLayer);
          result = {
            type: "memory",
            id: sc.memoryId ?? "",
            title,
            score: chunkScore,
            status: memStatus,
            memoryLayer: memLayer,
            category,
            memoryStore: memStore,
            tags,
            matchedBy: [method],
          };
          break;
        }
        case "decision": {
          const decisionId = sc.decisionId ?? "";
          key = `decision:${decisionId}`;
          if (opts.type && opts.type !== "all" && opts.type !== "decision") continue;
          let title = decisionId;
          let status = sc.status ?? "";
          let tags: string[] | undefined;
          const decision = tryGet(() => storage.decisions.get(decisionId));
          if (decision) {
            if (!decisionVisibleForSearch(decision, opts)) continue;
            title = decision.title;
            status = decision.status;
            tags = decision.tags;
          }
          result = {
            type: "decision",
            id: decisionId,
            title,
            score: chunkScore,
            status,
            tags,
            matchedBy: [method],
          };
          break;
        }
        default:
          continue;
      }

      const existing = seen.get(key);
      if (existing) {
        existing.scores.push(chunkScore);
        if (rawScore > existing.bestRaw) existing.bestRaw = rawScore;
        // Keep the result with the best snippet.
        if (chunkScore > existing.result.score) existing.result = result;
      } else {
        seen.set(key, { result, scores: [chunkScore], bestRaw: rawScore });
      }
    }

    const results: SearchResult[] = [];
    for (const sr of seen.values()) {
      sr.scores.sort((a, b) => b - a);
      let finalScore = sr.scores[0] as number;
      for (let i = 1; i < sr.scores.length && i < 3; i++) {
        finalScore = mulAdd(sr.scores[i] as number, 0.1, finalScore);
      }
      sr.result.score = finalScore;
      if (method === "semantic") sr.result.semanticScore = sr.bestRaw;
      results.push(sr.result);
    }
    return results;
  }

  private memoryEntryForChunk(sc: ScoredChunk): MemoryEntry | undefined {
    const { memory } = this.storage;
    const id = sc.memoryId ?? "";
    if (sc.memoryLayer) {
      const e = tryGet(() => memory.getInLayer(id, sc.memoryLayer as string));
      if (e) return e;
    }
    if (sc.memoryStore === MEMORY_STORE_GLOBAL)
      return tryGet(() => memory.getInLayer(id, "global"));
    return tryGet(() => memory.get(id));
  }

  /**
   * Hybrid rerank: add small bonuses for title/tag/content matches and recency to the fused rank,
   * cap them at 0.3, and renormalize so the best result scores 1.0.
   */
  private rerank(
    results: SearchResult[],
    query: string,
    limit: number,
    opts: SearchOptions,
  ): SearchResult[] {
    if (results.length === 0) return results;
    const queryLower = goToLower(query);
    const words = goFields(queryLower);
    const now = this.now();

    const items = results.map((r) => ({ result: { ...r }, rrfScore: r.score, bonus: 0 }));
    for (const item of items) {
      const r = item.result;
      let bonus = 0;
      if (r.type === "task") {
        const task = opts.taskSnapshot?.get(r.id);
        if (task) {
          const titleLower = goToLower(task.title);
          for (const w of words) bonus = mulAdd(wordBoundaryCount(task.title, w), 0.03, bonus);
          if (phraseMatch(task.title, query)) bonus += 0.15;
          else if (titleLower.includes(queryLower)) bonus += 0.05;
          for (const label of task.labels ?? []) {
            const labelLower = goToLower(label);
            for (const w of words) if (labelLower === w) bonus += 0.05;
          }
          const age = hoursSince(now, task.updatedAt) / 24;
          if (age < 7) bonus = mulAdd(0.05, 1 - age / 7, bonus);
        }
      } else if (r.type === "doc") {
        const doc = tryGet(() => this.storage.docs.get(r.id));
        if (doc) {
          const titleLower = goToLower(doc.title);
          for (const w of words) bonus = mulAdd(wordBoundaryCount(doc.title, w), 0.03, bonus);
          if (phraseMatch(doc.title, query)) bonus += 0.15;
          else if (titleLower.includes(queryLower)) bonus += 0.05;
          for (const tag of doc.tags ?? []) {
            const tagLower = goToLower(tag);
            for (const w of words) if (tagLower === w) bonus += 0.08;
          }
          for (const w of words) {
            let count = wordBoundaryCount(doc.content ?? "", w);
            if (count > 10) count = 10;
            bonus = mulAdd(count, 0.005, bonus);
          }
          const age = hoursSince(now, doc.updatedAt) / 24;
          if (age < 7) bonus = mulAdd(0.05, 1 - age / 7, bonus);
        }
      }
      item.bonus = bonus;
    }

    for (const item of items) {
      const b = Math.min(item.bonus, 0.3);
      item.result.score = item.rrfScore + b;
    }
    let maxScore = 0;
    for (const item of items) if (item.result.score > maxScore) maxScore = item.result.score;

    let out = items.map((item) => {
      if (maxScore > 0) item.result.score = item.result.score / maxScore;
      return item.result;
    });
    stableSort(out, (a, b) => a.score > b.score);
    if (limit > 0 && out.length > limit) out = out.slice(0, limit);
    return out;
  }

  // --- result canonicalization --------------------------------------------------------------------

  private canonicalizeTaskResults(results: SearchResult[], opts: SearchOptions): SearchResult[] {
    const out: SearchResult[] = [];
    for (const result of results) {
      if (result.type !== "task") {
        out.push(result);
        continue;
      }
      const task = opts.taskSnapshot?.get(result.id);
      if (!task || !taskVisibleForSearch(task, opts) || !taskMatchesSearchFilters(task, opts)) {
        continue;
      }
      const copy = { ...result };
      applyTaskLifecycleToSearchResult(copy, task);
      out.push(copy);
    }
    return out;
  }

  private canonicalizeRetrievalCandidates(
    candidates: RetrievalCandidate[],
    opts: SearchOptions,
  ): RetrievalCandidate[] {
    const out: RetrievalCandidate[] = [];
    for (const candidate of candidates) {
      if (candidate.type !== "task") {
        out.push(candidate);
        continue;
      }
      const task = opts.taskSnapshot?.get(candidate.id);
      if (!task || !taskVisibleForSearch(task, opts) || !taskMatchesSearchFilters(task, opts)) {
        continue;
      }
      const copy: RetrievalCandidate = { ...candidate, metadata: { ...candidate.metadata } };
      applyTaskLifecycleToCandidate(copy, task);
      out.push(copy);
    }
    sortRetrievalCandidates(out, opts.includeHistorical ?? false);
    return out;
  }

  // --- retrieval ----------------------------------------------------------------------------------

  /** buildCandidates: search results to source-level candidates, sorted by source preference. */
  buildCandidates(results: SearchResult[], opts: SearchOptions): RetrievalCandidate[] {
    const candidates = results.map((result): RetrievalCandidate => {
      const metadata = this.sourceRecord(result, opts);
      return {
        type: result.type,
        id: result.id,
        title: result.title,
        path: result.path,
        score: result.score,
        matchedBy: result.matchedBy,
        snippet: result.snippet,
        citation: citationFromResult(result),
        directMatch: true,
        status: result.status,
        priority: result.priority,
        lifecycleState: result.lifecycleState,
        completedAt: cloneTime(result.completedAt),
        archivedAt: cloneTime(result.archivedAt),
        tags: result.tags,
        memoryLayer: result.memoryLayer,
        category: result.category,
        memoryStore: result.memoryStore,
        sourcePreference: sourcePreference(result.type),
        updatedAt: metadata.updatedAt,
        metadata,
      };
    });
    sortRetrievalCandidates(candidates, opts.includeHistorical ?? false);
    return candidates;
  }

  /** The context pack: current canonical content for each visible candidate. */
  buildContextPack(candidates: RetrievalCandidate[], opts: SearchOptions): ContextItem[] {
    const ordered = this.canonicalizeRetrievalCandidates([...candidates], opts);
    sortRetrievalCandidates(ordered, opts.includeHistorical ?? false);
    const items: ContextItem[] = [];
    for (const candidate of ordered) {
      const content = this.contextContent(candidate, opts);
      if (content === undefined) continue;
      items.push({
        type: candidate.type,
        id: candidate.id,
        title: candidate.title,
        content,
        snippet: candidate.snippet,
        directMatch: candidate.directMatch,
        expandedFrom: candidate.expandedFrom,
        citation: candidate.citation,
        lifecycleState: candidate.lifecycleState,
        completedAt: cloneTime(candidate.completedAt),
        archivedAt: cloneTime(candidate.archivedAt),
        metadata: candidate.metadata,
      });
    }
    return items;
  }

  /** The text of a candidate, or undefined when it must not appear in the pack. */
  private contextContent(candidate: RetrievalCandidate, opts: SearchOptions): string | undefined {
    const snippet = candidate.snippet ?? "";
    switch (candidate.type) {
      case "doc": {
        const doc = tryGet(() => this.storage.docs.get(candidate.id));
        if (!doc) return snippet;
        return goTrimSpace([doc.title, doc.description ?? "", doc.content ?? ""].join("\n\n"));
      }
      case "task": {
        const task = opts.taskSnapshot?.get(candidate.id);
        if (!task || !taskVisibleForSearch(task, opts) || !taskMatchesSearchFilters(task, opts)) {
          return undefined;
        }
        const parts = [task.title, task.description ?? ""];
        if (task.implementationPlan) parts.push(task.implementationPlan);
        if (task.implementationNotes) parts.push(task.implementationNotes);
        return goTrimSpace(parts.join("\n\n"));
      }
      case "memory": {
        const entry = tryGet(() => this.storage.memory.get(candidate.id));
        if (!entry) return snippet;
        let parts = [entry.title, entry.content ?? ""];
        if (entry.category) parts = [`${entry.title} [${entry.category}]`, entry.content ?? ""];
        return goTrimSpace(parts.join("\n\n"));
      }
      case "decision": {
        const decision = tryGet(() => this.storage.decisions.get(candidate.id));
        if (!decision) return snippet;
        return decisionText(decision);
      }
      default:
        return snippet;
    }
  }

  private sourceRecord(result: SearchResult, opts: SearchOptions): SourceRecord {
    const record: SourceRecord = {
      type: result.type,
      id: result.id,
      path: result.path,
      tags: result.tags,
      status: result.status,
      priority: result.priority,
      lifecycleState: result.lifecycleState,
      completedAt: cloneTime(result.completedAt),
      archivedAt: cloneTime(result.archivedAt),
      memoryLayer: result.memoryLayer,
      category: result.category,
      memoryStore: result.memoryStore,
    };
    switch (result.type) {
      case "doc": {
        const doc = tryGet(() => this.storage.docs.get(result.id));
        if (doc) {
          record.path = doc.path;
          record.imported = doc.isImported;
          record.source = doc.importSource;
          record.updatedAt = timePtr(doc.updatedAt);
        }
        break;
      }
      case "task": {
        const task = opts.taskSnapshot?.get(result.id);
        if (task) {
          record.status = task.status;
          record.priority = task.priority;
          record.lifecycleState = taskLifecycleState(task);
          record.completedAt = cloneTime(task.completedAt);
          record.archivedAt = cloneTime(task.archivedAt);
          record.updatedAt = timePtr(task.updatedAt);
        }
        break;
      }
      case "memory": {
        const entry = tryGet(() => this.storage.memory.get(result.id));
        if (entry) record.updatedAt = timePtr(entry.updatedAt);
        break;
      }
      case "decision": {
        const decision = tryGet(() => this.storage.decisions.get(result.id));
        if (decision) {
          record.status = decision.status;
          record.tags = decision.tags;
          record.updatedAt = timePtr(decision.updatedAt);
        }
        break;
      }
    }
    return record;
  }

  expandCandidateReferences(
    candidates: RetrievalCandidate[],
    opts: RetrievalOptions,
    taskOpts: SearchOptions,
  ): RetrievalCandidate[] {
    const extractor = this.deps.references;
    if (!extractor) {
      throw new Error("reference expansion needs a reference extractor (internal/references)");
    }
    const allowed = allowedSourceSet(opts.sourceTypes);
    const expanded: RetrievalCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const content = this.referenceContent(candidate, taskOpts);
      for (const ec of this.extractReferenceCandidates(
        content,
        candidate,
        allowed,
        opts,
        taskOpts,
        extractor,
      )) {
        const key = `${ec.type}:${ec.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        expanded.push(ec);
      }
    }
    return expanded;
  }

  private referenceContent(candidate: RetrievalCandidate, taskOpts: SearchOptions): string {
    switch (candidate.type) {
      case "doc":
        return tryGet(() => this.storage.docs.get(candidate.id))?.content ?? "";
      case "task": {
        const task = taskOpts.taskSnapshot?.get(candidate.id);
        if (!task) return "";
        return [
          task.description ?? "",
          task.implementationPlan ?? "",
          task.implementationNotes ?? "",
        ].join("\n");
      }
      case "memory":
        return tryGet(() => this.storage.memory.get(candidate.id))?.content ?? "";
      case "decision": {
        const decision = tryGet(() => this.storage.decisions.get(candidate.id));
        return decision ? decisionText(decision) : "";
      }
      default:
        return "";
    }
  }

  private extractReferenceCandidates(
    content: string,
    source: RetrievalCandidate,
    allowed: Set<string>,
    opts: RetrievalOptions,
    taskOpts: SearchOptions,
    extractor: ReferenceExtractor,
  ): RetrievalCandidate[] {
    const out: RetrievalCandidate[] = [];
    const from = [`${source.type}:${source.id}`];
    const half = source.score * 0.5;
    for (const ref of extractor.extract(content)) {
      if (!ref.validRelation || !allowed.has(ref.type)) continue;
      switch (ref.type) {
        case "task": {
          const task = taskOpts.taskSnapshot?.get(ref.target);
          if (!task) break;
          if (!taskVisibleForSearch(task, taskOpts) || !taskMatchesSearchFilters(task, taskOpts)) {
            break;
          }
          const state = taskLifecycleState(task);
          out.push({
            type: "task",
            id: task.id,
            title: task.title,
            score: half,
            snippet: truncateStr(task.description ?? "", 150),
            citation: { type: "task", id: task.id },
            directMatch: false,
            expandedFrom: from,
            status: task.status,
            priority: task.priority,
            lifecycleState: state,
            completedAt: cloneTime(task.completedAt),
            archivedAt: cloneTime(task.archivedAt),
            sourcePreference: sourcePreference("task"),
            metadata: {
              type: "task",
              id: task.id,
              status: task.status,
              priority: task.priority,
              lifecycleState: state,
              completedAt: cloneTime(task.completedAt),
              archivedAt: cloneTime(task.archivedAt),
              updatedAt: timePtr(task.updatedAt),
            },
          });
          break;
        }
        case "doc": {
          const doc = tryGet(() => this.storage.docs.get(ref.target));
          if (!doc) break;
          out.push({
            type: "doc",
            id: doc.path,
            title: doc.title,
            path: doc.path,
            score: half,
            snippet: truncateStr(doc.description ?? "", 150),
            citation: { type: "doc", id: doc.path, path: doc.path },
            directMatch: false,
            expandedFrom: from,
            tags: doc.tags,
            sourcePreference: sourcePreference("doc"),
            metadata: {
              type: "doc",
              id: doc.path,
              path: doc.path,
              tags: doc.tags,
              updatedAt: timePtr(doc.updatedAt),
              imported: doc.isImported,
              source: doc.importSource,
            },
          });
          break;
        }
        case "memory": {
          const entry = tryGet(() => this.storage.memory.resolveReferenceTarget(ref.target));
          if (!entry) break;
          if (
            !memoryVisibleForSearch(entry, {
              status: opts.status,
              includeHistorical: opts.includeHistorical,
            })
          ) {
            break;
          }
          out.push({
            type: "memory",
            id: entry.id,
            title: entry.title,
            score: half,
            snippet: truncateStr(entry.content ?? "", 150),
            citation: { type: "memory", id: entry.id },
            directMatch: false,
            expandedFrom: from,
            status: entry.status,
            tags: entry.tags,
            memoryLayer: entry.layer,
            category: entry.category,
            sourcePreference: sourcePreference("memory"),
            metadata: {
              type: "memory",
              id: entry.id,
              status: entry.status,
              tags: entry.tags,
              memoryLayer: entry.layer,
              category: entry.category,
              updatedAt: timePtr(entry.updatedAt),
            },
          });
          break;
        }
        case "decision": {
          const decision = tryGet(() => this.storage.decisions.get(ref.target));
          if (!decision) break;
          if (
            !decisionVisibleForSearch(decision, {
              status: opts.status,
              includeHistorical: opts.includeHistorical,
            })
          ) {
            break;
          }
          out.push({
            type: "decision",
            id: decision.id,
            title: decision.title,
            score: half,
            snippet: truncateStr(decisionText(decision), 150),
            citation: { type: "decision", id: decision.id },
            directMatch: false,
            expandedFrom: from,
            status: decision.status,
            tags: decision.tags,
            sourcePreference: sourcePreference("decision"),
            metadata: {
              type: "decision",
              id: decision.id,
              status: decision.status,
              tags: decision.tags,
              updatedAt: timePtr(decision.updatedAt),
            },
          });
          break;
        }
      }
    }
    return out;
  }
}

// --- free helpers ----------------------------------------------------------------------------------

function tryGet<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

async function closeAll(stores: MemorySemanticStore[]): Promise<void> {
  for (const s of stores) {
    try {
      await s.close();
    } catch {
      // closing is best effort
    }
  }
}

function hoursSince(nowMs: number, stored: string): number {
  // time.Duration.Hours(): whole hours plus the remaining nanoseconds as a fraction.
  const ms = nowMs - timeMillis(stored);
  const hour = Math.trunc(ms / 3_600_000);
  const nsec = (ms - hour * 3_600_000) * 1_000_000;
  return hour + nsec / 3_600_000_000_000;
}

export function effectiveMode(mode: string, semanticAvailable: boolean): string {
  if (mode === "") return semanticAvailable ? "hybrid" : "keyword";
  if (mode !== "keyword" && !semanticAvailable) return "keyword";
  return mode;
}

function filterSearchResultsByType(
  results: SearchResult[],
  searchType: string | undefined,
): SearchResult[] {
  if (!searchType || searchType === "all") return results;
  return results.filter((r) => r.type === searchType);
}

export function typeFilterFromSources(sourceTypes: string[] | undefined): string {
  if (sourceTypes?.length === 1) {
    const t = sourceTypes[0] as string;
    if (t === "task" || t === "doc" || t === "memory" || t === "decision") return t;
  }
  return "all";
}

export function allowedSourceSet(sourceTypes: string[] | undefined): Set<string> {
  if (!sourceTypes || sourceTypes.length === 0) {
    return new Set(["doc", "task", "memory", "decision"]);
  }
  return new Set(sourceTypes);
}

export function filterBySourceTypes(
  results: SearchResult[],
  sourceTypes: string[] | undefined,
): SearchResult[] {
  const allowed = allowedSourceSet(sourceTypes);
  return results.filter((r) => allowed.has(r.type));
}

function applyTaskLifecycleToSearchResult(result: SearchResult, task: Task): void {
  result.title = task.title;
  result.status = task.status;
  result.priority = task.priority;
  result.lifecycleState = taskLifecycleState(task);
  result.completedAt = cloneTime(task.completedAt);
  result.archivedAt = cloneTime(task.archivedAt);
}

function applyTaskLifecycleToCandidate(candidate: RetrievalCandidate, task: Task): void {
  const state = taskLifecycleState(task);
  candidate.title = task.title;
  candidate.status = task.status;
  candidate.priority = task.priority;
  candidate.lifecycleState = state;
  candidate.completedAt = cloneTime(task.completedAt);
  candidate.archivedAt = cloneTime(task.archivedAt);
  const m = candidate.metadata;
  m.status = task.status;
  m.priority = task.priority;
  m.lifecycleState = state;
  m.completedAt = cloneTime(task.completedAt);
  m.archivedAt = cloneTime(task.archivedAt);
  m.updatedAt = timePtr(task.updatedAt);
  candidate.updatedAt = timePtr(task.updatedAt);
}

function groupHistoricalTaskResults(results: SearchResult[]): void {
  const tasks = results.filter((r) => r.type === "task");
  stableSort(tasks, (a, b) => {
    const ia = taskLifecycleRank(a.lifecycleState);
    const ib = taskLifecycleRank(b.lifecycleState);
    if (ia !== ib) return ia < ib;
    if (a.score !== b.score) return a.score > b.score;
    return compareStrings(a.title, b.title) < 0;
  });
  let next = 0;
  for (let i = 0; i < results.length; i++) {
    if ((results[i] as SearchResult).type !== "task") continue;
    results[i] = tasks[next++] as SearchResult;
  }
}

function sortRetrievalCandidates(
  candidates: RetrievalCandidate[],
  includeHistorical: boolean,
): void {
  stableSort(candidates, (a, b) => {
    if (a.sourcePreference !== b.sourcePreference) return a.sourcePreference < b.sourcePreference;
    if (includeHistorical && a.type === "task" && b.type === "task") {
      const ia = taskLifecycleRank(a.lifecycleState);
      const ib = taskLifecycleRank(b.lifecycleState);
      if (ia !== ib) return ia < ib;
    }
    if (a.score !== b.score) return a.score > b.score;
    return compareStrings(a.title, b.title) < 0;
  });
}

function mergeCandidates(
  primary: RetrievalCandidate[],
  expanded: RetrievalCandidate[],
  includeHistorical: boolean,
): RetrievalCandidate[] {
  const merged = primary.map((c) => ({ ...c }));
  const byKey = new Map<string, number>();
  for (const [i, c] of primary.entries()) byKey.set(`${c.type}:${c.id}`, i);
  for (const candidate of expanded) {
    const key = `${candidate.type}:${candidate.id}`;
    const idx = byKey.get(key);
    if (idx !== undefined) {
      const target = merged[idx] as RetrievalCandidate;
      target.expandedFrom = appendUnique(target.expandedFrom ?? [], candidate.expandedFrom ?? []);
      target.directMatch = target.directMatch || candidate.directMatch;
      continue;
    }
    merged.push(candidate);
    byKey.set(key, merged.length - 1);
  }
  sortRetrievalCandidates(merged, includeHistorical);
  return merged;
}

function appendUnique(existing: string[], values: string[]): string[] {
  const out = [...existing];
  const seen = new Set(existing);
  for (const v of values) {
    if (v === "" || seen.has(v)) continue;
    out.push(v);
    seen.add(v);
  }
  return out;
}

function citationFromResult(result: SearchResult): Citation {
  const citation: Citation = { type: result.type, id: result.id };
  if (result.type === "doc") {
    citation.path = result.path;
    citation.section = result.snippet;
  }
  return citation;
}

function chunkTypeForSearchType(searchType: string | undefined): ChunkType | "" {
  switch (searchType) {
    case "memory":
    case "task":
    case "doc":
    case "decision":
      return searchType;
    default:
      return "";
  }
}

function resultMergeKey(r: SearchResult): string {
  if (r.type === "memory" && r.memoryStore) return `${r.type}:${r.id}:${r.memoryStore}`;
  return `${r.type}:${r.id}`;
}

/** mergeStoreMemoryResults: best result per memory per store, ranked by score then title. */
function mergeStoreMemoryResults(results: SearchResult[], limit: number): SearchResult[] {
  if (results.length === 0) return [];
  const byKey = new Map<string, SearchResult>();
  for (const r of results) {
    const key = `${r.type}:${r.id}:${r.memoryStore ?? ""}`;
    const existing = byKey.get(key);
    if (existing && existing.score >= r.score) continue;
    byKey.set(key, r);
  }
  let merged = [...byKey.values()];
  stableSort(merged, (a, b) => {
    if (a.score !== b.score) return a.score > b.score;
    return compareStrings(a.title, b.title) < 0;
  });
  if (limit > 0 && merged.length > limit) merged = merged.slice(0, limit);
  return merged;
}

/** Reciprocal Rank Fusion (k = 60) of the keyword and semantic legs, normalized to 0-1. */
export function mergeResults(
  kwResults: SearchResult[],
  semResults: SearchResult[],
  limit: number,
): SearchResult[] {
  const K = 60.0;
  stableSort(kwResults, (a, b) => a.score > b.score);
  stableSort(semResults, (a, b) => a.score > b.score);

  interface Item {
    result: SearchResult;
    rrfScore: number;
    matchedBy: string[];
  }
  const merged = new Map<string, Item>();
  kwResults.forEach((r, rank) => {
    merged.set(resultMergeKey(r), {
      result: { ...r },
      rrfScore: 1.0 / (K + (rank + 1)),
      matchedBy: ["keyword"],
    });
  });
  semResults.forEach((r, rank) => {
    const key = resultMergeKey(r);
    const rrfScore = 1.0 / (K + (rank + 1));
    const item = merged.get(key);
    if (item) {
      item.rrfScore += rrfScore;
      item.matchedBy = ["semantic", "keyword"];
      // The keyword record is the one kept and it never had a cosine.
      if ((r.semanticScore ?? 0) > (item.result.semanticScore ?? 0)) {
        item.result.semanticScore = r.semanticScore;
      }
    } else {
      merged.set(key, { result: { ...r }, rrfScore, matchedBy: ["semantic"] });
    }
  });

  let maxRRF = 0;
  for (const item of merged.values()) if (item.rrfScore > maxRRF) maxRRF = item.rrfScore;
  let results: SearchResult[] = [];
  for (const item of merged.values()) {
    if (maxRRF > 0) item.result.score = item.rrfScore / maxRRF;
    item.result.matchedBy = item.matchedBy;
    results.push(item.result);
  }
  stableSort(results, (a, b) => a.score > b.score);
  if (limit > 0 && results.length > limit) results = results.slice(0, limit);
  return results;
}
