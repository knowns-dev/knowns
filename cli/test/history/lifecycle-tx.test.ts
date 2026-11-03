// Task lifecycle transaction (pending checkpoints, lifecycle versions, purge) and sync provenance.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskLifecyclePending } from "../../src/models/task-lifecycle.ts";
import { writeJson } from "../../src/storage/core/util.ts";
import {
  canonicalDocHash,
  createTaskWithHistory,
  explainConflict,
  isHistoryConflict,
  MutationConflictError,
  mutateDocWithHistory,
  purgeTaskLifecycle,
  recordSyncArrivals,
  SyncConflictError,
  syncArrivalFor,
  syncArrivalsPath,
  type TaskLifecycleTransaction,
  taskToSnapshot,
  withTaskLifecycleTransaction,
} from "../../src/storage/history/index.ts";
import { cleanup, makeContext, makeDoc, makeTask, newProject } from "./helpers.ts";

const dirs: string[] = [];
function setup() {
  const p = newProject();
  dirs.push(p.dir);
  return { ...p, ctx: makeContext(p.root) };
}
afterAll(() => cleanup(...dirs));

async function err(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

const pending = (over: Partial<TaskLifecyclePending> = {}): TaskLifecyclePending => ({
  eventId: "ev-1",
  taskId: "T-1",
  operation: "archive",
  at: "2026-01-01T00:00:00Z",
  from: "active",
  to: "archived",
  canonicalComplete: false,
  eventDelivered: false,
  derivedApplied: false,
  ...over,
});

describe("pending lifecycle checkpoints", () => {
  test("save, get, list in order, and delete", async () => {
    const { ctx, root } = setup();
    await withTaskLifecycleTransaction(ctx, (tx) => {
      tx.saveTaskLifecyclePending(pending({ eventId: "b", at: "2026-01-02T00:00:00Z" }));
      tx.saveTaskLifecyclePending(
        pending({ eventId: "a", at: "2026-01-01T00:00:00Z", taskId: "T-2" }),
      );
      tx.saveTaskLifecyclePending(
        pending({
          eventId: "c",
          at: "2026-01-01T00:00:00Z",
          operation: "reopen",
          to: "active",
          from: "archived",
        }),
      );
      expect(tx.listTaskLifecyclePending().map((p) => p.eventId)).toEqual(["c", "a", "b"]);
      expect(tx.listTaskLifecyclePending("archive").map((p) => p.eventId)).toEqual(["a", "b"]);
      expect(tx.getTaskLifecyclePendingEvent("T-1", "archive", "b")?.eventId).toBe("b");
      expect(tx.getTaskLifecyclePendingEvent("T-1", "archive", "zzz")).toBeUndefined();
      expect(tx.getIncompleteTaskLifecyclePending("T-1", "archive")?.eventId).toBe("b");
      tx.saveTaskLifecyclePending(
        pending({
          eventId: "b",
          at: "2026-01-02T00:00:00Z",
          canonicalComplete: true,
          moveComplete: true,
          patchComplete: true,
          versionComplete: true,
        }),
      );
      expect(tx.getIncompleteTaskLifecyclePending("T-1", "archive")).toBeUndefined();
      tx.deleteTaskLifecyclePending("T-1", "archive", "b");
      tx.deleteTaskLifecyclePending("T-1", "archive", "b"); // idempotent
    });
    // checkpoints are named by the SHA-256 of the event id under the ignored runtime directory
    const files = readdirSync(join(root, ".search", "task-lifecycle", "pending"));
    expect(files.every((f) => /^[0-9a-f]{64}\.json$/.test(f))).toBe(true);
  });

  test("invalid operation, missing event id and missing timestamp are rejected", async () => {
    const { ctx } = setup();
    await withTaskLifecycleTransaction(ctx, (tx) => {
      expect(() => tx.saveTaskLifecyclePending(pending({ operation: "bogus" }))).toThrow(
        'invalid Task lifecycle operation "bogus"',
      );
      expect(() => tx.saveTaskLifecyclePending(pending({ eventId: "" }))).toThrow(
        "pending Task lifecycle requires eventId and timestamp",
      );
      expect(() => tx.getTaskLifecyclePendingEvent("../x", "archive", "e")).toThrow(
        'invalid task ID "../x"',
      );
      expect(() => tx.getTaskLifecyclePendingEvent("T-1", "archive", " ")).toThrow(
        "pending Task lifecycle event ID is required",
      );
    });
  });
});

describe("lifecycle versions", () => {
  test("a lifecycle version is saved only when something changed, and rolled back by event id", async () => {
    const { ctx } = setup();
    const task = makeTask("T-V1");
    await createTaskWithHistory(ctx, task, {});
    await withTaskLifecycleTransaction(ctx, async (tx) => {
      await tx.saveTaskVersion(task, { ...task }, "actor", "2026-02-01T00:00:00Z", "ev-noop");
      expect(await tx.hasTaskLifecycleVersion(task.id, "ev-noop")).toBe(false);

      const done = { ...task, status: "done", completedAt: "2026-02-01T00:00:00Z" };
      await tx.saveTaskVersion(task, done, "actor", "2026-02-01T00:00:00Z", "ev-done");
      expect(await tx.hasTaskLifecycleVersion(task.id, "ev-done")).toBe(true);
      expect((await ctx.versions.getHistory(task.id)).versions).toHaveLength(2);

      await tx.rollbackTaskLifecycleVersion(task.id, "some-other-event"); // not the tail: no-op
      expect((await ctx.versions.getHistory(task.id)).versions).toHaveLength(2);
      await tx.rollbackTaskLifecycleVersion(task.id, "ev-done");
      expect((await ctx.versions.getHistory(task.id)).versions).toHaveLength(1);
      await tx.rollbackTaskLifecycleVersion(task.id, ""); // empty event id: no-op
    });
  });

  test("transactions serialize through the task lifecycle lock", async () => {
    const { ctx } = setup();
    const order: string[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        withTaskLifecycleTransaction(ctx, async () => {
          order.push(`start${n}`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`end${n}`);
        }),
      ),
    );
    expect(order).toEqual(["start1", "end1", "start2", "end2", "start3", "end3"]);
    expect(await err(withTaskLifecycleTransaction(ctx, null as never))).toBeInstanceOf(Error);
  });
});

