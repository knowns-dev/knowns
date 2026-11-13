/**
 * Runtime memory packs (internal/runtimememory/runtimememory.go): what the adapter hooks inject
 * into an agent's context on session start and prompt submit, and the capture step that runs
 * after it. Byte lengths are UTF-8 bytes, as Go's len() counts them.
 */

import type { RuntimeMemorySettings } from "../../models/config.ts";
import {
  ALLOWED_MEMORY_CATEGORIES,
  foldToAscii,
  MEMORY_LAYER_GLOBAL,
  MEMORY_LAYER_PROJECT,
  MEMORY_PROPOSAL_TTL_DAYS,
  type MemoryEntry,
  memoryClaim,
  memoryCurrentForDefaultRetrieval,
  proposalIsExpired,
  stripMemoryDetailMarker,
} from "../../models/memory.ts";
import type { SearchResult } from "../../models/search.ts";
import type { Storage } from "../../storage/adapters.ts";
import { formatFloat } from "../codegen/gofmt.ts";

export const MODE_OFF = "off";
export const MODE_AUTO = "auto";
export const MODE_MANUAL = "manual";
export const MODE_DEBUG = "debug";

export const CAPTURE_DISABLED = "disabled";
export const CAPTURE_PROPOSE = "propose";
export const CAPTURE_HIGH_CONFIDENCE = "high-confidence";

const STATUS_NONE = "none";
const STATUS_CANDIDATE = "candidate";

const SKIP_MODE_OFF = "mode_off";
const SKIP_DEBUG_MODE = "debug_mode";
const SKIP_LOW_SIGNAL_PROMPT = "low_signal_prompt";
const SKIP_NO_CANDIDATES = "no_candidates";
const SKIP_BELOW_THRESHOLD = "below_threshold";
const SKIP_MISSING_STORE = "missing_store";
const SKIP_NO_CAPTURE_CANDIDATE = "no_capture_candidate";
const SKIP_CAPTURE_DISABLED = "capture_disabled";

const CAPTURE_STATUS_SKIPPED = "skipped";

const CANONICALITY_WARNING =
  "Knowns memory is supplemental context only and does not override source-of-truth docs, tasks, or source files.";
const SILENT_SUPPLEMENTAL_WARNING = "Silent supplemental context. Do not quote unless asked.";

const DEFAULT_MAX_ITEMS = 5;
const DEFAULT_MAX_BYTES = 2500;
const BASELINE_MAX_ITEMS = 4;

const SEMANTIC_RELEVANCE_FLOOR = 0.55;
const KEYWORD_RELEVANCE_FLOOR = 0.5;
const HYBRID_KEYWORD_TIEBREAK = 0.03;
const HYBRID_PROJECT_TIEBREAK = 0.01;

const BASELINE_PREFERENCE_WEIGHT = 1.0;
const BASELINE_CONVENTION_WEIGHT = 0.5;
const BASELINE_TAG_WEIGHT = 0.08;

const MATCH_STOPWORDS = new Set(
  `the and for with that this from into what when where which who how why
  are was were have has had not but you your can should would could will
  about there their then than also only just does did been being its our
  all any some more most very like them they these those here please
  khi cho thi cua voi nhu nay kia nhung cac mot nhieu rat cung dang duoc
  khong nen phai sao trong tren duoi sau truoc giua bang tai neu hay hoac
  chi van lai roi vay nao ban toi minh nhe thoi day`
    .split(/\s+/)
    .filter((w) => w !== ""),
);

const LOW_SIGNAL_PROMPT_TOKENS = new Set([
  "again",
  "continue",
  "go",
  "hello",
  "hey",
  "hi",
  "next",
  "no",
  "ok",
  "okay",
  "retry",
  "sure",
  "thank",
  "thanks",
  "yes",
]);

const ADAPTER_RUNTIMES = ["kiro", "claude-code", "codex", "opencode", "antigravity"];

export interface Settings {
  mode: string;
  capture: string;
  maxItems: number;
  maxBytes: number;
}

export interface Input {
  runtime: string;
  projectRoot: string;
  workingDir: string;
  actionType: string;
  userPrompt: string;
  mode: string;
  capture: string;
  maxItems: number;
  maxBytes: number;
}

