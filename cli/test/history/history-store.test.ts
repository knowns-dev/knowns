// Port of internal/storage/history_jsonl_test.go and history_metadata_hash_test.go.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryRecord } from "../../src/models/version.ts";
import {
  applyTaskChangesToMap,
  cloneJson,
  decodeRecord,
  docHistoryFromRecords,
  HistoryConflictError,
  HistoryCorruptError,
  HistoryStore,
  hashSnapshot,
  historyRecordHash,
  isHistoryConflict,
  isHistoryCorrupt,
  taskCanonicalHash,
  taskHistoryFromRecords,
  VersionStore,
} from "../../src/storage/history/index.ts";
import { cleanup, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const newRoot = () => {
  const d = tempDir();
  dirs.push(d);
  return join(d, ".knowns");
};
afterAll(() => cleanup(...dirs));

const rec = (
  r: Partial<HistoryRecord> & { entityType: string; entityId: string },
): HistoryRecord => ({
  schemaVersion: 0,
  revision: 0,
  timestamp: "2026-01-01T00:00:00Z",
  ...r,
});

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("HistoryStore", () => {
  test("delta/checkpoint replay and metadata page", async () => {
    const history = new HistoryStore(newRoot());
    const first = { title: "first", status: "todo" };
    await history.append(
      rec({
        entityType: "task",
        entityId: "abc123",
        checkpoint: true,
        checkpointPayload: first,
        newHash: taskCanonicalHash(first),
      }),
    );
    await history.append(
      rec({
        entityType: "task",
        entityId: "abc123",
        baseHash: taskCanonicalHash(first),
        newHash: taskCanonicalHash({ title: "first", status: "done" }),
        taskChanges: [{ field: "status", oldValue: "todo", newValue: "done" }],
      }),
    );
    const result = await history.read("task", "abc123");
    expect(result.records).toHaveLength(2);
    expect(result.records?.[0]?.checkpoint).toBe(true);
    expect(result.records?.[1]?.checkpointPayload).toBeUndefined();
    const replayed = taskHistoryFromRecords("abc123", result.records ?? []);
    expect(replayed.versions?.[1]?.snapshot?.status).toBe("done");
    const page = await history.listMetadata("task", "abc123", 0, 1);
    expect(page.records).toHaveLength(1);
    expect(page.more).toBe(true);
    expect(page.records[0]?.checkpointPayload).toBeUndefined();
    expect(page.records[0]?.taskChanges).toBeUndefined();
  });

  test("replay preserves zero-value deltas", async () => {
    const root = newRoot();
    const history = new HistoryStore(root);
    const initial = {
      title: "Task",
      status: "todo",
      priority: "medium",
      archived: true,
      timeSpent: 42,
      description: "optional",
    };
    const initialHash = taskCanonicalHash(initial);
    await history.append(
      rec({
        entityType: "task",
        entityId: "zero-values",
        checkpoint: true,
        checkpointPayload: initial,
        newHash: initialHash,
      }),
    );
    const changes = [
      { field: "archived", oldValue: true, newValue: null },
      { field: "timeSpent", oldValue: 42, newValue: null },
      { field: "description", oldValue: "optional", newValue: null },
    ];
    const expected = applyTaskChangesToMap(cloneJson(initial), changes);
    await history.append(
      rec({
        entityType: "task",
        entityId: "zero-values",
        baseHash: initialHash,
        newHash: taskCanonicalHash(expected),
        taskChanges: changes,
      }),
    );
    const replayed = await new VersionStore(root).getHistory("zero-values");
    expect(replayed.versions).toHaveLength(2);
    const snap = replayed.versions?.[1]?.snapshot ?? {};
    expect(snap.archived).toBe(false);
    expect(snap.timeSpent).toBe(0);
    expect("description" in snap).toBe(false);
    expect(replayed.versions?.[1]?.newHash).toBe(taskCanonicalHash(snap));
  });

  test("tail recovery and fail-closed corruption", async () => {
    const history = new HistoryStore(newRoot());
    await history.append(
      rec({
        entityType: "doc",
        entityId: "doc1",
        checkpoint: true,
        checkpointPayload: { path: "guide" },
        newHash: "h1",
      }),
    );
    const path = history.entityPath("doc", "doc1");
    appendFileSync(path, '{"entityType":"doc"');
    const result = await history.read("doc", "doc1");
    expect(result.records).toHaveLength(1);
    expect(result.tailTruncated).toBe(true);
    await history.append(
      rec({
        entityType: "doc",
        entityId: "doc1",
        baseHash: "h1",
        newHash: "h2",
        docChanges: [{ field: "title", oldValue: null, newValue: "Guide" }],
      }),
    );
    expect((await history.read("doc", "doc1")).tailTruncated).toBeUndefined();
    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    lines[0] = "not-json";
    writeFileSync(path, lines.join("\n"));
    expect(isHistoryCorrupt(await caught(history.read("doc", "doc1")))).toBe(true);
  });

  test("injected append, fsync and directory-sync failures leave durable history unchanged", async () => {
    const payload = { title: "x" };
    const cases: [string, Partial<ConstructorParameters<typeof HistoryStore>[1]>, string][] = [
      [
        "fail",
        {
          append: () => {
            throw new Error("injected append");
          },
        },
        "injected append",
      ],
      [
        "sync",
        {
          sync: () => {
            throw new Error("injected fsync");
          },
        },
        "injected fsync",
      ],
      [
        "dir",
        {
          syncDirectory: () => {
            throw new Error("injected directory sync");
          },
        },
        "injected directory sync",
      ],
    ];
    for (const [id, opts, message] of cases) {
      const history = new HistoryStore(newRoot(), opts);
      const err = await caught(
        history.append(
          rec({
            entityType: "task",
            entityId: id,
            checkpoint: true,
            newHash: "hash",
            checkpointPayload: payload,
          }),
        ),
      );
      expect((err as Error).message).toContain(message);
      const read = await history.read("task", id);
      expect(read.records).toHaveLength(0);
    }
  });

  test("rejects invalid semantic envelopes", async () => {
    const history = new HistoryStore(newRoot());
    const invalid: HistoryRecord[] = [
      rec({ entityType: "task", entityId: "invalid", newHash: "hash" }),
      rec({
        entityType: "task",
        entityId: "empty-hash",
        checkpoint: true,
        checkpointPayload: { title: "x" },
      }),
      rec({
        entityType: "task",
        entityId: "first-delta",
        taskChanges: [{ field: "title", oldValue: null, newValue: "x" }],
        newHash: "hash",
      }),
    ];
    for (const r of invalid) expect(isHistoryCorrupt(await caught(history.append(r)))).toBe(true);
    await history.append(
      rec({
        entityType: "task",
        entityId: "missing-base",
        checkpoint: true,
        checkpointPayload: { title: "x" },
        newHash: "h1",
      }),
    );
    const err = await caught(
      history.append(
        rec({
          entityType: "task",
          entityId: "missing-base",
          taskChanges: [{ field: "title", oldValue: null, newValue: "y" }],
          newHash: "h2",
        }),
      ),
    );
    expect(isHistoryConflict(err)).toBe(true);
    expect((err as Error).message).toBe("history conflict: stale history head");

    await history.append(
      rec({
        entityType: "task",
        entityId: "chain",
        checkpoint: true,
        checkpointPayload: { title: "x" },
        newHash: "h1",
      }),
    );
    const path = history.entityPath("task", "chain");
    const record = decodeRecord(JSON.parse(readFileSync(path, "utf8").trim()));
    record.entityId = "other";
    record.recordHash = historyRecordHash(record);
    const { marshalRecordLine } = await import("../../src/storage/history/index.ts");
    writeFileSync(path, `${marshalRecordLine(record)}\n`);
    expect(isHistoryCorrupt(await caught(history.read("task", "chain")))).toBe(true);
    expect(isHistoryCorrupt(await caught(history.listMetadata("task", "chain", 0, 10)))).toBe(true);
  });

  test("two appends on the same base: exactly one wins, the other conflicts", async () => {
    const history = new HistoryStore(newRoot());
    const base = taskCanonicalHash({ title: "base" });
    await history.append(
      rec({
        entityType: "task",
        entityId: "conflict",
        checkpoint: true,
        newHash: base,
        checkpointPayload: { title: "base" },
      }),
    );
    const outcomes = await Promise.allSettled(
      ["x", "y"].map((t) =>
        history.append(
          rec({
            entityType: "task",
            entityId: "conflict",
            baseHash: base,
            newHash: taskCanonicalHash({ title: t }),
            taskChanges: [{ field: "title", oldValue: null, newValue: t }],
          }),
        ),
      ),
    );
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(HistoryConflictError);
    const result = await history.read("task", "conflict");
    expect(result.records).toHaveLength(2);
    // semantic tamper of the replayed hash fails closed
    const tampered = result.records?.map((r) => ({ ...r })) ?? [];
    (tampered[1] as HistoryRecord).newHash = "tampered";
    (tampered[1] as HistoryRecord).recordHash = historyRecordHash(tampered[1] as HistoryRecord);
    expect(() => taskHistoryFromRecords("conflict", tampered)).toThrow(HistoryCorruptError);
  });

  test("a section that cannot be replayed is corruption", async () => {
    const history = new HistoryStore(newRoot());
    const payload = { path: "bad-section", content: "# One\nold" };
    await history.append(
      rec({
        entityType: "doc",
        entityId: "bad-section",
        checkpoint: true,
        checkpointPayload: payload,
        newHash: hashSnapshot(payload),
      }),
    );
    const result = await history.read("doc", "bad-section");
    const records = [
      ...(result.records ?? []),
      rec({
        entityType: "doc",
        entityId: "bad-section",
        schemaVersion: 1,
        revision: 2,
        baseHash: result.records?.[0]?.newHash,
        newHash: result.records?.[0]?.newHash,
        changedScopes: [{ type: "section", field: "content", section: "Missing" }],
        docChanges: [{ field: "content", oldValue: null, newValue: "# Missing\nnew" }],
      }),
    ];
    expect(() => docHistoryFromRecords("bad-section", records)).toThrow(HistoryCorruptError);
    expect(await caught(history.read("../escape", "id"))).toBeInstanceOf(Error);
  });

  test("a read window ignores an unterminated valid-JSON tail and stops at the nearest checkpoint", async () => {
    const history = new HistoryStore(newRoot());
    const p1 = { title: "a" };
    await history.append(
      rec({
        entityType: "task",
        entityId: "w",
        checkpoint: true,
        checkpointPayload: p1,
        newHash: taskCanonicalHash(p1),
      }),
    );
    await history.append(
      rec({
        entityType: "task",
        entityId: "w",
        baseHash: taskCanonicalHash(p1),
        newHash: taskCanonicalHash({ title: "b" }),
        taskChanges: [{ field: "title", oldValue: "a", newValue: "b" }],
      }),
    );
    const p3 = { title: "c" };
    await history.append(
      rec({
        entityType: "task",
        entityId: "w",
        baseHash: taskCanonicalHash({ title: "b" }),
        newHash: taskCanonicalHash(p3),
        checkpoint: true,
        checkpointPayload: p3,
      }),
    );
    const full = readFileSync(history.entityPath("task", "w"), "utf8").split("\n")[0] as string;
    appendFileSync(history.entityPath("task", "w"), full);
    expect((await history.readRecordWindow("task", "w", 3)).map((r) => r.revision)).toEqual([3]);
    expect((await history.readRecordWindow("task", "w", 2)).map((r) => r.revision)).toEqual([1, 2]);
    expect(await caught(history.readRecordWindow("task", "w", 4))).toBeInstanceOf(Error);
    expect((await history.listMetadata("task", "w")).tailTruncated).toBe(true);
  });

  test("a revision gap fails closed", async () => {
    const history = new HistoryStore(newRoot());
    const p = { title: "a" };
    await history.append(
      rec({
        entityType: "task",
        entityId: "gap",
        checkpoint: true,
        checkpointPayload: p,
        newHash: taskCanonicalHash(p),
      }),
    );
    await history.append(
      rec({
        entityType: "task",
        entityId: "gap",
        baseHash: taskCanonicalHash(p),
        newHash: taskCanonicalHash({ title: "b" }),
        taskChanges: [{ field: "title", oldValue: "a", newValue: "b" }],
      }),
    );
    const path = history.entityPath("task", "gap");
    const [l1, l2] = readFileSync(path, "utf8").split("\n");
    const second = decodeRecord(JSON.parse(l2 as string));
    second.revision = 3;
    second.recordHash = historyRecordHash(second);
    const { marshalRecordLine } = await import("../../src/storage/history/index.ts");
    writeFileSync(path, `${l1}\n${marshalRecordLine(second)}\n`);
    expect(isHistoryCorrupt(await caught(history.read("task", "gap")))).toBe(true);
  });

  test("metadata hash matches the writer for nested change values, and still detects tampering", async () => {
    const root = newRoot();
    const versions = new VersionStore(root);
    const snap1 = {
      id: "n1",
      title: "t",
      status: "todo",
      priority: "medium",
      archived: false,
      timeSpent: 0,
      acceptanceCriteria: [{ completed: false, text: "a" }],
    };
    await versions.saveVersion("n1", {
      changes: [{ field: "status", oldValue: null, newValue: "todo" }],
      snapshot: snap1,
    });
    const snap2 = { ...snap1, acceptanceCriteria: [{ completed: true, text: "a" }] };
    await versions.saveVersion("n1", {
      changes: [
        {
          field: "acceptanceCriteria",
          oldValue: [{ text: "a", completed: false }],
          newValue: [{ text: "a", completed: true }],
        },
      ],
      snapshot: snap2,
    });
    const page = await versions.listTaskHistoryMetadata("n1");
    expect(page.items).toHaveLength(2);
    // The file keeps struct field order for the nested value ...
    const line = readFileSync(join(root, "history", "tasks", "n1.jsonl"), "utf8").split(
      "\n",
    )[1] as string;
    expect(line).toContain('"newValue":[{"text":"a","completed":true}]');
    // ... while the record hash covers the sorted form, so it still verifies.
    const path = join(root, "history", "tasks", "n1.jsonl");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace('"completed":true', '"completed":false'),
    );
    expect(isHistoryCorrupt(await caught(versions.listTaskHistoryMetadata("n1")))).toBe(true);
  });
});
