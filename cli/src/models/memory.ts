// Port of internal/models/memory.go.
import { z } from "zod";
import { int, timestampSchema } from "./common.ts";

export const MEMORY_LAYER_PROJECT = "project";
export const MEMORY_LAYER_GLOBAL = "global";

export const MEMORY_STATUSES = [
  "proposed",
  "active",
  "stale",
  "deprecated",
  "archived",
  "rejected",
  "merged",
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_CONFIDENCES = ["low", "medium", "high"] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

export const LEGACY_DECISION_MEMORY_CATEGORY = "decision";
export const LEGACY_DECISION_MIGRATION_ID_KEY = "decisionMigration.id";
export const LEGACY_DECISION_MIGRATION_RESOLUTION_KEY = "decisionMigration.resolution";
export const LEGACY_DECISION_MIGRATION_DECISION_KEY = "decisionMigration.decisionId";

export const LEGACY_DECISION_MEMORY_WRITE_ERROR =
  'memory category "decision" is legacy and read-only; archive, reject, reclassify, or migrate existing entries, and create new durable guidance as a first-class System Decision with `knowns decision create` or the Decision MCP/API';

/** models.MemoryEntry (JSON shape). */
export const memoryEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  key: z.string().optional(),
  layer: z.string(),
  category: z.string().optional(),
  content: z.string().optional(),
  status: z.string().optional(),
  confidence: z.string().optional(),
  lastVerified: timestampSchema.optional(),
  ttlDays: int.optional(),
  sources: z.array(z.string()).optional(),
  mergedInto: z.string().optional(),
  rejectedReason: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lifecycleMetadataMissing: z.array(z.string()).optional(),
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

/** memoryFrontmatter in internal/storage/memory_store.go; timestamps are strings. */
export const memoryFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string(),
  key: z.string().optional(),
  layer: z.string().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  confidence: z.string().optional(),
  lastVerified: z.string().optional(),
  ttlDays: int.optional(),
  sources: z.array(z.string()).nullish(),
  mergedInto: z.string().optional(),
  rejectedReason: z.string().optional(),
  tags: z.array(z.string()).nullish(),
  metadata: z.record(z.string(), z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MemoryFrontmatter = z.infer<typeof memoryFrontmatterSchema>;

const MEMORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const ALLOWED_MEMORY_CATEGORIES = [
  "pattern",
  "convention",
  "preference",
  "failure",
] as const;

export function isLegacyDecisionMemoryCategory(category: string): boolean {
  return category.trim().toLowerCase() === LEGACY_DECISION_MEMORY_CATEGORY;
}

export function validateNewMemoryCategory(category: string): void {
  if (isLegacyDecisionMemoryCategory(category)) throw new Error(LEGACY_DECISION_MEMORY_WRITE_ERROR);
}

/**
 * ValidateLegacyDecisionMemoryUpdate: legacy Decision memories only accept terminal lifecycle
 * changes (archived or rejected) or reclassification.
 */
export function validateLegacyDecisionMemoryUpdate(
  existing: Pick<MemoryEntry, "category"> | null,
  updated: Pick<MemoryEntry, "category" | "status"> | null,
): void {
  if (!existing || !updated) return;
  const wasLegacy = isLegacyDecisionMemoryCategory(existing.category ?? "");
  const isLegacy = isLegacyDecisionMemoryCategory(updated.category ?? "");
  if (!wasLegacy) {
    validateNewMemoryCategory(updated.category ?? "");
    return;
  }
  if (!isLegacy) return;
  if (updated.status === "archived" || updated.status === "rejected") return;
  throw new Error(LEGACY_DECISION_MEMORY_WRITE_ERROR);
}

export function validMemoryStatus(status: string): status is MemoryStatus {
  return (MEMORY_STATUSES as readonly string[]).includes(status);
}

export function validMemoryConfidence(confidence: string): confidence is MemoryConfidence {
  return (MEMORY_CONFIDENCES as readonly string[]).includes(confidence);
}

/** ValidateMemoryCategory: empty is legal; otherwise only the published categories. */
export function validateMemoryCategory(category: string): void {
  const trimmed = category.trim();
  if (trimmed === "") return;
  validateNewMemoryCategory(trimmed);
  const lower = trimmed.toLowerCase();
  if ((ALLOWED_MEMORY_CATEGORIES as readonly string[]).some((a) => a.toLowerCase() === lower))
    return;
  throw new Error(
    `memory category "${trimmed}" is not allowed; use one of ${ALLOWED_MEMORY_CATEGORIES.join(", ")}`,
  );
}

const WHY_MARKER = "**Why:**";

/** ValidatePreferenceWhy: a `preference` memory must carry a `**Why:**` line. */
export function validatePreferenceWhy(category: string, content: string): void {
  if (category.trim().toLowerCase() !== "preference") return;
  if (content.includes(WHY_MARKER)) return;
  throw new Error(
    `a preference memory must state its reason: add a ${WHY_MARKER} line saying why the user asked for this, since the reason is what lets the rule be applied to cases it does not name`,
  );
}

/** Separates the claim an agent is shown from the detail it fetches on demand. */
export const MEMORY_DETAIL_MARKER = "<!--memory:detail-->";

export const MEMORY_CLAIM_SOURCE_MARKER = "marker";
export const MEMORY_CLAIM_SOURCE_FIRST_PARAGRAPH = "first-paragraph";
export const MEMORY_CLAIM_SOURCE_WHOLE = "whole";

export interface MemoryClaimInfo {
  claim: string;
  claimSource: string;
  hasDetail: boolean;
  detailBytes?: number;
}

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

/** firstParagraph: cut at the first blank line, tolerating CR and trailing spaces. */
function firstParagraph(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && (lines[i] ?? "").replace(/\r$/, "").trim() === "") {
      end = i;
      break;
    }
  }
  return lines.slice(0, end).join("\n").trim();
}

