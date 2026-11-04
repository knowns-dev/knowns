// Types and JSON shapes of internal/decisionmigration (types.go).
import { type MemoryEntry, validateNewMemoryCategory } from "../../models/memory.ts";
import type { JsonObject } from "../../storage/stores/go-shape.ts";
import { memoryJson } from "../memoryreview/shape.ts";
import { goTrimSpace } from "./text.ts";

export const RESOLUTION_CREATE_DECISION = "create_decision";
export const RESOLUTION_LINK_EXISTING = "link_existing";
export const RESOLUTION_CONSOLIDATE_DUPLICATE = "consolidate_duplicate";
export const RESOLUTION_RECLASSIFY = "reclassify";
export const RESOLUTION_ARCHIVE_NOISE = "archive_noise";
export const RESOLUTION_REJECT_NOISE = "reject_noise";
export const RESOLUTION_LEAVE_UNCHANGED = "leave_unchanged";

export const NOISE_LOW = "low";
export const NOISE_MEDIUM = "medium";
export const NOISE_HIGH = "high";

export const JOURNAL_PENDING = "pending";
export const JOURNAL_APPLIED = "applied";
export const JOURNAL_ROLLED_BACK = "rolled_back";
export const JOURNAL_FAILED = "failed";

export const ALLOWED_RESOLUTIONS: readonly string[] = [
  RESOLUTION_CREATE_DECISION,
  RESOLUTION_LINK_EXISTING,
  RESOLUTION_CONSOLIDATE_DUPLICATE,
  RESOLUTION_RECLASSIFY,
  RESOLUTION_ARCHIVE_NOISE,
  RESOLUTION_REJECT_NOISE,
  RESOLUTION_LEAVE_UNCHANGED,
];

export const JOURNAL_VERSION = 1;

/** One deterministic row in a dry-run migration report. */
export interface Candidate {
  memoryId: string;
  title: string;
  layer: string;
  status: string;
  sources: string[];
  sourceIssues?: string[];
  noiseLikelihood: string;
  noiseReasons?: string[];
  duplicateGroup?: string;
  duplicateMembers?: string[];
  proposedResolution: string;
  proposedDecisionId?: string;
  proposedTargetId?: string;
  proposedCategory?: string;
  journalState?: string;
  linkedDecisionId?: string;
}

export interface PreviewCounts {
  total: number;
  highNoise: number;
  duplicate: number;
  withIssue: number;
}

/** Read-only: previewing never creates migration files. */
export interface PreviewReport {
  candidates: Candidate[];
  counts: PreviewCounts;
}

/** An explicit, reviewed resolution. Apply never resolves unselected candidates. */
export interface Selection {
  memoryId: string;
  resolution: string;
  decisionId?: string;
  targetMemoryId?: string;
  category?: string;
  reason?: string;
  relatedDocs?: string[];
  relatedTasks?: string[];
  acceptVerified?: boolean;
}

export interface ItemResult {
  memoryId: string;
  resolution: string;
  state: string;
  decisionId?: string;
  legacyExcluded: boolean;
  idempotent?: boolean;
  error?: string;
}

export interface ApplyResult {
  results: ItemResult[];
}

export interface RollbackResult {
  memoryId: string;
  state: string;
  decisionId?: string;
}

