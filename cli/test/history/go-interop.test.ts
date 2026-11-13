// Interop with the real Go 0.34.1 binary: Go's history views equal ours on the golden fixtures,
// chains extended from TypeScript are accepted by Go, and chains Go extends on top of ours verify
// in TypeScript. Skipped when neither KNOWNS_GO_BIN nor a Go toolchain is available.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Doc } from "../../src/models/doc.ts";
import {
  canonicalDocHash,
  docHistoryFromRecords,
  docStateOf,
  HistoryStore,
  taskHistoryFromRecords,
  VersionStore,
} from "../../src/storage/history/index.ts";
import { fixtureId } from "../helpers/fixtures.ts";
import { cleanup, copyFixture, hasGo, jsonlLines, runGo } from "./helpers.ts";

const suite = hasGo() ? describe : describe.skip;
const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

function project() {
  const p = copyFixture("full");
  dirs.push(p.dir.replace(/\/project$/, ""));
  return p;
}

const asJson = (v: unknown) => JSON.parse(JSON.stringify(v));

function goJson(p: { dir: string; home: string }, args: string[]) {
  const r = runGo(p.dir, p.home, [...args, "--json"]);
  expect(r.code, `${args.join(" ")}: ${r.stderr}${r.stdout}`).toBe(0);
  return JSON.parse(r.stdout);
}

suite("Go history views equal the TypeScript views on the golden fixtures", () => {
  const p = project();
  const versions = new VersionStore(p.root);
  const taskIds = readdirSync(join(p.root, "history", "tasks")).map((f) => f.replace(".jsonl", ""));

  for (const id of taskIds) {
    test(`task ${id}: metadata page and every revision detail`, async () => {
      const go = goJson(p, ["task", "history", id, "--metadata"]);
      expect(asJson(await versions.listTaskHistoryMetadata(id))).toEqual(go);
      const count = jsonlLines(p.root, "tasks", id).length;
      for (let n = 1; n <= count; n++) {
        const detail = goJson(p, ["task", "history", id, "--revision", `v${n}`]);
        expect(asJson(await versions.getTaskRevisionDetail(id, `v${n}`))).toEqual(detail);
      }
    });
  }

  for (const docPath of [
    "architecture",
    "guides/setup-guide",
    "guides/deep/er/nested-doc",
    "patterns/controllers/controller-pattern",
  ]) {
    test(`doc ${docPath}: metadata page and every revision detail`, async () => {
      const go = goJson(p, ["doc", "history", docPath, "--metadata"]);
      expect(asJson(await versions.listDocHistoryMetadata(docPath))).toEqual(go);
      const docId = fixtureId("full", `docid:${docPath}`);
      const count = jsonlLines(p.root, "docs", docId).length;
      for (let n = 1; n <= count; n++) {
        const detail = goJson(p, ["doc", "history", docPath, "--revision", `v${n}`]);
        expect(asJson(await versions.getDocRevisionDetail(docPath, `v${n}`))).toEqual(detail);
      }
    });
  }
});

