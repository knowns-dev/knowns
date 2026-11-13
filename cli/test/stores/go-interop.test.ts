// AC-2: entities written by the TS stores are read by the Go 0.34.1 binary and pass `validate`.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../../src/models/task.ts";
import { Store } from "../../src/storage/core/store.ts";
import {
  DecisionStore,
  DocStore,
  MemoryStore,
  TaskStore,
  TemplateStore,
  TimeStore,
  WorkspaceStore,
} from "../../src/storage/stores/index.ts";
import { goJson, hasGo, runGo, sandbox } from "./helpers.ts";

const go = hasGo();
const sb = sandbox();
afterAll(() => rmSync(sb.root, { recursive: true, force: true }));

const DERIVED = ["canonicalHash", "timeEntries", "activeTimer", "subtasks"];
const view = (v: unknown): Record<string, unknown> => {
  const o = JSON.parse(
    JSON.stringify(v, (_k, x) =>
      (Array.isArray(x) && x.length === 0) || x === "" ? undefined : x,
    ),
  ) as Record<string, unknown>;
  for (const k of DERIVED) delete o[k];
  return o;
};

const now = () => new Date().toISOString();
const base = (over: Partial<Task>): Task => ({
  id: "",
  title: "t",
  status: "todo",
  priority: "medium",
  labels: null,
  createdAt: now(),
  updatedAt: now(),
  archived: false,
  timeSpent: 0,
  acceptanceCriteria: null,
  ...over,
});