/** InspectMemoryClaim: split a memory body and report who chose the boundary. */
export function inspectMemoryClaim(content: string): MemoryClaimInfo {
  const trimmed = content.trim();
  if (trimmed === "")
    return { claim: "", claimSource: MEMORY_CLAIM_SOURCE_WHOLE, hasDetail: false };
  const idx = trimmed.indexOf(MEMORY_DETAIL_MARKER);
  if (idx >= 0) {
    const claim = trimmed.slice(0, idx).trim();
    const rest = trimmed.slice(idx + MEMORY_DETAIL_MARKER.length).trim();
    if (claim === "") {
      return { claim: trimmed, claimSource: MEMORY_CLAIM_SOURCE_WHOLE, hasDetail: false };
    }
    return {
      claim,
      claimSource: MEMORY_CLAIM_SOURCE_MARKER,
      hasDetail: rest !== "",
      ...(rest !== "" ? { detailBytes: byteLength(rest) } : {}),
    };
  }
  const claim = firstParagraph(trimmed);
  if (byteLength(claim) >= byteLength(trimmed)) {
    return { claim, claimSource: MEMORY_CLAIM_SOURCE_WHOLE, hasDetail: false };
  }
  return {
    claim,
    claimSource: MEMORY_CLAIM_SOURCE_FIRST_PARAGRAPH,
    hasDetail: true,
    detailBytes: byteLength(trimmed) - byteLength(claim),
  };
}

/** StripMemoryDetailMarker: the marker is a formatting directive, not content. */
export function stripMemoryDetailMarker(content: string): string {
  if (!content.includes(MEMORY_DETAIL_MARKER)) return content;
  let stripped = content.split(MEMORY_DETAIL_MARKER).join("");
  while (stripped.includes("\n\n\n")) stripped = stripped.split("\n\n\n").join("\n\n");
  return stripped.trim();
}

/** MemoryClaim: the part worth injecting, and whether anything was held back. */
export function memoryClaim(content: string): { claim: string; hasDetail: boolean } {
  const info = inspectMemoryClaim(content);
  return { claim: info.claim, hasDetail: info.hasDetail };
}