suite("chains extended by TypeScript are accepted by Go", () => {
  test("task: TS-written revision shows in Go history, then Go extends the TS chain", async () => {
    const p = project();
    const id = fixtureId("full", "task.rich");
    const versions = new VersionStore(p.root);
    const before = await versions.getHistory(id);
    const head = before.versions?.at(-1);
    expect(head).toBeDefined();
    const snapshot = {
      ...(head?.snapshot ?? {}),
      status: "in-review",
      implementationNotes: "written by TypeScript",
    };
    await versions.saveVersion(id, {
      timestamp: "2026-11-04T00:00:00Z",
      author: "ts-worker",
      changes: [
        { field: "status", oldValue: head?.snapshot?.status ?? null, newValue: "in-review" },
        {
          field: "implementationNotes",
          oldValue: head?.snapshot?.implementationNotes ?? null,
          newValue: "written by TypeScript",
        },
      ],
      snapshot,
    });
    const n = (before.versions?.length ?? 0) + 1;
    const lines = jsonlLines(p.root, "tasks", id);
    expect(lines).toHaveLength(n);

    const view = runGo(p.dir, p.home, ["task", "history", id, "--plain"]);
    expect(view.code, view.stderr).toBe(0);
    expect(view.stdout).toContain(`VERSION: v${n}`);
    expect(view.stdout).toContain("AUTHOR: ts-worker");
    expect(view.stdout).toContain("status: in-progress -> in-review");

    const meta = goJson(p, ["task", "history", id, "--metadata"]);
    const tsRecord = new HistoryStore(p.root).readPreview("task", id).records?.at(-1);
    expect(meta.items[0].recordHash).toBe(tsRecord?.recordHash);
    expect(meta.items[0].id).toBe(`v${n}`);

    const validate = goJson(p, ["validate"]);
    expect(validate.issues.filter((i: { level: string }) => i.level === "error")).toEqual([]);

    // Go appends on top of the TypeScript-written head (task edit reads the file, diffs, saves).
    const edit = runGo(p.dir, p.home, ["task", "edit", id, "--append-notes", "go on top"]);
    expect(edit.code, edit.stderr + edit.stdout).toBe(0);
    const after = new HistoryStore(p.root).readPreview("task", id);
    expect(after.records).toHaveLength(n + 1);
    expect(after.records?.[n]?.prevRecordHash).toBe(tsRecord?.recordHash);
    const replay = taskHistoryFromRecords(id, after.records ?? []);
    expect(replay.versions).toHaveLength(n + 1);
  });

  test("task: a stale TS append (wrong base) is rejected like Go would reject it", async () => {
    const p = project();
    const id = fixtureId("full", "task.rich");
    const history = new HistoryStore(p.root);
    const err = await history
      .append({
        schemaVersion: 0,
        entityType: "task",
        entityId: id,
        revision: 0,
        timestamp: "2026-11-04T00:00:00Z",
        baseHash: "0".repeat(64),
        newHash: "1".repeat(64),
        taskChanges: [{ field: "title", oldValue: null, newValue: "x" }],
      })
      .catch((e) => e);
    expect((err as Error).message).toBe("history conflict: stale history head");
  });

  test("doc: TS-written revision (file edited to match) is accepted, and Go edits on top of it", async () => {
    const p = project();
    const docPath = "guides/setup-guide";
    const docId = fixtureId("full", `docid:${docPath}`);
    const versions = new VersionStore(p.root);
    const state = await versions.resolveDocState(docPath, "");
    const oldDoc: Doc = {
      id: docId,
      path: docPath,
      title: state.title,
      description: state.description || undefined,
      content: state.content,
      tags: state.tags && state.tags.length > 0 ? state.tags : undefined,
      createdAt: "2026-11-03T13:37:36Z",
      updatedAt: "2026-11-03T13:37:36Z",
    };
    const newDoc: Doc = {
      ...oldDoc,
      content: `${state.content}\n\nAppended by the TypeScript worker.`,
    };
    // The canonical file and history must agree, as MutateDocWithHistory guarantees in Go.
    const file = join(p.root, "docs", `${docPath}.md`);
    writeFileSync(
      file,
      `${readFileSync(file, "utf8").trimEnd()}\n\nAppended by the TypeScript worker.\n`,
    );
    await versions.saveDocRevisionWithOptions(oldDoc, newDoc, {
      actor: "ts-worker",
      source: "cli",
    });

    const n = jsonlLines(p.root, "docs", docId).length;
    const view = runGo(p.dir, p.home, ["doc", "history", docPath, "--plain"]);
    expect(view.code, view.stderr).toBe(0);
    expect(view.stdout).toContain(`VERSION: v${n}`);
    expect(view.stdout).toContain("ACTOR: ts-worker");
    const validate = goJson(p, ["validate"]);
    expect(validate.issues.filter((i: { level: string }) => i.level === "error")).toEqual([]);

    // Go's optimistic-concurrency check compares the file hash with the history head: it passes
    // only because the TypeScript canonical hash matches the one Go computes from the file.
    const edit = runGo(p.dir, p.home, ["doc", "edit", docPath, "-a", "Go on top"]);
    expect(edit.code, edit.stderr + edit.stdout).toBe(0);
    const stream = new HistoryStore(p.root).readPreview("doc", docId);
    expect(stream.records).toHaveLength(n + 1);
    const replay = docHistoryFromRecords(docPath, stream.records ?? []);
    expect(replay.versions).toHaveLength(n + 1);
    expect(
      canonicalDocHash({
        ...docStateOf(newDoc),
        content: replay.versions?.at(-1)?.snapshot?.content as string,
      }),
    ).toBe(stream.records?.at(-1)?.newHash as string);
  });

  test("tail recovery: Go ignores a TS append that never got its newline", async () => {
    const p = project();
    const id = fixtureId("full", "task.plain");
    appendFileSync(
      join(p.root, "history", "tasks", `${id}.jsonl`),
      '{"schemaVersion":1,"entityType":"task"',
    );
    const view = runGo(p.dir, p.home, ["task", "history", id, "--metadata", "--json"]);
    expect(view.code, view.stderr).toBe(0);
    expect(JSON.parse(view.stdout).tailTruncated).toBe(true);
    expect((await new VersionStore(p.root).listTaskHistoryMetadata(id)).tailTruncated).toBe(true);
  });
});

suite("parity gap kept on purpose", () => {
  // Go 0.34.1 resolves the history head with applyDocVersionState, which never clears a field
  // whose new value is null. After a revision that clears a Doc field, the next edit therefore
  // fails with a mutation conflict. TypeScript preserves that behavior (D6, Go is frozen under D2);
  // this test pins both sides so a deliberate fix has to change them together.
  test("clearing a doc description then editing again conflicts in both", async () => {
    const dir = copyFixture("empty");
    dirs.push(dir.dir.replace(/\/project$/, ""));
    expect(
      runGo(dir.dir, dir.home, ["doc", "create", "Clr", "-d", "desc one", "-c", "first"]).code,
    ).toBe(0);
    expect(runGo(dir.dir, dir.home, ["doc", "edit", "clr", "-d", ""]).code).toBe(0);
    const go = runGo(dir.dir, dir.home, ["doc", "edit", "clr", "-t", "Clr2"]);
    expect(go.code).not.toBe(0);
    expect(go.stderr + go.stdout).toContain("mutation conflict");

    const { makeContext } = await import("./helpers.ts");
    const { mutateDocWithHistory, MutationConflictError } = await import(
      "../../src/storage/history/index.ts"
    );
    const ts = makeContext(dir.root);
    const first = {
      path: "p",
      title: "Clr",
      description: "desc one",
      content: "first",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await mutateDocWithHistory(ts, null, first);
    const v1 = ts.docs.get("p");
    await mutateDocWithHistory(ts, v1, { ...v1, description: undefined });
    const v2 = ts.docs.get("p");
    const e = await mutateDocWithHistory(ts, v2, { ...v2, title: "Clr2" }).catch((x) => x);
    expect(e).toBeInstanceOf(MutationConflictError);
  });
});
