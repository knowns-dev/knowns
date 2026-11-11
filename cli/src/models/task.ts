// Port of internal/models/task.go.
import { z } from "zod";
import { workedBySchema } from "./agent-work.ts";
import { int, nilableArray, stringList, timestampSchema } from "./common.ts";
import { activeTimerSchema, timeEntrySchema } from "./time.ts";

export const acceptanceCriterionSchema = z.object({
  text: z.string(),
  completed: z.boolean(),
});
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const TASK_LIFECYCLE_STATES = ["active", "done", "archived"] as const;
export const taskLifecycleStateSchema = z.enum(TASK_LIFECYCLE_STATES);
export type TaskLifecycleState = z.infer<typeof taskLifecycleStateSchema>;

/**
 * models.Task: the JSON (API) shape. Persisted tasks are markdown with the frontmatter in
 * `taskFrontmatterSchema` and the description, plan, notes, and acceptance criteria in the body.
 */
export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.string(),
  priority: z.string(),
  assignee: z.string().optional(),
  labels: nilableArray(z.string()),
  parent: z.string().optional(),
  /** Derived at load time; never persisted. */
  subtasks: stringList.optional(),
  spec: z.string().optional(),
  fulfills: stringList.optional(),
  order: int.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
  archivedAt: timestampSchema.optional(),
  /** Derived from the file location (archive/). */
  archived: z.boolean(),
  acceptanceCriteria: nilableArray(acceptanceCriterionSchema),
  /** Total time tracked, in seconds. */
  timeSpent: int,
  timeEntries: z.array(timeEntrySchema).optional(),
  activeTimer: activeTimerSchema.optional(),
  /** Derived from .knowns/agent-work.json at read time; never persisted in the task file. */
  workedBy: workedBySchema.optional(),
  canonicalHash: z.string().optional(),
  implementationPlan: z.string().optional(),
  implementationNotes: z.string().optional(),
});
export type Task = z.infer<typeof taskSchema>;

/**
 * The YAML frontmatter Go writes for a task (taskFrontmatter in internal/storage/task_store.go).
 * Loose: Go's lifecycle patch rewrites only the lifecycle keys and preserves every unknown
 * frontmatter key byte-for-byte, so the unknown keys must survive a parse.
 */
export const taskFrontmatterSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  labels: stringList.nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  archivedAt: z.string().optional(),
  timeSpent: int,
  assignee: z.string().optional(),
  parent: z.string().optional(),
  spec: z.string().optional(),
  fulfills: stringList.nullish(),
  order: int.optional(),
});
export type TaskFrontmatter = z.infer<typeof taskFrontmatterSchema>;

/** models.TaskTombstone, stored at .knowns/.../tombstones/<id>.json. */
export const taskTombstoneSchema = z.object({
  id: z.string(),
  deletedAt: timestampSchema,
  actor: z.string().optional(),
  reason: z.string(),
});
export type TaskTombstone = z.infer<typeof taskTombstoneSchema>;

export const DEFAULT_STATUSES = [
  "todo",
  "in-progress",
  "in-review",
  "done",
  "blocked",
  "on-hold",
  "urgent",
] as const;

export const VALID_PRIORITIES = ["low", "medium", "high"] as const;

/** Task.LifecycleState: archived wins over status. */
export function taskLifecycleState(task: Pick<Task, "archived" | "status">): TaskLifecycleState {
  if (task.archived) return "archived";
  if (task.status === "done") return "done";
  return "active";
}
