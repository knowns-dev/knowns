// Port of internal/storage/version_store_test.go and doc_history_canonical_test.go (the cases that
// do not need the entity stores), and of the retention/cleanup cases of history_migration_test.go.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Doc } from "../../src/models/doc.ts";
import { writeJson } from "../../src/storage/core/util.ts";
import {
  docStateOf,
  encodeDocVersionHistory,
  encodeTaskVersionHistory,
  HistoryStore,
  hashDoc,
  isHistoryConflict,
  isHistoryCorrupt,
  MutationConflictError,
  taskCanonicalHash,
  trackTaskChanges,
  VersionStore,
} from "../../src/storage/history/index.ts";
import { cleanup, makeDoc, makeTask, newProject } from "./helpers.ts";

const dirs: string[] = [];
function setup() {
  const p = newProject();
  dirs.push(p.dir);
  return { ...p, versions: new VersionStore(p.root) };
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

const doc = (path: string, content: string, extra: Partial<Doc> = {}) =>
  makeDoc(path, content, { title: "Guide", ...extra });

describe("metadata pages", () => {
  test("newest first, with root identity and a next offset", async () => {
    const { versions } = setup();
    const history = versions.historyStore();
    let state: Record<string, unknown> = { title: "one" };
    let hash = taskCanonicalHash(state);
    for (let i = 1; i <= 3; i++) {
      const next = i === 1 ? state : { title: String.fromCharCode(97 + i) };
      await history.append({
        schemaVersion: 0,
        entityType: "task",
        entityId: "page-task",
        revision: 0,
        timestamp: "2026-01-01T00:00:00Z",
        checkpoint: i === 1,
        checkpointPayload: i === 1 ? state : undefined,
        baseHash: i === 1 ? "" : hash,
        newHash: i === 1 ? hash : taskCanonicalHash(next),
        taskChanges:
          i === 1 ? undefined : [{ field: "title", oldValue: state.title, newValue: next.title }],
      });
      if (i > 1) {
        state = next;
        hash = taskCanonicalHash(next);
      }
    }
    const page = await versions.listTaskHistoryMetadata("page-task", 0, 2);
    expect(page).toMatchObject({
      entityType: "task",
      entityId: "page-task",
      currentVersion: 3,
      hasMore: true,
      nextOffset: 2,
    });
    expect(page.items?.map((i) => i.id)).toEqual(["v3", "v2"]);
    expect(page.items?.[0]?.newHash).toBeTruthy();
  });

  test("a truncated tail is surfaced without exposing a revision", async () => {
    const { versions, root } = setup();
    await versions.saveVersion("tail", {
      changes: [],
      snapshot: {
        id: "tail",
        title: "t",
        status: "todo",
        priority: "low",
        archived: false,
        timeSpent: 0,
      },
    });
    const path = join(root, "history", "tasks", "tail.jsonl");
    writeFileSync(path, `${readFileSync(path, "utf8")}{"schemaVersion":1`);
    const page = await versions.listTaskHistoryMetadata("tail");
    expect(page.tailTruncated).toBe(true);
    expect(page.items).toHaveLength(1);
    expect((await versions.getHistory("tail")).tailTruncated).toBe(true);
  });
});

describe("task versions", () => {
  test("a lifecycle version uses a delta after the initial checkpoint", async () => {
    const { versions, root } = setup();
    const t = makeTask("T-A1", {
      description: "x".repeat(400),
      labels: ["a", "b"],
      acceptanceCriteria: [{ text: "one", completed: false }],
    });
    const snap = (await import("../../src/storage/history/index.ts")).taskToSnapshot;
    await versions.saveVersion(t.id, { changes: trackTaskChanges(null, t), snapshot: snap(t) });
    const t2 = { ...t, status: "in-progress" };
    await versions.saveVersion(t.id, { changes: trackTaskChanges(t, t2), snapshot: snap(t2) });
    const lines = readFileSync(join(root, "history", "tasks", "T-A1.jsonl"), "utf8")
      .trim()
      .split("\n");
    const second = JSON.parse(lines[1] as string);
    expect(second.checkpoint).toBeUndefined();
    expect(second.checkpointPayload).toBeUndefined();
    expect(second.taskChanges).toEqual([
      { field: "status", oldValue: "todo", newValue: "in-progress" },
    ]);
    const replayed = await versions.getHistory("T-A1");
    expect(replayed.versions?.[1]?.snapshot?.status).toBe("in-progress");
    expect(replayed.versions?.[1]?.changes?.[0]?.field).toBe("status");
  });

  test("trackChanges follows Go's zero-value and pointer semantics", () => {
    const base = makeTask("T-A2", { labels: ["x"], order: 3 });
    const cleared = { ...base, labels: null, order: undefined, assignee: "@me" };
    expect(trackTaskChanges(base, cleared)).toEqual([
      { field: "assignee", oldValue: null, newValue: "@me" },
      { field: "labels", oldValue: ["x"], newValue: null },
      { field: "order", oldValue: 3, newValue: null },
    ]);
    // nil vs empty slice is a change in Go (reflect.DeepEqual), with both sides "zero"
    expect(trackTaskChanges({ ...base, labels: null }, { ...base, labels: [] })).toEqual([
      { field: "labels", oldValue: null, newValue: null },
    ]);
    expect(trackTaskChanges(null, base).map((c) => c.field)).toEqual(["status", "priority"]);
  });

  test("a hard-deleted Task ID is reserved", async () => {
    const { versions, root } = setup();
    mkdirSync(join(root, "tombstones", "tasks"), { recursive: true });
    writeFileSync(join(root, "tombstones", "tasks", "gone.json"), "{}");
    expect(
      (await err(versions.saveVersion("gone", { changes: [], snapshot: { title: "t" } }))).message,
    ).toBe('cannot save version for hard-deleted Task "gone"');
  });

  test("an unknown revision is not found", async () => {
    const { versions } = setup();
    await versions.saveVersion("rev", {
      changes: [],
      snapshot: {
        id: "rev",
        title: "t",
        status: "todo",
        priority: "low",
        archived: false,
        timeSpent: 0,
      },
    });
    expect((await err(versions.getTaskRevisionDetail("rev", "v9"))).message).toBe(
      'revision "v9" not found',
    );
    expect((await versions.getTaskRevisionDetail("rev", "1")).id).toBe("v1");
  });
});

describe("doc revisions", () => {
  test("a create revision is a checkpoint carrying identity and hashes", async () => {
    const { versions } = setup();
    const d = doc("guides/create", "body", {
      id: "doc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      tags: ["t"],
    });
    await versions.saveDocRevision(null, d);
    const h = await versions.getDocHistory("guides/create");
    expect(h.docId).toBe("doc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(h.versions).toHaveLength(1);
    const v = h.versions?.[0];
    expect(v).toMatchObject({
      id: "v1",
      version: 1,
      checkpoint: true,
      schemaVersion: 1,
      currentPath: "guides/create",
    });
    expect(v?.newHash).toBe(hashDoc(docStateOf(d)));
    expect(v?.baseHash).toBeUndefined();
    expect(v?.changes?.map((c) => c.field)).toEqual(["id", "path", "title", "content", "tags"]);
  });

  test("an update that changes nothing records nothing", async () => {
    const { versions } = setup();
    const d = doc("guides/noop", "body", { id: "doc-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    await versions.saveDocRevision(null, d);
    await versions.saveDocRevision(d, { ...d });
    expect((await versions.getDocHistory("guides/noop")).versions).toHaveLength(1);
  });

  test("the whole-content update stores the metadata Go stores", async () => {
    const { versions } = setup();
    const d = doc("guides/whole", "# A\n".repeat(1) + "x".repeat(300), {
      id: "doc-cccccccccccccccccccccccccccccccc",
    });
    await versions.saveDocRevision(null, d);
    const updated = { ...d, title: "Renamed title" };
    await versions.saveDocRevisionWithOptions(d, updated, {
      actor: "me",
      source: "mcp",
      sessionId: "s1",
    });
    const v = (await versions.getDocHistory("guides/whole")).versions?.[1];
    expect(v).toMatchObject({ author: "me", actor: "me", source: "mcp", sessionId: "s1" });
    expect(v?.checkpoint).toBeUndefined();
    expect(v?.baseHash).toBe(hashDoc(docStateOf(d)));
    expect(v?.changes).toEqual([{ field: "title", oldValue: "Guide", newValue: "Renamed title" }]);
    expect(v?.changedScopes?.[0]).toMatchObject({
      type: "field",
      field: "title",
      oldBytes: 7,
      newBytes: 15,
      deltaBytes: 8,
    });
  });

  test("an explicit section does not store the full body", async () => {
    const { versions } = setup();
    const d = doc("guides/section", "## One\nold one\n\n## Two\nsame two", {
      id: "doc-dddddddddddddddddddddddddddddddd",
    });
    await versions.saveDocRevision(null, d);
    const updated = { ...d, content: "## One\nnew one\n\n## Two\nsame two" };
    await versions.saveDocRevisionWithOptions(d, updated, {
      section: "One",
      actor: "cli",
      source: "cli",
      auditEventId: "audit-123",
      sessionId: "session-456",
    });
    const v = (await versions.getDocHistory("guides/section")).versions?.[1];
    expect(v).toMatchObject({
      actor: "cli",
      author: "cli",
      source: "cli",
      auditEventId: "audit-123",
      sessionId: "session-456",
    });
    expect(v?.snapshot && "content" in v.snapshot).toBe(false);
    expect(v?.changes?.find((c) => c.field === "content")).toEqual({
      field: "content",
      oldValue: "## One\nold one",
      newValue: "## One\nnew one",
    });
    expect(v?.changedScopes?.some((s) => s.type === "section" && s.section === "One")).toBe(true);
  });

  test("a single changed section is inferred", async () => {
    const { versions } = setup();
    const d = doc("guides/infer", "## One\nsame one\n\n## Two\nold two", {
      id: "doc-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    });
    await versions.saveDocRevision(null, d);
    await versions.saveDocRevision(d, { ...d, content: "## One\nsame one\n\n## Two\nnew two" });
    const v = (await versions.getDocHistory("guides/infer")).versions?.[1];
    expect(v?.changes?.find((c) => c.field === "content")).toEqual({
      field: "content",
      oldValue: "## Two\nold two",
      newValue: "## Two\nnew two",
    });
    expect(v?.changedScopes?.some((s) => s.section === "Two")).toBe(true);
    // a restored revision rebuilds the full body by replaying the section delta
    expect((await versions.resolveDocState("guides/infer", "v2")).content).toBe(
      "## One\nsame one\n\n## Two\nnew two",
    );
    expect((await versions.getDocRevisionDiff("guides/infer", "v2")).previousRevisionId).toBe("v1");
  });

  test("a rename keeps the stable history under the new path", async () => {
    const { versions } = setup();
    const d = doc("guides/old", "body", { id: "doc-ffffffffffffffffffffffffffffffff" });
    await versions.saveDocRevision(null, d);
    await versions.saveDocRevision(d, { ...d, path: "guides/new" });
    const h = await versions.getDocHistory("guides/new");
    expect(h.docId).toBe("doc-ffffffffffffffffffffffffffffffff");
    expect(h.versions).toHaveLength(2);
    expect(h.versions?.[1]).toMatchObject({
      previousPath: "guides/old",
      currentPath: "guides/new",
    });
    expect((await versions.getDocHistory("guides/old")).docId).toBe(
      "doc-ffffffffffffffffffffffffffffffff",
    );
  });

  test("a stale old doc is rejected before anything is appended", async () => {
    const { versions } = setup();
    const d = doc("guides/stale", "v1", { id: "doc-11111111111111111111111111111111" });
    await versions.saveDocRevision(null, d);
    await versions.saveDocRevision(d, { ...d, content: "v2" });
    const e = await err(versions.saveDocRevision(d, { ...d, content: "v3" }));
    expect(e).toBeInstanceOf(MutationConflictError);
    expect((await versions.getDocHistory("guides/stale")).versions).toHaveLength(2);
  });

  test("a nil old doc cannot append to an existing history", async () => {
    const { versions } = setup();
    const d = doc("guides/nilold", "v1", { id: "doc-22222222222222222222222222222222" });
    await versions.saveDocRevision(null, d);
    const e = await err(versions.saveDocRevision(null, { ...d, content: "v2" }));
    expect(isHistoryConflict(e)).toBe(true);
    expect(e.message).toBe("history conflict: nil old doc cannot append to existing history");
  });

  test("a canonical doc with no history is seeded with a checkpoint, not a delta", async () => {
    const { versions } = setup();
    const d = doc("guides/seed", "v1", { id: "doc-33333333333333333333333333333333" });
    await versions.saveDocRevision(d, { ...d, content: "v2" });
    const h = await versions.getDocHistory("guides/seed");
    expect(h.versions).toHaveLength(1);
    expect(h.versions?.[0]?.checkpoint).toBe(true);
    expect(h.versions?.[0]?.baseHash).toBeUndefined();
    expect(h.versions?.[0]?.newHash).toBe(hashDoc(docStateOf({ ...d, content: "v2" })));
  });

  test("an incomplete checkpoint and a wrong candidate hash are corruption", async () => {
    const { versions } = setup();
    expect(
      isHistoryCorrupt(
        await err(
          versions.saveDocVersion("guides/incomplete", { checkpoint: true, newHash: "hash" }),
        ),
      ),
    ).toBe(true);
    const d = doc("guides/hash-guard", "body", { id: "doc-44444444444444444444444444444444" });
    await versions.saveDocRevision(null, d);
    const before = await versions
      .historyStore()
      .read("doc", "doc-44444444444444444444444444444444");
    const e = await err(
      versions.saveDocVersion("guides/hash-guard", {
        baseHash: hashDoc(docStateOf(d)),
        newHash: "caller-supplied-wrong-hash",
        currentPath: "guides/hash-guard",
        changes: [{ field: "title", oldValue: "Guide", newValue: "After" }],
      }),
    );
    expect(isHistoryCorrupt(e)).toBe(true);
    const after = await versions.historyStore().read("doc", "doc-44444444444444444444444444444444");
    expect(after.records?.length).toBe(before.records?.length);
  });

  test("a clearing delta replays cleared fields", async () => {
    const { versions } = setup();
    const initial = doc("guides/clear", "long content", {
      description: "long description",
      tags: ["one", "two"],
      id: "doc-55555555555555555555555555555555",
    });
    await versions.saveDocRevision(null, initial);
    const cleared = { path: "guides/clear", title: "Guide", id: initial.id };
    await versions.saveDocVersion("guides/clear", {
      baseHash: hashDoc(docStateOf(initial)),
      newHash: hashDoc(docStateOf({ ...cleared })),
      currentPath: "guides/clear",
      changes: [
        { field: "description", oldValue: initial.description, newValue: null },
        { field: "content", oldValue: initial.content, newValue: null },
        { field: "tags", oldValue: initial.tags, newValue: null },
      ],
      changedScopes: [{ type: "whole_doc", field: "content" }],
    });
    const h = await versions.getDocHistory("guides/clear");
    expect(h.versions).toHaveLength(2);
    const v = h.versions?.[1];
    expect(v?.checkpoint).toBeUndefined();
    expect(
      v?.snapshot &&
        ("description" in v.snapshot || "content" in v.snapshot || "tags" in v.snapshot),
    ).toBe(false);
    expect(v?.newHash).toBe(hashDoc(docStateOf(cleared)));
  });

  test("content whitespace does not break the chain: the canonical form is trimmed", async () => {
    const { versions } = setup();
    const d = doc("guides/ws", "\n\n  body  \n\n", { id: "doc-66666666666666666666666666666666" });
    await versions.saveDocRevision(null, d);
    await versions.saveDocRevision(d, { ...d, title: "T2" });
    expect((await versions.getDocHistory("guides/ws")).versions).toHaveLength(2);
    expect(hashDoc(docStateOf(d))).toBe(hashDoc(docStateOf({ ...d, content: "body" })));
  });
});

describe("retention", () => {
  async function longHistory(n: number) {
    const s = setup();
    let d = doc("guides/retention", "start", { id: "doc-77777777777777777777777777777777" });
    await s.versions.saveDocRevision(null, d);
    for (let i = 1; i < n; i++) {
      const next = { ...d, title: `Title ${i}`, content: `${"x".repeat(200)}${i}` };
      await s.versions.saveDocRevision(d, next);
      d = next;
    }
    return { ...s, last: d };
  }

  test("max versions compacts to a checkpoint at the boundary and reports the gap", async () => {
    const { versions, last } = await longHistory(6);
    const h = await versions.applyDocHistoryRetention("guides/retention", { maxVersions: 3 });
    expect(h.versions?.map((v) => v.id)).toEqual(["v4", "v5", "v6"]);
    expect(h.versions?.[0]?.checkpoint).toBe(true);
    expect(h.retentionGaps).toHaveLength(1);
    expect(h.retentionGaps?.[0]).toMatchObject({
      type: "retention-gap",
      reason: "max_versions",
      count: 3,
      beforeVersion: "v3",
      afterVersion: "v4",
    });
    // the retained state is still exactly the current doc
    expect(hashDoc(await versions.resolveDocState("guides/retention", ""))).toBe(
      hashDoc(docStateOf(last)),
    );
    // and the stream stays writable
    await versions.saveDocRevision(last, { ...last, title: "after compaction" });
    expect((await versions.getDocHistory("guides/retention")).versions).toHaveLength(4);
  });

  test("max age removes only old detail", async () => {
    const { versions } = await longHistory(4);
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    const h = await versions.applyDocHistoryRetention("guides/retention", {
      maxAgeMs: 24 * 3600 * 1000,
      now: future,
    });
    expect(h.versions).toHaveLength(1);
    expect(h.retentionGaps?.[0]?.reason).toBe("max_age");
  });

  test("task compaction with the default policy keeps recent detail and reports the gap", async () => {
    const { versions } = setup();
    const snap = {
      id: "ret",
      title: "t",
      status: "todo",
      priority: "low",
      archived: false,
      timeSpent: 0,
    };
    await versions.saveVersion("ret", { changes: [], snapshot: snap });
    for (let i = 1; i <= 5; i++) {
      await versions.saveVersion("ret", {
        changes: [{ field: "title", oldValue: `t${i - 1}`, newValue: `t${i}` }],
        snapshot: { ...snap, title: `t${i}` },
      });
    }
    const h = await versions.applyTaskHistoryRetention("ret", { maxDetailedRevisions: 2 });
    expect(h.versions?.map((v) => v.id)).toEqual(["v5", "v6"]);
    expect(h.versions?.[0]?.checkpoint).toBe(true);
    expect(h.versions?.[1]?.snapshot?.title).toBe("t5");
    const stream = await versions.historyStore().read("task", "ret");
    expect(stream.records?.[0]?.retentionGaps?.[0]).toMatchObject({
      type: "retention-gap",
      count: 4,
      beforeVersion: "v4",
      afterVersion: "v5",
    });
  });

  test("compaction of a corrupt stream is refused and changes no bytes", async () => {
    const { versions, root } = setup();
    const store = versions.historyStore();
    await store.append({
      schemaVersion: 0,
      entityType: "task",
      entityId: "bad",
      revision: 0,
      timestamp: "2026-01-01T00:00:00Z",
      checkpoint: true,
      checkpointPayload: { title: "x" },
      newHash: "not-the-canonical-hash",
    });
    await store.append({
      schemaVersion: 0,
      entityType: "task",
      entityId: "bad",
      revision: 0,
      timestamp: "2026-01-01T00:00:00Z",
      baseHash: "not-the-canonical-hash",
      newHash: "other",
      taskChanges: [{ field: "title", oldValue: null, newValue: "y" }],
    });
    const path = join(root, "history", "tasks", "bad.jsonl");
    const before = readFileSync(path);
    const e = await err(store.compact("task", "bad", { maxDetailedRevisions: 1 }));
    expect(e.message).toContain("cannot compact semantically invalid history");
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test("an injected rename failure leaves the previous head readable", async () => {
    const { root } = setup();
    const store = new HistoryStore(root, {
      rename: () => {
        throw new Error("injected rename");
      },
    });
    const versions = new VersionStore(root, { historyStore: store });
    const snap = {
      id: "swap",
      title: "t",
      status: "todo",
      priority: "low",
      archived: false,
      timeSpent: 0,
    };
    await versions.saveVersion("swap", { changes: [], snapshot: snap });
    for (let i = 1; i <= 3; i++) {
      await versions.saveVersion("swap", {
        changes: [{ field: "title", oldValue: null, newValue: `t${i}` }],
        snapshot: { ...snap, title: `t${i}` },
      });
    }
    const before = readFileSync(join(root, "history", "tasks", "swap.jsonl"));
    const e = await err(versions.applyTaskHistoryRetention("swap", { maxDetailedRevisions: 1 }));
    expect(e.message).toContain("injected rename");
    expect(readFileSync(join(root, "history", "tasks", "swap.jsonl")).equals(before)).toBe(true);
    expect((await versions.getHistory("swap")).versions).toHaveLength(4);
  });
});

describe("legacy files and cleanup", () => {
  function legacyDoc(root: string, path: string, docId: string) {
    const h = {
      docId,
      docPath: path,
      currentPath: path,
      currentVersion: 1,
      versions: [
        {
          id: "v1",
          docId,
          docPath: path,
          currentPath: path,
          version: 1,
          timestamp: "2026-01-01T00:00:00Z",
          changes: [{ field: "title", oldValue: null, newValue: "Old" }],
          changedScopes: [{ type: "field", field: "title", summary: "title" }],
          snapshot: { id: docId, path, title: "Old", content: "legacy body" },
        },
      ],
    };
    mkdirSync(join(root, "versions"), { recursive: true });
    writeJson(join(root, "versions", `docid-${docId}.json`), h);
    return h;
  }

  test("GetDocHistory reads path-keyed legacy history without migrating", async () => {
    const { versions, root } = setup();
    mkdirSync(join(root, "versions"), { recursive: true });
    writeJson(join(root, "versions", "doc-guides--legacy.json"), {
      docPath: "guides/legacy",
      currentVersion: 1,
      versions: [
        {
          id: "v1",
          docPath: "guides/legacy",
          version: 1,
          timestamp: "2026-01-01T00:00:00Z",
          changes: null,
          snapshot: { path: "guides/legacy", title: "L", content: "c" },
        },
      ],
    });
    const h = await versions.getDocHistory("guides/legacy");
    expect(h.docId).toMatch(/^legacy-[0-9a-f]{16}$/);
    expect(h.versions).toHaveLength(1);
    expect(existsSync(join(root, "history", "docs"))).toBe(false);
  });

  test("a revision migrates a legacy stable-id history without loss and cleanup then requires proof", async () => {
    const { versions, root } = setup();
    const docId = "doc-88888888888888888888888888888888";
    legacyDoc(root, "guides/mig", docId);
    const current = doc("guides/mig", "legacy body", { id: docId, title: "Old" });
    await versions.saveDocRevision(current, { ...current, title: "New" });
    const h = await versions.getDocHistory("guides/mig");
    expect(h.versions).toHaveLength(2);
    expect(h.versions?.[0]?.legacyPath).toContain(`docid-${docId}.json`);
    const stream = await versions.historyStore().read("doc", docId);
    expect(stream.records?.[0]).toMatchObject({ legacy: true, legacyRevision: 1, legacyId: "v1" });
    expect(stream.records?.[1]?.legacyRevision).toBe(2);

    const preview = await versions
      .historyStore()
      .previewLegacyCleanup("doc", docId, join(root, "versions", `docid-${docId}.json`));
    const target = preview.targets.find((t) => t.legacyPath.endsWith(`docid-${docId}.json`));
    expect(target?.verified).toBe(true);
    expect(target?.previewToken).toBeTruthy();
    expect((await err(versions.confirmLegacyCleanup(target as never, false))).message).toBe(
      "legacy cleanup requires explicit confirmation",
    );
    // a modified legacy file invalidates the preview
    const legacyFile = join(root, "versions", `docid-${docId}.json`);
    writeFileSync(legacyFile, `${readFileSync(legacyFile, "utf8")} `);
    expect((await err(versions.confirmLegacyCleanup(target as never, true))).message).toBe(
      "legacy cleanup preview is stale or successor is not verified",
    );
    expect(existsSync(legacyFile)).toBe(true);
  });

  test("cleanup removes a verified legacy file only", async () => {
    const { versions, root } = setup();
    const docId = "doc-99999999999999999999999999999999";
    legacyDoc(root, "guides/clean", docId);
    const current = doc("guides/clean", "legacy body", { id: docId, title: "Old" });
    await versions.saveDocRevision(current, { ...current, title: "New" });
    const target = (
      await versions
        .historyStore()
        .previewLegacyCleanup("doc", docId, join(root, "versions", `docid-${docId}.json`))
    ).targets.find((t) => t.verified);
    expect(target).toBeDefined();
    await versions.confirmLegacyCleanup(target as never, true);
    expect(existsSync(join(root, "versions", `docid-${docId}.json`))).toBe(false);
    expect(existsSync(versions.historyStore().entityPath("doc", docId))).toBe(true);
    // a path outside the managed store is never a target
    const outside = await versions
      .historyStore()
      .previewLegacyCleanup("doc", docId, join(root, "elsewhere.json"));
    expect(outside.targets[0]?.verified).toBe(false);
  });

  test("the legacy writer path: a history that only exists as JSON stays JSON until migrated", async () => {
    const { versions, root } = setup();
    mkdirSync(join(root, "versions"), { recursive: true });
    const h = {
      taskId: "old1",
      currentVersion: 1,
      versions: [
        {
          id: "v1",
          taskId: "old1",
          version: 1,
          timestamp: "2026-01-01T00:00:00Z",
          changes: null,
          snapshot: null,
        },
      ],
    };
    writeJson(join(root, "versions", "task-old1.json"), encodeTaskVersionHistory(h as never));
    const history = await versions.getHistory("old1");
    expect(history.versions).toHaveLength(1);
    expect(versions.hasJsonlHistory("task", "old1")).toBe(false);
    void encodeDocVersionHistory;
  });
});
