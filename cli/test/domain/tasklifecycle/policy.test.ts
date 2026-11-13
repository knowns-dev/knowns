import { afterAll, describe, expect, test } from "bun:test";
import { applyStatusTransition, cloneTask } from "../../../src/domain/tasklifecycle/index.ts";
import { addTask, cleanup, newEnv } from "./helpers.ts";

const envs: string[] = [];
function env(...args: Parameters<typeof newEnv>) {
  const e = newEnv(...args);
  envs.push(e.dir);
  return e;
}
afterAll(() => cleanup(...envs));

const DAY = 24 * 3600 * 1000;

describe("applyStatusTransition", () => {
  const base = () => ({ ...cloneTask(emptyTask()), id: "T-1" });
  function emptyTask() {
    return {
      id: "T-1",
      title: "t",
      status: "todo",
      priority: "medium",
      labels: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archived: false,
      acceptanceCriteria: null,
      timeSpent: 0,
    };
  }
  const now = new Date("2026-06-01T12:00:00.123Z");

  test("entering done stamps completedAt and clears archivedAt", () => {
    const t = { ...base(), archivedAt: "2026-02-01T00:00:00Z" };
    applyStatusTransition(t, "done", now);
    expect(t.status).toBe("done");
    expect(t.completedAt).toBe("2026-06-01T12:00:00.123Z");
    expect(t.archivedAt).toBeUndefined();
    expect(t.updatedAt).toBe("2026-06-01T12:00:00.123Z");
  });

  test("leaving done clears both clocks", () => {
    const t = { ...base(), status: "done", completedAt: "2026-03-01T00:00:00Z" };
    applyStatusTransition(t, "in-progress", now);
    expect(t.completedAt).toBeUndefined();
    expect(t.status).toBe("in-progress");
  });

  test("a move between live statuses leaves the clocks alone and an identical status is a no-op", () => {
    const t = { ...base(), completedAt: "2026-03-01T00:00:00Z" };
    applyStatusTransition(t, "todo", now);
    expect(t.updatedAt).toBe("2026-01-01T00:00:00Z");
    applyStatusTransition(t, "blocked", now);
    expect(t.completedAt).toBe("2026-03-01T00:00:00Z");
    expect(t.status).toBe("blocked");
  });

  test("an undefined task is ignored", () => {
    expect(() => applyStatusTransition(undefined, "done", now)).not.toThrow();
  });
});

describe("cloneTask", () => {
  test("empty slices become null/absent as in Go, and the copy is independent", () => {
    const t = {
      id: "T-1",
      title: "t",
      status: "todo",
      priority: "low",
      labels: [] as string[],
      subtasks: [] as string[],
      fulfills: [] as string[],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archived: false,
      acceptanceCriteria: [{ text: "a", completed: false }],
      timeSpent: 0,
    };
    const c = cloneTask(t);
    expect(c.labels).toBeNull();
    expect(c.subtasks).toBeUndefined();
    expect(c.fulfills).toBeUndefined();
    const first = (c.acceptanceCriteria ?? [])[0];
    if (first) first.completed = true;
    expect(t.acceptanceCriteria[0]?.completed).toBe(false);
  });
});

