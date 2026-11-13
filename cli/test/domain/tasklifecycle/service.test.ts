import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type LifecycleEvent,
  partialOf,
  type Result,
  responseToWire,
  Service,
} from "../../../src/domain/tasklifecycle/index.ts";
import {
  goNow,
  MutationConflictError,
  withTaskLifecycleTransaction,
} from "../../../src/storage/history/index.ts";
import { addTask, cleanup, failure, newEnv } from "./helpers.ts";

const envs: string[] = [];
function env(...args: Parameters<typeof newEnv>) {
  const e = newEnv(...args);
  envs.push(e.dir);
  return e;
}
afterAll(() => cleanup(...envs));

const pendingFiles = (root: string): string[] => {
  const dir = join(root, ".search", "task-lifecycle", "pending");
  return existsSync(dir) ? readdirSync(dir) : [];
};

describe("archive and reopen", () => {
  test("archive moves the task, stamps archivedAt, records one lifecycle version and leaves no pending record", async () => {
    const e = env();
    const t = await addTask(e, "done one", {
      status: "done",
      completedAt: e.clock.now.toISOString(),
    });
    e.clock.advance(1000);
    const r = await e.service.archive(t.id, { actor: "alice" });
    expect(r).toMatchObject({
      taskId: t.id,
      operation: "archive",
      changed: true,
      eligible: true,
      before: "done",
      after: "archived",
      archivedAt: "2026-06-01T12:00:01Z",
    });
    expect(r.event).toMatchObject({
      type: "archive",
      actor: "alice",
      from: "done",
      to: "archived",
    });
    expect(r.event?.id).toMatch(new RegExp(`^task:${t.id}:archive:\\d+:[0-9a-f]{16}$`));
    const stored = e.storage.tasks.get(t.id);
    expect(stored.archived).toBe(true);
    expect(stored.archivedAt).toBe("2026-06-01T12:00:01Z");
    expect(existsSync(join(e.root, "archive", `${t.id}.md`))).toBe(true);
    const history = await e.storage.versions.getHistory(t.id);
    expect(history.versions?.filter((v) => v.lifecycleEventId === r.event?.id)).toHaveLength(1);
    expect(pendingFiles(e.root)).toEqual([]);
  });

  test("archive is idempotent: an archived task reports already_archived and changes nothing", async () => {
    const e = env();
    const t = await addTask(e, "done one", { status: "done" });
    await e.service.archive(t.id);
    const again = await e.service.archive(t.id);
    expect(again.changed).toBe(false);
    expect(again.eligible).toBe(true);
    expect(again.reasons?.map((x) => x.code)).toEqual(["already_archived"]);
    expect(again.before).toBe("archived");
  });

  test("a task that is not eligible is reported, not archived", async () => {
    const e = env();
    const t = await addTask(e, "still open");
    const r = await e.service.archive(t.id);
    expect(r.changed).toBe(false);
    expect(r.eligible).toBe(false);
    expect(r.reasons?.[0]?.code).toBe("not_done");
    expect(e.storage.tasks.get(t.id).archived).toBe(false);
  });

  test("a stale expected hash is a conflict and nothing moves", async () => {
    const e = env();
    const t = await addTask(e, "done one", { status: "done" });
    const err = await failure(e.service.archive(t.id, { expectedHash: "deadbeef" }));
    expect(err).toBeInstanceOf(MutationConflictError);
    expect(e.storage.tasks.get(t.id).archived).toBe(false);
    // Like Go, the partial result of a failed transaction is the zero Result (no task identity yet).
    expect(partialOf<Result>(err)).toMatchObject({ changed: false, eligible: false });
  });

  test("reopen restores an archived task to todo and clears both clocks", async () => {
    const e = env();
    const t = await addTask(e, "done one", {
      status: "done",
      completedAt: e.clock.now.toISOString(),
    });
    await e.service.archive(t.id);
    e.clock.advance(5000);
    const r = await e.service.reopen(t.id, { actor: "bob" });
    expect(r).toMatchObject({ changed: true, before: "archived", after: "active", eligible: true });
    const stored = e.storage.tasks.get(t.id);
    expect(stored).toMatchObject({ archived: false, status: "todo" });
    expect(stored.completedAt).toBeUndefined();
    expect(stored.archivedAt).toBeUndefined();
  });

  test("reopen takes an explicit status, maps done to todo, and refuses an active task", async () => {
    const e = env();
    const t = await addTask(e, "done one", {
      status: "done",
      completedAt: e.clock.now.toISOString(),
    });
    await e.service.reopen(t.id, { status: "in-review" });
    expect(e.storage.tasks.get(t.id).status).toBe("in-review");
    const d = await addTask(e, "done two", { status: "done" });
    await e.service.unarchive(d.id, { status: "done" });
    expect(e.storage.tasks.get(d.id).status).toBe("todo");
    const active = await e.service.reopen(t.id);
    expect(active).toMatchObject({ changed: false, eligible: false });
    expect(active.reasons?.map((x) => x.code)).toEqual(["already_active"]);
  });
});