describe("purge", () => {
  async function withHistory() {
    const s = setup();
    const task = makeTask("T-P1");
    await createTaskWithHistory(s.ctx, task, { snapshot: taskToSnapshot(task) });
    const stream = await s.ctx.versions.historyStore().read("task", "T-P1");
    return { ...s, head: stream.records?.at(-1)?.newHash as string };
  }

  test("a stale expected hash is refused and nothing is removed", async () => {
    const { ctx, root } = await withHistory();
    const e = await err(
      withTaskLifecycleTransaction(ctx, (tx) =>
        tx.purgeTaskVersionHistory("T-P1", "tester", "gdpr", "0".repeat(64)),
      ),
    );
    expect(isHistoryConflict(e)).toBe(true);
    expect(e.message).toBe("history conflict: history purge hash mismatch");
    expect(existsSync(join(root, "history", "tasks", "T-P1.jsonl"))).toBe(true);
  });

  test("an authorized purge leaves a content-free marker and removes the stream", async () => {
    const { ctx, root, head } = await withHistory();
    await withTaskLifecycleTransaction(ctx, (tx) =>
      tx.purgeTaskVersionHistory("T-P1", "tester", "gdpr", head),
    );
    expect(existsSync(join(root, "history", "tasks", "T-P1.jsonl"))).toBe(false);
    const markers = readdirSync(join(root, "history", "purged"));
    expect(markers).toHaveLength(1);
    const marker = JSON.parse(
      readFileSync(join(root, "history", "purged", markers[0] as string), "utf8"),
    );
    expect(marker).toMatchObject({
      entityType: "task",
      entityId: "T-P1",
      actor: "tester",
      reason: "gdpr",
      expectedHash: head,
      phase: "history_removed",
    });
    expect(JSON.stringify(marker)).not.toContain("Task T-P1"); // no entity content
  });

  test("a reason is required", async () => {
    const { ctx } = await withHistory();
    expect(
      (
        await err(
          withTaskLifecycleTransaction(ctx, (tx) =>
            tx.purgeTaskVersionHistory("T-P1", "x", " ", ""),
          ),
        )
      ).message,
    ).toBe("authorized history purge requires a reason");
  });

  test("a legacy-only history is removed only when the file identity matches", async () => {
    const { ctx, root } = setup();
    mkdirSync(join(root, "versions"), { recursive: true });
    const path = join(root, "versions", "task-T-L1.json");
    writeJson(path, { taskId: "T-L1", currentVersion: 0, versions: [] });
    await withTaskLifecycleTransaction(ctx, (tx) =>
      tx.purgeTaskVersionHistory("T-L1", "tester", "cleanup", ""),
    );
    expect(existsSync(path)).toBe(false);

    writeJson(join(root, "versions", "task-T-L2.json"), { taskId: "someone-else", versions: [] });
    await withTaskLifecycleTransaction(ctx, (tx) =>
      tx.purgeTaskVersionHistory("T-L2", "tester", "cleanup", ""),
    );
    expect(existsSync(join(root, "versions", "task-T-L2.json"))).toBe(true);
  });

  test("purgeTaskLifecycle validates the canonical path before delegating", async () => {
    const { root } = setup();
    const calls: string[] = [];
    const reconciler = {
      bootstrapTask: async (a: { relPath: string }) => {
        calls.push(`bootstrap:${a.relPath}`);
        return [{}];
      },
      hardDelete: async (a: { relPath: string; remove?: (id: string) => unknown }) => {
        calls.push(`delete:${a.relPath}`);
        await a.remove?.("T-X");
      },
    };
    mkdirSync(join(root, "tasks"), { recursive: true });
    writeFileSync(join(root, "tasks", "T-X.md"), "---\n---\n");
    const removed: string[] = [];
    await purgeTaskLifecycle(
      reconciler,
      root,
      "T-X",
      "tasks/T-X.md",
      "h",
      "me",
      "why",
      (id) => void removed.push(id),
    );
    expect(calls).toEqual(["bootstrap:tasks/T-X.md", "delete:tasks/T-X.md"]);
    expect(removed).toEqual(["T-X"]);
    // a missing canonical file is a valid retry state: no bootstrap, still the hard delete
    calls.length = 0;
    await purgeTaskLifecycle(reconciler, root, "T-Y", "archive/T-Y.md", "h", "me", "why");
    expect(calls).toEqual(["delete:archive/T-Y.md"]);

    for (const [path, message] of [
      ["../outside/T.md", "task lifecycle purge canonical path is outside project root"],
      ["tasks/T.txt", "task lifecycle purge canonical path is outside project root"],
      ["docs/T.md", "task lifecycle purge canonical path is outside Task roots"],
    ] as const) {
      expect(
        (await err(purgeTaskLifecycle(reconciler, root, "T", path, "h", "me", "why"))).message,
      ).toBe(message);
    }
    expect(
      (await err(purgeTaskLifecycle(reconciler, root, " ", "tasks/T.md", "h", "me", "why")))
        .message,
    ).toBe("task lifecycle purge requires task identity and canonical path");
    const failing = {
      ...reconciler,
      bootstrapTask: async () => [{ diagnostic: "manifest mismatch" }],
    };
    expect(
      (await err(purgeTaskLifecycle(failing, root, "T-X", "tasks/T-X.md", "h", "me", "why")))
        .message,
    ).toBe("manifest mismatch");
  });
});