describe("evaluate", () => {
  test("a task that is not done reports not_done", async () => {
    const e = env();
    const t = await addTask(e, "open");
    const r = await e.service.evaluate(t.id);
    expect(r.eligible).toBe(false);
    expect(r.lifecycle).toBe("active");
    expect(r.reasons.map((x) => x.code)).toEqual(["not_done"]);
  });

  test("a done task is eligible, and carries a durable-knowledge warning with sorted unique references", async () => {
    const e = env();
    const t = await addTask(e, "closed", {
      status: "done",
      completedAt: e.clock.now.toISOString(),
      description: "see @doc/zeta and @memory-abc",
      implementationPlan: "follow @doc/alpha#intro and @doc/alpha#intro",
      implementationNotes: "decided in @decision/use-bun, ignore @task-X1\n```\n@doc/in-code\n```",
    });
    const r = await e.service.evaluate(t.id);
    expect(r.eligible).toBe(true);
    expect(r.warnings).toEqual([
      {
        code: "durable_knowledge_review",
        message:
          "Review the Task Plan and Notes for durable knowledge before archival; this warning does not block the operation",
        references: ["@decision/use-bun", "@doc/alpha#intro", "@doc/zeta", "@memory/abc"],
      },
    ]);
  });

  test("no plan and no notes means no warning", async () => {
    const e = env();
    const t = await addTask(e, "closed", { status: "done", description: "@doc/x" });
    expect((await e.service.evaluate(t.id)).warnings).toBeUndefined();
  });

  test("a minimum age holds the task until completedAt plus the age, then releases it", async () => {
    const e = env();
    const t = await addTask(e, "closed", {
      status: "done",
      completedAt: e.clock.now.toISOString(),
    });
    const held = await e.service.evaluate(t.id, { minimumAgeMs: 2 * DAY });
    expect(held.eligible).toBe(false);
    expect(held.deadline).toBe("2026-06-03T12:00:00Z");
    expect(held.reasons).toEqual([
      {
        code: "retention_pending",
        message: "Task has not reached its archive deadline",
        deadline: "2026-06-03T12:00:00Z",
      },
    ]);
    e.clock.advance(2 * DAY);
    expect((await e.service.evaluate(t.id, { minimumAgeMs: 2 * DAY })).eligible).toBe(true);
    // An explicit zero is a threshold, not "none".
    expect((await e.service.evaluate(t.id, { minimumAgeMs: 0 })).eligible).toBe(true);
  });

  test("a done task without completedAt cannot be aged", async () => {
    const e = env();
    const t = await addTask(e, "closed", { status: "done" });
    const r = await e.service.evaluate(t.id, { minimumAgeMs: 1 });
    expect(r.reasons.map((x) => x.code)).toEqual(["completed_at_missing"]);
  });

  test("automatic archival honours the project switch and archiveAfter", async () => {
    const e = env();
    const t = await addTask(e, "closed", {
      status: "done",
      completedAt: e.clock.now.toISOString(),
    });
    // Defaults: autoArchive on, archiveAfter 30d.
    const pending = await e.service.evaluate(t.id, { automatic: true });
    expect(pending.reasons.map((x) => x.code)).toEqual(["retention_pending"]);
    e.clock.advance(30 * DAY);
    expect((await e.service.evaluate(t.id, { automatic: true })).eligible).toBe(true);

    const project = e.storage.config.load();
    project.settings = {
      ...project.settings,
      taskLifecycle: { ...(project.settings.taskLifecycle as object), autoArchive: false } as never,
    };
    e.storage.config.save(project);
    const off = await e.service.evaluate(t.id, { automatic: true });
    expect(off.reasons.map((x) => x.code)).toEqual(["auto_archive_disabled"]);
  });

  test("an active timer and unfinished descendants block archival", async () => {
    const e = env();
    const parent = await addTask(e, "parent", {
      status: "done",
      completedAt: e.clock.now.toISOString(),
    });
    const child = await addTask(e, "child", { parent: parent.id });
    const grandchild = await addTask(e, "grandchild", { parent: child.id, status: "done" });
    await e.storage.time.start(parent.id, "parent");
    const r = await e.service.evaluate(parent.id);
    expect(r.eligible).toBe(false);
    expect(r.reasons.map((x) => `${x.code}:${x.relatedTaskId ?? ""}`)).toEqual([
      "active_timer:",
      `unfinished_descendant:${child.id}`,
    ]);
    expect(grandchild.id).not.toBe("");
  });

  test("an archived task reports already_archived and an unknown task is an error", async () => {
    const e = env();
    const t = await addTask(e, "closed", { status: "done" });
    await e.service.archive(t.id);
    const r = await e.service.evaluate(t.id);
    expect(r.reasons.map((x) => x.code)).toEqual(["already_archived"]);
    expect((await e.service.evaluate(t.id)).lifecycle).toBe("archived");
    await expect(e.service.evaluate("nope")).rejects.toThrow("not found");
  });
});