describe("crash recovery from pending checkpoints", () => {
  test("an interrupted archive resumes from the move phase and completes exactly once", async () => {
    const e = env();
    const t = await addTask(e, "done one", {
      status: "done",
      completedAt: e.clock.now.toISOString(),
    });
    // Run the first half of an archive by hand: pending saved, file moved, nothing else.
    const original = e.storage.tasks.get(t.id);
    await withTaskLifecycleTransaction(e.storage.ctx, async (tx) => {
      const at = e.clock.now.toISOString();
      tx.saveTaskLifecyclePending({
        eventId: "ev-crash",
        taskId: t.id,
        operation: "archive",
        at,
        from: "done",
        to: "archived",
        original: {
          status: original.status,
          updatedAt: original.updatedAt,
          ...(original.completedAt && { completedAt: original.completedAt }),
          archived: false,
        },
        desired: {
          status: original.status,
          updatedAt: at,
          ...(original.completedAt && { completedAt: original.completedAt }),
          archivedAt: at,
          archived: true,
        },
        moveComplete: true,
        canonicalComplete: false,
        eventDelivered: false,
        derivedApplied: false,
      });
      await tx.archiveTask(t.id);
    });
    const delivered: LifecycleEvent[] = [];
    const resumed = new Service(e.storage, {
      clock: () => e.clock.now,
      hooks: { emit: (ev) => void delivered.push(ev) },
    });
    const r = await resumed.archive(t.id);
    expect(r.changed).toBe(true);
    expect(r.event?.id).toBe("ev-crash");
    expect(e.storage.tasks.get(t.id)).toMatchObject({
      archived: true,
      archivedAt: goNow(e.clock.now),
    });
    expect(delivered.map((d) => d.id)).toEqual(["ev-crash"]);
    expect(pendingFiles(e.root)).toEqual([]);
    const history = await e.storage.versions.getHistory(t.id);
    expect(history.versions?.filter((v) => v.lifecycleEventId === "ev-crash")).toHaveLength(1);
  });
});

describe("event and index delivery", () => {
  test("emit and indexTask run after the lock, once per event", async () => {
    const events: LifecycleEvent[] = [];
    const indexed: string[] = [];
    const e = env({
      hooks: {
        emit: (ev) => void events.push(ev),
        indexTask: (id) => void indexed.push(id),
      },
    });
    const t = await addTask(e, "done one", { status: "done" });
    const r = await e.service.archive(t.id, { actor: "carol" });
    expect(events).toEqual([r.event as LifecycleEvent]);
    expect(indexed).toEqual([t.id]);
    expect(pendingFiles(e.root)).toEqual([]);
  });

  test("a failing emit becomes a warning and the event is retried on the next call", async () => {
    let fail = true;
    const events: string[] = [];
    const e = env({
      hooks: {
        emit: (ev) => {
          if (fail) throw new Error("sink down");
          events.push(ev.id);
        },
      },
    });
    const t = await addTask(e, "done one", { status: "done" });
    const first = await e.service.archive(t.id);
    expect(
      first.warnings?.some((w) => w.code === "event_delivery_failed" && w.message === "sink down"),
    ).toBe(true);
    expect(pendingFiles(e.root)).toHaveLength(1);
    fail = false;
    const second = await e.service.archive(t.id);
    expect(second.reasons?.map((x) => x.code)).toEqual(["already_archived"]);
    expect(events).toEqual([first.event?.id as string]);
    expect(pendingFiles(e.root)).toEqual([]);
  });

  test("an index failure after the commit is reported with the result attached", async () => {
    const e = env({
      hooks: {
        indexTask: () => {
          throw new Error("index offline");
        },
      },
    });
    const t = await addTask(e, "done one", { status: "done" });
    const err = await failure(e.service.archive(t.id));
    expect(err.message).toBe(`index Task "${t.id}" lifecycle state: index offline`);
    expect(e.storage.tasks.get(t.id).archived).toBe(true);
    expect(partialOf<Result>(err)?.changed).toBe(true);
  });
});

