// Port of internal/search/lexical_backend.go: the BM25 backend behind keyword search. Field
// weights, boosts and the evaluation order of every sum match Go so scores are bit-identical.
import type { DecisionEntry } from "../models/decision.ts";
import type { Doc } from "../models/doc.ts";
import type { MemoryEntry } from "../models/memory.ts";
import type { SearchResult } from "../models/search.ts";
import { type Task, type TaskLifecycleState, taskLifecycleState } from "../models/task.ts";
import { decisionText } from "./chunker.ts";
import { mulAdd } from "./fma.ts";
import { goLog } from "./golog.ts";
import {
  compareStrings,
  containsStr,
  firstNonEmpty,
  goToLower,
  goTrimSpace,
  stableSort,
  truncateStr,
} from "./text.ts";
import { cloneTime } from "./time.ts";
import type { SearchOptions } from "./types.ts";
import {
  decisionVisibleForSearch,
  memoryVisibleForSearch,
  taskMatchesSearchFilters,
  taskVisibleForSearch,
} from "./visibility.ts";

const BM25_K1 = 1.2;
const BM25_B = 0.75;
// Go folds bm25K1 + 1 as an exact constant before rounding; 1.2 + 1 in doubles can land elsewhere.
const BM25_K1_PLUS_1 = 2.2;
const MEMORY_STORE_PROJECT = "project-store";
const MEMORY_STORE_GLOBAL = "global-store";

/** The storage reads the lexical backend needs; the engine supplies them over the wired storage. */
export interface LexicalSource {
  tasks(opts: SearchOptions): Task[];
  docs(): Doc[];
  memories(): MemoryEntry[];
  decisions(): DecisionEntry[];
}

interface LexicalField {
  name: string;
  text: string;
  weight: number;
  tokens: string[];
}

interface LexicalDoc {
  type: string;
  id: string;
  title: string;
  path: string;
  snippet: string;
  status: string;
  priority: string;
  lifecycleState?: TaskLifecycleState;
  completedAt?: string;
  archivedAt?: string;
  tags: string[];
  memoryLayer: string;
  category: string;
  memoryStore: string;
  fields: LexicalField[];
}

/** BM25Tokenize: lowercase, then maximal ASCII alphanumeric runs. */
export function bm25Tokenize(text: string): string[] {
  return goToLower(text).match(/[a-z0-9]+/g) ?? [];
}

export function sourcePreference(sourceType: string): number {
  switch (sourceType) {
    case "doc":
      return 0;
    case "decision":
      return 1;
    case "task":
      return 2;
    case "memory":
      return 3;
    default:
      return 4;
  }
}

