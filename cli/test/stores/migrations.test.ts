// Config schema migrations (internal/storage/migrations.go) against the Go `knowns migrate`.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../src/storage/stores/config-store.ts";
import {
  applyMigrations,
  currentSchemaVersion,
  type Migration,
  migrationResultJson,
  needsMigration,
  pendingMigrations,
  previewMigrations,
} from "../../src/storage/stores/migrations.ts";
import { fixtureRoot } from "../helpers/fixtures.ts";
import { hasGoCli, runGo } from "./cfg-go.ts";

const tmp = mkdtempSync(join(tmpdir(), "knowns-mig-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** A project at schema version 0 (the fixture config with the semanticSearch block patched in). */
function projectAt0(semantic: Record<string, unknown> | undefined): string {
  const dir = join(tmp, `p${n++}`);
  cpSync(join(fixtureRoot("empty"), ".knowns"), join(dir, ".knowns"), { recursive: true });
  const cfgPath = join(dir, ".knowns", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  delete cfg.schemaVersion;
  if (semantic) cfg.settings.semanticSearch = semantic;
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return dir;
}

const LOCAL = {
  enabled: true,
  model: "all-MiniLM-L6-v2",
  provider: "local",
  huggingFaceId: "sentence-transformers/all-MiniLM-L6-v2",
  dimensions: 384,
  maxTokens: 256,
};

describe("registry logic", () => {
  test("current version, pending and needsMigration", () => {
    expect(currentSchemaVersion()).toBe(1);
    expect(pendingMigrations(0).map((m) => m.version)).toEqual([1]);
    expect(pendingMigrations(1)).toEqual([]);
    const reg: Migration[] = [3, 1, 2].map((version) => ({
      version,
      description: "",
      apply: () => [],
    }));
    expect(pendingMigrations(1, reg).map((m) => m.version)).toEqual([2, 3]);
    expect(currentSchemaVersion(reg)).toBe(3);
    expect(needsMigration(undefined)).toBe(false);
  });

  test("apply is idempotent and preview does not mutate", () => {
    const dir = projectAt0(LOCAL);
    const cs = new ConfigStore(join(dir, ".knowns"));
    const project = cs.load();
    const before = structuredClone(project);
    const preview = previewMigrations(project);
    expect(project).toEqual(before);
    expect(preview.applied).toEqual([1]);
    const first = applyMigrations(project);
    expect(first.changes).toEqual(preview.changes);
    expect(project.schemaVersion).toBe(1);
    const second = applyMigrations(project);
    expect(second.applied).toEqual([]);
    expect(second.toVersion).toBe(1);
  });

  test("a project without semanticSearch only records the version", () => {
    const dir = projectAt0(undefined);
    const project = new ConfigStore(join(dir, ".knowns")).load();
    const r = applyMigrations(project);
    expect(r).toEqual({ fromVersion: 0, toVersion: 1, applied: [1], changes: [] });
  });
});

describe("parity with Go `knowns migrate`", () => {
  for (const [label, semantic] of [
    ["provider local with huggingFaceId", LOCAL],
    ["omitted provider", { enabled: true, model: "x", dimensions: 12 }],
    [
      "already ollama",
      { enabled: true, model: "nomic-embed-text", provider: "ollama", dimensions: 768 },
    ],
    ["no semanticSearch", undefined],
  ] as const) {
    test(label, () => {
      if (!hasGoCli()) return;
      const goDir = projectAt0(semantic as Record<string, unknown> | undefined);
      const tsDir = join(tmp, `ts${n++}`);
      cpSync(goDir, tsDir, { recursive: true });
      const home = mkdtempSync(join(tmp, "home-"));
      mkdirSync(home, { recursive: true });

      // Preview: same JSON.
      const prev = runGo(["migrate", "--json"], goDir, home);
      expect(prev.code, prev.err).toBe(0);
      const cs = new ConfigStore(join(tsDir, ".knowns"));
      const project = cs.load();
      expect(migrationResultJson(previewMigrations(project))).toEqual(JSON.parse(prev.out));

      // Write: same result JSON and same config.json bytes.
      const w = runGo(["migrate", "--write", "--json"], goDir, home);
      expect(w.code, w.err).toBe(0);
      const result = applyMigrations(project);
      cs.save(project);
      expect(migrationResultJson(result)).toEqual(JSON.parse(w.out));
      expect(readFileSync(join(tsDir, ".knowns", "config.json"), "utf8")).toBe(
        readFileSync(join(goDir, ".knowns", "config.json"), "utf8"),
      );
      // And Go says there is nothing left to do on the TS-written config.
      const again = runGo(["migrate", "--json"], tsDir, home);
      expect(JSON.parse(again.out).Applied).toBeNull();
    });
  }
});
