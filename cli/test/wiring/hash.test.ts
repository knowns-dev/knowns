// One canonical hash path: stores take the hash from history, and what a store reads equals what
// the history chain recorded for the same entity.
import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createStorage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/store.ts";
import { canonicalDocHash, canonicalTaskHash } from "../../src/storage/history/index.ts";
import { fixtureNames, fixtureRoot } from "../helpers/fixtures.ts";

const SRC = resolve(import.meta.dir, "..", "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith(".generated.ts")) out.push(p);
  }
  return out;
}

describe("single canonical hash implementation", () => {
  const files = sourceFiles(SRC).map((p) => ({ p, text: readFileSync(p, "utf8") }));
  const definers = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.p);

  test("the optional hook is gone", () => {
    expect(definers(/canonicalHashers|registerCanonicalHashers/)).toEqual([]);
  });

  test("each canonical hash is defined exactly once, in history/entities.ts", () => {
    const entities = join(SRC, "storage", "history", "entities.ts");
    for (const name of [
      "canonicalTaskHash",
      "canonicalDocHash",
      "canonicalMemoryHash",
      "hashSnapshot",
      "taskToSnapshot",
      "docToSnapshot",
    ]) {
      const re = new RegExp(`(?:function|const)\\s+${name}\\b`);
      expect(definers(re), name).toEqual([entities]);
    }
  });

  test("stores compute no hash of their own; history does not import stores", () => {
    const stores = files.filter((f) => f.p.includes(join("storage", "stores")));
    for (const f of stores) expect(/sha256|createHash/.test(f.text), f.p).toBe(false);
    const history = files.filter((f) => f.p.includes(join("storage", "history")));
    for (const f of history) expect(/from "\.\.\/stores\//.test(f.text), f.p).toBe(false);
    const core = files.filter((f) => f.p.includes(join("storage", "core")));
    for (const f of core) expect(/from "\.\.\/(stores|history)\//.test(f.text), f.p).toBe(false);
  });
});

describe("store-read canonicalHash equals the history chain", () => {
  for (const name of fixtureNames) {
    if (!existsSync(join(fixtureRoot(name), ".knowns", "tasks"))) continue;
    // A copy: reading history creates lock files, which must not land in the golden fixtures.
    const copy = mkdtempSync(join(tmpdir(), `knowns-hash-${name}-`));
    cpSync(fixtureRoot(name), copy, { recursive: true });
    afterAll(() => rmSync(copy, { recursive: true, force: true }));
    const storage = createStorage(Store.open(join(copy, ".knowns")));

    test(`${name}: tasks`, async () => {
      let checked = 0;
      for (const task of storage.tasks.listAll()) {
        expect(task.canonicalHash).toBe(canonicalTaskHash(task));
        expect(task.canonicalHash).toBeTruthy();
        if (!storage.history.hasHistory("task", task.id)) continue;
        const { records } = await storage.history.read("task", task.id);
        const head = (records ?? []).at(-1);
        expect(head, task.id).toBeDefined();
        expect(task.canonicalHash, task.id).toBe(head?.newHash as string);
        checked++;
      }
      if (name === "full") expect(checked).toBeGreaterThanOrEqual(9);
    });

    test(`${name}: docs`, async () => {
      let checked = 0;
      for (const doc of storage.docs.list()) {
        expect(doc.canonicalHash).toBe(canonicalDocHash(doc));
        expect(doc.canonicalHash).toBeTruthy();
        const id = doc.id as string;
        if (!storage.history.hasHistory("doc", id)) continue;
        const { records } = await storage.history.read("doc", id);
        const head = (records ?? []).at(-1);
        expect(doc.canonicalHash, doc.path).toBe(head?.newHash as string);
        checked++;
      }
      if (name === "full") expect(checked).toBeGreaterThanOrEqual(4);
    });
  }
});
