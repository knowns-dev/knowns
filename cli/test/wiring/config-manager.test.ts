// ConfigStore null vs empty, the schema version a new project is stamped with, and
// Manager.switch registering through the real Registry.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSIONS } from "../../src/models/schema-version.ts";
import { Manager } from "../../src/storage/core/manager.ts";
import { Store } from "../../src/storage/core/store.ts";
import { ConfigStore } from "../../src/storage/stores/config-store.ts";
import { currentSchemaVersion, MIGRATIONS } from "../../src/storage/stores/migrations.ts";
import { Registry } from "../../src/storage/stores/registry.ts";
import { fixtureNames, fixtureRoot } from "../helpers/fixtures.ts";
import { cleanup, hasGo, runGo } from "../history/helpers.ts";

const tmp = mkdtempSync(join(tmpdir(), "knowns-wiring-"));
afterAll(() => cleanup(tmp));
let n = 0;
const fresh = (): string => {
  const d = join(tmp, `t${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

describe("config null vs empty", () => {
  for (const name of fixtureNames) {
    test(`${name}: load then save is byte-identical`, () => {
      const dir = fresh();
      const raw = readFileSync(join(fixtureRoot(name), ".knowns", "config.json"), "utf8");
      writeFileSync(join(dir, "config.json"), raw);
      const cs = new ConfigStore(dir);
      cs.save(cs.load());
      expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(stripBom(raw));
    });
  }

  const cases: [string, string, unknown][] = [
    ["null", '"statuses":null,', null],
    ["absent", "", null],
    ["empty", '"statuses":[],', []],
  ];
  for (const [label, fragment, expected] of cases) {
    test(`statuses ${label} survives load then save`, () => {
      const dir = fresh();
      writeFileSync(
        join(dir, "config.json"),
        `{"name":"x","id":"x","createdAt":"2026-01-01T00:00:00Z","schemaVersion":1,"settings":{${fragment}"defaultPriority":"medium"}}`,
      );
      const cs = new ConfigStore(dir);
      const project = cs.load();
      expect(project.settings.statuses).toEqual(expected as string[] | null);
      cs.save(project);
      const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      expect(Object.hasOwn(saved.settings, "statuses")).toBe(true);
      expect(saved.settings.statuses).toEqual(expected);
    });
  }

  test.skipIf(!hasGo())("matches what Go writes for null, absent and empty statuses", () => {
    for (const [, fragment] of cases) {
      const dir = fresh();
      const root = join(dir, ".knowns");
      mkdirSync(root, { recursive: true });
      const raw = `{"name":"x","id":"x","createdAt":"2026-01-01T00:00:00Z","schemaVersion":0,"settings":{${fragment}"defaultPriority":"medium"}}`;
      writeFileSync(join(root, "config.json"), raw);
      const home = join(dir, "home");
      mkdirSync(home);
      // `migrate --write` saves the config through the Go struct.
      const go = runGo(dir, home, ["migrate", "--write"]);
      expect(go.code, go.stderr + go.stdout).toBe(0);
      const goBytes = readFileSync(join(root, "config.json"), "utf8");

      const tsDir = fresh();
      writeFileSync(join(tsDir, "config.json"), raw);
      const cs = new ConfigStore(tsDir);
      const project = cs.load();
      project.schemaVersion = currentSchemaVersion();
      cs.save(project);
      expect(readFileSync(join(tsDir, "config.json"), "utf8")).toBe(goBytes);
    }
  });
});

describe("schema version of new projects", () => {
  test("core stamps the migration registry's current version", () => {
    expect(SCHEMA_VERSIONS).toEqual(MIGRATIONS.map((m) => m.version).sort((a, b) => a - b));
    const dir = fresh();
    const root = join(dir, ".knowns");
    Store.open(root).init("Fresh Project");
    const cfg = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
    expect(cfg.schemaVersion).toBe(currentSchemaVersion());
    expect(new ConfigStore(root).load().schemaVersion).toBe(currentSchemaVersion());
  });

  test("ConfigStore.initDefault and Store.init write the same bytes apart from createdAt", () => {
    const a = fresh();
    const b = fresh();
    Store.open(join(a, ".knowns")).init("Same Name");
    mkdirSync(join(b, ".knowns"), { recursive: true });
    new ConfigStore(join(b, ".knowns")).initDefault("Same Name");
    const norm = (p: string) =>
      readFileSync(join(p, ".knowns", "config.json"), "utf8").replace(/"createdAt": "[^"]+"/, "");
    expect(norm(a)).toBe(norm(b));
  });
});

describe("Manager.switch through the Registry", () => {
  function projectDir(initialized = true): string {
    const dir = fresh();
    if (initialized) Store.open(join(dir, ".knowns")).init("proj");
    else mkdirSync(join(dir, ".knowns"), { recursive: true });
    return dir;
  }

  test("registers and activates the project", () => {
    const dir = projectDir();
    const reg = new Registry(join(fresh(), "registry.json"));
    const manager = new Manager(undefined, reg);
    const store = manager.switch(dir);
    expect(store.root).toBe(join(dir, ".knowns"));
    expect(manager.getStore()).toBe(store);
    const saved = new Registry(reg.filePath);
    saved.load();
    expect(saved.projects).toHaveLength(1);
    expect(saved.getActive()?.path).toBe(saved.projects[0]?.path);
  });

  test("a registry add failure (no config.json) does not abort the switch", () => {
    const dir = projectDir(false);
    const reg = new Registry(join(fresh(), "registry.json"));
    expect(() => reg.add(dir)).toThrow(/config\.json/);
    const manager = new Manager(undefined, reg);
    const store = manager.switch(dir);
    expect(store.root).toBe(join(dir, ".knowns"));
    expect(manager.getStore()).toBe(store);
    expect(reg.projects).toHaveLength(0);
  });

  test("a registry write failure does not abort the switch", () => {
    const dir = projectDir();
    const blocker = join(fresh(), "file");
    writeFileSync(blocker, "not a directory");
    const reg = new Registry(join(blocker, "registry.json"));
    const manager = new Manager(undefined, reg);
    expect(manager.switch(dir).root).toBe(join(dir, ".knowns"));
  });

  test("a directory without .knowns still fails", () => {
    const manager = new Manager(undefined, new Registry(join(fresh(), "registry.json")));
    expect(() => manager.switch(fresh())).toThrow(/no \.knowns\/ directory/);
  });
});
