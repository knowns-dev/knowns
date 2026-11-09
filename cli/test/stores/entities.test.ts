// Behaviour ported from the Go store tests (task, doc, decision, memory, template, time, audit).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../../src/models/task.ts";
import { Store } from "../../src/storage/core/store.ts";
import {
  AuditStore,
  DecisionStore,
  DocStore,
  MemoryStore,
  renderTask,
  TaskStore,
  TemplateStore,
  TimeStore,
  UserPrefsStore,
  WorkspaceStore,
  yamlScalar,
} from "../../src/storage/stores/index.ts";
import { setProcessHome } from "../helpers/process-env.ts";
import { tmp } from "./helpers.ts";

const roots: string[] = [];
const restores: (() => void)[] = [];
afterAll(() => {
  for (const restore of restores.reverse()) restore();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fresh() {
  const root = tmp();
  roots.push(root);
  restores.push(setProcessHome(join(root, "home")));
  const store = Store.open(join(root, "proj", ".knowns"));
  store.init("proj");
  return { root, store, home: join(root, "home", ".knowns") };
}

const now = () => new Date().toISOString();
const mk = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  status: "todo",
  priority: "medium",
  labels: null,
  createdAt: "2026-01-02T03:04:05.000Z",
  updatedAt: "2026-01-02T03:04:05.000Z",
  archived: false,
  timeSpent: 0,
  acceptanceCriteria: null,
  ...over,
});

describe("yamlScalar", () => {
  test("quoting rules of the Go helper", () => {
    expect(yamlScalar("plain")).toBe("plain");
    expect(yamlScalar("")).toBe("''");
    expect(yamlScalar("123")).toBe("'123'");
    expect(yamlScalar("true")).toBe("'true'");
    expect(yamlScalar("a: b")).toBe("'a: b'");
    expect(yamlScalar("it's #1")).toBe("'it''s #1'");
    expect(yamlScalar("[x] y")).toBe('"[x] y"');
    expect(yamlScalar('a "q" [b]\n')).toBe('"a \\"q\\" [b]\\n"');
    expect(yamlScalar("-dash")).toBe("'-dash'");
  });
});

