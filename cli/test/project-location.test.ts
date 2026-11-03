// internal/storage/{project_location,project_root,manager}_test.go, ported.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { registryFileSchema } from "../src/models/registry.ts";
import { parseBoundary } from "../src/schema/index.ts";
import {
  findProjectRoot,
  ignoredKnownsWarning,
  inRepoProjectRoot,
  inStoresDir,
  locateProject,
  locateProjectAt,
  locationWarnings,
  MachineRegistry,
  Manager,
  Store,
} from "../src/storage/core/index.ts";

let home: string;
const savedHome = process.env.HOME;

beforeEach(() => {
  // Left unresolved on purpose: on macOS the temp dir sits behind /var -> /private/var, the shape
  // safepath-style checks must accept for a store outside the project directory.
  home = mkdtempSync(join(tmpdir(), "knowns-loc-"));
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const mk = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  return dir;
};

function initInRepo(dir: string) {
  mkdirSync(join(dir, ".knowns"), { recursive: true });
  writeFileSync(join(dir, ".knowns", "config.json"), `{"name":"${basename(dir)}"}`);
}

/** Creates store "team" with an initialized folder and maps `code` to it, as `store link` does. */
function linkToStore(code: string): string {
  const folder = join(home, ".knowns", "stores", "team", basename(code));
  mk(folder);
  writeFileSync(join(folder, "config.json"), `{"name":"${basename(code)}"}`);
  addRegistryEntry(code, { name: "team", project: basename(code) });
  return folder;
}

function addRegistryEntry(code: string, store: { name: string; project: string }) {
  const file = join(home, ".knowns", "registry.json");
  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as unknown[]) : [];
  existing.push({
    id: `p${existing.length}`,
    name: basename(code),
    path: realpathSync(code),
    lastUsed: "2026-11-03T00:00:00Z",
    store,
  });
  mk(join(home, ".knowns"));
  writeFileSync(file, JSON.stringify(existing, null, 2));
}

const same = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
};

describe("locateProject", () => {
  test("an in-repo project behaves as before and never creates a registry", () => {
    const code = mk(join(home, "work", "legacy"));
    initInRepo(code);
    const sub = mk(join(code, "src", "pkg"));
    const loc = locateProject(sub);
    expect(loc).toEqual({ knowledgeRoot: join(code, ".knowns"), projectRoot: code });
    expect(findProjectRoot(sub)).toBe(join(code, ".knowns"));
    expect(existsSync(join(home, ".knowns", "registry.json"))).toBe(false);
  });

  test("every resolution path agrees for a store-linked project", () => {
    const code = mk(join(home, "work", "shop-web"));
    const knowledge = linkToStore(code);
    const sub = mk(join(code, "web", "src"));

    const walk = locateProject(sub);
    const exact = locateProjectAt(code);
    const found = findProjectRoot(sub);
    const reopened = Store.open(knowledge);
    const switched = new Manager(
      undefined,
      new MachineRegistry(join(home, ".knowns", "registry.json")),
    ).switch(code);
    const reg = new MachineRegistry(join(home, ".knowns", "registry.json"));
    reg.loadReadOnly();
    const switchedLoaded = new Manager(undefined, reg).switch(code);

    const results: Record<string, [string, string]> = {
      "walk-up": [walk.knowledgeRoot, walk.projectRoot],
      exact: [exact.knowledgeRoot, exact.projectRoot],
      findProjectRoot: [found, code],
      "Store.open": [reopened.root, reopened.projectRoot],
      "Manager.switch": [switched.root, switched.projectRoot],
      "switch (loaded)": [switchedLoaded.root, switchedLoaded.projectRoot],
    };
    for (const [name, [k, p]] of Object.entries(results)) {
      expect(same(k, knowledge), `${name} knowledge ${k}`).toBe(true);
      expect(same(p, code), `${name} project ${p}`).toBe(true);
    }
    expect(existsSync(join(code, ".knowns"))).toBe(false);
  });

  test("a store link wins over an in-repo .knowns/ and warns", () => {
    const code = mk(join(home, "work", "shop-api"));
    initInRepo(code);
    const knowledge = linkToStore(code);
    for (const loc of [locateProject(code), locateProjectAt(code)]) {
      expect(same(loc.knowledgeRoot, knowledge)).toBe(true);
      expect(loc.ignoredKnowns).toBe(join(code, ".knowns"));
      const msg = ignoredKnownsWarning(loc);
      expect(msg).toContain(join(code, ".knowns"));
      expect(msg).toContain("team");
      expect(locationWarnings(loc)).toEqual([msg]);
    }
  });

  test("the nearest enclosing project wins", () => {
    const outer = mk(join(home, "work", "mono"));
    initInRepo(outer);
    const inner = mk(join(outer, "apps", "shop-web"));
    const knowledge = linkToStore(inner);
    const loc = locateProject(inner);
    expect(same(loc.knowledgeRoot, knowledge)).toBe(true);
    expect(loc.projectRoot).toBe(inner);
    expect(locateProject(mk(join(outer, "docs"))).projectRoot).toBe(outer);
  });

  test("a broken store mapping falls back to the in-repo project and warns; without one it errors", () => {
    const code = mk(join(home, "work", "broken"));
    const folder = linkToStore(code);
    rmSync(join(folder, "config.json"));
    expect(() => locateProject(code)).toThrow(
      /is linked to store "team".*missing or not initialized/,
    );
    initInRepo(code);
    const loc = locateProject(code);
    expect(loc.knowledgeRoot).toBe(join(code, ".knowns"));
    expect(loc.brokenStore).toEqual({ name: "team", project: "broken" });
    expect(locationWarnings(loc)[0]).toContain(`using ${join(code, ".knowns")} meanwhile.`);
  });

  test("no project anywhere is an error naming the start directory", () => {
    const empty = mk(join(home, "nothing", "here"));
    expect(() => locateProject(empty)).toThrow(
      `no .knowns/ directory found (started from ${empty})`,
    );
    expect(() => locateProjectAt(empty)).toThrow(
      /no initialized .knowns\/ directory and no linked store/,
    );
  });

  test("a BOM-prefixed registry.json is read (Go 0.34.1 ignores it; the TypeScript build must not)", () => {
    const code = mk(join(home, "work", "bom"));
    const folder = join(home, ".knowns", "stores", "team", "bom");
    mk(folder);
    writeFileSync(join(folder, "config.json"), "{}");
    const entry = [
      {
        id: "a",
        name: "bom",
        path: realpathSync(code),
        lastUsed: "2026-11-03T00:00:00Z",
        store: { name: "team", project: "bom" },
      },
    ];
    writeFileSync(join(home, ".knowns", "registry.json"), `﻿${JSON.stringify(entry)}`);
    expect(same(locateProject(code).knowledgeRoot, folder)).toBe(true);
  });

  test("a corrupt registry means no store mappings", () => {
    const code = mk(join(home, "work", "corrupt"));
    initInRepo(code);
    mk(join(home, ".knowns"));
    writeFileSync(join(home, ".knowns", "registry.json"), "{not json");
    expect(locateProject(code).knowledgeRoot).toBe(join(code, ".knowns"));
  });
});

