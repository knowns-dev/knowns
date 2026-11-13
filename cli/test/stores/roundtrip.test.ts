// AC-1: every entity in the golden fixtures round-trips byte for byte through the TS stores.
import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GO_ZERO_TIME } from "../../src/models/common.ts";
import { Store } from "../../src/storage/core/store.ts";
import {
  AuditStore,
  DecisionStore,
  DocStore,
  MemoryStore,
  parseDecisionContent,
  parseMemoryContent,
  parseTaskContent,
  renderDecision,
  renderMemory,
  renderTask,
  TaskStore,
  TemplateStore,
  TimeStore,
  WorkspaceStore,
} from "../../src/storage/stores/index.ts";
import { fixtureFiles, fixtureNames, fixtureRoot, readFixture } from "../helpers/fixtures.ts";
import { copyFixture, storeAt } from "./helpers.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Go's omitempty: empty lists are not marshalled. */
const goJson = (v: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(v, (_k, x) => (Array.isArray(x) && x.length === 0 ? undefined : x)));

/** Rewrites drop a UTF-8 BOM, as the Go writers do. */
const noBom = (s: string) => (s.startsWith("\uFEFF") ? s.slice(1) : s);

const entityFiles = (name: string, dir: string) =>
  fixtureFiles(name).filter((f) => f.startsWith(`.knowns/${dir}/`) && f.endsWith(".md"));

for (const name of fixtureNames) {
  describe(`fixture ${name}`, () => {
    test("tasks and archived tasks: update, or the lifecycle patch Go used, keeps every file byte-identical", async () => {
      const { project, root } = copyFixture(name);
      roots.push(root);
      const store = storeAt(project);
      const tasks = new TaskStore(store);
      const all = tasks.listAll();
      const files = [...entityFiles(name, "tasks"), ...entityFiles(name, "archive")];
      expect(all.length).toBe(files.length);
      for (const f of files) {
        const raw = noBom(readFixture(name, f));
        const task = tasks.parseFile(join(project, f));
        if (renderTask(parseTaskContent(raw)) === raw) {
          await tasks.update(task);
        } else {
          // Archived by Go's lifecycle patch: archivedAt was appended after the other keys.
          // A full rewrite normalises the order (as Go's own Update would); the patch must not.
          expect(raw, f).toContain("archivedAt:");
          tasks.patchLifecycleUnlocked(task);
          const once = renderTask(parseTaskContent(raw));
          expect(renderTask(parseTaskContent(once)), f).toBe(once);
        }
        expect(readFileSync(join(project, f), "utf8"), f).toBe(raw);
      }
    });

    test("docs: store.update leaves every file byte-identical (ids are kept)", () => {
      const { project, root } = copyFixture(name);
      roots.push(root);
      const docs = new DocStore(storeAt(project));
      const list = docs.list();
      const files = entityFiles(name, "docs");
      expect(list.length).toBe(files.length);
      for (const doc of list) docs.update(structuredClone(doc));
      for (const f of files) {
        expect(readFileSync(join(project, f), "utf8"), f).toBe(noBom(readFixture(name, f)));
      }
    });

    test("decisions: parse then render is byte-identical", () => {
      const { project, root } = copyFixture(name);
      roots.push(root);
      const decisions = new DecisionStore(storeAt(project));
      const files = entityFiles(name, "decisions");
      expect(decisions.list().length).toBe(files.length);
      for (const f of files) {
        const raw = readFixture(name, f);
        expect(renderDecision(parseDecisionContent(raw)), f).toBe(raw);
        expect(renderDecision(decisions.parseFile(join(project, f))), f).toBe(raw);
      }
    });

    test("memories (project and global): parse then render is byte-identical", () => {
      const { project, home, root } = copyFixture(name);
      roots.push(root);
      const memories = new MemoryStore(storeAt(project), join(home, ".knowns"));
      const dirs: [string, string, string][] = [
        [join(project, ".knowns", "memory"), "project", `.knowns/memory`],
        [join(home, ".knowns", "memory"), "global", ""],
      ];
      let seen = 0;
      for (const [dir, layer] of dirs) {
        let names: string[] = [];
        try {
          names = readdirSync(dir).filter((n) => n.endsWith(".md"));
        } catch {
          continue;
        }
        for (const n of names) {
          const raw = readFileSync(join(dir, n), "utf8");
          expect(renderMemory(parseMemoryContent(raw, layer)), n).toBe(raw);
          seen++;
        }
      }
      expect(memories.list().length).toBe(seen);
    });

    test("time.json, time-entries.json and workspaces.json rewrite identically", async () => {
      const { project, root } = copyFixture(name);
      roots.push(root);
      const store = storeAt(project);
      const time = new TimeStore(store);
      await time.saveState(time.getState());
      time.saveAllEntriesUnlocked(time.getAllEntries());
      const ws = new WorkspaceStore(store);
      for (const w of ws.list()) ws.save(w);
      for (const f of ["time.json", "time-entries.json", "workspaces.json"]) {
        expect(readFileSync(join(project, ".knowns", f), "utf8"), f).toBe(
          readFixture(name, `.knowns/${f}`),
        );
      }
    });
  });
}