export function memoryStoreForLayer(layer: string): string {
  return layer === "global" ? MEMORY_STORE_GLOBAL : MEMORY_STORE_PROJECT;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const wordRegexCache = new Map<string, RegExp>();

/** The whole-word, case-insensitive matcher for `word` (compiled once; RE2's \b is ASCII-only). */
function wordRegex(word: string): RegExp {
  let re = wordRegexCache.get(word);
  if (!re) {
    re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi");
    if (wordRegexCache.size > 4096) wordRegexCache.clear();
    wordRegexCache.set(word, re);
  }
  return re;
}

/** wordBoundaryCount: whole-word, case-insensitive matches. */
export function wordBoundaryCount(text: string, word: string): number {
  // String.match with a global regex restarts from index 0, so the shared instance is safe.
  return text.match(wordRegex(word))?.length ?? 0;
}

/** phraseMatch: the phrase as a whole-word, case-insensitive match. */
export function phraseMatch(text: string, phrase: string): boolean {
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i").test(text);
}

function uniqueTokens(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function newField(name: string, text: string, weight: number): LexicalField {
  return { name, text, weight, tokens: bm25Tokenize(text) };
}

function snippetForDoc(fields: LexicalField[], fallback: string): string {
  for (const f of fields) {
    if (f.name === "title" || f.name === "path" || f.name === "tags" || f.name === "category") {
      continue;
    }
    if (goTrimSpace(f.text) !== "") return f.text;
  }
  return fallback;
}

function fromTask(task: Task): LexicalDoc {
  const fields = [
    newField("title", task.title, 4.0),
    newField("id", task.id, 5.0),
    newField("labels", (task.labels ?? []).join(" "), 2.2),
    newField("description", task.description ?? "", 1.5),
    newField("plan", task.implementationPlan ?? "", 1.0),
    newField("notes", task.implementationNotes ?? "", 0.8),
    newField("acceptance", (task.acceptanceCriteria ?? []).map((a) => a.text).join(" "), 0.8),
    newField("status_priority", `${task.status} ${task.priority}`, 0.4),
  ];
  const fallback = firstNonEmpty(
    task.description ?? "",
    task.implementationPlan ?? "",
    task.implementationNotes ?? "",
  );
  return {
    type: "task",
    id: task.id,
    title: task.title,
    path: "",
    snippet: snippetForDoc(fields, fallback),
    status: task.status,
    priority: task.priority,
    lifecycleState: taskLifecycleState(task),
    completedAt: cloneTime(task.completedAt),
    archivedAt: cloneTime(task.archivedAt),
    tags: [...(task.labels ?? [])],
    memoryLayer: "",
    category: "",
    memoryStore: "",
    fields,
  };
}

function fromDoc(doc: Doc): LexicalDoc {
  const tags = doc.tags ?? [];
  const fields = [
    newField("title", doc.title, 4.0),
    newField("path", doc.path, 3.2),
    newField("tags", tags.join(" "), 2.2),
    newField("description", doc.description ?? "", 1.6),
    newField("content", doc.content ?? "", 1.0),
  ];
  return {
    type: "doc",
    id: doc.path,
    title: doc.title,
    path: doc.path,
    snippet: snippetForDoc(fields, firstNonEmpty(doc.description ?? "", doc.content ?? "")),
    status: "",
    priority: "",
    tags: [...tags],
    memoryLayer: "",
    category: "",
    memoryStore: "",
    fields,
  };
}

function fromMemory(entry: MemoryEntry): LexicalDoc {
  const tags = entry.tags ?? [];
  const fields = [
    newField("title", entry.title, 4.0),
    newField("category", entry.category ?? "", 2.8),
    newField("tags", tags.join(" "), 2.2),
    newField("content", entry.content ?? "", 1.2),
    newField("layer", entry.layer, 0.4),
  ];
  return {
    type: "memory",
    id: entry.id,
    title: entry.title,
    path: "",
    snippet: snippetForDoc(fields, firstNonEmpty(entry.content ?? "", entry.category ?? "")),
    status: entry.status ?? "",
    priority: "",
    tags: [...tags],
    memoryLayer: entry.layer,
    category: entry.category ?? "",
    memoryStore: memoryStoreForLayer(entry.layer),
    fields,
  };
}

function fromDecision(entry: DecisionEntry): LexicalDoc {
  const text = decisionText(entry);
  const tags = entry.tags ?? [];
  const fields = [
    newField("title", entry.title, 4.0),
    newField("id", entry.id, 3.2),
    newField("status", entry.status, 0.6),
    newField("tags", tags.join(" "), 2.2),
    newField("sources", (entry.sources ?? []).join(" "), 1.0),
    newField("related_docs", (entry.relatedDocs ?? []).join(" "), 1.0),
    newField("related_tasks", (entry.relatedTasks ?? []).join(" "), 1.0),
    newField("content", text, 1.2),
  ];
  const fallback = firstNonEmpty(
    entry.decision ?? "",
    entry.context ?? "",
    entry.content ?? "",
    text,
  );
  return {
    type: "decision",
    id: entry.id,
    title: entry.title,
    path: "",
    snippet: snippetForDoc(fields, fallback),
    status: entry.status,
    priority: "",
    tags: [...tags],
    memoryLayer: "",
    category: "",
    memoryStore: "",
    fields,
  };
}

function toSearchResult(d: LexicalDoc, score: number): SearchResult {
  const r: SearchResult = {
    type: d.type,
    id: d.id,
    title: d.title,
    score,
    snippet: truncateStr(d.snippet, 150),
    matchedBy: ["keyword"],
    status: d.status,
    priority: d.priority,
    path: d.path,
    tags: d.tags,
    memoryLayer: d.memoryLayer,
    category: d.category,
    memoryStore: d.memoryStore,
  };
  if (d.lifecycleState) r.lifecycleState = d.lifecycleState;
  if (d.completedAt !== undefined) r.completedAt = d.completedAt;
  if (d.archivedAt !== undefined) r.archivedAt = d.archivedAt;
  return r;
}

interface CorpusStats {
  docCount: number;
  documentFreqs: Map<string, number>;
  fieldLengths: Map<string, number>;
  fieldDocCounts: Map<string, number>;
}

function newStats(corpus: LexicalDoc[]): CorpusStats {
  const stats: CorpusStats = {
    docCount: corpus.length,
    documentFreqs: new Map(),
    fieldLengths: new Map(),
    fieldDocCounts: new Map(),
  };
  for (const doc of corpus) {
    const docTerms = new Set<string>();
    for (const f of doc.fields) {
      stats.fieldLengths.set(f.name, (stats.fieldLengths.get(f.name) ?? 0) + f.tokens.length);
      stats.fieldDocCounts.set(f.name, (stats.fieldDocCounts.get(f.name) ?? 0) + 1);
      for (const t of uniqueTokens(f.tokens)) docTerms.add(t);
    }
    for (const t of docTerms) stats.documentFreqs.set(t, (stats.documentFreqs.get(t) ?? 0) + 1);
  }
  return stats;
}

function idf(stats: CorpusStats, term: string): number {
  const df = stats.documentFreqs.get(term) ?? 0;
  if (stats.docCount === 0 || df === 0) return 0;
  return goLog(1 + (stats.docCount - df + 0.5) / (df + 0.5));
}

function avgFieldLength(stats: CorpusStats, field: string): number {
  const count = stats.fieldDocCounts.get(field) ?? 0;
  if (count === 0) return 1;
  const avg = (stats.fieldLengths.get(field) ?? 0) / count;
  return avg <= 0 ? 1 : avg;
}

function termFrequency(tokens: readonly string[], term: string): number {
  let n = 0;
  for (const t of tokens) if (t === term) n++;
  return n;
}

function rerankBoost(doc: LexicalDoc, query: string, queryTokens: string[]): number {
  const queryLower = goToLower(goTrimSpace(query));
  if (queryLower === "") return 0;
  let boost = 0;
  const titleLower = goToLower(doc.title);
  const pathLower = goToLower(doc.path);
  const categoryLower = goToLower(doc.category);

  if (titleLower === queryLower) boost += 8.0;
  else if (phraseMatch(doc.title, queryLower)) boost += 4.0;
  if (doc.path !== "") {
    if (pathLower === queryLower) boost += 7.0;
    else if (pathLower.includes(queryLower)) boost += 3.0;
  }
  if (categoryLower === queryLower) boost += 4.0;
  else if (categoryLower !== "" && categoryLower.includes(queryLower)) boost += 2.0;
  for (const tag of doc.tags) {
    if (goToLower(tag) === queryLower) {
      boost += 3.0;
      break;
    }
  }
  const unique = uniqueTokens(queryTokens);
  let matchedTitleTerms = 0;
  for (const token of unique) if (wordBoundaryCount(doc.title, token) > 0) matchedTitleTerms++;
  if (matchedTitleTerms > 0 && queryTokens.length > 1) {
    boost = mulAdd(matchedTitleTerms / unique.length, 6.0, boost);
  }
  return boost;
}

function scoreDocument(
  doc: LexicalDoc,
  query: string,
  queryTokens: string[],
  stats: CorpusStats,
): number {
  let bm25 = 0;
  for (const term of uniqueTokens(queryTokens)) {
    const termIdf = idf(stats, term);
    for (const field of doc.fields) {
      const tf = termFrequency(field.tokens, term);
      if (tf === 0) continue;
      const fieldLen = field.tokens.length;
      const norm = mulAdd(BM25_B, fieldLen / avgFieldLength(stats, field.name), 1 - BM25_B);
      const denom = mulAdd(BM25_K1, norm, tf);
      bm25 = mulAdd(field.weight * termIdf, (tf * BM25_K1_PLUS_1) / denom, bm25);
    }
  }
  let boost = rerankBoost(doc, query, queryTokens);
  // The source-type boost only applies to a real BM25 match; otherwise every document would
  // score above zero for any query.
  if (bm25 > 0) {
    switch (doc.type) {
      case "doc":
        boost += 0.2;
        break;
      case "task":
        boost += 0.3;
        break;
      case "memory":
        boost += 0.05;
        break;
      case "decision":
        boost += 0.18;
        break;
    }
  }
  return bm25 + boost;
}

function buildCorpus(src: LexicalSource, opts: SearchOptions): LexicalDoc[] {
  const type = opts.type ?? "all";
  const corpus: LexicalDoc[] = [];
  const all = type === "" || type === "all";
  if (all || type === "task") {
    for (const task of src.tasks(opts)) {
      if (!taskVisibleForSearch(task, opts) || !taskMatchesSearchFilters(task, opts)) continue;
      corpus.push(fromTask(task));
    }
  }
  if (all || type === "doc") {
    for (const doc of src.docs()) {
      if (opts.tag && !containsStr(doc.tags, opts.tag)) continue;
      corpus.push(fromDoc(doc));
    }
  }
  if (all || type === "memory") {
    for (const entry of src.memories()) {
      if (!memoryVisibleForSearch(entry, opts)) continue;
      if (opts.tag && !containsStr(entry.tags, opts.tag)) continue;
      corpus.push(fromMemory(entry));
    }
  }
  if (all || type === "decision") {
    for (const decision of src.decisions()) {
      if (!decisionVisibleForSearch(decision, opts)) continue;
      if (opts.tag && !containsStr(decision.tags, opts.tag)) continue;
      corpus.push(fromDecision(decision));
    }
  }
  return corpus;
}

/** bm25LexicalBackend.Search. */
export function bm25Search(src: LexicalSource, query: string, opts: SearchOptions): SearchResult[] {
  const queryTokens = bm25Tokenize(query);
  if (queryTokens.length === 0) return [];
  const corpus = buildCorpus(src, opts);
  if (corpus.length === 0) return [];
  const stats = newStats(corpus);
  const results: SearchResult[] = [];
  for (const doc of corpus) {
    const score = scoreDocument(doc, query, queryTokens, stats);
    if (score <= 0) continue;
    results.push(toSearchResult(doc, score));
  }
  return stableSort(results, (a, b) => {
    if (a.score !== b.score) return a.score > b.score;
    if (a.type !== b.type) return sourcePreference(a.type) < sourcePreference(b.type);
    return compareStrings(a.title, b.title) < 0;
  });
}