describe("Store roots", () => {
  test("an in-repo knowledge root derives its code root from its parent", () => {
    const project = mk(join(home, "p"));
    expect(Store.open(join(project, ".knowns")).projectRoot).toBe(project);
    expect(inRepoProjectRoot(join(project, ".knowns"))).toBe(project);
  });

  test("the two roots stay independent when given separately", () => {
    const knowledge = join(home, "stores", "team", "shop-web");
    const project = join(home, "shop-web");
    const store = new Store(knowledge, project);
    expect(store.root).toBe(knowledge);
    expect(store.projectRoot).toBe(project);
    expect(store.paths.tasksDir).toBe(join(knowledge, "tasks"));
  });

  test("a store link made after an earlier lookup is seen (registry cache invalidation)", () => {
    const code = mk(join(home, "work", "late"));
    const folder = join(home, ".knowns", "stores", "team", "late");
    mk(folder);
    writeFileSync(join(folder, "config.json"), "{}");
    mk(join(home, ".knowns"));
    writeFileSync(join(home, ".knowns", "registry.json"), "[]");
    expect(same(Store.open(folder).projectRoot, code)).toBe(false);
    addRegistryEntryOverwriting(code);
    expect(same(Store.open(folder).projectRoot, code)).toBe(true);
  });

  function addRegistryEntryOverwriting(code: string) {
    writeFileSync(
      join(home, ".knowns", "registry.json"),
      JSON.stringify([
        {
          id: "late",
          name: "late",
          path: realpathSync(code),
          lastUsed: "2026-11-03T00:00:00Z",
          store: { name: "team", project: "late" },
          // padding so size changes even when mtime resolution is coarse
          machine: { pad: "x".repeat(40) },
        },
      ]),
    );
  }

  test("inStoresDir is a textual gate on <global>/.knowns/stores", () => {
    expect(inStoresDir(join(home, ".knowns", "stores", "team", "p"))).toBe(true);
    expect(inStoresDir(join(home, ".knowns", "memory"))).toBe(false);
  });
});

describe("Manager", () => {
  const fake = (parent: string, name: string) => {
    const dir = join(parent, name);
    mk(join(dir, ".knowns"));
    return dir;
  };

  test("getStore returns the initial store; activeProjectRoot reads projectRoot", () => {
    const proj = fake(home, "proj");
    const store = Store.open(join(proj, ".knowns"));
    const m = new Manager(store, undefined);
    expect(m.getStore()).toBe(store);
    expect(m.activeProjectRoot()).toBe(proj);
    expect(new Manager(undefined, undefined).activeProjectRoot()).toBe("");
  });

  test("switch opens the in-repo store of another project", () => {
    const proj1 = fake(home, "proj1");
    const proj2 = fake(home, "proj2");
    const m = new Manager(
      Store.open(join(proj1, ".knowns")),
      new MachineRegistry(join(home, "registry.json")),
    );
    const next = m.switch(proj2);
    expect(next.root).toBe(join(proj2, ".knowns"));
    expect(m.getStore()?.root).toBe(next.root);
  });

  test("switching to a path without .knowns/ fails and keeps the active store", () => {
    const proj = fake(home, "proj");
    const store = Store.open(join(proj, ".knowns"));
    const m = new Manager(store, undefined);
    expect(() => m.switch(join(home, "nonexistent"))).toThrow(/no \.knowns\/ directory at/);
    expect(m.getStore()).toBe(store);
  });
});

describe("registry file shape", () => {
  test("a registry written by Go 0.34.1 style (array of projects) validates", () => {
    const sample = [
      { id: "abc123", name: "x", path: "/p", lastUsed: "2026-11-03T13:09:22.1Z" },
      {
        id: "def456",
        name: "y",
        path: "/q",
        lastUsed: "2026-11-03T13:09:22Z",
        store: { name: "t", project: "y", remote: "git@x" },
        machine: { serverPort: 6420 },
      },
    ];
    expect(parseBoundary(registryFileSchema, sample, "registry")).toEqual(sample);
  });
});
