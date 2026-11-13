// What the lifecycle operations need from the service, so the operation modules (time, ...) do not
// import the Service class that uses them.
import type { Task } from "../../models/task.ts";
import type { TaskLifecycleTransaction } from "../../storage/history/index.ts";
import type { Clock } from "./clock.ts";

/** Minimal storage surface: the wired `Storage` (storage/adapters.ts) satisfies it. */
export interface LifecycleStorage {
  /** Knowledge root. */
  store: { root: string };
  tasks: { get(id: string): Task };
  config: { load(): { settings: { taskLifecycle?: unknown } & Record<string, unknown> } };
  ctx: import("../../storage/history/ports.ts").HistoryContext;
  /** KN-4FQN0P: the agent claims; absent on storages that predate them. */
  agentWork?: { release(taskId: string): Promise<void> };
}

export interface LifecycleCore {
  readonly clock: Clock;
  withTransaction<T>(fn: (tx: TaskLifecycleTransaction) => Promise<T> | T): Promise<T>;
  /** The canonical hash of the Task as observed now (the compatibility OCC base). */
  observedTaskHash(taskId: string): string;
  taskFor(taskId: string): Task;
  indexTask(taskId: string): Promise<void>;
}
