// KN-1E9BJ9: the server's list index. Runs the real Server in process (no port, no Go oracle), over
// a project on disk that other processes also write to.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../src/models/task.ts";
import { Server } from "../../src/server/index.ts";
import { DocIndex, TaskIndex } from "../../src/server/list-index.ts";
import { createStorage } from "../../src/storage/adapters.ts";
import {
  KEEP_PREVIOUS_MS,
  newScanState,
  readOrKeep,
} from "../../src/storage/core/dir-freshness.ts";
import { Store } from "../../src/storage/core/store.ts";
import { renderTask } from "../../src/storage/stores/task-store.ts";

const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const tmp = mkdtempSync(join(tmpdir(), "knowns-list-index-"));
const repo = join(tmp, "repo");
const root = join(repo, ".knowns");
let server: Server;
let storage: ReturnType<typeof createStorage>;

const STATUSES = ["todo", "in-progress", "done", "blocked"];

function task(i: number, over: Partial<Task> = {}): Task {
  const ms = Date.UTC(2026, 0, 1) + i * 60_000;
  const iso = new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  return {
    id: `LX-${String(i).padStart(4, "0")}`,
    title: `Indexed task ${String(i).padStart(4, "0")}`,
    description: `Body of task ${i}`,
    status: STATUSES[i % STATUSES.length] as string,
    priority: i % 3 === 0 ? "high" : "medium",
    labels: i % 5 === 0 ? ["five"] : [],
    createdAt: iso,
    updatedAt: iso,
    archived: false,
    acceptanceCriteria: [],
    timeSpent: 0,
    ...over,
  };
}

function writeTask(t: Task, dir = join(root, "tasks")): string {
  const path = join(dir, `task-${t.id} - ${t.title.replaceAll(" ", "-")}.md`);
  writeFileSync(path, renderTask(t));
  return path;
}

// biome-ignore lint/suspicious/noExplicitAny: test JSON
async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await server.handle(new Request(`http://127.0.0.1:6420${path}`));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function pageAll(query: string, limit = 7): Promise<string[]> {
  const ids: string[] = [];
  let cursor = "";
  for (let n = 0; n < 1000; n++) {
    const r = await get(
      `/api/tasks?limit=${limit}&summary=true${query}${cursor ? `&cursor=${cursor}` : ""}`,
    );
    expect(r.status).toBe(200);
    ids.push(...r.body.tasks.map((t: { id: string }) => t.id));
    if (!r.body.nextCursor) return ids;
    cursor = r.body.nextCursor;
  }
  throw new Error("cursor never ended");
}

beforeAll(() => {
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  mkdirSync(repo, { recursive: true });
  cpSync(join(import.meta.dir, "..", "fixtures", "full"), repo, { recursive: true });
  // Start from an empty task list so counts are exact.
  rmSync(join(root, "tasks"), { recursive: true, force: true });
  mkdirSync(join(root, "tasks"), { recursive: true });
  rmSync(join(root, "archive"), { recursive: true, force: true });
  mkdirSync(join(root, "archive"), { recursive: true });
  const store = new Store(root, repo);
  storage = createStorage(store);
  server = new Server(store, repo, 0, {});
});

