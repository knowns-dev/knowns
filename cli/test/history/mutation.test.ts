// Port of internal/storage/mutation_transaction_test.go and the conflict cases of
// history_identity_test.go / version_store_test.go, against in-memory entity stores.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  asMutationConflict,
  canonicalDocHash,
  canonicalTaskHash,
  createTaskWithHistory,
  DocIdentityConflictError,
  deleteDocWithExpectedHash,
  HistoryStore,
  isHistoryConflict,
  MutationConflictError,
  mutateDocWithHistory,
  restoreDoc,
  restoreDocSection,
  taskToSnapshot,
} from "../../src/storage/history/index.ts";
import { cleanup, makeContext, makeDoc, makeTask, newProject } from "./helpers.ts";

const dirs: string[] = [];
function setup(historyOptions?: Parameters<typeof makeContext>[1]) {
  const p = newProject();
  dirs.push(p.dir);
  return { ...p, ctx: makeContext(p.root, historyOptions) };
}
afterAll(() => cleanup(...dirs));

const failingAppend = {
  append: () => {
    throw new Error("injected history append");
  },
};

async function err(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

describe("create", () => {
  test("a failed history append removes the newly created Task", async () => {
    const { ctx } = setup(failingAppend);
    const task = makeTask("atomic-task");
    const e = await err(createTaskWithHistory(ctx, task, { snapshot: taskToSnapshot(task) }));
    expect(e.message).toContain("injected history append");
    expect(() => ctx.tasks.get("atomic-task")).toThrow();
  });

  test("an empty ID is allocated from the project prefix and the history starts with a checkpoint", async () => {
    const { ctx } = setup();
    const task = makeTask("");
    await createTaskWithHistory(ctx, task, {}, "ab");
    expect(task.id).toMatch(/^AB-/);
    const history = await ctx.versions.getHistory(task.id);
    expect(history.versions).toHaveLength(1);
    expect(history.versions?.[0]?.checkpoint).toBe(true);
    expect(history.versions?.[0]?.changes?.map((c) => c.field)).toEqual(["status", "priority"]);
    await expect(createTaskWithHistory(ctx, makeTask(""), {}, "1")).rejects.toThrow(
      "task ID prefix must be 2-8 alphanumeric characters and start with a letter",
    );
  });

  test("a failed doc create removes the document; a failed update restores it", async () => {
    const failing = setup(failingAppend);
    const created = makeDoc("guides/atomic", "old", { title: "Atomic" });
    await err(mutateDocWithHistory(failing.ctx, null, created));
    expect(() => failing.ctx.docs.get("guides/atomic")).toThrow();

    const { ctx, root } = setup();
    const old = makeDoc("guides/atomic", "old", { title: "Atomic" });
    await mutateDocWithHistory(ctx, null, old);
    expect(old.id).toMatch(/^doc-[0-9a-f]{32}$/);
    // swap in a failing history for the update
    const failingCtx = makeContext(root, failingAppend);
    failingCtx.docs.create({ ...ctx.docs.get("guides/atomic") });
    const candidate = { ...old, content: "new" };
    await err(mutateDocWithHistory(failingCtx, old, candidate));
    expect(failingCtx.docs.get("guides/atomic").content).toBe("old");
  });
});

describe("optimistic concurrency", () => {
  async function created() {
    const s = setup();
    const doc = makeDoc("conflicts/doc", "# A\none\n\n# B\ntwo", { title: "Doc" });
    await mutateDocWithHistory(s.ctx, null, doc);
    return { ...s, doc };
  }

  test("an expected-hash mismatch is a MutationConflictError carrying only identity and hashes", async () => {
    const { ctx, doc } = await created();
    const stale = { ...doc, content: "secret changed content" };
    const e = await err(mutateDocWithHistory(ctx, doc, stale, { expectedHash: "0".repeat(64) }));
    expect(e).toBeInstanceOf(MutationConflictError);
    expect(isHistoryConflict(e)).toBe(true);
    const conflict = asMutationConflict(e) as MutationConflictError;
    expect(conflict.entityType).toBe("doc");
    expect(conflict.entityId).toBe(doc.id as string);
    expect(conflict.expectedHash).toBe("0".repeat(64));
    expect(conflict.currentHash).toBe(canonicalDocHash(ctx.docs.get("conflicts/doc")));
    expect(e.message).not.toContain("secret changed content");
    expect(e.message).toBe(
      `doc "${doc.id}" mutation conflict: expected hash "${"0".repeat(64)}", current hash "${conflict.currentHash}"`,
    );
    // nothing was written
    expect(ctx.docs.get("conflicts/doc").content).toBe(doc.content);
    expect((await ctx.versions.getDocHistory("conflicts/doc")).versions).toHaveLength(1);
  });

  test("an old doc that no longer matches the canonical file conflicts", async () => {
    const { ctx, doc } = await created();
    const concurrent = { ...ctx.docs.get("conflicts/doc"), content: "someone else" };
    await mutateDocWithHistory(ctx, ctx.docs.get("conflicts/doc"), concurrent);
    const e = await err(mutateDocWithHistory(ctx, doc, { ...doc, content: "mine" }));
    expect(e).toBeInstanceOf(MutationConflictError);
  });

  test("two concurrent writers on the same base: exactly one succeeds", async () => {
    const { ctx, doc } = await created();
    const results = await Promise.allSettled(
      ["x", "y"].map((c) => mutateDocWithHistory(ctx, { ...doc }, { ...doc, content: c })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(MutationConflictError);
    expect((await ctx.versions.getDocHistory("conflicts/doc")).versions).toHaveLength(2);
  });

  test("a stable doc ID cannot be reassigned", async () => {
    const { ctx, doc } = await created();
    const e = await err(
      mutateDocWithHistory(ctx, doc, {
        ...doc,
        id: "doc-ffffffffffffffffffffffffffffffff",
        content: "x",
      }),
    );
    expect(e).toBeInstanceOf(DocIdentityConflictError);
    expect(isHistoryConflict(e)).toBe(true);
    expect(e.message).toBe(
      `doc "${doc.id}" stable identity cannot be changed to "doc-ffffffffffffffffffffffffffffffff"`,
    );
  });

  test("a document that vanished is a history conflict", async () => {
    const { ctx, doc } = await created();
    ctx.docs.delete("conflicts/doc");
    const e = await err(mutateDocWithHistory(ctx, doc, { ...doc, content: "x" }));
    expect(isHistoryConflict(e)).toBe(true);
    expect(e.message).toBe("history conflict: document changed or was deleted");
  });

  test("creating over an existing path fails", async () => {
    const { ctx } = await created();
    await expect(mutateDocWithHistory(ctx, null, makeDoc("conflicts/doc", "x"))).rejects.toThrow(
      'document "conflicts/doc" already exists',
    );
  });

  test("delete requires the observed hash at the storage boundary", async () => {
    const { ctx } = await created();
    expect((await err(deleteDocWithExpectedHash(ctx, "conflicts/doc", {}))).message).toBe(
      "document delete: expected canonical hash is required",
    );
    const e = await err(
      deleteDocWithExpectedHash(ctx, "conflicts/doc", { expectedHash: "1".repeat(64) }),
    );
    expect(e).toBeInstanceOf(MutationConflictError);
    expect(ctx.docs.docs.has("conflicts/doc")).toBe(true);
  });

  test("a history head that disagrees with the file also conflicts on delete", async () => {
    const { ctx } = await created();
    // an out-of-band file edit: canonical hash no longer equals the durable head
    ctx.docs.writeExact({ ...ctx.docs.get("conflicts/doc"), content: "edited outside" });
    const hash = canonicalDocHash(ctx.docs.get("conflicts/doc"));
    const e = await err(deleteDocWithExpectedHash(ctx, "conflicts/doc", { expectedHash: hash }));
    expect(e).toBeInstanceOf(MutationConflictError);
    expect((asMutationConflict(e) as MutationConflictError).currentHash).toBe(hash);
  });

  test("a task expected-hash check", async () => {
    const { ctx } = setup();
    const { TaskLifecycleTransaction } = await import("../../src/storage/history/index.ts");
    const tx = new TaskLifecycleTransaction(ctx);
    const task = makeTask("t1");
    expect(() => tx.checkTaskExpectedHash(task, " ")).toThrow(
      'task "t1" expected canonical hash is required',
    );
    const e = (() => {
      try {
        tx.checkTaskExpectedHash(task, "abc");
      } catch (x) {
        return x as MutationConflictError;
      }
    })();
    expect(e).toBeInstanceOf(MutationConflictError);
    expect(e?.currentHash).toBe(canonicalTaskHash(task));
    expect(() => tx.checkTaskExpectedHash(task, canonicalTaskHash(task))).not.toThrow();
  });
});

describe("delete", () => {
  test("appends a tombstone and rolls back when the append fails", async () => {
    const { ctx } = setup();
    const doc = makeDoc("delete-me", "body", { title: "Delete" });
    await mutateDocWithHistory(ctx, null, doc);
    const current = ctx.docs.get("delete-me");
    const hash = canonicalDocHash(current);
    await deleteDocWithExpectedHash(ctx, "delete-me", {
      expectedHash: hash,
      actor: "test",
      source: "test",
    });
    expect(() => ctx.docs.get("delete-me")).toThrow();
    const stream = await ctx.versions.historyStore().read("doc", current.id as string);
    expect(stream.records).toHaveLength(2);
    const head = stream.records?.[1];
    expect(head?.operation).toBe("delete");
    expect(head?.tombstone).toBe(true);
    expect(head?.baseHash).toBe(hash);
    expect(head?.newHash).toBe(hash);
    expect(head?.actor).toBe("test");
    // the in-flight marker is gone once the tombstone is durable
    expect(
      await Bun.file(join(ctx.root, "history", "state", "doc-delete-transactions")).exists(),
    ).toBe(false);

    const failing = setup();
    const doc2 = makeDoc("rollback", "body", { title: "Rollback" });
    await mutateDocWithHistory(failing.ctx, null, doc2);
    const current2 = failing.ctx.docs.get("rollback");
    const failingCtx = makeContext(failing.root, failingAppend);
    failingCtx.docs.create(current2);
    const e = await err(
      deleteDocWithExpectedHash(failingCtx, "rollback", {
        expectedHash: canonicalDocHash(current2),
      }),
    );
    expect(e.message).toContain("injected history append");
    expect(canonicalDocHash(failingCtx.docs.get("rollback"))).toBe(canonicalDocHash(current2));
  });

  test("a doc that is already tombstoned is refused", async () => {
    const { ctx } = setup();
    const doc = makeDoc("twice", "body");
    await mutateDocWithHistory(ctx, null, doc);
    const current = ctx.docs.get("twice");
    await deleteDocWithExpectedHash(ctx, "twice", { expectedHash: canonicalDocHash(current) });
    ctx.docs.create(current); // the file came back
    const e = await err(
      deleteDocWithExpectedHash(ctx, "twice", { expectedHash: canonicalDocHash(current) }),
    );
    expect(e.message).toBe(
      "document delete: document is already tombstoned; restore reconciliation is required",
    );
  });
});

describe("rename with references", () => {
  async function renameSetup() {
    const s = setup();
    const target = makeDoc("old/path", "target body", { title: "Target" });
    const other = makeDoc("refs/other", "see @doc/old/path for details", { title: "Other" });
    await mutateDocWithHistory(s.ctx, null, target);
    await mutateDocWithHistory(s.ctx, null, other);
    const task = makeTask("T-1", { description: "implements @doc/old/path", spec: "old/path" });
    await createTaskWithHistory(s.ctx, task, {});
    s.ctx.memory.entries.set("m1\0project", {
      id: "m1",
      layer: "project",
      content: "remember @doc/old/path",
    } as never);
    return { ...s, target: s.ctx.docs.get("old/path") };
  }

  test("rewrites references in docs, tasks and memory with per-entity history", async () => {
    const { ctx, target } = await renameSetup();
    await mutateDocWithHistory(ctx, target, { ...target, path: "new/path" }, { actor: "tester" });
    expect(ctx.docs.docs.has("old/path")).toBe(false);
    expect(ctx.docs.get("new/path").title).toBe("Target");
    expect(ctx.docs.get("refs/other").content).toBe("see @doc/new/path for details");
    const task = ctx.tasks.get("T-1");
    expect(task.description).toBe("implements @doc/new/path");
    expect(task.spec).toBe("new/path");
    expect(ctx.memory.getInLayer("m1", "project").content).toBe("remember @doc/new/path");

    const renamed = await ctx.versions.getDocHistory("new/path");
    expect(renamed.versions?.map((v) => v.version)).toEqual([1, 2]);
    expect(renamed.versions?.[1]?.previousPath).toBe("old/path");
    const other = await ctx.versions.getDocHistory("refs/other");
    expect(other.versions).toHaveLength(2);
    const taskHistory = await ctx.versions.getHistory("T-1");
    expect(taskHistory.versions).toHaveLength(2);
    expect(taskHistory.versions?.[1]?.lifecycleEventId).toMatch(/^doc-rename-\d+-T-1$/);
    expect(taskHistory.versions?.[1]?.author).toBe("tester");
  });

  test("a task edited between preflight and the locks rejects the rename and writes nothing", async () => {
    const { ctx, target } = await renameSetup();
    ctx.renameReferencePreflight = () => {
      ctx.tasks.updateUnlocked({ ...ctx.tasks.get("T-1"), title: "edited concurrently" });
    };
    const e = await err(mutateDocWithHistory(ctx, target, { ...target, path: "new/path" }));
    expect(e).toBeInstanceOf(MutationConflictError);
    expect((asMutationConflict(e) as MutationConflictError).entityType).toBe("task");
    expect(ctx.docs.docs.has("old/path")).toBe(true);
    expect(ctx.docs.docs.has("new/path")).toBe(false);
    expect(ctx.docs.get("refs/other").content).toBe("see @doc/old/path for details");
  });

  test("a referencing doc edited concurrently rejects the rename", async () => {
    const { ctx, target } = await renameSetup();
    ctx.renameReferencePreflight = () => {
      ctx.docs.writeExact({ ...ctx.docs.get("refs/other"), description: "changed" });
    };
    const e = await err(mutateDocWithHistory(ctx, target, { ...target, path: "new/path" }));
    expect(e).toBeInstanceOf(MutationConflictError);
    expect(ctx.docs.docs.has("old/path")).toBe(true);
  });

  test("a failure while appending reference history rolls everything back", async () => {
    const { ctx, root, target } = await renameSetup();
    // fail the second doc history append (the first rewritten doc succeeds)
    let calls = 0;
    const flaky = makeContext(root, {
      append: (fd, data) => {
        calls++;
        if (calls >= 1) throw new Error("injected history append");
        return require("node:fs").writeSync(fd, data);
      },
    });
    for (const d of ctx.docs.list()) flaky.docs.create(d);
    for (const t of ctx.tasks.listAll()) flaky.tasks.createUnlocked(t);
    for (const m of ctx.memory.list()) flaky.memory.writeExisting(m);
    const e = await err(mutateDocWithHistory(flaky, target, { ...target, path: "new/path" }));
    expect(e.message).toContain("injected history append");
    expect(flaky.docs.docs.has("old/path")).toBe(true);
    expect(flaky.docs.docs.has("new/path")).toBe(false);
    expect(flaky.docs.get("refs/other").content).toBe("see @doc/old/path for details");
  });
});

describe("restore", () => {
  test("restoring a section changes only that section and records a normal revision", async () => {
    const { ctx } = setup();
    const doc = makeDoc("restore/sections", "# One\nalpha\n\n# Two\nbeta", { title: "R" });
    await mutateDocWithHistory(ctx, null, doc);
    const v1 = ctx.docs.get("restore/sections");
    await mutateDocWithHistory(
      ctx,
      v1,
      { ...v1, content: "# One\nALPHA\n\n# Two\nbeta" },
      { section: "One" },
    );
    const v2 = ctx.docs.get("restore/sections");
    await mutateDocWithHistory(
      ctx,
      v2,
      { ...v2, content: "# One\nALPHA\n\n# Two\nBETA" },
      { section: "Two" },
    );
    const restored = await restoreDocSection(ctx, "restore/sections", "v1", "One");
    expect(restored.content).toBe("# One\nalpha\n\n# Two\nBETA");
    const history = await ctx.versions.getDocHistory("restore/sections");
    expect(history.versions).toHaveLength(4);
    expect(history.versions?.[3]?.source).toBe("restore");
    expect(history.versions?.[3]?.changedScopes?.[0]?.section).toBe("One");
  });

  test("restoring a revision restores content and metadata but keeps the path", async () => {
    const { ctx } = setup();
    const doc = makeDoc("restore/whole", "first", {
      title: "First",
      description: "d1",
      tags: ["a"],
    });
    await mutateDocWithHistory(ctx, null, doc);
    const v1 = ctx.docs.get("restore/whole");
    await mutateDocWithHistory(ctx, v1, {
      ...v1,
      title: "Second",
      content: "second",
      tags: ["b"],
      description: "d2",
    });
    const restored = await restoreDoc(ctx, "restore/whole", "v1");
    expect(restored).toMatchObject({
      title: "First",
      content: "first",
      description: "d1",
      tags: ["a"],
      path: "restore/whole",
    });
    expect(ctx.docs.get("restore/whole").title).toBe("First");
    expect((await ctx.versions.getDocHistory("restore/whole")).versions).toHaveLength(3);
  });
});

test("HistoryStore is the one history backend a context exposes", () => {
  const { ctx } = setup();
  expect(ctx.versions.historyStore()).toBeInstanceOf(HistoryStore);
});