describe.skipIf(!go)("TS stores -> Go 0.34.1", () => {
  const store = Store.open(join(sb.project, ".knowns"));
  store.init("Interop Project");
  const ids: Record<string, string> = {};

  test("tasks: every shape the renderer emits is read back identically by Go", async () => {
    const tasks = new TaskStore(store);
    const specs: Record<string, Task> = {
      plain: base({ title: "Plain task" }),
      rich: base({
        title: 'Fix: unicode 日本語 [x] it\'s "q" & colon',
        description: "Line one\n\nLine two with `code`",
        status: "in-progress",
        priority: "high",
        assignee: "@me",
        labels: ["a", "b-c"],
        spec: "specs/x",
        fulfills: ["AC-1", "AC-2"],
        order: 3,
        acceptanceCriteria: [
          { text: "first", completed: true },
          { text: "second", completed: false },
        ],
        implementationPlan: "1. a\n2. b",
        implementationNotes: "notes\n\nmore",
        completedAt: now(),
        timeSpent: 90,
      }),
      numericAssignee: base({ title: "123", assignee: "42" }),
      colon: base({ title: "a: b #c", assignee: "- dash" }),
    };
    for (const [k, t] of Object.entries(specs)) {
      await tasks.createGenerated(t, "INT");
      ids[k] = t.id;
    }
    const child = base({ title: "Child", parent: ids.rich as string });
    await tasks.createGenerated(child, "INT");
    ids.child = child.id;
    const archived = base({ title: "To archive" });
    await tasks.createGenerated(archived, "INT");
    ids.archived = archived.id;
    await tasks.archive(archived.id);

    for (const k of Object.keys(ids)) {
      const id = ids[k] as string;
      const fromGo = goJson<Record<string, unknown>>(["task", "view", id], sb.project, sb.home);
      for (const d of DERIVED) delete fromGo[d];
      expect(view(tasks.get(id)), k).toEqual(fromGo);
    }
  });

  test("docs", () => {
    const docs = new DocStore(store);
    docs.create({
      path: "guides/deep/setup",
      title: "Setup: the [guide]",
      description: "How to: set up",
      content: "# Setup\n\nBody text.\n\n\n",
      tags: ["guide", "setup"],
      order: 2,
      createdAt: now(),
      updatedAt: now(),
    });
    docs.create({
      path: "root-doc",
      title: "Root",
      content: "",
      createdAt: now(),
      updatedAt: now(),
    });
    for (const p of ["guides/deep/setup", "root-doc"]) {
      const fromGo = goJson<Record<string, unknown>>(["doc", "view", p], sb.project, sb.home);
      expect(view(docs.get(p)), p).toEqual(view(fromGo));
    }
  });

  test("decisions", async () => {
    const decisions = new DecisionStore(store);
    const draft = {
      id: "",
      title: "Use Bun: always",
      status: "",
      tags: ["runtime"],
      sources: ["doc:guides/deep/setup"],
      context: "Because",
      decision: "Do it",
      consequences: "Fast",
      reviewState: "needs_evidence",
      reviewMatches: [{ id: "20260101-0000-x", title: "X", score: 0.5, matchedBy: ["title"] }],
      createdAt: "",
      updatedAt: "",
    };
    await decisions.create(draft);
    const second = {
      ...draft,
      title: "Second decision",
      reviewState: "",
      reviewMatches: undefined,
      id: "",
    };
    await decisions.create(second);
    await decisions.accept(second.id, ["source:doc:guides/deep/setup"]);
    for (const d of [draft, second]) {
      const fromGo = goJson<Record<string, unknown>>(
        ["decision", "get", d.id],
        sb.project,
        sb.home,
      );
      expect(view(decisions.get(d.id)), d.id).toEqual(view(fromGo));
    }
    const listed = goJson<{ id: string }[]>(["decision", "list"], sb.project, sb.home);
    // The default list shows current guidance only (the accepted decision).
    expect(listed.map((d) => d.id)).toContain(second.id);
  });

  test("memories (project and global)", async () => {
    const memories = new MemoryStore(store, join(sb.home, ".knowns"));
    const mk = (over: Record<string, unknown>) => ({
      id: "",
      title: "Memory",
      layer: "project",
      createdAt: "",
      updatedAt: "",
      ...over,
    });
    const a = mk({
      title: "Prefer hyphens",
      category: "preference",
      content: "Use hyphens.\n\n**Why:** readability.",
      tags: ["style"],
      metadata: { zeta: "1", alpha: "two: words" },
      sources: ["doc:x"],
      confidence: "high",
      ttlDays: 30,
    });
    const g = mk({ title: "Global note", layer: "global", category: "convention", content: "x" });
    // biome-ignore lint/suspicious/noExplicitAny: shape-only test fixtures
    await memories.create(a as any);
    // biome-ignore lint/suspicious/noExplicitAny: shape-only test fixtures
    await memories.create(g as any);
    for (const m of [a, g]) {
      const fromGo = goJson<Record<string, unknown>>(
        ["memory", "view", m.id as string],
        sb.project,
        sb.home,
      );
      expect(view(memories.get(m.id as string)), m.id as string).toEqual(view(fromGo));
    }
    const moved = await memories.promote(a.id);
    expect(moved.layer).toBe("global");
    expect(goJson<{ layer: string }>(["memory", "view", a.id], sb.project, sb.home).layer).toBe(
      "global",
    );
  });

  test("templates", () => {
    const templates = new TemplateStore(store);
    templates.create("widget", "A widget thing");
    const fromGo = goJson<Record<string, unknown>>(
      ["template", "view", "widget"],
      sb.project,
      sb.home,
    );
    const mine = view(templates.get("widget"));
    delete fromGo.path;
    delete mine.path;
    expect(mine).toEqual(view(fromGo));
  });

  test("time: timers written by TS are seen by Go", async () => {
    const time = new TimeStore(store);
    await time.start(ids.plain as string, "Plain task");
    const status = runGo(["time", "status", "--plain"], sb.project, sb.home);
    expect(status).toContain(ids.plain as string);
    await time.pause(ids.plain as string);
    await time.resume(ids.plain as string);
    const entry = await time.stop(ids.plain as string);
    expect(time.getEntries(ids.plain as string)).toEqual([entry]);
    await expect(time.start(ids.archived as string, "x")).rejects.toThrow(/archived/);
    expect(runGo(["time", "status", "--plain"], sb.project, sb.home)).not.toContain(
      `${ids.plain}\n`,
    );
  });

  test("workspaces", () => {
    const ws = new WorkspaceStore(store);
    ws.save({
      id: "ws1",
      name: "One",
      useWorktree: false,
      status: "running",
      phases: [],
      currentPhaseIndex: 0,
      createdAt: now(),
    });
    ws.markAllStopped();
    expect(ws.get("ws1").status).toBe("stopped");
  });

  test("knowns validate passes on everything TS wrote", () => {
    const report = goJson<{ valid: boolean; errors: number; issues: unknown[] }>(
      ["validate"],
      sb.project,
      sb.home,
    );
    expect(report.issues.filter((i) => (i as { severity?: string }).severity === "error")).toEqual(
      [],
    );
    expect(report.errors).toBe(0);
  });
});