/** runtimememory.Item, in Go's JSON field order; undefined is Go's omitempty. */
export interface Item {
  id: string;
  title: string;
  category: string;
  layer: string;
  status?: string;
  updatedAt: string;
  content: string;
  claim?: string;
  hasDetail?: boolean;
  fullBytes?: number;
  semanticScore?: number;
  keywordMatch?: number;
  score: number;
  retrieval?: string;
  matchedBy?: string[];
  reasons?: string[];
  tags?: string[];
}

export interface CaptureOutcome {
  status: string;
  reason?: string;
  created: boolean;
  trusted: boolean;
  expiredProposals?: number;
}

export interface Pack {
  runtime: string;
  mode: string;
  status: string;
  warning: string;
  /** null is Go's nil slice. */
  items: Item[] | null;
  candidates?: Item[];
  serialized?: string;
  bytes: number;
  skipReason?: string;
  candidateCount: number;
  selectedCount: number;
  retrievalMode?: string;
  capture?: CaptureOutcome;
}

/** The pack in Go's struct field order (fields set late would otherwise serialize last). */
export function packJSON(p: Pack): Pack {
  const c = p.capture;
  return {
    runtime: p.runtime,
    mode: p.mode,
    status: p.status,
    warning: p.warning,
    items: p.items,
    candidates: p.candidates,
    serialized: p.serialized,
    bytes: p.bytes,
    skipReason: p.skipReason,
    candidateCount: p.candidateCount,
    selectedCount: p.selectedCount,
    retrievalMode: p.retrievalMode,
    capture: c && {
      status: c.status,
      reason: c.reason,
      created: c.created,
      trusted: c.trusted,
      expiredProposals: c.expiredProposals,
    },
  };
}

/** A hit from the semantic engine, resolved to its memory entry. */
export interface HybridCandidate {
  entry: MemoryEntry;
  score: number;
  semantic: number;
  matchedBy: string[];
}

/** The semantic lookup: `undefined` when the semantic layer is unavailable. */
export type HybridLookup = (
  storage: Storage,
  input: Input,
  limit: number,
) => Promise<HybridCandidate[] | undefined>;

// --- Go string helpers -----------------------------------------------------------------------

/** Go's unicode.IsSpace set, as a regex character class body. */
const GO_SPACE_CLASS =
  "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const GO_SPACE = new RegExp(`[${GO_SPACE_CLASS}]+`, "u");
const GO_SPACE_EDGES = new RegExp(`^[${GO_SPACE_CLASS}]+|[${GO_SPACE_CLASS}]+$`, "gu");
function trimSpace(s: string): string {
  return s.replace(GO_SPACE_EDGES, "");
}