describe("fixture full: reads match the Go --json goldens", () => {
  const golden = (f: string) =>
    JSON.parse(readFileSync(join(fixtureRoot("full"), "_api", f), "utf8")) as Record<
      string,
      unknown
    >;
  const { project, home, root } = copyFixture("full");
  roots.push(root);
  const store = storeAt(project);

  /** The Go view includes fields derived outside the stores (hashes, time entries). */
  const DERIVED = ["canonicalHash", "timeEntries", "activeTimer"];
  const strip = (o: Record<string, unknown>) => {
    const c = { ...o };
    for (const k of DERIVED) delete c[k];
    return c;
  };

  for (const name of [
    "task.rich",
    "task.plain",
    "task.parent",
    "task.child1",
    "task.unicode",
    "task.blocked",
    "task.onhold",
    "task.urgent",
    "task.ops",
  ]) {
    test(name, () => {
      const g = strip(golden(`${name}.view.json`));
      const tasks = new TaskStore(store);
      const t = tasks.get(g.id as string);
      expect(t).toBeDefined();
      // JSON round trip drops undefined keys, as Go's omitempty does.
      expect(goJson(strip(t as unknown as Record<string, unknown>))).toEqual(g);
    });
  }

  test("listAll derives subtasks across active and archived tasks", () => {
    const all = new TaskStore(store).listAll();
    const parent = all.find((t) => t.id === "FX-65T7HG");
    expect(parent?.subtasks?.sort()).toEqual(["FX-3GCY37", "FX-7TGPH1"]);
  });

  test("decisions", () => {
    const decisions = new DecisionStore(store);
    for (const f of ["accepted", "draft", "superseded"]) {
      const g = golden(`decision.${f}.get.json`);
      const d = decisions.get(g.id as string);
      expect(goJson(d)).toEqual(g);
    }
  });

  test("memories", () => {
    const memories = new MemoryStore(store, join(home, ".knowns"));
    for (const f of ["global", "preference", "proposed"]) {
      const g = golden(`memory.${f}.view.json`);
      expect(goJson(memories.get(g.id as string))).toEqual(g);
    }
  });

  test("docs", () => {
    const docs = new DocStore(store);
    for (const f of ["root", "guide", "nested"]) {
      const g = strip(golden(`doc.${f}.view.json`));
      const d = docs.get(g.path as string);
      expect(goJson(strip(d as unknown as Record<string, unknown>))).toEqual(g);
    }
  });

  test("templates", () => {
    const tmpl = new TemplateStore(store).get("component");
    const g = golden("template.component.view.json");
    const j = JSON.parse(JSON.stringify(tmpl)) as Record<string, unknown>;
    j.path = "<project>/.knowns/templates/component";
    g.path = String(g.path).replace("<project>", "<project>");
    expect(j).toEqual(g);
  });
});

describe("misc", () => {
  test("unparseable timestamps read as Go's zero time", () => {
    const m = parseMemoryContent(
      "---\nid: x\ntitle: t\ncreatedAt: nope\nupdatedAt: ''\n---\nbody\n",
      "project",
    );
    expect(m.createdAt).toBe(GO_ZERO_TIME);
  });

  test("Store and AuditStore are constructible without a project", () => {
    expect(new AuditStore("/nonexistent-dir-for-test").recent()).toEqual([]);
    expect(Store.open("/nonexistent/.knowns").root).toBe("/nonexistent/.knowns");
  });
});
