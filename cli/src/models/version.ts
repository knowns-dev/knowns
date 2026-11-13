// Port of internal/models/version.go: task/doc revisions and the JSONL history records.
//
// Snapshots and change values are `map[string]any` / `any` in Go so history stays decoupled from
// field additions; they stay `unknown` here. Hash chains are computed by the history layer, not here.
import { z } from "zod";
import { anyRecord, int, nilableArray, timestampSchema } from "./common.ts";
import { acceptanceCriterionSchema } from "./task.ts";

export const taskChangeSchema = z.object({
  field: z.string(),
  oldValue: z.unknown(),
  newValue: z.unknown(),
});
export type TaskChange = z.infer<typeof taskChangeSchema>;

export const docChangeSchema = taskChangeSchema;
export type DocChange = TaskChange;

export const docChangeScopeSchema = z.object({
  type: z.string(),
  field: z.string().optional(),
  section: z.string().optional(),
  summary: z.string().optional(),
  oldBytes: int.optional(),
  newBytes: int.optional(),
  deltaBytes: int.optional(),
});
export type DocChangeScope = z.infer<typeof docChangeScopeSchema>;

export const docHistoryGapSchema = z.object({
  type: z.string(),
  reason: z.string(),
  count: int,
  beforeVersion: z.string().optional(),
  afterVersion: z.string().optional(),
  appliedAt: timestampSchema,
});
export type DocHistoryGap = z.infer<typeof docHistoryGapSchema>;

export const taskVersionSchema = z.object({
  /** "v1", "v2", ... */
  id: z.string(),
  taskId: z.string(),
  version: int,
  timestamp: timestampSchema,
  author: z.string().optional(),
  lifecycleEventId: z.string().optional(),
  changes: nilableArray(taskChangeSchema),
  snapshot: anyRecord.nullable(),
  schemaVersion: int.optional(),
  baseHash: z.string().optional(),
  newHash: z.string().optional(),
  checkpoint: z.boolean().optional(),
  source: z.string().optional(),
  sessionId: z.string().optional(),
  batchId: z.string().optional(),
  operation: z.string().optional(),
  tombstone: z.boolean().optional(),
  legacyUnverified: z.boolean().optional(),
  legacyPath: z.string().optional(),
  legacyDigest: z.string().optional(),
});
export type TaskVersion = z.infer<typeof taskVersionSchema>;

export const taskVersionHistorySchema = z.object({
  taskId: z.string(),
  currentVersion: int,
  versions: nilableArray(taskVersionSchema),
  tailTruncated: z.boolean().optional(),
});
export type TaskVersionHistory = z.infer<typeof taskVersionHistorySchema>;

/** Typed view of the fields a task version snapshot captures. */
export const taskSnapshotSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  status: z.string(),
  priority: z.string(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).optional(),
  implementationPlan: z.string().optional(),
  implementationNotes: z.string().optional(),
});
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

export const docVersionSchema = z.object({
  id: z.string(),
  docId: z.string().optional(),
  docPath: z.string(),
  currentPath: z.string().optional(),
  previousPath: z.string().optional(),
  version: int,
  timestamp: timestampSchema,
  author: z.string().optional(),
  actor: z.string().optional(),
  source: z.string().optional(),
  auditEventId: z.string().optional(),
  sessionId: z.string().optional(),
  baseHash: z.string().optional(),
  newHash: z.string().optional(),
  checkpoint: z.boolean().optional(),
  changes: nilableArray(docChangeSchema),
  changedScopes: z.array(docChangeScopeSchema).optional(),
  snapshot: anyRecord.nullable(),
  schemaVersion: int.optional(),
  batchId: z.string().optional(),
  recordHash: z.string().optional(),
  operation: z.string().optional(),
  tombstone: z.boolean().optional(),
  legacyUnverified: z.boolean().optional(),
  legacyPath: z.string().optional(),
  legacyDigest: z.string().optional(),
});
export type DocVersion = z.infer<typeof docVersionSchema>;

export const docVersionHistorySchema = z.object({
  docId: z.string().optional(),
  docPath: z.string(),
  currentPath: z.string().optional(),
  currentVersion: int,
  versions: nilableArray(docVersionSchema),
  retentionGaps: z.array(docHistoryGapSchema).optional(),
  tailTruncated: z.boolean().optional(),
});
export type DocVersionHistory = z.infer<typeof docVersionHistorySchema>;