describe("updateTask", () => {
  test("applies the patch, the status clocks and one history version", async () => {
    const e = env();
    const t = await addTask(e, "to do");
    e.clock.advance(1000);
    const updated = await e.service.updateTask(t.id, {
      actor: "dave",
      mutate: (task) => {
        task.status = "done";
        task.title = "finished";
        task.id = "ignored";
        task.createdAt = "1999-01-01T00:00:00Z";
      },
    });
    expect(updated).toMatchObject({ id: t.id, title: "finished", status: "done" });
    expect(updated.completedAt).toBe("2026-06-01T12:00:01Z");
    expect(updated.createdAt).toBe(goNow(new Date(t.createdAt)));
    expect(updated.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
    const history = await e.storage.versions.getHistory(t.id);
    expect(history.versions?.at(-1)?.author).toBe("dave");
    expect(history.versions?.at(-1)?.changes?.map((c) => c.field)).toContain("status");
  });

  test("a mutate error aborts without writing; an archived task is refused; a stale hash conflicts", async () => {
    const e = env();
    const t = await addTask(e, "to do");
    const before = e.storage.tasks.get(t.id).updatedAt;
    await expect(
      e.service.updateTask(t.id, {
        mutate: () => {
          throw new Error("bad patch");
        },
      }),
    ).rejects.toThrow("bad patch");
    expect(e.storage.tasks.get(t.id).updatedAt).toBe(before);
    expect(await failure(e.service.updateTask(t.id, { expectedHash: "nope" }))).toBeInstanceOf(
      MutationConflictError,
    );
    const done = await addTask(e, "done", { status: "done" });
    await e.service.archive(done.id);
    await expect(e.service.updateTask(done.id, {})).rejects.toThrow(
      "is archived; reopen it before updating",
    );
  });
});

describe("reorderTasks", () => {
  test("changes only tasks whose order differs and records an api version for each", async () => {
    const e = env();
    const a = await addTask(e, "a", { order: 1 });
    const b = await addTask(e, "b");
    const c = await addTask(e, "c", { order: 3 });
    const changed = await e.service.reorderTasks([
      { taskId: a.id, order: 1 },
      { taskId: b.id, order: 2 },
      { taskId: c.id, order: 0 },
    ]);
    expect(changed).toBe(2);
    expect(e.storage.tasks.get(a.id).order).toBe(1);
    expect(e.storage.tasks.get(b.id).order).toBe(2);
    expect(e.storage.tasks.get(c.id).order).toBe(0);
    expect((await e.storage.versions.getHistory(b.id)).versions?.at(-1)?.author).toBe("api");
  });

  test("duplicates, blanks and conflicts are rejected before anything is written", async () => {
    const e = env();
    const a = await addTask(e, "a");
    await expect(
      e.service.reorderTasks([
        { taskId: a.id, order: 1 },
        { taskId: a.id, order: 2 },
      ]),
    ).rejects.toThrow("appears more than once");
    await expect(e.service.reorderTasks([{ taskId: " ", order: 1 }])).rejects.toThrow(
      "Task ID is required",
    );
    expect(
      await failure(e.service.reorderTasks([{ taskId: a.id, order: 1 }], { [a.id]: "stale" })),
    ).toBeInstanceOf(MutationConflictError);
    expect(e.storage.tasks.get(a.id).order).toBeUndefined();
    expect(await e.service.reorderTasks([])).toBe(0);
  });
});

describe("batches", () => {
  test("batchArchive previews, then executes, and reports per-task failures in a joined error", async () => {
    const e = env();
    const d1 = await addTask(e, "d1", { status: "done" });
    const d2 = await addTask(e, "d2", { status: "done" });
    const open = await addTask(e, "open");
    const ids = [d2.id, d1.id, open.id, "missing", d1.id];

    const previewErr = await failure(e.service.batchArchive({ ids }));
    const preview = partialOf<Awaited<ReturnType<Service["batchArchive"]>>>(previewErr);
    expect(previewErr.message).toBe('Task missing: task "missing" not found');
    expect(preview).toMatchObject({
      operation: "batch_archive",
      execute: false,
      completed: true,
      processed: 4,
      changed: 0,
    });
    expect(preview?.failedTaskId).toBe("missing");
    expect(preview?.items.map((i) => i.taskId).sort()).toEqual(
      [d1.id, d2.id, open.id, "missing"].sort(),
    );

    const err = await failure(e.service.batchArchive({ ids, execute: true, actor: "eve" }));
    const batch = partialOf<Awaited<ReturnType<Service["batchArchive"]>>>(err);
    expect(err.message).toBe('Task missing: task "missing" not found');
    expect(batch?.changed).toBe(2);
    expect(batch?.failedTaskId).toBe("missing");
    expect(e.storage.tasks.get(d1.id).archived).toBe(true);
    expect(e.storage.tasks.get(open.id).archived).toBe(false);
    const openItem = batch?.items.find((i) => i.taskId === open.id);
    expect(openItem?.reasons?.[0]?.code).toBe("not_done");
  });

  test("batchArchive without ids covers every active task", async () => {
    const e = env();
    await addTask(e, "d1", { status: "done" });
    await addTask(e, "open");
    const batch = await e.service.batchArchive({ execute: true });
    expect(batch.processed).toBe(2);
    expect(batch.changed).toBe(1);
  });

  test("batchUnarchive previews and restores", async () => {
    const e = env();
    const d = await addTask(e, "d", { status: "done" });
    const open = await addTask(e, "open");
    await e.service.archive(d.id);
    const preview = await e.service.batchUnarchive({ ids: [d.id, open.id] });
    expect(preview.items.map((i) => [i.taskId, i.eligible])).toEqual(
      [
        [d.id, true],
        [open.id, false],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(e.storage.tasks.get(d.id).archived).toBe(true);
    const done = await e.service.batchUnarchive({ ids: [d.id, open.id], execute: true });
    expect(done.changed).toBe(1);
    expect(e.storage.tasks.get(d.id).archived).toBe(false);
  });

  test("autoArchive archives only what retention allows", async () => {
    const e = env();
    const old = await addTask(e, "old", { status: "done", completedAt: e.clock.now.toISOString() });
    e.clock.advance(31 * 24 * 3600 * 1000);
    const fresh = await addTask(e, "fresh", {
      status: "done",
      completedAt: e.clock.now.toISOString(),
    });
    const batch = await e.service.autoArchive("scheduler");
    expect(batch.changed).toBe(1);
    expect(e.storage.tasks.get(old.id).archived).toBe(true);
    expect(e.storage.tasks.get(fresh.id).archived).toBe(false);
    expect(batch.items.find((i) => i.taskId === old.id)?.event?.automatic).toBe(true);
  });
});

describe("hardDelete", () => {
  test("needs confirmation and a reason, and says so for each", async () => {
    const e = env();
    const t = await addTask(e, "doomed");
    const r = await e.service.hardDelete(t.id, {});
    expect(r.eligible).toBe(false);
    expect(r.reasons?.map((x) => x.code)).toEqual([
      "confirmation_required",
      "delete_reason_required",
    ]);
    const r2 = await e.service.hardDelete(t.id, { confirmed: true, reason: "  " });
    expect(r2.reasons?.map((x) => x.code)).toEqual(["delete_reason_required"]);
    expect(e.storage.tasks.get(t.id).id).toBe(t.id);
  });

  test("without a wired purge reconciler the purge fails clearly after the tombstone and pending proof are durable", async () => {
    const e = env();
    const t = await addTask(e, "doomed");
    const err = await failure(
      e.service.hardDelete(t.id, { confirmed: true, reason: "gdpr", actor: "ops" }),
    );
    expect(err.message).toContain("purge reconciler is not wired");
    expect(e.storage.tasks.isIdReserved(t.id)).toBe(true);
    expect(pendingFiles(e.root)).toHaveLength(1);
  });

  test("a tombstone with different audit metadata blocks the delete", async () => {
    const e = env();
    const t = await addTask(e, "doomed");
    await failure(e.service.hardDelete(t.id, { confirmed: true, reason: "first", actor: "ops" }));
    const r = await e.service.hardDelete(t.id, { confirmed: true, reason: "second", actor: "ops" });
    expect(r.eligible).toBe(false);
    expect(r.reasons?.map((x) => x.code)).toEqual(["tombstone_conflict"]);
  });
});

describe("executePublic", () => {
  test("rejects malformed requests as invalid_request", async () => {
    const e = env();
    const { response, error } = await e.service.executePublic(
      { operation: "archive", execute: false },
      false,
    );
    expect(error?.kind).toBe("invalid_request");
    expect(response.items[0]?.reasons?.[0]).toEqual({
      code: "invalid_request",
      message: "taskId is required",
    });
    const bad = await e.service.executePublic(
      { operation: "batch_unarchive", execute: true, ids: [] },
      false,
    );
    expect(bad.error?.kind).toBe("invalid_request");
    const unknown = await e.service.executePublic(
      { operation: "nonsense" as never, execute: false, taskId: "x" },
      false,
    );
    expect(unknown.response.items[0]?.reasons?.[0]?.message).toBe(
      'unsupported Task lifecycle operation "nonsense"',
    );
  });

  test("archive capability gates every archive-family operation; hard-delete needs its own", async () => {
    const e = env();
    const t = await addTask(e, "d", { status: "done" });
    for (const operation of ["archive", "reopen", "batch_archive", "batch_unarchive"] as const) {
      const r = await e.service.executePublicWithCapabilities(
        { operation, execute: true, taskId: t.id, ids: [t.id] },
        { archive: false, hardDelete: true },
      );
      expect(r.error?.kind).toBe("permission_denied");
    }
    const hd = await e.service.executePublic(
      { operation: "hard_delete", execute: true, taskId: t.id, confirmed: true, reason: "r" },
      false,
    );
    expect(hd.error?.kind).toBe("permission_denied");
    expect(hd.response.completed).toBe(false);
    expect(e.storage.tasks.get(t.id).archived).toBe(false);
  });

  test("preview is informational, execute denies, and both serialize to Go's wire shape", async () => {
    const e = env();
    const open = await addTask(e, "open");
    const preview = await e.service.executePublic(
      { operation: "archive", execute: false, taskId: open.id },
      false,
    );
    expect(preview.error).toBeUndefined();
    expect(preview.response.completed).toBe(true);
    expect(preview.response.items[0]?.eligible).toBe(false);
    const run = await e.service.executePublic(
      { operation: "archive", execute: true, taskId: open.id },
      false,
    );
    expect(run.error?.kind).toBe("business_denied");
    expect(Object.keys(responseToWire(run.response))).toEqual([
      "operation",
      "execute",
      "completed",
      "processed",
      "changed",
      "items",
    ]);
    expect(Object.keys(run.response.items[0] ?? {})).toContain("reasons");
  });

  test("a missing task is not_found, and minimumAgeMs is range-checked", async () => {
    const e = env();
    const missing = await e.service.executePublic(
      { operation: "archive", execute: true, taskId: "nope" },
      false,
    );
    expect(missing.error?.kind).toBe("not_found");
    expect(missing.response.failedTaskId).toBe("nope");
    const neg = await e.service.executePublic(
      { operation: "archive", execute: false, taskId: "x", minimumAgeMs: -1 },
      false,
    );
    expect(neg.error?.kind).toBe("invalid_request");
    expect(neg.response.items[0]?.reasons?.[0]?.message).toBe(
      "minimumAgeMs must be a non-negative duration",
    );
  });

  test("the full archive and reopen round trip through the public contract", async () => {
    const e = env();
    const t = await addTask(e, "d", { status: "done" });
    const arch = await e.service.executePublic(
      { operation: "archive", execute: true, taskId: t.id, actor: "mcp" },
      false,
    );
    expect(arch.error).toBeUndefined();
    expect(arch.response).toMatchObject({ completed: true, processed: 1, changed: 1 });
    expect(arch.response.items[0]).toMatchObject({ before: "done", after: "archived" });
    const re = await e.service.executePublic(
      { operation: "reopen", execute: true, taskId: t.id, status: "blocked" },
      false,
    );
    expect(re.response.items[0]).toMatchObject({ after: "active" });
    expect(e.storage.tasks.get(t.id).status).toBe("blocked");
  });
});

describe("transaction hygiene", () => {
  test("the lifecycle lock is free after a failed operation", async () => {
    const e = env();
    await failure(e.service.archive("missing"));
    const t = await addTask(e, "d", { status: "done" });
    expect((await e.service.archive(t.id)).changed).toBe(true);
  });
});
