// Keyword search reuses parsed files and tokenized documents between queries (StatCache plus the
// LexicalDoc memo). The index is an optimisation only: every query must return exactly what a full
// rescan returns, scores included, however the files change in between.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bm25Search, type LexicalSource } from "../../src/search/lexical.ts";
import type { SearchOptions } from "../../src/search/types.ts";
import type { Storage } from "../../src/storage/adapters.ts";
import { RACY_WINDOW_MS, StatCache, setCacheClock } from "../../src/storage/core/stat-cache.ts";
import { cleanup, openFixture } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  setCacheClock(undefined);
  cleanup(...dirs);
});
// Files made by a test are brand new, which the racy rule never serves from memory. Moving the
// shared caches' clock an hour ahead lets these tests exercise real cache hits; the racy rule has
// its own tests with the clock under control.
beforeAll(() => setCacheClock(() => Date.now() + 3_600_000));

function open() {
  const f = openFixture("full");
  dirs.push(f.dir.replace(/\/project$/, ""));
  return f;
}

const opts = (extra: Partial<SearchOptions> = {}): SearchOptions => ({
  query: "",
  type: "all",
  taskVisibility: "active-and-done",
  purpose: "human-search",
  ...extra,
});

/** What the engine feeds the backend, from the shared (indexed) listings. */
function indexed(storage: Storage): LexicalSource {
  return {
    tasks: () => storage.tasks.listActiveReadOnly(),
    docs: () => storage.docs.listReadOnly(),
    memories: () => storage.memory.list(""),
    decisions: () => storage.decisions.list(),
  };
}

/** The same reads the engine did before the index existed: a fresh read and parse of every file. */
function scan(storage: Storage): LexicalSource {
  return {
    tasks: () => storage.tasks.listActive(),
    docs: () => storage.docs.list(),
    memories: () => storage.memory.list(""),
    decisions: () => storage.decisions.list(),
  };
}

const QUERIES = ["login", "bun", "task", "doc", "login bun", "the api", "zzunseen", "auth token"];

function expectSame(storage: Storage, o: SearchOptions = opts()) {
  for (const q of QUERIES) {
    const a = bm25Search(indexed(storage), q, { ...o, query: q });
    const b = bm25Search(scan(storage), q, { ...o, query: q });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  }
}

function firstFile(dir: string, ext = ".md"): string {
  const name = readdirSync(dir)
    .filter((n) => n.endsWith(ext))
    .sort()[0] as string;
  return join(dir, name);
}

describe("indexed keyword search equals a full scan", () => {
  test("on an untouched store, cold and warm", () => {
    const f = open();
    expectSame(f.storage); // fills the index
    expectSame(f.storage); // served from it
    expect(
      bm25Search(indexed(f.storage), "login", opts({ query: "login" })).length,
    ).toBeGreaterThan(0);
  });

  test("after a task file is edited", () => {
    const f = open();
    expectSame(f.storage);
    const file = firstFile(join(f.root, "tasks"));
    writeFileSync(file, readFileSync(file, "utf8").replace(/^title: (.*)$/m, "title: $1 zzunseen"));
    expectSame(f.storage);
    const hits = bm25Search(indexed(f.storage), "zzunseen", opts({ query: "zzunseen" }));
    expect(hits.length).toBeGreaterThan(0);
  });

  test("after a doc is edited, added and removed", () => {
    const f = open();
    expectSame(f.storage);
    const docsDir = join(f.root, "docs");
    const file = firstFile(docsDir);
    const before = readFileSync(file, "utf8");
    writeFileSync(file, `${before.trimEnd()}\nzzunseen login\n`);
    expectSame(f.storage);
    const added = join(docsDir, "zz-added.md");
    writeFileSync(added, "---\ntitle: Added later\n---\nlogin zzunseen\n");
    expectSame(f.storage);
    expect(
      bm25Search(indexed(f.storage), "zzunseen", opts({ query: "zzunseen" })).some(
        (r) => r.path === "zz-added",
      ),
    ).toBe(true);
    rmSync(added);
    writeFileSync(file, before);
    expectSame(f.storage);
    expect(
      bm25Search(indexed(f.storage), "zzunseen", opts({ query: "zzunseen" })).some(
        (r) => r.path === "zz-added",
      ),
    ).toBe(false);
  });

  test("after a task file is deleted", () => {
    const f = open();
    expectSame(f.storage);
    rmSync(firstFile(join(f.root, "tasks")));
    expectSame(f.storage);
  });

  test("under filters, which change the corpus the statistics are computed over", () => {
    const f = open();
    for (const extra of [
      { type: "task" },
      { type: "doc" },
      { type: "task", status: "done" },
      { type: "task", status: "todo" },
      { tag: "api" },
      { taskVisibility: "active-only" as const },
    ] as Partial<SearchOptions>[]) {
      expectSame(f.storage, opts(extra));
      expectSame(f.storage, opts(extra));
      expectSame(f.storage, opts()); // back to the full corpus: statistics must not leak across
    }
  });

  test("a file rewritten with the same size is still picked up", () => {
    const f = open();
    expectSame(f.storage);
    const file = firstFile(join(f.root, "tasks"));
    const text = readFileSync(file, "utf8");
    const i = text.indexOf("login");
    // Same byte length, different token: only the stat (ino, mtime, ctime) can tell.
    const swapped = i >= 0 ? `${text.slice(0, i)}zzunseen`.padEnd(i + 5) + text.slice(i + 5) : null;
    if (swapped === null) return;
    expect(Buffer.byteLength(swapped)).toBe(Buffer.byteLength(text));
    writeFileSync(file, swapped);
    expectSame(f.storage);
  });
});

