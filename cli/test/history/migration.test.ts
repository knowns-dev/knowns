// Legacy `.knowns/versions/*.json` to JSONL migration. The expected output is whatever the Go
// binary writes for the same legacy project: both sides migrate from byte-identical copies of one
// pristine project in the same directory (so absolute provenance paths and digests agree).
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  DocVersion,
  DocVersionHistory,
  TaskVersion,
  TaskVersionHistory,
} from "../../src/models/version.ts";
import { writeJson } from "../../src/storage/core/util.ts";
import {
  docHistoryFromRecords,
  encodeDocVersionHistory,
  encodeTaskVersionHistory,
  HistoryStore,
  normalizeDocHistory,
  rawDocSnapshot,
  resolveDocStateFromHistory,
  taskHistoryFromRecords,
  VersionStore,
} from "../../src/storage/history/index.ts";
import { cleanup, copyFixture, hasGo, jsonlLines, runGo } from "./helpers.ts";

const suite = hasGo() ? describe : describe.skip;
const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

function emptyProject() {
  const p = copyFixture("empty");
  dirs.push(dirname(p.dir));
  return p;
}

function snapshotProject(p: { dir: string }): string {
  const copy = join(dirname(p.dir), `pristine-${Math.random().toString(36).slice(2)}`);
  cpSync(p.dir, copy, { recursive: true });
  return copy;
}

function restoreProject(p: { dir: string }, pristine: string): void {
  rmSync(p.dir, { recursive: true, force: true });
  cpSync(pristine, p.dir, { recursive: true });
}

function ok(r: { code: number; stderr: string; stdout: string }) {
  expect(r.code, r.stderr + r.stdout).toBe(0);
  return r.stdout;
}

/** Create a task with Go, then turn its JSONL history into the legacy full-snapshot JSON file. */
function legacyTaskProject(mutate?: (v: TaskVersion, i: number) => void) {
  const p = emptyProject();
  const out = ok(
    runGo(p.dir, p.home, [
      "task",
      "create",
      "Legacy task",
      "-d",
      "from legacy",
      "--ac",
      "first",
      "--ac",
      "second",
    ]),
  );
  const id = /Created task (\S+):/.exec(out)?.[1] as string;
  ok(runGo(p.dir, p.home, ["task", "edit", id, "-s", "in-progress"]));
  ok(runGo(p.dir, p.home, ["task", "edit", id, "--check-ac", "1"]));
  const records = new HistoryStore(p.root).readPreview("task", id).records ?? [];
  const replay = taskHistoryFromRecords(id, records);
  const legacy: TaskVersionHistory = { taskId: id, currentVersion: records.length, versions: [] };
  replay.versions?.forEach((v, i) => {
    // The old format: id/version/timestamp/changes/snapshot only, no hashes or chain metadata.
    const lv: TaskVersion = {
      id: v.id,
      taskId: id,
      version: v.version,
      timestamp: v.timestamp,
      changes: v.changes,
      snapshot: v.snapshot,
    };
    if (v.author) lv.author = v.author;
    mutate?.(lv, i);
    legacy.versions = [...(legacy.versions ?? []), lv];
  });
  rmSync(join(p.root, "history", "tasks", `${id}.jsonl`));
  rmSync(join(p.root, "history", "locks"), { recursive: true, force: true });
  mkdirSync(join(p.root, "versions"), { recursive: true });
  writeJson(join(p.root, "versions", `task-${id}.json`), encodeTaskVersionHistory(legacy));
  return { p, id, count: records.length };
}

