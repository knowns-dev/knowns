// End to end: the wired storage (stores + history ports) edits a copy of the Go-written `full`
// fixture, and the real Go 0.34.1 binary sees the new revisions and validates the result.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Doc } from "../../src/models/doc.ts";
import type { MemoryEntry } from "../../src/models/memory.ts";
import { createStorage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/store.ts";
import {
  canonicalMemoryHash,
  createTaskWithHistory,
  goNow,
  mutateDocWithHistory,
  taskToSnapshot,
  withTaskLifecycleTransaction,
} from "../../src/storage/history/index.ts";
import { renderMemory } from "../../src/storage/stores/index.ts";
import { fixtureId, fixtureRoot } from "../helpers/fixtures.ts";
import { hasGoHelper, runHelper } from "../helpers/go-helper.ts";
import { cleanup, copyFixture, hasGo, runGo } from "../history/helpers.ts";

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

function project() {
  const p = copyFixture("full");
  dirs.push(p.dir.replace(/\/project$/, ""));
  const storage = createStorage(Store.open(p.root), { globalRoot: join(p.home, ".knowns") });
  return { ...p, storage };
}

function goJson(p: { dir: string; home: string }, args: string[]) {
  const r = runGo(p.dir, p.home, [...args, "--json"]);
  expect(r.code, `${args.join(" ")}: ${r.stderr}${r.stdout}`).toBe(0);
  return JSON.parse(r.stdout);
}

const suite = hasGo() ? describe : describe.skip;

suite("stores plus history transactions, accepted by Go", () => {
  test("task edit, task create, doc edit and doc create are visible to Go and validate clean", async () => {
    const p = project();
    const { storage } = p;
    const { ctx } = storage;
    const taskId = fixtureId("full", "task.rich");

    const beforeCount = goJson(p, ["task", "history", taskId, "--metadata"]).items.length;

    // --- task edit under the lifecycle lock: write the file, then the history revision
    await withTaskLifecycleTransaction(ctx, async (tx) => {
      const before = await tx.getTask(taskId);
      expect(before.canonicalHash).toBeTruthy();
      tx.checkTaskExpectedHash(before, before.canonicalHash as string);
      const after = {
        ...before,
        title: `${before.title} (edited through wired stores)`,
        implementationNotes: "written by the TypeScript stores",
        updatedAt: goNow(),
      };
      await tx.updateTask(after);
      await ctx.versions.saveVersionUnlocked(taskId, {
        timestamp: goNow(),
        author: "ts-wired",
        changes: tx.trackTaskChanges(before, after),
        snapshot: taskToSnapshot(after),
      });
    });

    // --- task create
    const created = {
      id: "",
      title: "Created through wired stores",
      status: "todo",
      priority: "medium",
      labels: ["wiring"],
      createdAt: goNow(),
      updatedAt: goNow(),
      archived: false,
      acceptanceCriteria: null,
      timeSpent: 0,
    };
    await createTaskWithHistory(ctx, created, { author: "ts-wired" });
    expect(created.id).not.toBe("");

    // --- doc edit and create
    const docPath = "architecture";
    const oldDoc = storage.docs.get(docPath);
    const newDoc: Doc = {
      ...oldDoc,
      content: `${oldDoc.content}\n\nAppended by the wired stores.`,
      updatedAt: goNow(),
    };
    await mutateDocWithHistory(ctx, oldDoc, newDoc, {
      expectedHash: oldDoc.canonicalHash,
      actor: "ts-wired",
      source: "test",
    });
    const fresh: Doc = {
      path: "guides/wired-doc",
      title: "Wired doc",
      content: "Created through the wired stores.",
      createdAt: goNow(),
      updatedAt: goNow(),
    };
    await mutateDocWithHistory(ctx, null, fresh, { actor: "ts-wired", source: "test" });

    // The store reads back what history recorded.
    const taskAfter = storage.tasks.get(taskId);
    const { records } = await storage.history.read("task", taskId);
    expect(records?.at(-1)?.newHash).toBe(taskAfter.canonicalHash as string);
    const docAfter = storage.docs.get(docPath);
    const docRecords = (await storage.history.read("doc", docAfter.id as string)).records;
    expect(docRecords?.at(-1)?.newHash).toBe(docAfter.canonicalHash as string);

    // --- Go sees the revisions
    const taskHistory = goJson(p, ["task", "history", taskId, "--metadata"]);
    expect(taskHistory.items.length).toBe(beforeCount + 1);
    const taskView = runGo(p.dir, p.home, ["task", "history", taskId, "--plain"]);
    expect(taskView.stdout).toContain("AUTHOR: ts-wired");

    const createdHistory = goJson(p, ["task", "history", created.id, "--metadata"]);
    expect(createdHistory.items.length).toBe(1);

    const docHistory = goJson(p, ["doc", "history", docPath, "--metadata"]);
    expect(docHistory.items[0].recordHash).toBe(docRecords?.at(-1)?.recordHash);
    const freshHistory = goJson(p, ["doc", "history", "guides/wired-doc", "--metadata"]);
    expect(freshHistory.items.length).toBe(1);

    const task = goJson(p, ["task", "view", taskId]);
    expect(JSON.stringify(task)).toContain("written by the TypeScript stores");

    // --- and validates with zero errors
    const validate = goJson(p, ["validate"]);
    const errors = validate.issues.filter((i: { level: string }) => i.level === "error");
    expect(errors).toEqual([]);
  });

  test("Go extends a chain the wired stores wrote, and the stores read it back", async () => {
    const p = project();
    const { storage } = p;
    const taskId = fixtureId("full", "task.rich");
    await withTaskLifecycleTransaction(storage.ctx, async (tx) => {
      const before = await tx.getTask(taskId);
      const after = { ...before, implementationNotes: "ts first", updatedAt: goNow() };
      await tx.updateTask(after);
      await storage.ctx.versions.saveVersionUnlocked(taskId, {
        timestamp: goNow(),
        author: "ts-wired",
        changes: tx.trackTaskChanges(before, after),
        snapshot: taskToSnapshot(after),
      });
    });
    const edit = runGo(p.dir, p.home, ["task", "edit", taskId, "--append-notes", "go second"]);
    expect(edit.code, edit.stderr + edit.stdout).toBe(0);
    const task = storage.tasks.get(taskId);
    const { records } = await storage.history.read("task", taskId);
    expect(records?.at(-1)?.newHash).toBe(task.canonicalHash as string);
    expect(task.implementationNotes).toContain("go second");
  });
});

describe("adapters over the real stores", () => {
  test("TaskStore archiveUnlocked / unarchiveUnlocked move the file between tasks/ and archive/", () => {
    const p = project();
    const id = fixtureId("full", "task.plain");
    expect(p.storage.tasks.get(id).archived).toBe(false);
    p.storage.tasks.archiveUnlocked(id);
    expect(p.storage.tasks.get(id).archived).toBe(true);
    p.storage.ctx.tasks.unarchiveUnlocked(id);
    expect(p.storage.tasks.get(id).archived).toBe(false);
    expect(() => p.storage.tasks.unarchiveUnlocked(id)).toThrow();
  });

  test("time port writeEntriesFile rewrites the entries file", async () => {
    const p = project();
    const time = p.storage.ctx.time;
    const entries = await time?.getAllEntries();
    expect(Object.keys(entries ?? {}).length).toBeGreaterThan(1);
    const drop = Object.keys(entries ?? {})[0] as string;
    const next = { ...entries };
    delete next[drop];
    await time?.writeEntriesFile(next);
    expect(
      Object.hasOwn(JSON.parse(readFileSync(p.storage.time.entriesPath(), "utf8")), drop),
    ).toBe(false);
    expect(Object.keys((await time?.getAllEntries()) ?? {})).toEqual(Object.keys(next));
  });

  test("memory port: getInLayer, writeExisting in place, canonicalHash, withLocks", async () => {
    const p = project();
    const memory = p.storage.ctx.memory;
    expect(memory).toBeDefined();
    const list = (await memory?.list("project")) ?? [];
    expect(list.length).toBeGreaterThanOrEqual(2);
    const current = (await memory?.getInLayer("rrvcia", "project")) as MemoryEntry;
    const hash = memory?.canonicalHash(current);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const next = { ...current, content: "Rewritten in place." };
    await memory?.withLocks([current.id], async () => {
      await memory.writeExisting(next, current, false);
    });
    const reread = (await memory?.getInLayer("rrvcia", "project")) as MemoryEntry;
    expect(reread.content).toBe("Rewritten in place.");
    expect(reread.updatedAt).toBe(current.updatedAt);
    expect(memory?.canonicalHash(reread)).not.toBe(hash);
  });

  test("rewriteDocPath defaults to the reference extractor and stays injectable", () => {
    const p = project();
    expect(p.storage.ctx.rewriteDocPath("see @doc/a#h{related}", "a", "b")).toBe(
      "see @doc/b#h{related}",
    );
    const wired = createStorage(Store.open(p.root), { rewriteDocPath: (c) => c });
    expect(wired.ctx.rewriteDocPath("x", "a", "b")).toBe("x");
  });
});

const goHelper = hasGoHelper() ? describe : describe.skip;

goHelper("canonicalMemoryHash equals Go's CanonicalMemoryHash", () => {
  const same = (root: string, home: string) => {
    const storage = createStorage(Store.open(root));
    const entries = storage.memory.list("project");
    for (const e of entries) {
      const [go] = runHelper(["memhash", root, e.layer, e.id], home);
      expect(canonicalMemoryHash(e), e.id).toBe(go as string);
    }
    return entries;
  };

  test("every project memory in the full fixture", () => {
    const home = mkdtempSync(join(tmpdir(), "knowns-memhash-"));
    dirs.push(home);
    const entries = same(join(fixtureRoot("full"), ".knowns"), home);
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  test("memories with metadata, ttl, sources, lastVerified and merge fields", () => {
    const p = project();
    const entry: MemoryEntry = {
      id: "richmem",
      title: "Rich <memory> & more",
      layer: "project",
      category: "pattern",
      content: "Body with <tags> & ampersands.",
      status: "active",
      confidence: "high",
      lastVerified: "2026-11-02T10:00:00.5Z",
      ttlDays: 30,
      sources: ["@doc/architecture", "task-1"],
      mergedInto: "rrvcia",
      rejectedReason: "n/a",
      tags: ["a", "b"],
      metadata: { zeta: "1", alpha: "2" },
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-02T00:00:00Z",
    };
    writeFileSync(join(p.root, "memory", "memory-richmem.md"), renderMemory(entry));
    same(p.root, p.home);
  });
});
