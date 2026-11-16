// Keyword search reuses parsed files and tokenized documents between queries (StatCache plus the
// LexicalDoc memo). The index is an optimisation only: every query must return exactly what a full
// rescan returns, scores included, however the files change in between.
import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bm25Search, type LexicalSource } from "../../src/search/lexical.ts";
import type { SearchOptions } from "../../src/search/types.ts";
import type { Storage } from "../../src/storage/adapters.ts";
import { StatCache } from "../../src/storage/core/stat-cache.ts";
import { cleanup, openFixture } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

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
    tasks: () => storage.tasks.listActiveShared(),
    docs: () => storage.docs.listShared(),
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
  test("parses once per file version and again after a change", () => {
    const f = open();
    const file = firstFile(join(f.root, "tasks"));
    const cache = new StatCache<string>();
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

  test("is dropped when it grows past its bound", () => {
    const f = open();
    const files = readdirSync(join(f.root, "tasks")).map((n) => join(f.root, "tasks", n));
    const cache = new StatCache<number>(2);
    for (const file of files) cache.read(file, () => 1);
    expect(cache.size).toBeLessThanOrEqual(2);
  });
});