/** strings.Fields. */
function fields(s: string): string[] {
  return s.split(GO_SPACE).filter((f) => f !== "");
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function normalizeWhitespace(s: string): string {
  return fields(trimSpace(s)).join(" ");
}

// --- settings --------------------------------------------------------------------------------

export function normalizeMode(mode: string | undefined): string {
  switch (trimSpace(mode ?? "").toLowerCase()) {
    case MODE_OFF:
      return MODE_OFF;
    case MODE_MANUAL:
      return MODE_MANUAL;
    case MODE_DEBUG:
      return MODE_DEBUG;
    default:
      return MODE_AUTO;
  }
}

export function normalizeCaptureMode(capture: string | undefined): string {
  switch (trimSpace(capture ?? "").toLowerCase()) {
    case CAPTURE_DISABLED:
    case "off":
    case "none":
    case "false":
      return CAPTURE_DISABLED;
    case CAPTURE_PROPOSE:
    case "proposed":
      return CAPTURE_PROPOSE;
    default:
      return CAPTURE_HIGH_CONFIDENCE;
  }
}

export function normalizeSettings(cfg: RuntimeMemorySettings | undefined): Settings {
  const settings: Settings = {
    mode: MODE_AUTO,
    capture: CAPTURE_HIGH_CONFIDENCE,
    maxItems: DEFAULT_MAX_ITEMS,
    maxBytes: DEFAULT_MAX_BYTES,
  };
  if (!cfg) return settings;
  settings.mode = normalizeMode(cfg.mode);
  settings.capture = normalizeCaptureMode(cfg.capture);
  if ((cfg.maxItems ?? 0) > 0) settings.maxItems = cfg.maxItems as number;
  if ((cfg.maxBytes ?? 0) > 0) settings.maxBytes = cfg.maxBytes as number;
  return settings;
}

function lookupAdapter(runtime: string): boolean {
  return ADAPTER_RUNTIMES.includes(trimSpace(runtime.toLowerCase()));
}

// --- build -----------------------------------------------------------------------------------

/** runtimememory.Build. `storage` undefined is Go's nil store. */
export async function build(
  storage: Storage | undefined,
  input: Input,
  hybrid: HybridLookup,
  now: number = Date.now(),
): Promise<Pack> {
  const mode = normalizeMode(input.mode);
  const pack: Pack = {
    runtime: input.runtime,
    mode,
    status: STATUS_NONE,
    warning: CANONICALITY_WARNING,
    items: null,
    bytes: 0,
    candidateCount: 0,
    selectedCount: 0,
  };
  if (mode === MODE_OFF) {
    pack.skipReason = SKIP_MODE_OFF;
    return pack;
  }
  if (!storage) {
    pack.skipReason = SKIP_MISSING_STORE;
    return pack;
  }
  if (!lookupAdapter(input.runtime)) {
    throw new Error(`unsupported runtime adapter: ${input.runtime}`);
  }
  const isBaseline = shouldUseSessionBaseline(input.actionType, input.userPrompt);
  const reason = promptSkipReason(input.userPrompt);
  if (reason !== "" && !isBaseline) {
    pack.skipReason = reason;
    return pack;
  }
  let maxItems = input.maxItems > 0 ? input.maxItems : DEFAULT_MAX_ITEMS;
  if (isBaseline && maxItems > BASELINE_MAX_ITEMS) maxItems = BASELINE_MAX_ITEMS;
  const maxBytes = input.maxBytes > 0 ? input.maxBytes : DEFAULT_MAX_BYTES;

  const candidates = await buildCandidates(storage, input, maxItems, isBaseline, hybrid, now);
  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ta = timeMs(a.updatedAt);
    const tb = timeMs(b.updatedAt);
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const eligible = isBaseline ? candidates : candidates.filter(clearsInjectionFloor);
  const selected = capItems(eligible, maxItems);
  pack.candidateCount = candidates.length;
  pack.retrievalMode = retrievalModeForItems(selected);
  if (pack.retrievalMode === "")
    pack.retrievalMode = retrievalModeForItems(capItems(candidates, maxItems));
  if (pack.retrievalMode === "") pack.retrievalMode = undefined;

  if (mode === MODE_DEBUG) {
    pack.candidates = nonEmpty(capItems(candidates, maxItems));
    if (selected.length === 0) {
      pack.skipReason = SKIP_NO_CANDIDATES;
      if (!isBaseline && candidates.length > 0) pack.skipReason = SKIP_BELOW_THRESHOLD;
      return pack;
    }
    pack.status = STATUS_CANDIDATE;
    return pack;
  }

  const prefix = trimToByteLimit(serializePrefix(input.runtime), maxBytes);
  let serialized = prefix;

  if (!isBaseline && selected.length === 0 && candidates.length > 0) {
    pack.candidates = nonEmpty(capItems(candidates, maxItems));
    pack.skipReason = SKIP_BELOW_THRESHOLD;
    pack.bytes = byteLen(prefix);
    return pack;
  }
  if (selected.length === 0) {
    if (isBaseline) serialized += serializeKnownsSummary(maxBytes - byteLen(serialized));
    if (trimSpace(serialized) === trimSpace(prefix)) {
      pack.skipReason = SKIP_NO_CANDIDATES;
      pack.bytes = byteLen(prefix);
      return pack;
    }
    pack.serialized = emptyToUndefined(trimToByteLimit(serialized, maxBytes));
    pack.bytes = byteLen(pack.serialized ?? "");
    pack.status = STATUS_CANDIDATE;
    pack.selectedCount = pack.items?.length ?? 0;
    return pack;
  }

  const serializedItems: Item[] = [];
  serialized += serializeItems(selected, maxBytes - byteLen(serialized), serializedItems);
  if (isBaseline || serializedItems.length > 0) {
    serialized += serializeKnownsSummary(maxBytes - byteLen(serialized));
  }
  if (serializedItems.length === 0 && !isBaseline) {
    pack.bytes = byteLen(prefix);
    return pack;
  }
  pack.items = serializedItems;
  pack.serialized = emptyToUndefined(serialized);
  pack.bytes = byteLen(serialized);
  pack.status = STATUS_CANDIDATE;
  pack.selectedCount = serializedItems.length;
  return pack;
}

function nonEmpty(items: Item[]): Item[] | undefined {
  return items.length > 0 ? items : undefined;
}

function emptyToUndefined(s: string): string | undefined {
  return s === "" ? undefined : s;
}

function timeMs(ts: string): number {
  if (!ts || ts.startsWith("0001-01-01T00:00:00")) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

// --- capture ---------------------------------------------------------------------------------

/** runtimememory.CaptureWithOutcome: nothing is captured from prompt text any more. */
export async function captureWithOutcome(
  storage: Storage | undefined,
  input: Input,
  now: number = Date.now(),
): Promise<CaptureOutcome> {
  const outcome: CaptureOutcome = {
    status: CAPTURE_STATUS_SKIPPED,
    created: false,
    trusted: false,
  };
  if (!storage) {
    outcome.reason = SKIP_MISSING_STORE;
    return outcome;
  }
  const captureMode = normalizeCaptureMode(input.capture);
  switch (normalizeMode(input.mode)) {
    case MODE_OFF:
      outcome.reason = SKIP_MODE_OFF;
      return outcome;
    case MODE_DEBUG:
      outcome.reason = SKIP_DEBUG_MODE;
      return outcome;
  }
  if (captureMode === CAPTURE_DISABLED) {
    outcome.reason = SKIP_CAPTURE_DISABLED;
    return outcome;
  }
  const reason = promptSkipReason(input.userPrompt);
  if (reason !== "") {
    outcome.reason = reason;
    return outcome;
  }
  const expired = await expireAbandonedProposals(storage, now);
  if (expired > 0) outcome.expiredProposals = expired;
  outcome.reason = SKIP_NO_CAPTURE_CANDIDATE;
  return outcome;
}

/** Retires `proposed` entries that outlived the review queue; errors are swallowed. */
async function expireAbandonedProposals(storage: Storage, now: number): Promise<number> {
  let entries: MemoryEntry[];
  try {
    entries = storage.memory.list("");
  } catch {
    return 0;
  }
  let expired = 0;
  for (const entry of entries) {
    if (!proposalIsExpired(entry, MEMORY_PROPOSAL_TTL_DAYS, now)) continue;
    entry.status = "rejected";
    entry.rejectedReason = "expired_unreviewed";
    try {
      await storage.memory.update(entry);
      expired++;
    } catch {
      // failing to tidy a backlog must never fail a prompt
    }
  }
  return expired;
}

// --- candidates ------------------------------------------------------------------------------

async function buildCandidates(
  storage: Storage,
  input: Input,
  maxItems: number,
  baseline: boolean,
  hybrid: HybridLookup,
  now: number,
): Promise<Item[]> {
  if (baseline) return buildBaselineItems(storage.memory.list(""), input, now);
  const limit = Math.max(maxItems * 4, 20);
  const hits = await hybrid(storage, input, limit);
  if (hits) return buildHybridItems(hits, input, now);
  return buildHeuristicItems(storage.memory.list(""), input, now);
}

function visibleForRuntime(entry: MemoryEntry | undefined, input: Input): boolean {
  if (!entry) return false;
  if (normalizeMode(input.mode) === MODE_DEBUG) return true;
  return memoryCurrentForDefaultRetrieval(entry);
}

function baseItem(entry: MemoryEntry): Item {
  const { claim, hasDetail, fullBytes } = claimFields(entry.content ?? "");
  const item: Item = {
    id: entry.id,
    title: entry.title,
    category: entry.category ?? "",
    layer: entry.layer,
    updatedAt: entry.updatedAt,
    content: normalizeWhitespace(entry.content ?? ""),
    score: 0,
  };
  if (entry.status) item.status = entry.status;
  if (claim !== "") item.claim = claim;
  if (hasDetail) item.hasDetail = true;
  if (fullBytes !== 0) item.fullBytes = fullBytes;
  return item;
}

/** Fills in the fields that follow `content` in Go's order (and the trailing slices). */
function finishItem(
  base: Item,
  rest: {
    score: number;
    semantic?: number;
    keywordMatch?: number;
    retrieval: string;
    matchedBy?: string[];
    reasons: string[];
    tags: string[];
  },
): Item {
  const item: Item = {
    id: base.id,
    title: base.title,
    category: base.category,
    layer: base.layer,
    status: base.status,
    updatedAt: base.updatedAt,
    content: base.content,
    claim: base.claim,
    hasDetail: base.hasDetail,
    fullBytes: base.fullBytes,
    semanticScore: rest.semantic ? rest.semantic : undefined,
    keywordMatch: rest.keywordMatch ? rest.keywordMatch : undefined,
    score: rest.score,
    retrieval: rest.retrieval,
    matchedBy: rest.matchedBy && rest.matchedBy.length > 0 ? rest.matchedBy : undefined,
    reasons: rest.reasons.length > 0 ? rest.reasons : undefined,
    tags: rest.tags.length > 0 ? rest.tags : undefined,
  };
  return item;
}

function buildBaselineItems(entries: MemoryEntry[], input: Input, now: number): Item[] {
  const out: Item[] = [];
  for (const entry of entries) {
    if (!visibleForRuntime(entry, input)) continue;
    if (!allowedCategory(entry.category ?? "")) continue;
    if (entry.layer !== MEMORY_LAYER_PROJECT && entry.layer !== MEMORY_LAYER_GLOBAL) continue;
    if (hasMemoryTag(entry, "probe") || entry.title.toLowerCase().includes("probe")) continue;
    const [score, reasons] = baselineScore(entry, now);
    if (score <= 0) continue;
    out.push(
      finishItem(baseItem(entry), {
        score,
        retrieval: "session-baseline",
        reasons,
        tags: [...(entry.tags ?? [])],
      }),
    );
  }
  return out;
}

function buildHeuristicItems(entries: MemoryEntry[], input: Input, now: number): Item[] {
  const out: Item[] = [];
  for (const entry of entries) {
    if (!visibleForRuntime(entry, input)) continue;
    if (!allowedCategory(entry.category ?? "")) continue;
    const [score, reasons, match] = scoreEntry(entry, input, true, now);
    if (score <= 0) continue;
    out.push(
      finishItem(baseItem(entry), {
        score,
        keywordMatch: match.fraction,
        retrieval: "heuristic-fallback",
        reasons: [...reasons, "heuristic-fallback"],
        tags: [...(entry.tags ?? [])],
      }),
    );
  }
  return out;
}

function buildHybridItems(hits: HybridCandidate[], input: Input, now: number): Item[] {
  // Keep the strongest match per entry: one memory can be indexed in two stores.
  const best = new Map<string, number>();
  hits.forEach((hit, i) => {
    if (!hit.entry || hit.entry.id === "") return;
    const j = best.get(hit.entry.id);
    if (j === undefined || hit.semantic > (hits[j] as HybridCandidate).semantic) {
      best.set(hit.entry.id, i);
    }
  });

  const out: Item[] = [];
  hits.forEach((hit, i) => {
    const entry = hit.entry;
    if (!entry || !visibleForRuntime(entry, input) || !allowedCategory(entry.category ?? ""))
      return;
    if (entry.id !== "" && best.get(entry.id) !== i) return;
    if (!containsString(hit.matchedBy, "semantic")) return;
    const [, reasons, match] = scoreEntry(entry, input, false, now);
    let score = hit.semantic + HYBRID_KEYWORD_TIEBREAK * match.fraction;
    if (entry.layer === MEMORY_LAYER_PROJECT) score += HYBRID_PROJECT_TIEBREAK;
    score += recencyBonus(entry.updatedAt, now) / 12;
    const all = [
      ...reasons,
      `semantic:${formatFloat(hit.semantic, "f", 2)}`,
      "hybrid-retrieval",
      "semantic-match",
    ];
    if (containsString(hit.matchedBy, "keyword")) all.push("keyword-match");
    out.push(
      finishItem(baseItem(entry), {
        score,
        semantic: hit.semantic,
        retrieval: "hybrid",
        matchedBy: [...hit.matchedBy],
        reasons: all,
        tags: [...(entry.tags ?? [])],
      }),
    );
  });
  return out;
}

/** The search-engine side of the hybrid lookup, separated so the command can wire the engine. */
export async function hybridCandidatesFrom(
  storage: Storage,
  search: (opts: {
    query: string;
    type: string;
    mode: string;
    limit: number;
    includeHistorical: boolean;
  }) => Promise<{ results: SearchResult[]; degraded?: unknown }>,
  input: Input,
  limit: number,
): Promise<HybridCandidate[] | undefined> {
  let outcome: { results: SearchResult[]; degraded?: unknown };
  try {
    outcome = await search({
      query: trimSpace(input.userPrompt),
      type: "memory",
      mode: "hybrid",
      limit,
      includeHistorical: normalizeMode(input.mode) === MODE_DEBUG,
    });
  } catch {
    return undefined;
  }
  if (outcome.degraded) return undefined;
  const hits: HybridCandidate[] = [];
  for (const result of outcome.results) {
    if (result.type !== "memory" || trimSpace(result.id) === "") continue;
    let entry: MemoryEntry;
    try {
      entry = storage.memory.get(result.id);
    } catch {
      continue;
    }
    if (!entry) continue;
    hits.push({
      entry,
      score: result.score ?? 0,
      semantic: result.semanticScore ?? 0,
      matchedBy: [...(result.matchedBy ?? [])],
    });
  }
  return hits;
}

// --- serialization ---------------------------------------------------------------------------

function serializePrefix(runtime: string): string {
  let prefix = "Knowns Guidance\n";
  if (trimSpace(runtime).toLowerCase() === "opencode") prefix += `${SILENT_SUPPLEMENTAL_WARNING}\n`;
  return `${prefix}${CANONICALITY_WARNING}\n`;
}

const KNOWNS_SUMMARY =
  '\nKnowns is the repository memory and workflow layer for tasks, docs, templates, references, and reusable knowledge.\n\n- A Memory is a fact the NEXT session needs, written from an outcome you reached. If it only repeats the prompt, do not write it.\n- Use MCP `initial` first when available; use `help("tool.*")` or `help("workflow.*")` for domain details.\n- Use MCP `memory({ action: "list" })` before `memory({ action: "get" })`, and update an existing entry rather than adding a near-duplicate.\n- If MCP bootstrap is unavailable, use the `knowns` CLI for project context.\n- If you have not checked project readiness yet, call MCP `project({ action: "status" })` to see knowledge counts, search state, runtime health, and available capabilities.\n';

function serializeKnownsSummary(remaining: number): string {
  if (remaining <= 0) return "";
  // The block is ASCII, so characters and bytes agree.
  if (KNOWNS_SUMMARY.length <= remaining) return KNOWNS_SUMMARY;
  if (remaining <= 48) return "";
  let trimmed = KNOWNS_SUMMARY.slice(0, remaining);
  const idx = trimmed.lastIndexOf("\n");
  if (idx <= 0) return "";
  trimmed = trimmed.slice(0, idx + 1);
  if (!trimmed.includes("\n- ")) return "";
  return trimmed;
}

function serializeItems(items: Item[], remainingIn: number, serializedItems: Item[]): string {
  let remaining = remainingIn;
  if (remaining <= 0 || items.length === 0) return "";
  let out = "\n";
  remaining--;

  if (items.length > 1) {
    const reserved = byteLen(serializeElision(items.length));
    if (reserved < remaining) remaining -= reserved;
  }

  let emitted = 0;
  let elided = 0;
  for (const item of items) {
    const block = serializeItem(item, remaining);
    if (block === "") {
      elided++;
      continue;
    }
    out += block;
    remaining -= byteLen(block);
    emitted++;
    serializedItems.push(item);
  }

  if (emitted === 0) {
    const first = items[0] as Item;
    const block = buildItemBlock(first);
    if (block === "") return "";
    out += block;
    elided = items.length - 1;
    serializedItems.push(first);
  }
  if (elided > 0) out += serializeElision(elided);
  return out;
}

function serializeElision(count: number): string {
  const noun = count === 1 ? "memory" : "memories";
  return `- ${count} more matching ${noun} did not fit; list them with memory(action:"list")\n`;
}

function serializeItem(item: Item, remaining: number): string {
  if (remaining <= 0) return "";
  const block = buildItemBlock(item);
  if (block === "" || byteLen(block) > remaining) return "";
  return block;
}

/** Go's %q of an ID (IDs are restricted to [A-Za-z0-9._-]). */
function quoteId(id: string): string {
  return JSON.stringify(id);
}

function buildItemBlock(item: Item): string {
  const id = trimSpace(item.id);
  const ref = `@memory/${id === "" ? "unknown" : id}`;
  const layer = trimSpace(item.layer) || "unknown";
  const category = trimSpace(item.category) || "uncategorized";
  const title = normalizeWhitespace(item.title) || "Untitled memory";
  let claim = normalizeWhitespace(item.claim ?? "");
  if (claim === "") claim = normalizeWhitespace(item.content);
  if (claim === "") return "";
  const header = `- ${ref} [${layer}/${category}] ${title}${serializeTrustMetadata(item)}\n`;
  const detail = item.hasDetail
    ? `\n  full=${item.fullBytes ?? 0}b  detail: memory(action:"get", id:${quoteId(item.id)})`
    : "";
  return `${header}  ${claim}${detail}\n`;
}

function serializeTrustMetadata(item: Item): string {
  const parts: string[] = [];
  if (item.score > 0) parts.push(`score=${formatFloat(item.score, "f", 2)}`);
  const status = trimSpace(item.status ?? "") || "active";
  parts.push(`trust=${status === "active" ? "active" : status}`);
  return ` (${parts.join("; ")})`;
}

function trimToByteLimit(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off to a character boundary (never inside a multi-byte sequence).
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

// --- scoring ---------------------------------------------------------------------------------

function allowedCategory(category: string): boolean {
  const normalized = trimSpace(category).toLowerCase();
  if (normalized === "") return false;
  if ((ALLOWED_MEMORY_CATEGORIES as readonly string[]).includes(normalized)) return true;
  return normalized === "decision" || normalized === "warning";
}

export function promptSkipReason(prompt: string): string {
  const normalized = fields(trimSpace(prompt).toLowerCase()).join(" ");
  if (normalized === "" || byteLen(normalized) < 3) return SKIP_LOW_SIGNAL_PROMPT;
  const tokens = foldToAscii(normalized).match(/[a-z0-9]+/g) ?? [];
  if (tokens.length === 0) return SKIP_LOW_SIGNAL_PROMPT;
  if (tokens.length > 2) return "";
  for (const token of tokens) if (!LOW_SIGNAL_PROMPT_TOKENS.has(token)) return "";
  return SKIP_LOW_SIGNAL_PROMPT;
}

function shouldUseSessionBaseline(actionType: string, prompt: string): boolean {
  if (prompt !== "") return false;
  switch (trimSpace(actionType).toLowerCase()) {
    case "session-start":
    case "sessionstart":
    case "session.created":
    case "agentspawn":
      return true;
    default:
      return false;
  }
}

function baselineScore(entry: MemoryEntry, now: number): [number, string[]] {
  let score = 0;
  const reasons: string[] = [];
  switch (trimSpace(entry.category ?? "").toLowerCase()) {
    case "preference":
      score += BASELINE_PREFERENCE_WEIGHT;
      reasons.push("user-commitment");
      break;
    case "convention":
      score += BASELINE_CONVENTION_WEIGHT;
      reasons.push("project-convention");
      break;
  }
  if (entry.layer === MEMORY_LAYER_PROJECT) {
    score += 0.2;
    reasons.push("project-baseline");
  } else if (entry.layer === MEMORY_LAYER_GLOBAL) {
    score += 0.14;
    reasons.push("global-baseline");
  }
  const bonus = recencyBonus(entry.updatedAt, now);
  if (bonus > 0) {
    score += bonus;
    reasons.push("recent");
  }
  for (const tag of entry.tags ?? []) {
    switch (trimSpace(tag).toLowerCase()) {
      case "preference":
      case "convention":
      case "style":
      case "runtime-memory":
      case "runtime":
        score += BASELINE_TAG_WEIGHT;
        reasons.push("baseline-tag");
        return [score, dedupeStrings(reasons)];
    }
  }
  return [score, dedupeStrings(reasons)];
}

function hasMemoryTag(entry: MemoryEntry, target: string): boolean {
  const t = target.toLowerCase();
  return (entry.tags ?? []).some((tag) => trimSpace(tag).toLowerCase() === t);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = trimSpace(raw);
    if (v === "" || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

interface KeywordMatch {
  overlaps: number;
  total: number;
  fraction: number;
}

function scoreEntry(
  entry: MemoryEntry,
  input: Input,
  requirePromptMatch: boolean,
  now: number,
): [number, string[], KeywordMatch] {
  const promptTokens = uniqueTokens(input.userPrompt);
  const contextTokens = uniqueTokens(
    input.runtime,
    filepathBase(input.projectRoot),
    filepathBase(input.workingDir),
    input.actionType,
  );
  const textSet = new Set(
    uniqueTokens(
      entry.title,
      entry.category ?? "",
      (entry.tags ?? []).join(" "),
      stripMemoryDetailMarker(entry.content ?? ""),
    ),
  );

  let score = 0;
  const reasons: string[] = [];
  if (entry.layer === MEMORY_LAYER_PROJECT) {
    score += 0.12;
    reasons.push("project-scoped");
  } else if (entry.layer === MEMORY_LAYER_GLOBAL) {
    score += 0.04;
    reasons.push("global-memory");
  }

  const match: KeywordMatch = { overlaps: 0, total: promptTokens.length, fraction: 0 };
  for (const token of promptTokens) if (textSet.has(token)) match.overlaps++;
  if (match.total > 0) match.fraction = match.overlaps / match.total;
  if (match.overlaps === 0 && requirePromptMatch) return [0, [], match];
  if (match.overlaps > 0) {
    score += match.fraction;
    reasons.push(`keyword-overlap:${match.overlaps}/${match.total}`);
  }

  let contextOverlaps = 0;
  for (const token of contextTokens) if (textSet.has(token)) contextOverlaps++;
  if (contextOverlaps > 0) score += contextOverlaps * 0.05;
  if (tokenMatches(textSet, trimSpace(input.runtime).toLowerCase())) {
    score += 0.08;
    reasons.push("runtime-match");
  }
  if (tokenMatches(textSet, trimSpace(input.actionType).toLowerCase())) {
    score += 0.08;
    reasons.push("action-match");
  }
  const bonus = recencyBonus(entry.updatedAt, now);
  if (bonus > 0) {
    score += bonus;
    reasons.push("recent");
  }
  return [score, reasons, match];
}

function retrievalModeForItems(items: Item[]): string {
  let mode = "";
  for (const item of items) {
    const retrieval = trimSpace(item.retrieval ?? "");
    if (retrieval === "") continue;
    if (mode === "") {
      mode = retrieval;
      continue;
    }
    if (mode !== retrieval) return "mixed";
  }
  return mode;
}

function containsString(values: string[], target: string): boolean {
  const t = target.toLowerCase();
  return values.some((v) => trimSpace(v).toLowerCase() === t);
}

function recencyBonus(updatedAt: string, now: number): number {
  const t = timeMs(updatedAt);
  if (t === Number.NEGATIVE_INFINITY) return 0;
  const ageDays = (now - t) / 86_400_000;
  if (ageDays <= 7) return 0.12;
  if (ageDays <= 30) return 0.06;
  if (ageDays <= 90) return 0.03;
  return 0;
}

function filepathBase(path: string): string {
  let p = path.replaceAll("\\\\", "/");
  if (p.endsWith("/")) p = p.slice(0, -1);
  if (p === "") return "";
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

function tokenMatches(set: Set<string>, value: string): boolean {
  return uniqueTokens(value).some((t) => set.has(t));
}

function uniqueTokens(...parts: string[]): string[] {
  const seen = new Set<string>();
  for (const part of parts) {
    for (const token of foldToAscii(part).match(/[a-z0-9]+/g) ?? []) {
      if (token.length < 3 || MATCH_STOPWORDS.has(token)) continue;
      seen.add(token);
    }
  }
  return [...seen].sort();
}

function claimFields(raw: string): { claim: string; hasDetail: boolean; fullBytes: number } {
  const { claim, hasDetail } = memoryClaim(raw);
  return {
    claim: normalizeWhitespace(claim),
    hasDetail,
    fullBytes: byteLen(trimSpace(stripMemoryDetailMarker(raw))),
  };
}

function clearsInjectionFloor(item: Item): boolean {
  switch (item.retrieval) {
    case "hybrid":
      return (item.semanticScore ?? 0) >= SEMANTIC_RELEVANCE_FLOOR;
    case "heuristic-fallback":
      return (item.keywordMatch ?? 0) >= KEYWORD_RELEVANCE_FLOOR;
    default:
      return true;
  }
}

function capItems(items: Item[], n: number): Item[] {
  return items.slice(0, Math.max(0, n));
}
