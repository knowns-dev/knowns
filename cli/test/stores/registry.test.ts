// Registry (internal/registry/registry.go).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath } from "../../src/storage/core/index.ts";
import { Registry } from "../../src/storage/stores/registry.ts";
import { goTool } from "./cfg-go.ts";

const tmp = mkdtempSync(join(tmpdir(), "knowns-reg-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const d = join(tmp, `t${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const repo = (dir: string, name: string): string => {
  const p = join(dir, name);
  mkdirSync(join(p, ".knowns"), { recursive: true });
  writeFileSync(join(p, ".knowns", "config.json"), "{}\n");
  return canonicalPath(p);
};

/** Load + Save with the real Go registry package. */
const GO_RESAVE = `package main

import (
	"fmt"
	"os"

	"github.com/howznguyen/knowns/internal/registry"
)

func main() {
	r := registry.NewRegistryWithPath(os.Args[1])
	if err := r.Load(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := r.Save(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
`;
const goResave = (file: string): boolean => {
  const exe = goTool("regresave", GO_RESAVE);
  if (!exe) return false;
  const res = Bun.spawnSync([exe, file]);
  expect(res.exitCode, res.stderr.toString()).toBe(0);
  return true;
};

const SAMPLE = [
  { id: "aaa111", name: "one", path: "/nonexistent/one", lastUsed: "2026-11-03T10:00:00Z" },
  {
    id: "bbb222",
    name: "two",
    path: "/nonexistent/two",
    lastUsed: "2026-11-03T17:00:00.123456+07:00",
    store: { name: "team", project: "p2", remote: "git@example.com:t/x.git" },
    machine: { serverPort: 6420, lsp: { enabled: true, note: "a<b&c" } },
  },
];

describe("read", () => {
  test("missing file is empty", () => {
    const r = new Registry(join(fresh(), "registry.json"));
    r.load();
    expect(r.list()).toEqual([]);
  });

  test("a UTF-8 BOM registry.json is read correctly", () => {
    const dir = fresh();
    const file = join(dir, "registry.json");
    writeFileSync(file, `\uFEFF${JSON.stringify(SAMPLE, null, 2)}`);
    const r = new Registry(file);
    r.loadReadOnly();
    expect(r.list().map((p) => p.id)).toEqual(["aaa111", "bbb222"]);
    expect(r.list()[1]?.store?.remote).toBe("git@example.com:t/x.git");
    // Writing it back drops the BOM and is otherwise the canonical form.
    r.load();
    r.save();
    expect(readFileSync(file, "utf8").startsWith("[")).toBe(true);
  });

  test("duplicate spellings collapse (last wins) and the repair is written back", () => {
    const dir = fresh();
    const real = repo(dir, "proj");
    const link = join(dir, "link");
    symlinkSync(real, link);
    const file = join(dir, "registry.json");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "a", name: "proj", path: real, lastUsed: "2026-01-01T00:00:00Z" },
        { id: "b", name: "proj", path: real, lastUsed: "2026-01-02T00:00:00Z" },
      ]),
    );
    const r = new Registry(file);
    r.load();
    expect(r.list().map((p) => p.id)).toEqual(["b"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
  });
});

