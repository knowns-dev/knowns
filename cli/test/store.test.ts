// Store init and layout (internal/storage/store.go).
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSchema } from "../src/models/config.ts";
import { Store, StorePaths } from "../src/storage/core/index.ts";
import { parseJsonPreservingNumbers } from "../src/storage/core/util.ts";
import { fixtureFiles, readFixture } from "./helpers/fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "knowns-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Store.init", () => {
  test("creates the directory layout the Go binary creates", () => {
    const root = join(dir, "proj", ".knowns");
    const store = Store.open(root);
    store.init("My Project");

    // Directories Go's Store.Init creates (the fixture shows the same layout after `knowns init`).
    for (const d of [
      "tasks",
      "docs",
      "archive",
      "versions",
      "templates",
      "imports",
      ".search",
      "memory",
      "decisions",
    ]) {
      expect(statSync(join(root, d)).isDirectory(), d).toBe(true);
    }
    const goFiles = new Set(fixtureFiles("empty").map((f) => f.replace(".knowns/", "")));
    for (const f of [
      "config.json",
      "time.json",
      "time-entries.json",
      "workspaces.json",
      "chats.json",
    ]) {
      expect(goFiles.has(f), `Go init writes ${f}`).toBe(true);
      expect(existsSync(join(root, f)), f).toBe(true);
    }
    expect(store.projectRoot).toBe(join(dir, "proj"));
  });

  test("the empty-state files are byte-identical to what Go wrote", () => {
    const root = join(dir, "bytes", ".knowns");
    Store.open(root).init("x");
    for (const f of ["time.json", "time-entries.json", "workspaces.json", "chats.json"]) {
      expect(readFileSync(join(root, f), "utf8"), f).toBe(readFixture("empty", `.knowns/${f}`));
    }
  });

  test("config.json is canonical, valid, and has the same keys as Go's default project", () => {
    const root = join(dir, "cfg", ".knowns");
    Store.open(root).init("My Project");
    const text = readFileSync(join(root, "config.json"), "utf8");
    const project = projectSchema.parse(parseJsonPreservingNumbers(text));
    expect(project).toMatchObject({ name: "My Project", id: "My-Project", schemaVersion: 1 });
    expect(text.endsWith("}\n")).toBe(true);

    const goConfig = parseJsonPreservingNumbers(
      readFixture("empty", ".knowns/config.json"),
    ) as Record<string, unknown>;
    const ours = parseJsonPreservingNumbers(text) as Record<string, unknown>;
    // `knowns init` (the CLI) adds platform and git settings on top of Store.Init; everything the
    // store layer writes must also be present, with identical values, in Go's init output.
    const oursSettings = ours.settings as Record<string, unknown>;
    const goSettings = goConfig.settings as Record<string, unknown>;
    for (const key of Object.keys(oursSettings)) {
      expect(oursSettings[key], `settings.${key}`).toEqual(goSettings[key]);
    }
    expect(ours.schemaVersion).toBe(goConfig.schemaVersion);
    expect(Object.keys(ours).sort()).toEqual([
      "createdAt",
      "id",
      "name",
      "schemaVersion",
      "settings",
    ]);
    // keys are sorted in the file, like Go's writeCanonicalJSON
    const topKeys = [...text.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
    expect(topKeys).toEqual([...topKeys].sort());
  });

  test("never overwrites existing files", () => {
    const root = join(dir, "keep", ".knowns");
    const store = Store.open(root);
    store.init("a");
    writeFileSync(join(root, "config.json"), '{"keep":true}\n');
    writeFileSync(join(root, "time.json"), '{"active":[{"taskId":"x"}]}\n');
    store.init("b");
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe('{"keep":true}\n');
    expect(readFileSync(join(root, "time.json"), "utf8")).toContain('"taskId"');
    expect(readdirSync(root).filter((f) => f.startsWith(".tmp-knowns-"))).toEqual([]);
  });

  test("an empty name falls back to 'knowns'", () => {
    const root = join(dir, "noname", ".knowns");
    Store.open(root).init("");
    expect(
      projectSchema.parse(
        parseJsonPreservingNumbers(readFileSync(join(root, "config.json"), "utf8")),
      ).name,
    ).toBe("knowns");
  });
});

describe("StorePaths", () => {
  test("lays out every location under the knowledge root", () => {
    const p = new StorePaths("/k");
    expect([
      p.config,
      p.tasksDir,
      p.archiveDir,
      p.docsDir,
      p.memoryDir,
      p.decisionsDir,
      p.historyDir,
      p.semanticDb,
    ]).toEqual(
      [
        "/k/config.json",
        "/k/tasks",
        "/k/archive",
        "/k/docs",
        "/k/memory",
        "/k/decisions",
        "/k/history",
        "/k/.search/index.db",
      ].map((x) => join(x)),
    );
  });

  test("lock paths use the file names of internal/storage/*_lock*.go", () => {
    const root = "/k";
    const store = new Store(root, "/p");
    expect(store.lockPaths.taskLifecycle()).toBe(join(root, ".search/locks/tasks.lock"));
    expect(store.lockPaths.decisionLifecycle()).toBe(join(root, ".search/locks/decisions.lock"));
    expect(store.lockPaths.decisionMemoryMigration()).toBe(
      join(root, ".search/locks/decision-memory-migration.lock"),
    );
    expect(store.lockPaths.qdrantWatermark()).toBe(
      join(root, ".search/locks/qdrant-watermarks.lock"),
    );
  });
});