suite("legacy task versions migrate to the same JSONL as Go writes", () => {
  test("a verifiable legacy chain", async () => {
    const { p, id, count } = legacyTaskProject();
    const pristine = snapshotProject(p);
    // Go migrates on the next write; the first `count` lines are the migrated legacy records.
    ok(runGo(p.dir, p.home, ["task", "edit", id, "--append-notes", "after migration"]));
    const goLines = jsonlLines(p.root, "tasks", id);
    expect(goLines.length).toBe(count + 1);

    restoreProject(p, pristine);
    expect(existsSync(join(p.root, "history", "tasks", `${id}.jsonl`))).toBe(false);
    const versions = new VersionStore(p.root);
    await versions.migrateLegacyTask(id);
    const tsLines = jsonlLines(p.root, "tasks", id);
    expect(tsLines).toEqual(goLines.slice(0, count));

    // The legacy source is untouched and the migrated stream replays and is Go-readable.
    expect(readFileSync(join(p.root, "versions", `task-${id}.json`), "utf8")).toBe(
      readFileSync(join(pristine, ".knowns", "versions", `task-${id}.json`), "utf8"),
    );
    const view = runGo(p.dir, p.home, ["task", "history", id, "--plain"]);
    expect(view.code, view.stderr).toBe(0);
    expect(view.stdout).toContain(`VERSIONS: ${count}`);
  });

  test("an unverifiable legacy chain is refused identically and stays authoritative", async () => {
    const { p, id } = legacyTaskProject((v, i) => {
      if (i === 1) v.newHash = "f".repeat(64);
    });
    const pristine = snapshotProject(p);
    const go = runGo(p.dir, p.home, ["task", "edit", id, "--append-notes", "x"]);
    expect(go.code).not.toBe(0);
    expect(go.stderr + go.stdout).toContain(
      "unverified legacy chain has no verified reconcile checkpoint",
    );
    expect(existsSync(join(p.root, "history", "tasks", `${id}.jsonl`))).toBe(false);

    restoreProject(p, pristine);
    const versions = new VersionStore(p.root);
    const err = await versions.migrateLegacyTask(id).catch((e) => e as Error);
    expect((err as Error).message).toContain(
      "unverified legacy chain has no verified reconcile checkpoint",
    );
    expect(existsSync(join(p.root, "history", "tasks", `${id}.jsonl`))).toBe(false);
    expect(existsSync(join(p.root, "versions", `task-${id}.json`))).toBe(true);
  });

  test("a caller payload that differs from the provenance bytes is rejected", async () => {
    const { p, id } = legacyTaskProject();
    const path = join(p.root, "versions", `task-${id}.json`);
    const tampered: TaskVersionHistory = JSON.parse(readFileSync(path, "utf8"));
    tampered.currentVersion += 5;
    const err = await new HistoryStore(p.root)
      .migrateLegacyTask(path, id, tampered)
      .catch((e) => e as Error);
    expect((err as Error).message).toBe(
      "legacy Task input does not match the exact provenance bytes",
    );
  });

  test("migration refuses a source outside the managed versions store", async () => {
    const { p, id } = legacyTaskProject();
    const outside = join(p.dir, "elsewhere.json");
    writeFileSync(outside, readFileSync(join(p.root, "versions", `task-${id}.json`)));
    const err = await new HistoryStore(p.root)
      .migrateLegacyTask(outside, id, { taskId: id, currentVersion: 0, versions: [] })
      .catch((e) => e as Error);
    expect((err as Error).message).toBe(
      "legacy Task provenance source is outside the managed versions store",
    );
  });
});

/** Create a doc with Go, then turn its history into a legacy stable-id JSON file. */
function legacyDocProject(mutate?: (v: DocVersion, i: number) => void) {
  const p = emptyProject();
  ok(
    runGo(p.dir, p.home, [
      "doc",
      "create",
      "Legacy Guide",
      "-d",
      "legacy doc",
      "-t",
      "a,b",
      "--json",
    ]),
  );
  const docPath = "legacy-guide";
  ok(runGo(p.dir, p.home, ["doc", "edit", docPath, "-c", "# Guide\n\nsecond body"]));
  ok(runGo(p.dir, p.home, ["doc", "edit", docPath, "-a", "third line"]));
  const idFile = readFileSync(join(p.root, "docs", `${docPath}.md`), "utf8").match(/^id: (\S+)/m);
  const docId = idFile?.[1] ?? "";
  expect(docId).toMatch(/^doc-/);
  const records = new HistoryStore(p.root).readPreview("doc", docId).records ?? [];
  const replay = docHistoryFromRecords(docPath, records);
  const legacy: DocVersionHistory = {
    docId,
    docPath,
    currentPath: docPath,
    currentVersion: records.length,
    versions: [],
  };
  replay.versions?.forEach((v, i) => {
    const lv: DocVersion = {
      id: v.id,
      docId,
      docPath,
      currentPath: docPath,
      version: v.version,
      timestamp: v.timestamp,
      changes: v.changes,
      // Full state per version, as the old store kept it (replay snapshots drop section content).
      snapshot: rawDocSnapshot(resolveDocStateFromHistory(replay, v.id)),
    };
    if (v.author) lv.author = v.author;
    mutate?.(lv, i);
    legacy.versions = [...(legacy.versions ?? []), lv];
  });
  rmSync(join(p.root, "history", "docs", `${docId}.jsonl`));
  rmSync(join(p.root, "history", "locks"), { recursive: true, force: true });
  mkdirSync(join(p.root, "versions"), { recursive: true });
  // Files Go wrote were normalized first (derived changedScopes included); the migration proof
  // compares the normalized history with the bytes on disk.
  normalizeDocHistory(legacy, docId, docPath);
  writeJson(join(p.root, "versions", `docid-${docId}.json`), encodeDocVersionHistory(legacy));
  return { p, docId, docPath, count: records.length };
}

