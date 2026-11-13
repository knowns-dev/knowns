// CLI glue for the task lifecycle library (newCLITaskLifecycleService, cliLifecycleActor,
// runCLILifecycle and printLifecycleResponse in internal/cli/task.go).

import { type Request, type Response, Service } from "../../domain/tasklifecycle/index.ts";
import { responseToWire } from "../../domain/tasklifecycle/wire.ts";
import { createStorage, type Storage } from "../../storage/adapters.ts";
import type { TaskPurgeReconciler } from "../../storage/history/index.ts";
import type { CommandContext } from "../core/define.ts";

/**
 * Seams for work the lifecycle library hands to other subsystems. They are inert until the owning
 * subsystem registers itself, so a missing one degrades exactly as Go's best-effort hooks do.
 */
export const taskLifecycleSeams: {
  /** search.BestEffortIndexTask / BestEffortRemoveTask (the search sync and runtime queue). */
  indexTask?: (storage: Storage, taskId: string) => void | Promise<void>;
  removeTask?: (storage: Storage, taskId: string) => void | Promise<void>;
  /** The phased purge reconciler `task hard-delete` needs (TSR-MBTAN6). */
  purgeReconciler?: TaskPurgeReconciler;
} = {};

/** The wired storage of the project the command runs in. */
export async function openStorage(ctx: CommandContext): Promise<Storage> {
  return createStorage(await ctx.getStore());
}

export function newCLITaskLifecycleService(storage: Storage): Service {
  return new Service(storage, {
    ...(taskLifecycleSeams.purgeReconciler && {
      purgeReconciler: taskLifecycleSeams.purgeReconciler,
    }),
    hooks: {
      indexTask: async (id) => {
        try {
          await taskLifecycleSeams.indexTask?.(storage, id);
        } catch {
          // Best effort: indexing never fails a lifecycle operation.
        }
      },
      removeTask: async (id) => {
        try {
          await taskLifecycleSeams.removeTask?.(storage, id);
        } catch {
          // Best effort.
        }
      },
    },
  });
}

/** $USER, else "cli". */
export function cliLifecycleActor(env: Record<string, string | undefined>): string {
  const actor = (env.USER ?? "").trim();
  return actor !== "" ? actor : "cli";
}

export async function runCLILifecycle(
  ctx: CommandContext,
  request: Request,
  hardDeleteAuthorized: boolean,
): Promise<void> {
  const storage = await openStorage(ctx);
  const { response, error } = await newCLITaskLifecycleService(storage).executePublic(
    request,
    hardDeleteAuthorized,
  );
  if (ctx.json) ctx.printJSON(responseToWire(response));
  else ctx.print(formatLifecycleResponse(response));
  if (error) throw error;
}

export function formatLifecycleResponse(response: Response): string {
  const mode = response.execute ? "execute" : "preview";
  let out = `${response.operation} ${mode}: processed=${response.processed} changed=${response.changed} completed=${response.completed}\n`;
  if (response.failedTaskId) out += `failedTaskId=${response.failedTaskId}\n`;
  response.items.forEach((item, index) => {
    out += `  [${index + 1}/${response.processed}] ${item.taskId}: ${item.before} -> ${item.after} changed=${item.changed} eligible=${item.eligible}`;
    const reasons = item.reasons ?? [];
    if (reasons.length > 0) out += ` reasons=${reasons.map((r) => r.code).join(",")}`;
    if (item.completedAt !== undefined) out += ` completedAt=${item.completedAt}`;
    if (item.archivedAt !== undefined) out += ` archivedAt=${item.archivedAt}`;
    if (item.deadline !== undefined) out += ` deadline=${item.deadline}`;
    if (item.event) out += ` eventId=${item.event.id}`;
    out += "\n";
    for (const warning of item.warnings ?? []) {
      out += `    warning=${warning.code} message=${warning.message}`;
      if (warning.references && warning.references.length > 0) {
        out += ` references=${warning.references.join(",")}`;
      }
      out += "\n";
    }
  });
  return out;
}