describe("TaskStore", () => {
  test("create, get, update keeps the file, delete", async () => {
    const { store } = fresh();
    const ts = new TaskStore(store);
    await ts.create(mk("abc123", { title: "Hello", description: "d" }));
    expect(existsSync(join(store.root, "tasks", "abc123.md"))).toBe(true);
    await expect(ts.create(mk("abc123"))).rejects.toThrow(/already exists/);
    const t = ts.get("abc123");
    expect(t.title).toBe("Hello");
    expect(t.labels).toBeNull();
    t.title = "Renamed";
    await ts.update(t);
    expect(readdirSync(join(store.root, "tasks"))).toEqual(["abc123.md"]);
    expect(ts.get("abc123").title).toBe("Renamed");
    await ts.delete("abc123");
    expect(() => ts.get("abc123")).toThrow(/not found/);
  });

  test("legacy file names are found; duplicates keep the newest updatedAt", () => {
    const { store } = fresh();
    const ts = new TaskStore(store);
    const dir = join(store.root, "tasks");
    mkdirSync(dir, { recursive: true });
    const old = renderTask(mk("dup", { title: "old", updatedAt: "2026-01-01T00:00:00.000Z" }));
    const newer = renderTask(mk("dup", { title: "new", updatedAt: "2026-02-01T00:00:00.000Z" }));
    writeFileSync(join(dir, "task-dup - Old title.md"), old);
    writeFileSync(join(dir, "dup.md"), newer);
    const list = ts.listActive();
    expect(list.map((t) => t.title)).toEqual(["new"]);
    expect(readdirSync(dir)).toEqual(["dup.md"]);
    writeFileSync(join(dir, "task-legacy.md"), renderTask(mk("legacy")));
    expect(ts.get("legacy").id).toBe("legacy");
  });

  test("archive and unarchive; ListAll links subtasks across them", async () => {
    const { store } = fresh();
    const ts = new TaskStore(store);
    await ts.create(mk("p1"));
    await ts.create(mk("c1", { parent: "p1" }));
    await ts.archive("p1");
    expect(ts.get("p1").archived).toBe(true);
    const all = ts.listAll();
    expect(all.find((t) => t.id === "p1")?.subtasks).toEqual(["c1"]);
    await expect(ts.archive("p1")).rejects.toThrow();
    await ts.unarchive("p1");
    expect(ts.get("p1").archived).toBe(false);
  });

  test("tombstones reserve an ID; saving the same one twice is idempotent", async () => {
    const { store } = fresh();
    const ts = new TaskStore(store);
    const tomb = { id: "gone1", deletedAt: "2026-03-01T00:00:00.000Z", reason: "cleanup" };
    await ts.saveTombstone(tomb);
    await ts.saveTombstone(tomb);
    await expect(ts.saveTombstone({ ...tomb, reason: "other" })).rejects.toThrow(/different audit/);
    expect(ts.isIdReserved("gone1")).toBe(true);
    await expect(ts.create(mk("gone1"))).rejects.toThrow(/tombstone/);
    expect(ts.getTombstone("gone1").reason).toBe("cleanup");
    expect(readFileSync(join(store.root, "tombstones", "tasks", "gone1.json"), "utf8")).toBe(
      '{\n  "id": "gone1",\n  "deletedAt": "2026-03-01T00:00:00Z",\n  "reason": "cleanup"\n}\n',
    );
    expect(() => ts.isIdReserved("../x")).toThrow(/invalid task ID/);
    await expect(ts.saveTombstone({ id: "x", deletedAt: now(), reason: " " })).rejects.toThrow(
      /reason is required/,
    );
  });

  test("createGenerated allocates prefixed IDs and avoids collisions", async () => {
    const { store } = fresh();
    const ts = new TaskStore(store);
    const t = mk("");
    await ts.createGenerated(t, "abc");
    expect(t.id).toMatch(/^ABC-[0-9A-HJKMNP-TV-Z]{6}$/);
    await expect(ts.createGenerated(mk("preset"), "")).rejects.toThrow(/must not already/);
    let calls = 0;
    expect(
      ts.allocateTaskIdUnlocked("", () => {
        calls++;
        return calls < 3 ? t.id : "fresh1";
      }),
    ).toBe("fresh1");
    expect(() => ts.allocateTaskIdUnlocked("", () => t.id)).toThrow(/could not allocate/);
  });

  test("patchLifecycle preserves unknown frontmatter keys and the body", async () => {
    const { store } = fresh();
    const ts = new TaskStore(store);
    await ts.create(mk("pl1", { description: "keep me" }));
    const path = join(store.root, "tasks", "pl1.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("timeSpent: 0", "timeSpent: 0\ncustom: kept"),
    );
    const t = ts.get("pl1");
    t.status = "done";
    t.updatedAt = "2026-05-05T05:05:05.000Z";
    t.completedAt = "2026-05-05T05:05:05.000Z";
    ts.patchLifecycleUnlocked(t);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("custom: kept");
    expect(after).toContain("status: done");
    expect(after).toContain("completedAt: '2026-05-05T05:05:05.000Z'");
    expect(after).toContain("keep me");
    t.completedAt = undefined;
    ts.patchLifecycleUnlocked(t);
    expect(readFileSync(path, "utf8")).not.toContain("completedAt");
  });
});