async function tsMigrateDoc(p: { root: string }, docPath: string) {
  const versions = new VersionStore(p.root);
  const state = await versions.history; // keep the history store warm; no-op
  void state;
  const file = readFileSync(join(p.root, "docs", `${docPath}.md`), "utf8");
  const fm = file.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const yaml = fm?.[1] ?? "";
  const field = (k: string) => yaml.match(new RegExp(`^${k}: ?'?(.*?)'?$`, "m"))?.[1] ?? "";
  const tags = [...yaml.matchAll(/^ {2}- (.+)$/gm)].map((m) => m[1] as string);
  await versions.migrateLegacyDocPathsWithCurrent(
    {
      id: field("id"),
      path: docPath,
      title: field("title"),
      description: field("description") || undefined,
      content: fm?.[2] ?? "",
      tags: tags.length > 0 ? tags : undefined,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    docPath,
  );
}

suite("legacy doc versions migrate to the same JSONL as Go writes", () => {
  test("a verifiable legacy chain", async () => {
    const { p, docId, docPath, count } = legacyDocProject();
    const pristine = snapshotProject(p);
    ok(runGo(p.dir, p.home, ["doc", "edit", docPath, "-a", "after migration"]));
    const goLines = jsonlLines(p.root, "docs", docId);

    restoreProject(p, pristine);
    await tsMigrateDoc(p, docPath);
    const tsLines = jsonlLines(p.root, "docs", docId);
    // Legacy hashes are absent, so the chain is verifiable and needs no reconcile checkpoint.
    expect(goLines.length).toBe(count + 1);
    expect(tsLines).toEqual(goLines.slice(0, count));
  });

  test("a mismatched legacy chain gets a verified migration-reconcile checkpoint", async () => {
    const { p, docId, docPath, count } = legacyDocProject((v, i) => {
      if (i === 1) v.newHash = "e".repeat(64);
    });
    const pristine = snapshotProject(p);
    ok(runGo(p.dir, p.home, ["doc", "edit", docPath, "-a", "after migration"]));
    const goLines = jsonlLines(p.root, "docs", docId);

    restoreProject(p, pristine);
    await tsMigrateDoc(p, docPath);
    const tsLines = jsonlLines(p.root, "docs", docId);
    expect(tsLines).toHaveLength(count + 1);
    expect(tsLines.slice(0, count)).toEqual(goLines.slice(0, count));

    // The reconcile record differs only by its wall-clock timestamp (and so its record hash).
    const strip = (line: string) => {
      const r = JSON.parse(line);
      r.timestamp = "";
      r.recordHash = "";
      return r;
    };
    expect(strip(tsLines[count] as string)).toEqual(strip(goLines[count] as string));
    expect(JSON.parse(tsLines[count] as string).source).toBe("migration-reconcile");
    const stream = new HistoryStore(p.root).readPreview("doc", docId);
    expect(docHistoryFromRecords(docPath, stream.records ?? []).versions).toHaveLength(count + 1);
  });
});
