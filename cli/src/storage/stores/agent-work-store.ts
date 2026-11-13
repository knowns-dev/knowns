// KN-4FQN0P: .knowns/agent-work.json, the ephemeral record of which MCP agent is working on which task.
// Not part of 0.34.x: Go ignores the file and the TS task file never carries it, so D10 holds. Claims are
// advisory: Task.workedBy is derived from them (see deriveWorkedBy) and a stale claim is simply ignored.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentClaim, agentWorkFileSchema, type WorkedBy } from "../../models/agent-work.ts";
import type { Task } from "../../models/task.ts";
import type { TimeState } from "../../models/time.ts";
import { parseBoundary } from "../../schema/index.ts";
import type { Store } from "../core/store.ts";
import { parseJsonPreservingNumbers, writeJson } from "../core/util.ts";
import { isNotFound } from "./internal.ts";

/** A claim with no running timer is dropped after this long (a session that died without stopping). */
export const CLAIM_TTL_MS = 12 * 60 * 60 * 1000;

function claimJson(c: AgentClaim): Record<string, unknown> {
  const out: Record<string, unknown> = { taskId: c.taskId, client: c.client };
  if (c.version) out.version = c.version;
  out.since = c.since;
  if (c.pid !== undefined) out.pid = c.pid;
  return out;
}

/** Whether a process is alive on this host (EPERM still means it exists). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class AgentWorkStore {
  private readonly root: string;
  constructor(private readonly store: Pick<Store, "root" | "withTaskLifecycleLock">) {
    this.root = store.root;
  }

  path(): string {
    return join(this.root, "agent-work.json");
  }

  /** An unreadable or malformed file reads as no claims: the data is advisory and must never block work. */
  list(): AgentClaim[] {
    let data: string;
    try {
      data = readFileSync(this.path(), "utf8");
    } catch (e) {
      if (isNotFound(e)) return [];
      return [];
    }
    try {
      const file = parseBoundary(
        agentWorkFileSchema,
        parseJsonPreservingNumbers(data),
        "agent-work.json",
      );
      return file.claims ?? [];
    } catch {
      return [];
    }
  }

  get(taskId: string): AgentClaim | undefined {
    return this.list().find((c) => c.taskId === taskId);
  }

  private save(claims: AgentClaim[]): void {
    writeJson(this.path(), { claims: claims.map(claimJson) });
  }

  /** Record that `client` works on the task; another client's claim is replaced. */
  claim(
    taskId: string,
    client: string,
    version?: string,
    pid: number = process.pid,
  ): Promise<void> {
    return this.store.withTaskLifecycleLock(() => this.claimUnlocked(taskId, client, version, pid));
  }

  claimUnlocked(taskId: string, client: string, version?: string, pid: number = process.pid): void {
    const claims = this.list();
    const existing = claims.find((c) => c.taskId === taskId);
    // The same client keeps its original start time, so "since" survives repeated in-progress updates.
    const since =
      existing && existing.client === client ? existing.since : new Date().toISOString();
    const next: AgentClaim = { taskId, client, since, pid };
    if (version) next.version = version;
    this.save([...claims.filter((c) => c.taskId !== taskId), next]);
  }

  release(taskId: string): Promise<void> {
    return this.store.withTaskLifecycleLock(() => this.releaseUnlocked(taskId));
  }

  releaseUnlocked(taskId: string): void {
    const claims = this.list();
    if (!claims.some((c) => c.taskId === taskId)) return;
    this.save(claims.filter((c) => c.taskId !== taskId));
  }
}

/**
 * Task.workedBy for one task, or undefined. A claim counts only while the task is in progress and not
 * archived, and is ignored when its process is gone or it is older than CLAIM_TTL_MS without a running timer.
 */
export function deriveWorkedBy(
  task: Pick<Task, "id" | "status" | "archived">,
  claim: AgentClaim | undefined,
  time: TimeState,
  now: number = Date.now(),
): WorkedBy | undefined {
  if (!claim || task.archived || task.status !== "in-progress") return undefined;
  const timer = time.active?.find((a) => a.taskId === task.id);
  const active = !!timer && timer.pausedAt === null;
  if (!timer) {
    if (claim.pid !== undefined && !pidAlive(claim.pid)) return undefined;
    const startedMs = Date.parse(claim.since);
    if (Number.isFinite(startedMs) && now - startedMs > CLAIM_TTL_MS) return undefined;
  }
  const out: WorkedBy = { client: claim.client, since: claim.since, active };
  if (claim.version) out.version = claim.version;
  return out;
}

/** Fills Task.workedBy on every task from the claims file and the timer state (one read of each). */
export function attachWorkedBy(
  tasks: Task[],
  agentWork: AgentWorkStore,
  readTime: () => TimeState,
): void {
  const claims = agentWork.list();
  if (claims.length === 0) return;
  let time: TimeState;
  try {
    time = readTime();
  } catch {
    time = { active: [] };
  }
  for (const task of tasks) {
    const w = deriveWorkedBy(
      task,
      claims.find((c) => c.taskId === task.id),
      time,
    );
    if (w) task.workedBy = w;
  }
}