describe("DocStore", () => {
  test("create backfills an ID, trims content, rejects traversal", () => {
    const { store } = fresh();
    const ds = new DocStore(store);
    ds.create({
      path: "a/b",
      title: "B",
      content: "\n\nbody\n\n",
      createdAt: now(),
      updatedAt: now(),
    });
    const d = ds.get("a/b");
    expect(d.id).toMatch(/^doc-[0-9a-f]{32}$/);
    expect(d.content).toBe("body");
    expect(d.folder).toBe("a");
    expect(() =>
      ds.create({ path: "../escape", title: "x", createdAt: now(), updatedAt: now() }),
    ).toThrow(/invalid doc path/);
    expect(() => ds.get("")).toThrow(/required/);
    expect(() => ds.get("missing")).toThrow(/not found/);
  });

  test("a doc without frontmatter takes its title from the path", () => {
    const { store } = fresh();
    const ds = new DocStore(store);
    writeFileSync(join(store.root, "docs", "plain.md"), "just text\n");
    expect(ds.get("plain")).toMatchObject({ title: "plain", content: "just text", tags: [] });
  });

  test("rename moves the file; imported docs are found by short path", () => {
    const { store } = fresh();
    const ds = new DocStore(store);
    ds.create({ path: "old", title: "T", content: "x", createdAt: now(), updatedAt: now() });
    const d = ds.get("old");
    d.path = "new/place";
    ds.rename("old", d);
    expect(existsSync(join(store.root, "docs", "old.md"))).toBe(false);
    expect(ds.get("new/place").title).toBe("T");
    const imp = join(store.root, "imports", "pkg", "docs", "pkg");
    mkdirSync(imp, { recursive: true });
    writeFileSync(join(imp, "guide.md"), "---\ntitle: G\n---\nhello\n");
    expect(ds.get("guide")).toMatchObject({
      isImported: true,
      importSource: "pkg",
      path: "pkg/guide",
    });
    expect(ds.list().map((x) => x.path)).toContain("pkg/guide");
  });

  test("duplicate stable IDs are ambiguous", () => {
    const { store } = fresh();
    const ds = new DocStore(store);
    writeFileSync(join(store.root, "docs", "x.md"), "---\nid: same\ntitle: X\n---\n");
    writeFileSync(join(store.root, "docs", "y.md"), "---\nid: same\ntitle: Y\n---\n");
    expect(() => ds.list()).toThrow(/ambiguous Doc stable ID/);
    expect(() => ds.validateStableId("same", "z")).toThrow(/ambiguous/);
  });

  test("editing Locked Decisions of an approved doc reopens review", () => {
    const { store } = fresh();
    const ds = new DocStore(store);
    ds.create({
      path: "spec",
      title: "S",
      tags: ["approved", "spec"],
      content: "## Locked Decisions\n\n- D1\n\n## Other\n\nx",
      createdAt: now(),
      updatedAt: now(),
    });
    const d = ds.get("spec");
    d.content = d.content?.replace("- D1", "- D1 changed");
    ds.update(d);
    expect(ds.get("spec").tags).toEqual(["spec", "draft", "review-required"]);
    const e = ds.get("spec");
    e.tags = ["approved"];
    e.content = e.content?.replace("x", "y");
    ds.update(e);
    expect(ds.get("spec").tags).toContain("approved");
  });

  test("rewriteDocReferences updates docs, task specs and memories", async () => {
    const { store, home } = fresh();
    const ds = new DocStore(store);
    const ts = new TaskStore(store);
    const ms = new MemoryStore(store, home);
    ds.create({
      path: "other",
      title: "O",
      content: "see @doc/old",
      createdAt: now(),
      updatedAt: now(),
    });
    await ts.create(mk("t1", { spec: "old", description: "see @doc/old" }));
    await ms.create({
      id: "m1",
      title: "M",
      layer: "project",
      content: "@doc/old",
      createdAt: "",
      updatedAt: "",
    });
    const rewrite = (c: string, o: string, n: string) => c.replaceAll(`@doc/${o}`, `@doc/${n}`);
    await ds.rewriteDocReferences("old", "new", rewrite, ts, ms);
    expect(ds.get("other").content).toBe("see @doc/new");
    expect(ts.get("t1")).toMatchObject({ spec: "new", description: "see @doc/new" });
    expect(ms.get("m1").content).toBe("@doc/new");
  });
});

