// ConfigStore (internal/storage/config_store.go, config_split.go).
import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/storage/core/index.ts";
import { ConfigStore, projectToGo } from "../../src/storage/stores/config-store.ts";
import { Registry } from "../../src/storage/stores/registry.ts";
import { fixtureRoot, readFixture } from "../helpers/fixtures.ts";
import { goCli, hasGoCli, runGo } from "./cfg-go.ts";

const tmp = mkdtempSync(join(tmpdir(), "knowns-cfg-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const d = join(tmp, `t${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

describe("fixtures round trip", () => {
  for (const name of ["empty", "full", "active-timer", "bom-config"]) {
    test(`${name}: load then save is byte-identical (BOM stripped)`, () => {
      const dir = fresh();
      const original = stripBom(readFixture(name, ".knowns/config.json"));
      writeFileSync(join(dir, "config.json"), readFixture(name, ".knowns/config.json"));
      const cs = new ConfigStore(dir);
      cs.save(cs.load());
      expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(original);
    });

    test(`${name}: set of an unchanged value is byte-identical`, () => {
      const dir = fresh();
      const original = stripBom(readFixture(name, ".knowns/config.json"));
      writeFileSync(join(dir, "config.json"), readFixture(name, ".knowns/config.json"));
      const cs = new ConfigStore(dir);
      cs.set("settings.defaultPriority", cs.get("settings.defaultPriority"));
      expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(original);
    });
  }
});

describe("BOM config.json", () => {
  test("is read correctly", () => {
    const cs = new ConfigStore(join(fixtureRoot("bom-config"), ".knowns"));
    const p = cs.load();
    expect(p.name.length).toBeGreaterThan(0);
    expect((p.settings.statuses ?? []).length).toBeGreaterThan(0);
    expect(cs.get("name")).toBe(p.name);
  });
});

describe("get / set", () => {
  test("dot-notation get, missing key errors", () => {
    const dir = fresh();
    cpSync(join(fixtureRoot("full"), ".knowns", "config.json"), join(dir, "config.json"));
    const cs = new ConfigStore(dir);
    expect(cs.get("settings.serverPort")).toBe(6420);
    expect(cs.get("settings.gitTracking.docs")).toBe(true);
    expect(() => cs.get("settings.nope")).toThrow('config key "settings.nope" not found');
  });

  test("set keeps unknown fields, canonicalizes the id prefix, and validates", () => {
    const dir = fresh();
    writeFileSync(
      join(dir, "config.json"),
      '{"name":"x","id":"x","createdAt":"2026-01-01T00:00:00Z","future":{"a":1.0},' +
        '"settings":{"defaultPriority":"medium","statuses":["todo"],"newThing":[1,2]}}',
    );
    const cs = new ConfigStore(dir);
    cs.set("settings.defaultTaskIdPrefix", " ab ");
    const out = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(out.settings.defaultTaskIdPrefix).toBe("AB");
    expect(out.future).toEqual({ a: 1 });
    expect(out.settings.statuses).toEqual(["todo"]);
    expect(out.settings.newThing).toEqual([1, 2]);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toContain('"a": 1.0');
    expect(() => cs.set("settings.defaultTaskIdPrefix", "1!!")).toThrow();
    expect(() => cs.set("settings.taskLifecycle.archiveAfter", "bogus")).toThrow(/archiveAfter/);
  });

  test("save drops unknown keys and omits empty omitempty fields like the Go struct", () => {
    const g = projectToGo({
      name: "n",
      id: "i",
      createdAt: "2026-01-01T00:00:00Z",
      unknown: 1,
      settings: { defaultPriority: "", statuses: undefined, editor: "", serverPort: 0 },
    });
    expect(g).toEqual({
      name: "n",
      id: "i",
      createdAt: "2026-01-01T00:00:00Z",
      settings: { defaultPriority: "", statuses: null },
    });
  });
});

describe("Store.init config", () => {
  test("a TypeScript-initialised project is accepted by ConfigStore and Go", () => {
    const proj = fresh();
    const store = Store.open(join(proj, ".knowns"));
    store.init("My Proj");
    const cs = new ConfigStore(store.root);
    cs.initDefault("My Proj");
    const p = cs.load();
    expect(p.schemaVersion).toBe(1);
    if (!hasGoCli()) return;
    const home = fresh();
    const r = runGo(["validate", "--json"], proj, home);
    expect(r.code, r.out + r.err).toBe(0);
    cs.set("settings.defaultAssignee", "@ts");
    const g = runGo(["config", "get", "settings.defaultAssignee", "--plain"], proj, home);
    expect(g.out).toContain("@ts");
    expect(goCli()).toBeDefined();
  });

  test("Go config set output is re-readable and TS rewrites it identically", () => {
    if (!hasGoCli()) return;
    const proj = fresh();
    const home = fresh();
    Store.open(join(proj, ".knowns")).init("p");
    expect(runGo(["config", "set", "settings.editor", "vim"], proj, home).code).toBe(0);
    expect(runGo(["config", "set", "settings.defaultTaskIdPrefix", "zz"], proj, home).code).toBe(0);
    const cfg = join(proj, ".knowns", "config.json");
    const goBytes = readFileSync(cfg, "utf8");
    const cs = new ConfigStore(join(proj, ".knowns"));
    cs.save(cs.load());
    expect(readFileSync(cfg, "utf8")).toBe(goBytes);
    cs.set("settings.editor", "vim");
    expect(readFileSync(cfg, "utf8")).toBe(goBytes);
  });
});

describe("store-linked project split (D13)", () => {
  test("personal and machine settings leave config.json and are overlaid on load", () => {
    const home = fresh();
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const repo = fresh();
      const kn = join(home, ".knowns", "stores", "team", "proj");
      mkdirSync(kn, { recursive: true });
      cpSync(join(fixtureRoot("empty"), ".knowns", "config.json"), join(kn, "config.json"));
      const reg = new Registry(join(home, ".knowns", "registry.json"));
      reg.load();
      reg.addStoreLinked(repo, { name: "team", project: "proj" });

      const cs = new ConfigStore(kn, repo);
      cs.set("settings.defaultAssignee", "@me");
      cs.set("settings.serverPort", 7777);
      cs.set("settings.editor", "code");

      const teamFile = JSON.parse(readFileSync(join(kn, "config.json"), "utf8"));
      expect(teamFile.settings.defaultAssignee).toBeUndefined();
      expect(teamFile.settings.serverPort).toBeUndefined();
      expect(teamFile.settings.editor).toBe("code");

      const loaded = cs.load();
      expect(loaded.settings.defaultAssignee).toBe("@me");
      expect(loaded.settings.serverPort).toBe(7777);

      const personal = JSON.parse(readFileSync(join(home, ".knowns", "settings.json"), "utf8"));
      const id = reg.findStoreLinked(repo)?.id as string;
      expect(personal.projectSettings[id]).toEqual({
        defaultAssignee: "@me",
        platforms: ["claude-code", "agents"],
      });
      const regFile = JSON.parse(readFileSync(join(home, ".knowns", "registry.json"), "utf8"));
      expect(regFile[0].machine).toEqual({ serverPort: 7777 });
      expect(existsSync(join(home, ".knowns", "registry.json"))).toBe(true);
    } finally {
      process.env.HOME = oldHome;
    }
  });
});

describe("Go zero values", () => {
  test("an empty config object loads like json.Unmarshal into models.Project", () => {
    const root = join(tmp, "zero", ".knowns");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "config.json"), "{}\n");
    const p = new ConfigStore(root).load();
    expect(p.name).toBe("");
    expect(p.id).toBe("");
    expect(p.createdAt).toBe("0001-01-01T00:00:00Z");
    expect(p.settings.defaultPriority).toBe("");
  });
});