export const docRevisionDiffSchema = z.object({
  docId: z.string().optional(),
  docPath: z.string(),
  currentPath: z.string().optional(),
  revisionId: z.string(),
  previousRevisionId: z.string().optional(),
  version: docVersionSchema,
  checkpoint: z.boolean(),
  changes: nilableArray(docChangeSchema),
  changedScopes: z.array(docChangeScopeSchema).optional(),
  retentionGaps: z.array(docHistoryGapSchema).optional(),
});
export type DocRevisionDiff = z.infer<typeof docRevisionDiffSchema>;

export const HISTORY_ENTITY_TYPES = ["task", "doc"] as const;
export type HistoryEntityType = (typeof HISTORY_ENTITY_TYPES)[number];

/**
 * models.HistoryRecord: one line of .knowns/history/<tasks|docs>/<id>.jsonl. Typed in Go, so
 * unknown keys are dropped on rewrite; this schema strips them too.
 */
export const historyRecordSchema = z.object({
  schemaVersion: int,
  entityType: z.string(),
  entityId: z.string(),
  revision: int,
  timestamp: timestampSchema,
  author: z.string().optional(),
  actor: z.string().optional(),
  source: z.string().optional(),
  auditEventId: z.string().optional(),
  sessionId: z.string().optional(),
  batchId: z.string().optional(),
  operation: z.string().optional(),
  tombstone: z.boolean().optional(),
  lifecycleEventId: z.string().optional(),
  baseHash: z.string().optional(),
  newHash: z.string().optional(),
  prevRecordHash: z.string().optional(),
  recordHash: z.string().optional(),
  checkpoint: z.boolean().optional(),
  legacyRevision: int.optional(),
  legacyId: z.string().optional(),
  legacy: z.boolean().optional(),
  legacyUnverified: z.boolean().optional(),
  legacyBaseHash: z.string().optional(),
  legacyNewHash: z.string().optional(),
  legacyPath: z.string().optional(),
  legacyDigest: z.string().optional(),
  retentionGaps: z.array(docHistoryGapSchema).optional(),
  taskChanges: z.array(taskChangeSchema).optional(),
  docChanges: z.array(docChangeSchema).optional(),
  changedScopes: z.array(docChangeScopeSchema).optional(),
  currentPath: z.string().optional(),
  previousPath: z.string().optional(),
  checkpointPayload: anyRecord.optional(),
});
export type HistoryRecord = z.infer<typeof historyRecordSchema>;

export const historyReadResultSchema = z.object({
  records: nilableArray(historyRecordSchema),
  tailTruncated: z.boolean().optional(),
});
export type HistoryReadResult = z.infer<typeof historyReadResultSchema>;

/** Payload-free public view of one revision. */
export const historyMetadataSchema = z.object({
  schemaVersion: int.optional(),
  entityType: z.string(),
  entityId: z.string(),
  revision: int,
  id: z.string(),
  timestamp: timestampSchema,
  author: z.string().optional(),
  actor: z.string().optional(),
  source: z.string().optional(),
  auditEventId: z.string().optional(),
  sessionId: z.string().optional(),
  batchId: z.string().optional(),
  operation: z.string().optional(),
  tombstone: z.boolean().optional(),
  lifecycleEventId: z.string().optional(),
  baseHash: z.string().optional(),
  newHash: z.string().optional(),
  prevRecordHash: z.string().optional(),
  recordHash: z.string().optional(),
  checkpoint: z.boolean().optional(),
  legacyRevision: int.optional(),
  legacyId: z.string().optional(),
  legacy: z.boolean().optional(),
  legacyUnverified: z.boolean().optional(),
  legacyPath: z.string().optional(),
  legacyDigest: z.string().optional(),
  retentionGaps: z.array(docHistoryGapSchema).optional(),
  currentPath: z.string().optional(),
  previousPath: z.string().optional(),
});
export type HistoryMetadata = z.infer<typeof historyMetadataSchema>;

export const historyMetadataPageSchema = z.object({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  docPath: z.string().optional(),
  currentPath: z.string().optional(),
  retentionGaps: z.array(docHistoryGapSchema).optional(),
  offset: int,
  limit: int,
  hasMore: z.boolean(),
  nextOffset: int.optional(),
  currentVersion: int,
  items: nilableArray(historyMetadataSchema),
  tailTruncated: z.boolean().optional(),
});
export type HistoryMetadataPage = z.infer<typeof historyMetadataPageSchema>;
export type TaskVersionHistoryPage = HistoryMetadataPage;
export type DocVersionHistoryPage = HistoryMetadataPage;