describe("DecisionStore", () => {
  const draft = (title: string) => ({
    id: "",
    title,
    status: "",
    createdAt: "",
    updatedAt: "",
    context: "c",
    decision: "d",
  });

  test("ids are date-slug with numeric suffixes on collision; body renders the four sections", async () => {
    const { store } = fresh();
    const ds = new DecisionStore(store);
    const a = draft("Same title");
    const b = draft("Same title");
    const at = new Date("2026-04-05T06:07:00");
    await ds.create(a, { now: at });
    await ds.create(b, { now: at });
    expect(a.id).toBe("20260405-0607-same-title");
    expect(b.id).toBe("20260405-0607-same-title-2");
    const raw = readFileSync(join(store.root, "decisions", `${a.id}.md`), "utf8");
    expect(raw).toContain(
      "## Context\n\nc\n\n## Decision\n\nd\n\n## Alternatives Considered\n\n\n## Consequences\n",
    );
    await expect(ds.create(draft(" "))).rejects.toThrow(/title is required/);
    expect(ds.list().map((x) => x.id)).toEqual([a.id, b.id]);
  });

  test("accept, supersede, cycle and idempotence", async () => {
    const { store } = fresh();
    const ds = new DecisionStore(store);
    const a = draft("Old one");
    const b = draft("New one");
    await ds.create(a);
    await ds.create(b);
    await expect(ds.accept(a.id, [])).rejects.toThrow(/verification evidence/);
    await ds.accept(a.id, ["e1"]);
    const { accepted, replaced } = await ds.accept(b.id, ["e2"], [a.id]);
    expect(accepted.supersedes).toEqual([a.id]);
    expect(replaced[0]?.status).toBe("superseded");
    expect(ds.get(a.id).supersededBy).toEqual([b.id]);
    const again = await ds.supersede(a.id, b.id);
    expect(again.old.status).toBe("superseded");
    await expect(ds.supersede(b.id, b.id)).rejects.toThrow(/cannot supersede itself/);
  });

  test("a failed write in a decision set restores the earlier writes", async () => {
    const { store } = fresh();
    const ds = new DecisionStore(store);
    const a = draft("First");
    const b = draft("Second");
    await ds.create(a);
    await ds.create(b);
    await ds.accept(a.id, ["e"]);
    await ds.accept(b.id, ["e"]);
    const before = readFileSync(join(store.root, "decisions", `${a.id}.md`), "utf8");
    let n = 0;
    ds.writeFile = (path, data) => {
      if (++n === 2) throw new Error("disk full");
      writeFileSync(path, data);
    };
    await expect(ds.supersede(a.id, b.id)).rejects.toThrow(/disk full/);
    ds.writeFile = undefined;
    expect(readFileSync(join(store.root, "decisions", `${a.id}.md`), "utf8")).toBe(before);
  });

  test("candidates can be rejected, idempotently", async () => {
    const { store } = fresh();
    const ds = new DecisionStore(store);
    const a = draft("Cand");
    await ds.create(a);
    expect((await ds.rejectCandidate(a.id)).status).toBe("rejected");
    expect((await ds.rejectCandidate(a.id)).status).toBe("rejected");
  });

  test("rollback of a migration draft deletes it", async () => {
    const { store } = fresh();
    const ds = new DecisionStore(store);
    const a = { ...draft("Migrated"), tags: ["legacy-memory-migration"], sources: ["memory:m1"] };
    await ds.create(a);
    await ds.rollbackLegacyMemoryMigration(a.id, "memory:m1", true, [], [], []);
    expect(() => ds.get(a.id)).toThrow(/not found/);
  });
});