describe("write", () => {
  test("save format: MarshalIndent, no trailing newline, Go field order", () => {
    const file = join(fresh(), "registry.json");
    writeFileSync(file, JSON.stringify(SAMPLE));
    const r = new Registry(file);
    r.load();
    r.save();
    const text = readFileSync(file, "utf8");
    expect(text.endsWith("\n")).toBe(false);
    expect(text.startsWith('[\n  {\n    "id": "aaa111",\n    "name": "one",')).toBe(true);
    expect(text).toContain('"a<b&c"'.replace("<", "\\u003c").replace("&", "\\u0026"));
  });

  test("an empty registry saves as []", () => {
    const file = join(fresh(), "registry.json");
    const r = new Registry(file);
    r.load();
    r.save();
    expect(readFileSync(file, "utf8")).toBe("[]");
  });

  test("load+save is byte-identical to Go's load+save", () => {
    const dir = fresh();
    const tsFile = join(dir, "ts.json");
    const goFile = join(dir, "go.json");
    writeFileSync(tsFile, JSON.stringify(SAMPLE));
    writeFileSync(goFile, JSON.stringify(SAMPLE));
    const r = new Registry(tsFile);
    r.load();
    r.save();
    if (!goResave(goFile)) return;
    expect(readFileSync(tsFile, "utf8")).toBe(readFileSync(goFile, "utf8"));
  });

  test("add / setActive / remove / getActive / scan", () => {
    const dir = fresh();
    const a = repo(dir, "alpha");
    const b = repo(dir, "beta");
    const file = join(dir, "reg", "registry.json");
    const r = new Registry(file);
    r.load();

    const pa = r.add(a);
    expect(pa.id).toMatch(/^[0-9a-z]{6}$/);
    expect(pa.name).toBe("alpha");
    expect(r.add(a).id).toBe(pa.id); // no duplicate
    expect(r.list()).toHaveLength(1);
    expect(pa.lastUsed).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/);

    expect(() => r.add(join(dir, "missing"))).toThrow(/no \.knowns\/ directory found/);
    mkdirSync(join(dir, "empty", ".knowns"), { recursive: true });
    expect(() => r.add(join(dir, "empty"))).toThrow(/no config\.json found/);

    const added = r.scan([dir]);
    expect(added.map((p) => p.name)).toEqual(["beta"]);
    const pb = r.findByPath(b);
    expect(pb).toBeDefined();

    r.setActive(pa.id);
    expect(r.getActive()?.id).toBe(pa.id);
    expect(() => r.setActive("nope")).toThrow("project nope not found");

    // Persisted and Go can re-read it without changing a byte.
    const persisted = readFileSync(file, "utf8");
    expect(JSON.parse(persisted)).toHaveLength(2);
    const copy = join(dir, "copy.json");
    writeFileSync(copy, persisted);
    if (goResave(copy)) expect(readFileSync(copy, "utf8")).toBe(persisted);

    r.remove(pa.id);
    expect(r.list().map((p) => p.id)).toEqual([pb?.id as string]);
    expect(() => r.remove("nope")).toThrow("project nope not found");
  });

  test("store links: addStoreLinked, setMachine, clearStore, validation", () => {
    const dir = fresh();
    const file = join(dir, "registry.json");
    const proj = join(dir, "code");
    mkdirSync(proj);
    const r = new Registry(file);
    r.load();
    expect(() => r.addStoreLinked(proj, { name: "..", project: "p" })).toThrow(
      /single path segment/,
    );
    expect(() => r.addStoreLinked(proj, { name: "team", project: "p" })).toThrow(
      /no initialized project folder/,
    );
    mkdirSync(join(dir, "stores", "team", "p"), { recursive: true });
    writeFileSync(join(dir, "stores", "team", "p", "config.json"), "{}\n");
    const p = r.addStoreLinked(proj, { name: "team", project: "p" });
    expect(r.findStoreLinked(proj)?.id).toBe(p.id);
    expect(r.findByKnowledgeRoot(join(dir, "stores", "team", "p"))?.id).toBe(p.id);

    r.setMachine(proj, { serverPort: 1234 });
    expect(r.findByPath(proj)?.machine).toEqual({ serverPort: 1234 });
    const copy = join(dir, "copy.json");
    writeFileSync(copy, readFileSync(file));
    if (goResave(copy)) expect(readFileSync(copy, "utf8")).toBe(readFileSync(file, "utf8"));
    r.setMachine(proj, {});
    expect(r.findByPath(proj)?.machine).toBeUndefined();
    r.clearStore(proj);
    expect(r.findByPath(proj)?.store).toBeUndefined();
    expect(() => r.clearStore(proj)).toThrow(/no store is linked/);
    expect(() => r.setMachine(proj, { a: 1 })).toThrow(/no store is linked/);
  });
});
