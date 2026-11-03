// Port of internal/models/audit.go. Events are JSON lines in ~/.knowns/audit.jsonl.
import { z } from "zod";
import { int, nilableArray, nilableRecord, timestampSchema } from "./common.ts";

export const auditEventSchema = z.object({
  timestamp: timestampSchema,
  toolName: z.string(),
  action: z.string().optional(),
  /** read, write, delete, generate, admin. */
  actionClass: z.string(),
  projectRoot: z.string().optional(),
  dryRun: z.boolean().optional(),
  /** "success", "error", or "denied". */
  result: z.string(),
  durationMs: int,
  errorMessage: z.string().optional(),
  entityRefs: z.array(z.string()).optional(),
  argumentSummary: z.record(z.string(), z.string()).optional(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditStatsSchema = z.object({
  totalCalls: int,
  byTool: nilableRecord(int),
  byActionClass: nilableRecord(int),
  byResult: nilableRecord(int),
  dryRunCount: int,
  executeCount: int,
  byToolResult: nilableRecord(z.record(z.string(), int)),
});
export type AuditStats = z.infer<typeof auditStatsSchema>;

export const auditCoverageSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  partial: z.boolean(),
});
export type AuditCoverage = z.infer<typeof auditCoverageSchema>;

export const auditDailyBucketSchema = z.object({
  date: z.string(),
  covered: z.boolean(),
  totalCalls: int,
  successCount: int,
  errorCount: int,
  deniedCount: int,
  needsAttention: int,
  averageDurationMs: z.number(),
  topTool: z.string().optional(),
  topToolCalls: int,
});
export type AuditDailyBucket = z.infer<typeof auditDailyBucketSchema>;

export const auditToolStatsSchema = z.object({
  tool: z.string(),
  totalCalls: int,
  byResult: nilableRecord(int),
  averageDurationMs: z.number(),
});
export type AuditToolStats = z.infer<typeof auditToolStatsSchema>;

/** AuditAnalytics embeds AuditStats, so its fields are flattened into the object. */
export const auditAnalyticsSchema = auditStatsSchema.extend({
  timezone: z.string(),
  rangeStart: z.string(),
  rangeEnd: z.string(),
  coverage: auditCoverageSchema,
  dailyBuckets: nilableArray(auditDailyBucketSchema),
  tools: nilableArray(auditToolStatsSchema),
  byProject: nilableRecord(int),
  needsAttention: int,
  averageDurationMs: z.number(),
});
export type AuditAnalytics = z.infer<typeof auditAnalyticsSchema>;

export const auditAnalyticsQuerySchema = z.object({
  days: int,
  timezone: z.string(),
  project: z.string().optional(),
  allProjects: z.boolean().optional(),
});
export type AuditAnalyticsQuery = z.infer<typeof auditAnalyticsQuerySchema>;

/** Labels events recorded without a project scope. */
export const UNKNOWN_AUDIT_PROJECT = "(unknown)";
