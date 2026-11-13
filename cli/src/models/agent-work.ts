// KN-4FQN0P: which agent is working on a task. An ephemeral claim in .knowns/agent-work.json (next to
// time.json), never in the task file, so a task's canonical hash and history stay as 0.34.x reads them.
import { z } from "zod";

export const agentClaimSchema = z.object({
  taskId: z.string(),
  /** Normalized MCP clientInfo.name, e.g. "claude-code". */
  client: z.string(),
  version: z.string().optional(),
  since: z.string(),
  /** The MCP process that made the claim; a dead pid on this host ends the claim. */
  pid: z.number().optional(),
});
export type AgentClaim = z.infer<typeof agentClaimSchema>;

export const agentWorkFileSchema = z.object({
  claims: z.array(agentClaimSchema).nullish(),
});
export type AgentWorkFile = z.infer<typeof agentWorkFileSchema>;

/** Derived on read and never persisted: Task.workedBy. */
export const workedBySchema = z.object({
  client: z.string(),
  version: z.string().optional(),
  since: z.string(),
  /** True while the task's timer is running (not paused). */
  active: z.boolean(),
});
export type WorkedBy = z.infer<typeof workedBySchema>;
