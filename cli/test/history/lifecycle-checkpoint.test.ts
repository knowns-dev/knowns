// Decision a-briefly-missing-file-is-not-a-deletion: lifecycle checkpoints (tombstone, restore)
// are written from the full replayed entity state, never from a display snapshot, and replay
// heals older content-less delete/restore checkpoints when BaseHash proves the lineage.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryRecord } from "../../src/models/version.ts";
import {
  canonicalDocHash,
  deleteDocWithExpectedHash,
  docHashRecognized,
  docHistoryFromRecords,
  type docStateOf,
  hashDoc,
  isHistoryCorrupt,
  mutateDocWithHistory,
  replayDocHistory,
} from "../../src/storage/history/index.ts";
import { cleanup, copyFixture, hasGo, jsonlLines, makeContext, makeDoc, runGo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

const BODY = "# One\nalpha\n\n# Two\nbeta\n\n# Three\ngamma";
const EDITED = "# One\nalpha\n\n# Two\nBETA EDITED\n\n# Three\ngamma";

async function sectionScopedDoc(root: string) {
  const ctx = makeContext(root);
  await mutateDocWithHistory(
    ctx,
    null,
    makeDoc("lifecycle/doc", BODY, { title: "L", description: "d" }),
  );
  const v1 = ctx.docs.get("lifecycle/doc");
  await mutateDocWithHistory(ctx, v1, { ...v1, content: EDITED }, { section: "Two" });
  return { ctx, doc: ctx.docs.get("lifecycle/doc") };
}

describe("a tombstone after a section-scoped revision", () => {
  test("the display snapshot drops content but the replayed state keeps it", async () => {
    const p = copyFixture("empty");
    dirs.push(p.dir.replace(/\/project$/, ""));
    const { ctx, doc } = await sectionScopedDoc(p.root);
    const history = await ctx.versions.getDocHistory("lifecycle/doc");
    const v2 = history.versions?.[1];
    expect(v2?.checkpoint).toBeUndefined();
    expect(v2?.changedScopes?.[0]).toMatchObject({ type: "section", section: "Two" });
    expect(v2?.snapshot && "content" in v2.snapshot).toBe(false);

    const stream = await ctx.versions.historyStore().read("doc", doc.id as string);
    const replay = replayDocHistory("lifecycle/doc", stream.records ?? []);
    expect(replay.state.content).toBe(EDITED);
    expect(hashDoc(replay.state)).toBe(canonicalDocHash(doc));
  });

  test("the tombstone checkpoint carries the full content and is self-describing", async () => {
    const p = copyFixture("empty");
    dirs.push(p.dir.replace(/\/project$/, ""));
    const { ctx, doc } = await sectionScopedDoc(p.root);
    await deleteDocWithExpectedHash(ctx, "lifecycle/doc", {
      expectedHash: canonicalDocHash(doc),
      actor: "test",
    });

    const stream = await ctx.versions.historyStore().read("doc", doc.id as string);
    const head = stream.records?.at(-1) as HistoryRecord;
    expect(head.tombstone).toBe(true);
    expect(head.operation).toBe("delete");
    expect(head.checkpoint).toBe(true);
    expect(head.checkpointPayload?.content).toBe(EDITED);
    expect(head.checkpointPayload?.description).toBe("d");

    // Standalone: the tombstone alone replays to a state its own NewHash describes.
    const standalone = replayDocHistory("lifecycle/doc", [head]);
    expect(docHashRecognized(head.newHash, standalone.state)).toBe(true);
    expect(standalone.state.content).toBe(EDITED);
    // And the full stream replays cleanly with the tombstone as its head.
    const full = docHistoryFromRecords("lifecycle/doc", stream.records ?? []);
    expect(full.versions).toHaveLength(3);
    expect(full.versions?.[2]?.tombstone).toBe(true);
  });

  test("Go reads the tombstoned history", () => {
    if (!hasGo()) return;
    const p = copyFixture("empty");
    dirs.push(p.dir.replace(/\/project$/, ""));
    return (async () => {
      const { ctx, doc } = await sectionScopedDoc(p.root);
      await deleteDocWithExpectedHash(ctx, "lifecycle/doc", {
        expectedHash: canonicalDocHash(doc),
        actor: "test",
      });
      const view = runGo(p.dir, p.home, [
        "doc",
        "history",
        "lifecycle/doc",
        "--revision",
        "v3",
        "--json",
      ]);
      expect(view.code, view.stderr + view.stdout).toBe(0);
      const detail = JSON.parse(view.stdout);
      expect(detail.tombstone).toBe(true);
      expect(detail.snapshot.content).toBe(EDITED);
      const lines = jsonlLines(p.root, "docs", doc.id as string);
      expect(lines).toHaveLength(3);
    })();
  });
});

describe("replay heals content-less lifecycle checkpoints", () => {
  async function stream() {
    const p = copyFixture("empty");
    dirs.push(p.dir.replace(/\/project$/, ""));
    const { ctx, doc } = await sectionScopedDoc(p.root);
    const history = ctx.versions.historyStore();
    const records = (await history.read("doc", doc.id as string)).records ?? [];
    const full = replayDocHistory("lifecycle/doc", records).state;
    const hash = hashDoc(full);
    return { history, doc, records, full, hash, root: p.root };
  }

  function lifecycleRecord(
    base: { doc: { id?: string }; hash: string; full: ReturnType<typeof docStateOf> },
    operation: string,
    overrides: Partial<HistoryRecord> = {},
  ): HistoryRecord {
    // what the display-snapshot bug wrote: a checkpoint without any `content` key
    const payload: Record<string, unknown> = {
      id: base.full.id,
      path: base.full.path,
      title: base.full.title,
      description: base.full.description,
    };
    return {
      schemaVersion: 0,
      entityType: "doc",
      entityId: base.doc.id as string,
      revision: 0,
      timestamp: "2026-11-04T00:00:00Z",
      operation,
      tombstone: operation === "delete",
      baseHash: base.hash,
      newHash: base.hash,
      checkpoint: true,
      checkpointPayload: payload,
      currentPath: "docs/lifecycle/doc.md",
      ...overrides,
    };
  }

  for (const operation of ["delete", "restore"]) {
    test(`a content-less ${operation} checkpoint replays with the prior content`, async () => {
      const s = await stream();
      await s.history.append(lifecycleRecord(s, operation));
      const records = (await s.history.read("doc", s.doc.id as string)).records ?? [];
      const replay = replayDocHistory("lifecycle/doc", records);
      expect(replay.state.content).toBe(EDITED);
      expect(replay.history.versions).toHaveLength(3);
      // History files are never rewritten to heal: the payload on disk still has no content.
      const last = JSON.parse(jsonlLines(s.root, "docs", s.doc.id as string).at(-1) as string);
      expect("content" in last.checkpointPayload).toBe(false);
    });
  }

  test("without a BaseHash that proves the lineage nothing is carried forward", async () => {
    const s = await stream();
    await s.history.append(lifecycleRecord(s, "delete", { baseHash: s.hash }));
    const records = (await s.history.read("doc", s.doc.id as string)).records ?? [];
    // forge: same payload but claiming a different (unrelated) base lineage
    const forged = { ...(records.at(-1) as HistoryRecord), baseHash: "0".repeat(64) };
    expect(() => docHistoryFromRecords("lifecycle/doc", [...records.slice(0, -1), forged])).toThrow(
      /Doc canonical hash mismatch at revision 3/,
    );
  });

  test("an update checkpoint without content is not healed (only delete and restore are)", async () => {
    const s = await stream();
    await s.history.append(lifecycleRecord(s, "update", { tombstone: false }));
    const records = (await s.history.read("doc", s.doc.id as string)).records ?? [];
    let caught: unknown;
    try {
      docHistoryFromRecords("lifecycle/doc", records);
    } catch (e) {
      caught = e;
    }
    expect(isHistoryCorrupt(caught)).toBe(true);
  });

  test("Go heals it the same way", () => {
    if (!hasGo()) return;
    return (async () => {
      const s = await stream();
      await s.history.append(lifecycleRecord(s, "delete"));
      const go = runGo(join(s.root, ".."), join(s.root, "..", "..", "home"), [
        "doc",
        "history",
        "lifecycle/doc",
        "--plain",
      ]);
      expect(go.code, go.stderr + go.stdout).toBe(0);
      expect(go.stdout).toContain("VERSIONS: 3");
      expect(go.stdout).toContain("VERSION: v3");
      expect(
        readFileSync(s.history.entityPath("doc", s.doc.id as string), "utf8")
          .split("\n")
          .filter(Boolean),
      ).toHaveLength(3);
    })();
  });
});
