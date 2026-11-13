// Port of internal/models/task_lifecycle.go.
import { z } from "zod";
import { timestampSchema } from "./common.ts";
import { taskLifecycleStateSchema } from "./task.ts";

/** Content-free portion of a Task needed to resume an interrupted archive/reopen. */
export const taskLifecycleDataSchema = z.object({
  status: z.string(),
  updatedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
  archivedAt: timestampSchema.optional(),
  archived: z.boolean(),
});
export type TaskLifecycleData = z.infer<typeof taskLifecycleDataSchema>;

/** Serializes one external delivery attempt; expired claims can be retried. */
export const taskLifecycleClaimSchema = z.object({
  token: z.string(),
  claimedAt: timestampSchema,
});
export type TaskLifecycleClaim = z.infer<typeof taskLifecycleClaimSchema>;

/** Content-free durable delivery checkpoint for one lifecycle event. */
export const taskLifecyclePendingSchema = z.object({
  eventId: z.string(),
  taskId: z.string(),
  operation: z.string(),
  at: timestampSchema,
  actor: z.string().optional(),
  reason: z.string().optional(),
  from: taskLifecycleStateSchema,
  to: taskLifecycleStateSchema,
  automatic: z.boolean().optional(),
  original: taskLifecycleDataSchema.optional(),
  desired: taskLifecycleDataSchema.optional(),
  moveComplete: z.boolean().optional(),
  patchComplete: z.boolean().optional(),
  versionComplete: z.boolean().optional(),
  canonicalComplete: z.boolean(),
  eventDelivered: z.boolean(),
  derivedApplied: z.boolean(),
  canonicalPath: z.string().optional(),
  canonicalHash: z.string().optional(),
  eventClaim: taskLifecycleClaimSchema.optional(),
  derivedClaim: taskLifecycleClaimSchema.optional(),
});
export type TaskLifecyclePending = z.infer<typeof taskLifecyclePendingSchema>;