describe("StatCache", () => {
  const later = () => Date.now() + 3_600_000;

  test("parses once per file version and again after a change", () => {
    const f = open();
    const file = firstFile(join(f.root, "tasks"));
    const cache = new StatCache<string>({ now: later });
    let parses = 0;
    const read = () =>
      cache.read(file, () => {
        parses++;
        return readFileSync(file, "utf8");
      });
    const first = read();
    expect(read()).toBe(first);
    expect(parses).toBe(1);
    writeFileSync(file, `${first}\nmore\n`);
    expect(read()).toContain("more");
    expect(parses).toBe(2);
  });

  test("a missing file is parsed (so the caller sees the usual error), never cached", () => {
    const cache = new StatCache<string>();
    expect(() =>
      cache.read("/definitely/not/here.md", () => {
        throw new Error("gone");
      }),
    ).toThrow("gone");
    expect(cache.size).toBe(0);
  });

  test("is held under its byte budget, least recently used first", () => {
    const f = open();
    const files = readdirSync(join(f.root, "tasks")).map((n) => join(f.root, "tasks", n));
    const cache = new StatCache<number>({ budgetBytes: 2000, now: later });
    for (const file of files) cache.read(file, () => 1);
    expect(cache.cost).toBeLessThanOrEqual(2000);
    expect(cache.size).toBeLessThan(files.length);
    const last = files[files.length - 1] as string;
    let parses = 0;
    cache.read(last, () => ++parses);
    expect(parses).toBe(0); // the most recent entry survived eviction
  });

  test("a listing pass forgets files that are gone, and dropPrefix a whole project", () => {
    const f = open();
    const cache = new StatCache<number>({ now: later });
    const tasks = join(f.root, "tasks");
    const files = readdirSync(tasks).map((n) => join(tasks, n));
    const first = cache.pass(`${tasks}/`);
    for (const file of files) first.read(file, () => 1);
    first.end();
    expect(cache.size).toBe(files.length);
    rmSync(files[0] as string);
    const second = cache.pass(`${tasks}/`);
    for (const file of files.slice(1)) second.read(file, () => 1);
    second.end();
    expect(cache.size).toBe(files.length - 1);
    cache.dropPrefix(`${tasks}/`);
    expect(cache.size).toBe(0);
    expect(cache.cost).toBe(0);
  });

  test("Windows keys: a prefix with another separator or case still forgets deleted files", () => {
    const f = open();
    const tasks = join(f.root, "tasks");
    const files = readdirSync(tasks).map((n) => join(tasks, n));
    // Listing prefix as a Windows caller might write it: backslashes and a different case, while
    // the cached keys came from join()/readdir.
    const prefix = `${tasks.toUpperCase().replaceAll("/", "\\")}\\`;
    const cache = new StatCache<number>({ now: later, windows: true });
    const first = cache.pass(prefix);
    for (const file of files) first.read(file, () => 1);
    first.end();
    expect(cache.size).toBe(files.length);
    rmSync(files[0] as string);
    const second = cache.pass(prefix);
    for (const file of files.slice(1)) second.read(file, () => 1);
    second.end();
    expect(cache.size).toBe(files.length - 1); // was one too many: the prefix never matched
    cache.dropPrefix(prefix);
    expect(cache.size).toBe(0);
    expect(cache.cost).toBe(0);
  });

  test("P2-1: a file modified within the racy margin of being cached is parsed again", () => {
    const f = open();
    const file = firstFile(join(f.root, "tasks"));
    const st = statSync(file, { bigint: true });
    const newest = Number((st.mtimeNs > st.ctimeNs ? st.mtimeNs : st.ctimeNs) / 1_000_000n);
    let clock = newest + 50; // cached 50 ms after the last change: a later write could share its tick
    const cache = new StatCache<number>({ now: () => clock });
    let parses = 0;
    const read = () => cache.read(file, () => ++parses);
    read();
    read();
    expect(parses).toBe(2); // a racy entry is never trusted
    clock = newest + RACY_WINDOW_MS + 100; // the file had been quiet long enough when cached
    read();
    read();
    read();
    expect(parses).toBe(3); // cached once, then served
  });

  test("P2-1: a same-size rewrite with an unchanged mtime, right after a query, is seen", () => {
    const f = open();
    const file = firstFile(join(f.root, "tasks"));
    const text = readFileSync(file, "utf8");
    const a = text.replace(/^title: .*$/m, "title: AAAA");
    const b = a.replace("AAAA", "BBBB"); // same size
    const t = new Date();
    writeFileSync(file, a);
    utimesSync(file, t, t);
    // The real clock, passed explicitly: the file-level beforeAll moves the shared default an hour
    // ahead, which would make this just-written file look old and quiet (it only failed where the
    // ctime is as coarse as the mtime, e.g. ext4).
    const cache = new StatCache<string>({ now: Date.now });
    const read = () => cache.read(file, () => readFileSync(file, "utf8"));
    expect(read()).toContain("AAAA");
    writeFileSync(file, b);
    utimesSync(file, t, t); // the coarse-timestamp case: the same mtime as before
    expect(read()).toContain("BBBB");
  });

  test("P3-1: shared values are deeply frozen", () => {
    const f = open();
    const file = firstFile(join(f.root, "tasks"));
    const cache = new StatCache<{ list: string[]; n: { a: number } }>({ now: later });
    const v = cache.read(file, () => ({ list: ["x"], n: { a: 1 } }));
    expect(() => v.list.push("y")).toThrow();
    expect(() => {
      v.n.a = 2;
    }).toThrow();
  });
});