export function memoryClaimNeedsMarker(content: string): boolean {
  return inspectMemoryClaim(content).claimSource === MEMORY_CLAIM_SOURCE_FIRST_PARAGRAPH;
}

/** InsertMemoryDetailMarker: freeze the boundary the fallback is already using. */
export function insertMemoryDetailMarker(content: string): { content: string; changed: boolean } {
  const info = inspectMemoryClaim(content);
  if (info.claimSource !== MEMORY_CLAIM_SOURCE_FIRST_PARAGRAPH) return { content, changed: false };
  const trimmed = content.trim();
  // Go slices by byte offset; claim is a prefix of trimmed so the UTF-16 length is equivalent.
  const rest = trimmed.slice(info.claim.length).trim();
  return { content: `${info.claim}\n\n${MEMORY_DETAIL_MARKER}\n\n${rest}`, changed: true };
}

/** FoldToASCII: lowercase and strip diacritics (NFD, drop combining marks). */
export function foldToAscii(s: string): string {
  const lowered = s
    .trim()
    .toLowerCase()
    .replaceAll("đ", "d")
    .replaceAll("ø", "o")
    .replaceAll("ł", "l")
    .replaceAll("ß", "ss")
    .replaceAll("æ", "ae")
    .replaceAll("œ", "oe");
  return lowered.normalize("NFD").replace(/\p{Mn}/gu, "");
}

/** DeriveMemoryKey: the upsert handle derived from the TITLE (never the content), max 80 chars. */
export function deriveMemoryKey(title: string): string {
  let slug = foldToAscii(title)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > 80) slug = slug.slice(0, 80).replace(/^-+|-+$/g, "");
  return slug;
}

export function memoryApplyLifecycleDefaults<T extends { status?: string }>(m: T): T {
  if (!m.status) m.status = "active";
  return m;
}

/** MissingTrustMetadata: lifecycle fields absent on a (legacy) entry. */
export function missingTrustMetadata(
  m: Pick<
    MemoryEntry,
    "status" | "confidence" | "lastVerified" | "ttlDays" | "sources" | "lifecycleMetadataMissing"
  >,
): string[] {
  const seen = new Set<string>();
  const missing: string[] = [];
  const add = (field: string) => {
    if (field === "" || seen.has(field)) return;
    seen.add(field);
    missing.push(field);
  };
  for (const field of m.lifecycleMetadataMissing ?? []) add(field);
  if (!m.status) add("status");
  if (!m.confidence) add("confidence");
  if (!m.lastVerified || m.lastVerified === "0001-01-01T00:00:00Z") add("lastVerified");
  if ((m.ttlDays ?? 0) <= 0) add("ttlDays");
  if ((m.sources?.length ?? 0) === 0) add("sources");
  return missing;
}

export function memoryCurrentForDefaultRetrieval(
  m: Pick<MemoryEntry, "status"> | null | undefined,
): boolean {
  if (!m) return false;
  return (m.status || "active") === "active";
}

/** MemoryFileName: `memory-<id>.md`. */
export function memoryFileName(id: string): string {
  return `memory-${id}.md`;
}

/** ValidateMemoryID: rejects ids that change the file name or use alternate path syntax. */
export function validateMemoryId(id: string): void {
  if (!MEMORY_ID.test(id) || id.endsWith(".")) throw new Error(`invalid memory ID "${id}"`);
}

export function validMemoryLayer(layer: string): boolean {
  return layer === MEMORY_LAYER_PROJECT || layer === MEMORY_LAYER_GLOBAL;
}

export const validPersistentMemoryLayer = validMemoryLayer;

export function promoteLayer(layer: string): string | undefined {
  return layer === MEMORY_LAYER_PROJECT ? MEMORY_LAYER_GLOBAL : undefined;
}

export function demoteLayer(layer: string): string | undefined {
  return layer === MEMORY_LAYER_GLOBAL ? MEMORY_LAYER_PROJECT : undefined;
}

export const promotePersistentMemoryLayer = promoteLayer;
export const demotePersistentMemoryLayer = demoteLayer;

