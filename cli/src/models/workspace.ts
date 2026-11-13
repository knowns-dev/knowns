// Port of internal/models/workspace.go. Persisted in .knowns/workspaces.json (an array).
import { z } from "zod";
import { int, nilableArray } from "./common.ts";

export const WORKSPACE_STATUSES = ["creating", "idle", "running", "stopped", "error"] as const;
export const WORKSPACE_PHASE_TYPES = ["research", "plan", "implement", "review"] as const;
export const WORKSPACE_PHASE_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
] as const;

export const workspacePhaseSchema = z.object({
  type: z.string(),
  agentType: z.string(),
  model: z.string().optional(),
  apiBase: z.string().optional(),
  status: z.string(),
  prompt: z.string().optional(),
  output: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  exitCode: int.optional(),
  error: z.string().optional(),
  retryCount: int.optional(),
});
export type WorkspacePhase = z.infer<typeof workspacePhaseSchema>;

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  taskId: z.string().optional(),
  useWorktree: z.boolean(),
  worktreePath: z.string().optional(),
  worktreeBranch: z.string().optional(),
  status: z.string(),
  phases: nilableArray(workspacePhaseSchema),
  currentPhaseIndex: int,
  pid: int.optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  stoppedAt: z.string().optional(),
  error: z.string().optional(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** Contents of .knowns/workspaces.json. */
export const workspacesFileSchema = z.array(workspaceSchema);

export const PROXY_EVENT_TYPES = [
  "init",
  "thinking",
  "text",
  "tool_use",
  "tool_result",
  "result",
  "error",
  "stderr",
  "exit",
] as const;

/** Normalised event emitted by the agent proxy as newline-delimited JSON. */
export const proxyEventSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  agent: z.string(),
  /** Unix milliseconds. */
  ts: int,
  raw: z.unknown().optional(),
});
export type ProxyEvent = z.infer<typeof proxyEventSchema>;