export interface Journal {
  version: number;
  migrationId: string;
  memoryId: string;
  selection: Selection;
  originalMemory: MemoryEntry | null;
  decisionId?: string;
  decisionCreated?: boolean;
  addedSources?: string[];
  addedDocs?: string[];
  addedTasks?: string[];
  state: string;
  legacyExcluded: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const MIGRATION_MEMORY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validMigrationMemoryId(id: string): boolean {
  return MIGRATION_MEMORY_ID.test(goTrimSpace(id));
}

/** Selection.validate. Throws the reason a selection is not acceptable. */
export function validateSelection(selection: Selection): void {
  const memoryId = goTrimSpace(selection.memoryId);
  const resolution = goTrimSpace(selection.resolution);
  if (memoryId === "") throw new Error("memoryId is required");
  if (!validMigrationMemoryId(memoryId)) {
    throw new Error(`invalid migration memory ID "${memoryId}"`);
  }
  switch (resolution) {
    case RESOLUTION_CREATE_DECISION:
    case RESOLUTION_ARCHIVE_NOISE:
    case RESOLUTION_REJECT_NOISE:
    case RESOLUTION_LEAVE_UNCHANGED:
      break;
    case RESOLUTION_LINK_EXISTING:
      if (goTrimSpace(selection.decisionId ?? "") === "") {
        throw new Error(`decisionId is required for ${resolution}`);
      }
      break;
    case RESOLUTION_CONSOLIDATE_DUPLICATE:
      if (goTrimSpace(selection.targetMemoryId ?? "") === "") {
        throw new Error(`targetMemoryId is required for ${resolution}`);
      }
      if (selection.targetMemoryId === selection.memoryId) {
        throw new Error("duplicate memory cannot target itself");
      }
      break;
    case RESOLUTION_RECLASSIFY:
      if (goTrimSpace(selection.category ?? "") === "") {
        throw new Error(`category is required for ${resolution}`);
      }
      validateNewMemoryCategory(selection.category ?? "");
      break;
    default:
      throw new Error(`unsupported migration resolution "${resolution}"`);
  }
  if (
    selection.acceptVerified &&
    resolution !== RESOLUTION_CREATE_DECISION &&
    resolution !== RESOLUTION_LINK_EXISTING &&
    resolution !== RESOLUTION_CONSOLIDATE_DUPLICATE
  ) {
    throw new Error("acceptVerified requires a Decision-backed migration resolution");
  }
}

/** Go marshals Selection with omitempty on everything except memoryId and resolution. */
export function selectionJson(s: Selection): JsonObject {
  const out: JsonObject = { memoryId: s.memoryId, resolution: s.resolution };
  if (s.decisionId) out.decisionId = s.decisionId;
  if (s.targetMemoryId) out.targetMemoryId = s.targetMemoryId;
  if (s.category) out.category = s.category;
  if (s.reason) out.reason = s.reason;
  if (s.relatedDocs && s.relatedDocs.length > 0) out.relatedDocs = s.relatedDocs;
  if (s.relatedTasks && s.relatedTasks.length > 0) out.relatedTasks = s.relatedTasks;
  if (s.acceptVerified) out.acceptVerified = true;
  return out;
}

/** The JSON object Go would marshal for a Journal. */
export function journalJson(j: Journal): JsonObject {
  const out: JsonObject = {
    version: j.version,
    migrationId: j.migrationId,
    memoryId: j.memoryId,
    selection: selectionJson(j.selection),
    originalMemory: j.originalMemory ? memoryJson(j.originalMemory) : null,
  };
  if (j.decisionId) out.decisionId = j.decisionId;
  if (j.decisionCreated) out.decisionCreated = true;
  if (j.addedSources && j.addedSources.length > 0) out.addedSources = j.addedSources;
  if (j.addedDocs && j.addedDocs.length > 0) out.addedDocs = j.addedDocs;
  if (j.addedTasks && j.addedTasks.length > 0) out.addedTasks = j.addedTasks;
  out.state = j.state;
  out.legacyExcluded = j.legacyExcluded;
  if (j.error) out.error = j.error;
  out.createdAt = j.createdAt;
  out.updatedAt = j.updatedAt;
  return out;
}

/** The JSON object Go would marshal for a Candidate. */
export function candidateJson(c: Candidate): JsonObject {
  const out: JsonObject = {
    memoryId: c.memoryId,
    title: c.title,
    layer: c.layer,
    status: c.status,
    sources: c.sources,
  };
  if (c.sourceIssues && c.sourceIssues.length > 0) out.sourceIssues = c.sourceIssues;
  out.noiseLikelihood = c.noiseLikelihood;
  if (c.noiseReasons && c.noiseReasons.length > 0) out.noiseReasons = c.noiseReasons;
  if (c.duplicateGroup) out.duplicateGroup = c.duplicateGroup;
  if (c.duplicateMembers && c.duplicateMembers.length > 0)
    out.duplicateMembers = c.duplicateMembers;
  out.proposedResolution = c.proposedResolution;
  if (c.proposedDecisionId) out.proposedDecisionId = c.proposedDecisionId;
  if (c.proposedTargetId) out.proposedTargetId = c.proposedTargetId;
  if (c.proposedCategory) out.proposedCategory = c.proposedCategory;
  if (c.journalState) out.journalState = c.journalState;
  if (c.linkedDecisionId) out.linkedDecisionId = c.linkedDecisionId;
  return out;
}

export function previewReportJson(r: PreviewReport): JsonObject {
  return {
    candidates: r.candidates.map(candidateJson),
    counts: {
      total: r.counts.total,
      highNoise: r.counts.highNoise,
      duplicate: r.counts.duplicate,
      withIssue: r.counts.withIssue,
    },
  };
}

export function itemResultJson(i: ItemResult): JsonObject {
  const out: JsonObject = { memoryId: i.memoryId, resolution: i.resolution, state: i.state };
  if (i.decisionId) out.decisionId = i.decisionId;
  out.legacyExcluded = i.legacyExcluded;
  if (i.idempotent) out.idempotent = true;
  if (i.error) out.error = i.error;
  return out;
}

export function applyResultJson(r: ApplyResult): JsonObject {
  return { results: r.results.map(itemResultJson) };
}

export function rollbackResultJson(r: RollbackResult): JsonObject {
  const out: JsonObject = { memoryId: r.memoryId, state: r.state };
  if (r.decisionId) out.decisionId = r.decisionId;
  return out;
}