describe("parents and duplicates (P2-2, P3-2, P2-4)", () => {
  function withParent() {
    const f = open();
    const dir = join(f.root, "tasks");
    const names = readdirSync(dir).sort();
    const parentFile = join(dir, names[0] as string);
    const childFile = join(dir, names[1] as string);
    const parentId = /^id: (.+)$/m.exec(readFileSync(parentFile, "utf8"))?.[1] as string;
    const child = readFileSync(childFile, "utf8");
    writeFileSync(childFile, child.replace("\nassignee:", `\nparent: ${parentId}\nassignee:`));
    return { f, dir, parentId, parentFile, childFile };
  }

  test("P2-2: a parent keeps its identity across calls", () => {
    const { f, parentId } = withParent();
    const a = f.storage.tasks.listActiveReadOnly();
    const b = f.storage.tasks.listActiveReadOnly();
    const pa = a.find((t) => t.id === parentId);
    expect(pa?.subtasks?.length).toBe(1);
    expect(b.find((t) => t.id === parentId)).toBe(pa);
    expect(a.every((t, i) => t === b[i])).toBe(true);
  });

  test("P2-2: a parent's view is rebuilt when its children change", () => {
    const { f, parentId, childFile } = withParent();
    const before = f.storage.tasks.listActiveReadOnly().find((t) => t.id === parentId);
    writeFileSync(childFile, readFileSync(childFile, "utf8").replace(/^parent: .*\n/m, ""));
    const after = f.storage.tasks.listActiveReadOnly().find((t) => t.id === parentId);
    expect(after).not.toBe(before);
    expect(after?.subtasks ?? []).toEqual([]);
  });

  test("P3-2: indexed search equals a scan with a parent task, including a term only it has", () => {
    const { f, parentFile } = withParent();
    writeFileSync(
      parentFile,
      readFileSync(parentFile, "utf8").replace(
        "\nassignee:",
        "\nlabels: [zzparentonly]\nassignee:",
      ),
    );
    expectSame(f.storage);
    const hits = bm25Search(indexed(f.storage), "zzparentonly", opts({ query: "zzparentonly" }));
    expect(hits.length).toBeGreaterThan(0);
    expectSame(f.storage);
  });

  test("P2-4: a duplicate id is resolved like listActive, but a search deletes no file", () => {
    const f = open();
    const dir = join(f.root, "tasks");
    const file = firstFile(dir);
    const copy = join(dir, "zz-duplicate.md");
    writeFileSync(
      copy,
      readFileSync(file, "utf8").replace(/^title: .*$/m, "title: Stale duplicate"),
    );
    const before = readdirSync(dir).sort();
    const shared = f.storage.tasks.listActiveReadOnly();
    expect(readdirSync(dir).sort()).toEqual(before); // nothing removed
    const id = /^id: (.+)$/m.exec(readFileSync(file, "utf8"))?.[1];
    expect(shared.filter((t) => t.id === id)).toHaveLength(1);
    f.storage.tasks.listActive(); // the write path is the one that repairs
    expect(readdirSync(dir).length).toBe(before.length - 1);
  });
});