describe("MemoryStore", () => {
  // biome-ignore lint/suspicious/noExplicitAny: minimal entries
  const entry = (over: Record<string, unknown>): any => ({
    id: "",
    title: "M",
    layer: "project",
    createdAt: "",
    updatedAt: "",
    ...over,
  });

  test("legacy decision memories are read-only; ids and layers are validated", async () => {
    const { store, home } = fresh();
    const ms = new MemoryStore(store, home);
    await expect(ms.create(entry({ category: "decision" }))).rejects.toThrow(/legacy/);
    await expect(ms.create(entry({ layer: "working" }))).rejects.toThrow(/invalid memory layer/);
    await expect(ms.create(entry({ id: "../x" }))).rejects.toThrow(/invalid memory ID/);
    mkdirSync(join(store.root, "memory"), { recursive: true });
    writeFileSync(
      join(store.root, "memory", "memory-old.md"),
      "---\nid: old\ntitle: Old\nlayer: project\ncategory: decision\nstatus: active\ncreatedAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n---\nx\n",
    );
    await expect(ms.delete("old")).rejects.toThrow(/legacy/);
    const m = ms.get("old");
    m.content = "changed";
    await expect(ms.update(m)).rejects.toThrow(/legacy/);
    m.status = "archived";
    await ms.update(m);
    expect(ms.get("old").status).toBe("archived");
  });

  test("lifecycle metadata missing is derived; promote/demote move the file", async () => {
    const { store, home } = fresh();
    const ms = new MemoryStore(store, home);
    mkdirSync(join(store.root, "memory"), { recursive: true });
    writeFileSync(
      join(store.root, "memory", "memory-leg.md"),
      "---\nid: leg\ntitle: Legacy\nlayer: project\ncreatedAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n---\nbody\n",
    );
    const m = ms.get("leg");
    expect(m.status).toBe("active");
    expect(m.lifecycleMetadataMissing).toEqual([
      "status",
      "confidence",
      "lastVerified",
      "ttlDays",
      "sources",
    ]);
    const up = await ms.promote("leg");
    expect(up.layer).toBe("global");
    expect(existsSync(join(store.root, "memory", "memory-leg.md"))).toBe(false);
    expect(existsSync(join(home, "memory", "memory-leg.md"))).toBe(true);
    await expect(ms.promote("leg")).rejects.toThrow(/top layer/);
    await ms.demote("leg");
    expect(ms.countByLayer("project")).toBe(1);
    expect(ms.countByLayer("global")).toBe(0);
  });

  test("a title slug resolves a reference; ambiguity is an error", async () => {
    const { store, home } = fresh();
    const ms = new MemoryStore(store, home);
    await ms.create(entry({ title: "Security Pattern" }));
    expect(ms.resolveReferenceTarget("security-pattern").title).toBe("Security Pattern");
    await ms.create(entry({ title: "Security  Pattern" }));
    expect(() => ms.resolveReferenceTarget("security-pattern")).toThrow(/ambiguous/);
    expect(() => ms.resolveReferenceTarget("nope")).toThrow(/not found/);
  });
});

describe("TemplateStore", () => {
  test("create scaffolds, get/list parse, traversal is rejected", () => {
    const { store } = fresh();
    const ts = new TemplateStore(store);
    ts.create("gen", "Generates things");
    expect(() => ts.create("gen", "again")).toThrow(/already exists/);
    expect(() => ts.create("../evil", "x")).toThrow(/invalid template name/);
    expect(() => ts.get("../../etc")).toThrow(/invalid import template name/);
    expect(() => ts.get("..")).toThrow(/invalid template name/);
    const t = ts.get("gen");
    expect(t).toMatchObject({ name: "gen", version: "1.0.0", destination: "src" });
    expect(t.prompts?.[0]).toMatchObject({ name: "name", type: "text", validate: "required" });
    expect(t.actions?.[0]).toMatchObject({ type: "add", skipIfExists: true });
    expect(t.messages?.success).toBe("Created: {{name}}\n");
    expect(ts.list().map((x) => x.name)).toEqual(["gen"]);
    expect(readFileSync(join(store.root, "templates", "gen", "main.hbs"), "utf8")).toBe(
      "// Generated: {{name}}\n// Created by Knowns template: gen\n",
    );
  });
});

describe("TimeStore", () => {
  test("start rejects duplicates, unknown tasks and hard-deleted tasks; stop records an entry", async () => {
    const { store } = fresh();
    const tasks = new TaskStore(store);
    const time = new TimeStore(store);
    await tasks.create(mk("tt1"));
    await time.start("tt1", "Task");
    await expect(time.start("tt1", "Task")).rejects.toThrow(/already running/);
    await expect(time.start("nope", "x")).rejects.toThrow(/start timer/);
    await expect(time.pause("nope")).rejects.toThrow(/no active timer/);
    await time.pause("tt1");
    await expect(time.pause("tt1")).rejects.toThrow(/already paused/);
    await time.resume("tt1");
    await expect(time.resume("tt1")).rejects.toThrow(/not paused/);
    const entry = await time.stop("tt1");
    expect(entry.id).toMatch(/^te-\d+-tt1$/);
    expect(time.getState().active).toEqual([]);
    expect(time.getActiveTimer("tt1")).toBeUndefined();
    await tasks.saveTombstone({ id: "dead", deletedAt: now(), reason: "r" });
    await expect(time.start("dead", "x")).rejects.toThrow(/hard-deleted/);
  });
});