/** How long a `proposed` entry may sit unresolved. */
export const MEMORY_PROPOSAL_TTL_DAYS = 30;

/** The day the review queue started being reported and expired (2026-09-09 UTC). */
const MEMORY_PROPOSAL_TTL_EFFECTIVE_FROM = Date.UTC(2026, 8, 9);

export const MEMORY_CLEANUP_ABANDONED_PROPOSAL = "abandoned-proposal";
export const MEMORY_CLEANUP_STALE_ENTRY = "stale-entry";

export const memoryCleanupCandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  layer: z.string(),
  category: z.string().optional(),
  status: z.string().optional(),
  kind: z.string(),
  tags: z.array(z.string()).optional(),
  content: z.string(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  ageDays: int,
});
export type MemoryCleanupCandidate = z.infer<typeof memoryCleanupCandidateSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Epoch ms of a timestamp, or 0 when absent/zero (Go's zero time). */
function ms(ts: string | undefined): number {
  if (!ts || ts === "0001-01-01T00:00:00Z") return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

/** MemoryEffectiveUpdatedAt: UpdatedAt, else CreatedAt (epoch ms; 0 when neither is set). */
export function memoryEffectiveUpdatedAt(
  entry: Pick<MemoryEntry, "updatedAt" | "createdAt"> | null | undefined,
): number {
  if (!entry) return 0;
  return ms(entry.updatedAt) || ms(entry.createdAt);
}

/** ProposalIsExpired: only `proposed` entries expire, measured from no earlier than 2026-09-09. */
export function proposalIsExpired(
  entry: Pick<MemoryEntry, "status" | "updatedAt" | "createdAt"> | null | undefined,
  ttlDays: number,
  now: number,
): boolean {
  if (entry?.status !== "proposed") return false;
  const ttl = ttlDays <= 0 ? MEMORY_PROPOSAL_TTL_DAYS : ttlDays;
  let effective = memoryEffectiveUpdatedAt(entry);
  if (effective === 0) return false;
  if (effective < MEMORY_PROPOSAL_TTL_EFFECTIVE_FROM)
    effective = MEMORY_PROPOSAL_TTL_EFFECTIVE_FROM;
  return effective < now - ttl * DAY_MS;
}

/** SelectMemoryCleanupCandidates: the one selection rule for cleanup (proposals first, oldest first). */
export function selectMemoryCleanupCandidates(
  entries: ReadonlyArray<MemoryEntry | null | undefined>,
  olderThanDays: number,
  limit: number,
  now: number,
): MemoryCleanupCandidate[] {
  const older = olderThanDays <= 0 ? 7 : olderThanDays;
  const max = limit <= 0 ? 20 : limit;
  const threshold = now - older * DAY_MS;

  const candidates: MemoryCleanupCandidate[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    const effective = memoryEffectiveUpdatedAt(entry);
    if (effective === 0) continue;
    let kind: string;
    if (proposalIsExpired(entry, MEMORY_PROPOSAL_TTL_DAYS, now)) {
      kind = MEMORY_CLEANUP_ABANDONED_PROPOSAL;
    } else if (effective < threshold) {
      kind = MEMORY_CLEANUP_STALE_ENTRY;
    } else {
      continue;
    }
    candidates.push({
      id: entry.id,
      title: entry.title,
      layer: entry.layer,
      ...(entry.category ? { category: entry.category } : {}),
      ...(entry.status ? { status: entry.status } : {}),
      kind,
      ...(entry.tags && entry.tags.length > 0 ? { tags: entry.tags } : {}),
      content: entry.content ?? "",
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ageDays: Math.trunc((now - effective) / (60 * 60 * 1000) / 24),
    });
  }
  // Stable sort (Array.prototype.sort is stable): abandoned proposals first, then oldest first.
  candidates.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === MEMORY_CLEANUP_ABANDONED_PROPOSAL ? -1 : 1;
    return b.ageDays - a.ageDays;
  });
  return candidates.slice(0, max);
}