describe("sync provenance", () => {
  test("arrivals are remembered by content hash and forgotten when the file is gone", () => {
    const { root } = setup();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "a.md"), "one");
    writeFileSync(join(root, "docs", "b.md"), "two");
    recordSyncArrivals(root, [
      { path: "docs\\a.md", author: "Ann", arrivedAt: "2026-03-01T10:00:00.000Z", commit: "abc" },
      { path: "docs/b.md", author: "Bob", arrivedAt: "2026-03-01T10:00:00Z" },
      { path: "docs/missing.md", author: "Cy", arrivedAt: "2026-03-01T10:00:00Z" },
    ]);
    expect(syncArrivalFor(root, "docs/a.md")?.author).toBe("Ann");
    expect(syncArrivalFor(root, "docs/missing.md")).toBeUndefined();
    // a later local write no longer matches what arrived
    writeFileSync(join(root, "docs", "a.md"), "one, edited locally");
    expect(syncArrivalFor(root, "docs/a.md")).toBeUndefined();
    expect(syncArrivalFor(root, "docs/b.md")?.author).toBe("Bob");

    // Go marshals the map sorted by key, each arrival in struct order, indented two spaces
    const raw = readFileSync(syncArrivalsPath(root), "utf8");
    expect(Object.keys(JSON.parse(raw))).toEqual(["docs/a.md", "docs/b.md"]);
    expect(raw).toMatch(
      /^\{\n {2}"docs\/a\.md": \{\n {4}"path": "docs\/a\.md",\n {4}"author": "Ann",\n {4}"commit": "abc",\n {4}"arrivedAt": "2026-03-01T10:00:00Z",\n {4}"contentSha": "[0-9a-f]{64}"\n {2}\}/,
    );
    expect(raw.endsWith("}\n")).toBe(true);
  });

  test("a stale-hash conflict on a file that arrived through sync is explained", async () => {
    const { ctx, root } = setup();
    const doc = makeDoc("team/plan", "v1", { title: "Plan" });
    await mutateDocWithHistory(ctx, null, doc);
    const mine = ctx.docs.get("team/plan");
    // a teammate's change arrives through sync: file on disk, recorded as an arrival
    ctx.docs.writeExact({ ...mine, content: "teammate edit" });
    mkdirSync(join(root, "docs", "team"), { recursive: true });
    writeFileSync(join(root, "docs", "team", "plan.md"), "teammate edit");
    recordSyncArrivals(root, [
      { path: "docs/team/plan.md", author: "Dana", arrivedAt: "2026-03-02T09:30:00Z" },
    ]);

    const e = await err(mutateDocWithHistory(ctx, mine, { ...mine, content: "my edit" }));
    expect(e).toBeInstanceOf(SyncConflictError);
    expect(e).toBeInstanceOf(MutationConflictError);
    expect(isHistoryConflict(e)).toBe(true);
    expect(e.message).toBe(
      'doc "team/plan" was changed by Dana and arrived through store sync at 2026-03-02T09:30:00Z, after the version your write was based on. Nothing was written. Reread the doc and apply your change to the version you just read.',
    );
    expect((e as SyncConflictError).currentHash).toBe(canonicalDocHash(ctx.docs.get("team/plan")));

    // without an arrival record the plain conflict is returned unchanged
    recordSyncArrivals(root, [
      { path: "docs/team/plan.md", author: "", arrivedAt: "2026-03-02T09:30:00Z", contentSha: "x" },
    ]);
    const plain = await err(mutateDocWithHistory(ctx, mine, { ...mine, content: "my edit" }));
    expect(plain).not.toBeInstanceOf(SyncConflictError);
    expect(plain).toBeInstanceOf(MutationConflictError);
    // unrelated errors pass through untouched
    const other = new Error("boom");
    expect(
      await explainConflict(
        { root, taskCanonicalPath: () => undefined, listDocs: () => [] },
        other,
      ),
    ).toBe(other);
  });

  test("a task conflict on a synced task file names the task by id", async () => {
    const { ctx, root } = setup();
    const task = makeTask("T-S1");
    await createTaskWithHistory(ctx, task, {});
    mkdirSync(join(root, "tasks"), { recursive: true });
    writeFileSync(join(root, "tasks", "T-S1.md"), "synced");
    recordSyncArrivals(root, [
      { path: "tasks/T-S1.md", author: "Eve", arrivedAt: "2026-03-03T00:00:00Z" },
    ]);
    const e = await err(
      withTaskLifecycleTransaction(ctx, (tx: TaskLifecycleTransaction) =>
        tx.checkTaskExpectedHash(task, "1".repeat(64)),
      ),
    );
    expect(e).toBeInstanceOf(SyncConflictError);
    expect(e.message).toContain('task "T-S1" was changed by Eve');
  });
});