describe("AuditStore", () => {
  test("append writes compact Go-ordered JSON lines; recent, stats, rotation", () => {
    const root = tmp();
    roots.push(root);
    const audit = new AuditStore(root);
    const ev = (i: number, over: object = {}) => ({
      timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
      toolName: "tasks",
      action: "get",
      actionClass: "read",
      result: "success",
      durationMs: 5,
      ...over,
    });
    audit.append(ev(1, { argumentSummary: { b: "2", a: "<1>" } }));
    audit.append(ev(2, { result: "error", errorMessage: "boom", dryRun: true }));
    const lines = readFileSync(join(root, "audit.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines[0]).toBe(
      '{"timestamp":"2026-11-01T00:00:01Z","toolName":"tasks","action":"get","actionClass":"read","result":"success","durationMs":5,"argumentSummary":{"a":"\\u003c1\\u003e","b":"2"}}',
    );
    expect(audit.recent(1).map((e) => e.result)).toEqual(["error"]);
    const stats = audit.stats();
    expect(stats).toMatchObject({ totalCalls: 2, dryRunCount: 1, executeCount: 1 });
    expect(stats.byTool).toEqual({ "tasks.get": 2 });
    expect(audit.stats({ result: "error" }).totalCalls).toBe(1);

    writeFileSync(join(root, "audit.jsonl"), "x".repeat(5 * 1024 * 1024));
    audit.append(ev(3));
    expect(existsSync(join(root, "audit.jsonl.1"))).toBe(true);
    expect(readFileSync(join(root, "audit.jsonl"), "utf8").split("\n").length).toBe(2);
  });

  test("analytics buckets by day in the requested zone", () => {
    const root = tmp();
    roots.push(root);
    const audit = new AuditStore(root);
    const today = new Date();
    audit.append({
      timestamp: today.toISOString(),
      toolName: "docs",
      actionClass: "read",
      result: "success",
      durationMs: 10,
    });
    const a = audit.analytics({ days: 7, timezone: "UTC" });
    expect(a.dailyBuckets?.length).toBe(7);
    expect(a.totalCalls).toBe(1);
    expect(a.dailyBuckets?.at(-1)).toMatchObject({
      totalCalls: 1,
      topTool: "docs",
      topToolCalls: 1,
    });
    expect(() => audit.analytics({ days: 5, timezone: "UTC" })).toThrow(/7, 30, or 90/);
    expect(() => audit.analytics({ days: 7, timezone: "Nope/Zone" })).toThrow(/timezone/);
  });
});

describe("WorkspaceStore and UserPrefsStore", () => {
  test("workspace CRUD and crash recovery", () => {
    const { store } = fresh();
    const ws = new WorkspaceStore(store);
    const w = (id: string, status: string) => ({
      id,
      name: id,
      useWorktree: false,
      status,
      phases: [],
      currentPhaseIndex: 0,
      createdAt: now(),
    });
    expect(ws.list()).toEqual([]);
    ws.save(w("a", "running"));
    ws.save(w("b", "idle"));
    ws.save({ ...w("a", "running"), name: "A2" });
    expect(ws.list().map((x) => x.name)).toEqual(["A2", "b"]);
    ws.markAllStopped();
    expect(ws.get("a").status).toBe("stopped");
    ws.delete("b");
    expect(() => ws.delete("b")).toThrow(/not found/);
    expect(() => ws.save(w("", "idle"))).toThrow(/ID is required/);
  });

  test("user prefs round trip as {}", () => {
    const root = tmp();
    roots.push(root);
    const path = join(root, "x", "preferences.json");
    const prefs = new UserPrefsStore(path);
    expect(prefs.load()).toEqual({});
    prefs.save({});
    expect(readFileSync(path, "utf8")).toBe("{}");
    writeFileSync(path, "not json");
    expect(() => prefs.load()).toThrow(/parse user prefs/);
  });
});