afterAll(() => {
  process.env.HOME = savedEnv.HOME;
  process.env.USERPROFILE = savedEnv.USERPROFILE;
  if (savedEnv.HOME === undefined) delete process.env.HOME;
  if (savedEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
  rmSync(tmp, { recursive: true, force: true });
});

describe("task list index", () => {
  test("pages, counts and the updated-desc keyset agree with the files on disk", async () => {
    for (let i = 0; i < 40; i++) writeTask(task(i));
    const order = await pageAll("");
    expect(order.length).toBe(40);
    expect(new Set(order).size).toBe(40);

    const recent = await pageAll("&sort=updated-desc");
    expect(recent).toEqual([...recent].sort().reverse()); // updatedAt grows with the id
    expect(recent.length).toBe(40);

    const todo = await pageAll("&status=todo");
    expect(todo.length).toBe(10);
    const high = await pageAll("&status=todo&priority=high");
    expect(high.every((id) => todo.includes(id))).toBe(true);

    const counts = await get("/api/tasks/counts");
    expect(counts.status).toBe(200);
    expect(counts.body.total).toBe(40);
    expect(counts.body.byStatus).toEqual({ todo: 10, "in-progress": 10, done: 10, blocked: 10 });
    expect(counts.body.archived.total).toBe(0);
    const filtered = await get("/api/tasks/counts?label=five");
    expect(filtered.body.total).toBe(8);
  });

  test("a bad cursor, sort or limit is a 400", async () => {
    expect((await get("/api/tasks?limit=5&cursor=zzz")).status).toBe(400);
    expect((await get("/api/tasks?limit=5&sort=nope")).status).toBe(400);
    expect((await get("/api/tasks?limit=0")).status).toBe(400);
  });

  test("the unpaged call still returns every task, with and without summary", async () => {
    const full = await get("/api/tasks");
    expect(Array.isArray(full.body)).toBe(true);
    expect(full.body.length).toBe(40);
    expect(full.body[0].description).toBeDefined();
    const sum = await get("/api/tasks?summary=true");
    expect(sum.body[0].description).toBeUndefined();
  });

  test("a rename, a delete and an archive show up on the very next request", async () => {
    const before = await pageAll("");
    const dir = join(root, "tasks");
    const files = readdirSync(dir).sort();
    // delete
    rmSync(join(dir, files[0] as string));
    expect((await pageAll("")).length).toBe(before.length - 1);
    // move to the archive: gone from the active list, present with includeHistorical
    renameSync(join(dir, files[1] as string), join(root, "archive", files[1] as string));
    expect((await pageAll("")).length).toBe(before.length - 2);
    expect((await pageAll("&includeHistorical=true")).length).toBe(before.length - 1);
    const counts = await get("/api/tasks/counts");
    expect(counts.body.total).toBe(before.length - 2);
    expect(counts.body.archived.total).toBe(1);
    // rename in place (new title in the file name, same content)
    const f2 = files[2] as string;
    renameSync(join(dir, f2), join(dir, f2.replace("Indexed", "Renamed")));
    expect((await pageAll("")).length).toBe(before.length - 2);
    // and back from the archive
    renameSync(join(root, "archive", files[1] as string), join(dir, files[1] as string));
    expect((await pageAll("")).length).toBe(before.length - 1);
  });

  test("a same-size rewrite inside the racy window is seen at once, every time", async () => {
    const t = task(900, { title: "Racy AAAA" });
    const path = writeTask(t);
    for (let i = 0; i < 12; i++) {
      const title = i % 2 ? "Racy AAAA" : "Racy BBBB";
      // The same bytes in length, the same millisecond tick: only the racy rule tells them apart.
      writeFileSync(`${path}.tmp`, renderTask({ ...t, title }));
      renameSync(`${path}.tmp`, path);
      const r = await get("/api/tasks?limit=200&summary=true&query=Racy");
      expect(r.body.tasks.map((x: { title: string }) => x.title)).toEqual([title]);
    }
    rmSync(path);
  });

  test("a task that cannot be parsed is skipped without poisoning the index", async () => {
    const bad = join(root, "tasks", "task-LX-BAD - broken.md");
    writeFileSync(bad, "no frontmatter at all");
    const a = await pageAll("");
    const b = await pageAll("");
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(30);
    rmSync(bad);
    expect(await pageAll("")).toEqual(a);
  });

  test("writes from another process show up while it is still writing", async () => {
    const script = join(tmp, "writer.ts");
    const taskStoreUrl = new URL("../../src/storage/stores/task-store.ts", import.meta.url).href;
    writeFileSync(
      script,
      `import { writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { renderTask } from ${JSON.stringify(taskStoreUrl)};
const dir = process.argv[2];
const mk = (i, status) => ({ id: "PX-" + String(i).padStart(4, "0"), title: "Proc " + i, status,
  priority: "medium", labels: [], createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z",
  archived: false, acceptanceCriteria: [], timeSpent: 0, description: "" });
for (let i = 0; i < 60; i++) {
  const p = join(dir, "task-PX-" + String(i).padStart(4, "0") + " - Proc.md");
  writeFileSync(p + ".tmp", renderTask(mk(i, "todo"))); renameSync(p + ".tmp", p);
  if (i % 3 === 0) { writeFileSync(p + ".tmp", renderTask(mk(i, "done"))); renameSync(p + ".tmp", p); }
  if (i % 10 === 9) rmSync(p);
}
`,
    );
    const baseline = (await pageAll("&query=Proc")).length;
    expect(baseline).toBe(0);
    const child = Bun.spawn([process.execPath, script, join(root, "tasks")], {
      stdout: "ignore",
      stderr: "inherit",
    });
    // Read while the writer runs: never an error, never a duplicate, never more than it wrote.
    let reads = 0;
    while (child.exitCode === null) {
      const ids = await pageAll("&query=Proc", 11);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeLessThanOrEqual(60);
      reads++;
      await Bun.sleep(1); // let the child's exit be observed
    }
    expect(await child.exited).toBe(0);
    expect(reads).toBeGreaterThan(0);
    // Once it is done the index equals the directory.
    const onDisk = readdirSync(join(root, "tasks")).filter((f) => f.includes("PX-")).length;
    const ids = await pageAll("&query=Proc");
    expect(ids.length).toBe(onDisk);
    expect(onDisk).toBe(54);
    const done = await pageAll("&query=Proc&status=done");
    expect(done.length).toBe(18);
    for (const f of readdirSync(join(root, "tasks")).filter((x) => x.includes("PX-")))
      rmSync(join(root, "tasks", f));
  }, 60_000);
});

describe("index freshness", () => {
  const taskPage = (ix: TaskIndex, query = {}, limit = 50) => {
    const p = ix.page({ includeArchived: false, sort: "order", query, limit });
    if ("error" in p) throw new Error(p.error);
    return p;
  };

  test("a quiet directory is not rescanned; a change is seen by signature, dirty flag and age", async () => {
    // "Quiet" is a clock past the racy window, not a switch that turns the rule off.
    const later = () => Date.now() + 10_000;
    const ix = new TaskIndex(storage.tasks, { maxAgeMs: 60_000, now: later });
    const first = taskPage(ix);
    taskPage(ix); // the first scan could not commit: the dirs were not signed yet
    const scans = ix.scans;
    for (let i = 0; i < 200; i++) taskPage(ix);
    expect(ix.scans).toBe(scans); // 200 pages, no scan

    // The directory signature alone sees a rename into the directory. A real mtime may share the
    // tick of the earlier one (NTFS: 15.6 ms), so move it by hand: the product rule under test is
    // "a different signature is a rescan", not the speed of this machine's clock.
    const dir = join(root, "tasks");
    const path = join(dir, "task-LX-0700 - Fresh.md");
    writeFileSync(`${path}.new`, renderTask(task(700, { title: "Fresh AAAA" })));
    renameSync(`${path}.new`, path);
    const bump = new Date(Date.now() - 20_000);
    utimesSync(dir, bump, bump);
    expect(taskPage(ix).total).toBe(first.total + 1);

    // An in-place edit does not touch the directory: the dirty flag (a watcher event or a write by
    // this process) or the age of the state makes the next call scan.
    writeFileSync(path, renderTask(task(700, { title: "Fresh BBBB" })));
    ix.invalidate();
    expect(taskPage(ix, { query: "Fresh" }).items[0]?.title).toBe("Fresh BBBB");
    const aging = new TaskIndex(storage.tasks, { maxAgeMs: 100, now: later });
    taskPage(aging);
    taskPage(aging);
    expect(taskPage(aging, { query: "Fresh" }).items[0]?.title).toBe("Fresh BBBB");
    writeFileSync(path, renderTask(task(700, { title: "Fresh CCCC" })));
    await Bun.sleep(150); // older than maxAgeMs
    expect(taskPage(aging, { query: "Fresh" }).items[0]?.title).toBe("Fresh CCCC");
    rmSync(path);
  });

  test("inside the racy window of a directory an unchanged signature proves nothing", () => {
    // The real clock: every file written below is younger than DIR_RACY_MS.
    const ix = new TaskIndex(storage.tasks);
    taskPage(ix);
    const dir = join(root, "tasks");
    const before = ix.scans;
    taskPage(ix);
    taskPage(ix);
    expect(ix.scans).toBe(before + 2); // the directory is recent: every call scans
    // Back-to-back changes, each possibly in the same file system tick as the last (the 39 of 40
    // misses NTFS showed): every one is seen, because no signature was ever trusted.
    for (let i = 0; i < 25; i++) {
      const path = join(dir, `task-LX-08${String(i).padStart(2, "0")} - Tick.md`);
      writeFileSync(path, renderTask(task(800 + i, { title: `Tick ${i}` })));
      expect(taskPage(ix, { query: "Tick" }).total).toBe(i + 1);
    }
    for (const f of readdirSync(dir).filter((x) => x.includes("Tick"))) rmSync(join(dir, f));
    expect(taskPage(ix, { query: "Tick" }).total).toBe(0);
  });

  test("a file that vanishes mid-scan keeps its entry until a later scan confirms the delete", () => {
    const calls = { n: 0 };
    const state = newScanState<string>();
    expect(readOrKeep(state, "/a", () => "A1")).toBe("A1");
    const second = newScanState<string>(state.seen);
    const gone = () => {
      calls.n++;
      throw new Error("ENOENT");
    };
    expect(readOrKeep(second, "/a", gone)).toBe("A1"); // kept
    expect(second.skipped).toBe(1); // so the pass is not committed as fresh
    expect(readOrKeep(second, "/never-seen", gone)).toBeUndefined();
    // a path that keeps failing is given up after KEEP_PREVIOUS_MS
    const third = newScanState<string>(second.seen);
    expect(readOrKeep(third, "/a", gone, Date.now() + KEEP_PREVIOUS_MS + 1)).toBeUndefined();
  });

  test("a task in both the active and the archive dir is listed once", () => {
    const dir = join(root, "tasks");
    const t = task(950, { title: "Moving" });
    const a = writeTask(t);
    const b = writeTask({ ...t, archived: true }, join(root, "archive"));
    const ix = new TaskIndex(storage.tasks);
    const ids = (() => {
      const p = ix.page({
        includeArchived: true,
        sort: "order",
        query: { query: "Moving" },
        limit: 50,
      });
      return "error" in p ? [] : p.items.map((x) => x.id);
    })();
    expect(ids).toEqual(["LX-0950"]);
    rmSync(a);
    rmSync(b);
    expect(readdirSync(dir).some((f) => f.includes("0950"))).toBe(false);
  });

  test("an external writer renaming and rewriting files: counts never dip, no id twice per traversal", async () => {
    const N = 200;
    const dir = join(root, "tasks");
    for (const f of readdirSync(dir)) rmSync(join(dir, f));
    const mk = (i: number, title: string, status: string): Task =>
      task(i, {
        id: `EX-${String(i).padStart(4, "0")}`,
        title,
        status,
        updatedAt: "2026-02-01T00:00:00Z",
      });
    const nameOf = (i: number, title: string) =>
      `task-EX-${String(i).padStart(4, "0")} - ${title.replaceAll(" ", "-")}.md`;
    for (let i = 0; i < N; i++)
      writeFileSync(join(dir, nameOf(i, `T ${i}`)), renderTask(mk(i, `T ${i}`, "todo")));
    const writer = join(tmp, "storm.ts");
    writeFileSync(
      writer,
      `import { renameSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderTask } from ${JSON.stringify(new URL("../../src/storage/stores/task-store.ts", import.meta.url).href)};
const dir = process.argv[2]; const N = ${N};
const end = Date.now() + 3000; let n = 0;
const files = new Map(readdirSync(dir).map((f) => [f.match(/EX-\\d+/)[0], f]));
while (Date.now() < end) {
  const i = (n * 37) % N; const id = "EX-" + String(i).padStart(4, "0");
  const title = "R " + n; const to = "task-" + id + " - " + title.replaceAll(" ", "-") + ".md";
  renameSync(join(dir, files.get(id)), join(dir, to)); files.set(id, to);
  // not atomic, like an editor: a reader may see the file empty
  writeFileSync(join(dir, to), renderTask({ id, title, description: "", status: n % 2 ? "done" : "todo", priority: "medium", labels: [], createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z", archived: false, acceptanceCriteria: [], timeSpent: 0 }));
  n++; await Bun.sleep(3);
}
`,
    );
    await pageAll("&sort=updated-desc", 50); // cold
    const child = Bun.spawn([process.execPath, writer, dir], {
      stdout: "ignore",
      stderr: "inherit",
    });
    let dips = 0;
    let dupes = 0;
    let reads = 0;
    while (child.exitCode === null) {
      const ids = await pageAll("&sort=updated-desc", 50);
      reads++;
      if (new Set(ids).size !== ids.length) dupes++;
      if (ids.length < N) dips++;
      const c = await get("/api/tasks/counts");
      if (c.body.total < N) dips++;
      await Bun.sleep(5);
    }
    expect(await child.exited).toBe(0);
    expect(reads).toBeGreaterThan(3);
    expect(dips).toBe(0);
    expect(dupes).toBe(0);
    for (const f of readdirSync(dir)) rmSync(join(dir, f));
  }, 60_000);
});

describe("doc list index", () => {
  test("pages docs, filters server-side and sees a new doc at once", async () => {
    const docs = join(root, "docs");
    mkdirSync(join(docs, "bulk"), { recursive: true });
    for (let i = 0; i < 25; i++) {
      writeFileSync(
        join(docs, "bulk", `doc-${String(i).padStart(2, "0")}.md`),
        `---\ntitle: Bulk ${i}\ndescription: d${i}\ncreatedAt: '2026-01-01T00:00:00Z'\nupdatedAt: '2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z'\ntags:\n  - ${i % 2 ? "odd" : "even"}\n---\n\nbody ${i}\n`,
      );
    }
    const all = await get("/api/docs");
    expect(all.status).toBe(200);
    const everything = all.body.docs.length as number;
    expect(all.body.docs.find((d: { path: string }) => d.path === "bulk/doc-03").content).toContain(
      "body 3",
    );

    const walk: string[] = [];
    let cursor = "";
    for (let n = 0; n < 100; n++) {
      const r = await get(`/api/docs?limit=10&summary=true${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(everything);
      for (const d of r.body.docs) {
        expect(d.content).toBeUndefined();
        walk.push(d.path);
      }
      if (!r.body.nextCursor) break;
      cursor = r.body.nextCursor;
    }
    expect(walk.length).toBe(everything);
    expect(walk).toEqual([...walk].sort());

    const odd = await get("/api/docs?limit=50&tag=odd&folder=bulk");
    expect(odd.body.total).toBe(12);
    expect((await get("/api/docs?limit=5&sort=walk")).status).toBe(400);

    writeFileSync(
      join(docs, "bulk", "doc-new.md"),
      "---\ntitle: Brand new\ncreatedAt: '2026-01-01T00:00:00Z'\nupdatedAt: '2099-03-01T00:00:00Z'\n---\n\nx\n",
    );
    const after = await get("/api/docs?limit=5&sort=updated-desc");
    expect(after.body.total).toBe(everything + 1);
    expect(after.body.docs[0].path).toBe("bulk/doc-new");
  });

  test("a doc in a new subfolder is seen", async () => {
    const ix = new DocIndex(storage.docs, { maxAgeMs: 60_000 });
    const n = () => ix.all({}).length;
    const base = n();
    n();
    mkdirSync(join(root, "docs", "deep", "er"), { recursive: true });
    writeFileSync(
      join(root, "docs", "deep", "er", "x.md"),
      "---\ntitle: Deep\ncreatedAt: '2026-01-01T00:00:00Z'\nupdatedAt: '2026-01-01T00:00:00Z'\n---\n\nx\n",
    );
    expect(n()).toBe(base + 1);
    writeFileSync(
      join(root, "docs", "deep", "er", "y.md"),
      "---\ntitle: Deep2\ncreatedAt: '2026-01-01T00:00:00Z'\nupdatedAt: '2026-01-01T00:00:00Z'\n---\n\nx\n",
    );
    expect(n()).toBe(base + 2);
  });
});

describe("list bench", () => {
  test("p95 of GET /api/tasks?limit=50 at 1000 tasks", async () => {
    // A fresh project root so the earlier tests' files do not count.
    const dir = join(root, "tasks");
    for (const f of readdirSync(dir)) rmSync(join(dir, f));
    for (let i = 0; i < 1000; i++) writeTask(task(i));
    const quiet = process.env.KNOWNS_STAT_RACY_MS;
    const sample = async (path: string, n: number): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const r = await server.handle(new Request(`http://127.0.0.1:6420${path}`));
        await r.text();
        out.push(performance.now() - t0);
      }
      return out.sort((a, b) => a - b);
    };
    try {
      // The racy window is what makes a just-written store rescan; wait it out like a quiet store.
      await Bun.sleep(3300);
      await get("/api/tasks?limit=50"); // cold: the one parse of 1000 files
      const full = await sample("/api/tasks?limit=50", 100);
      const summary = await sample("/api/tasks?limit=50&summary=true", 100);
      const status = await sample("/api/tasks?limit=50&status=todo&sort=updated-desc", 100);
      const p95 = (xs: number[]) => xs[Math.floor(xs.length * 0.95)] as number;
      console.log(
        `p95 ms at 1000 tasks: full ${p95(full).toFixed(2)}, summary ${p95(summary).toFixed(2)}, status+updated-desc ${p95(status).toFixed(2)}`,
      );
      // Windows timers and file systems are slower; the budget there is three times the Mac's.
      const budget = process.platform === "win32" ? 30 : 10;
      expect(p95(full)).toBeLessThan(budget);
      expect(p95(summary)).toBeLessThan(budget);
      expect(p95(status)).toBeLessThan(budget);
    } finally {
      if (quiet === undefined) delete process.env.KNOWNS_STAT_RACY_MS;
      else process.env.KNOWNS_STAT_RACY_MS = quiet;
    }
  }, 120_000);
});
