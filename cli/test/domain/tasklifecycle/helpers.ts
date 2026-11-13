// Fixtures for the task lifecycle library tests: a wired project on a fixed, steppable clock.
import { join } from "node:path";
import { Service, type ServiceOptions } from "../../../src/domain/tasklifecycle/index.ts";
import type { Task } from "../../../src/models/task.ts";
import { createStorage, type Storage } from "../../../src/storage/adapters.ts";
import { Store } from "../../../src/storage/core/store.ts";
import { createTaskWithHistory } from "../../../src/storage/history/index.ts";
import { cleanup, newProject } from "../../history/helpers.ts";

export { cleanup };

export interface Env {
  dir: string;
  root: string;
  storage: Storage;
  service: Service;
  clock: { now: Date; advance(ms: number): void };
}

/** A fresh project whose lifecycle service runs on a clock the test steps by hand. */
export function newEnv(options: ServiceOptions = {}, start = "2026-06-01T12:00:00.000Z"): Env {
  const { dir, root } = newProject();
  const storage = createStorage(Store.open(root), { globalRoot: join(dir, "home") });
  const clock = {
    now: new Date(start),
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  const service = new Service(storage, { clock: () => new Date(clock.now), ...options });
  return { dir, root, storage, service, clock };
}

/** Creates a task through history, like `task create`. */
export async function addTask(env: Env, title: string, extra: Partial<Task> = {}): Promise<Task> {
  const now = env.clock.now.toISOString();
  const task: Task = {
    id: "",
    title,
    status: "todo",
    priority: "medium",
    labels: [],
    createdAt: now,
    updatedAt: now,
    archived: false,
    acceptanceCriteria: null,
    timeSpent: 0,
    ...extra,
  };
  await createTaskWithHistory(env.storage.ctx, task, {
    author: "test",
    changes: env.storage.versions.trackChanges(null, task),
  });
  return task;
}

export async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}
