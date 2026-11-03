// Every history chain in the golden fixtures (written by Go 0.34.1) verifies in TypeScript, and
// the record hash algorithm reproduces the hashes Go wrote.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeRecord,
  docHistoryFromRecords,
  goTime,
  HistoryCorruptError,
  HistoryStore,
  historyRecordHash,
  isHistoryCorrupt,
  marshalRecordLine,
  taskHistoryFromRecords,
} from "../../src/storage/history/index.ts";
import { fixtureNames, fixtureRoot } from "../helpers/fixtures.ts";
import { cleanup, copyFixture } from "./helpers.ts";

function streams(root: string): { kind: "task" | "doc"; id: string; file: string }[] {
  const out: { kind: "task" | "doc"; id: string; file: string }[] = [];
  for (const [kind, dir] of [
    ["task", "tasks"],
    ["doc", "docs"],
  ] as const) {
    const base = join(root, "history", dir);
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base).filter((n) => n.endsWith(".jsonl"))) {
      out.push({ kind, id: f.slice(0, -".jsonl".length), file: join(base, f) });
    }
  }
  return out;
}

describe("golden fixture chains", () => {
  test("the full fixture has chains to verify", () => {
    expect(streams(join(fixtureRoot("full"), ".knowns")).length).toBeGreaterThanOrEqual(14);
  });

  for (const name of fixtureNames) {
    const root = join(fixtureRoot(name), ".knowns");
    for (const s of streams(root)) {
      test(`${name}: ${s.kind} ${s.id} verifies and replays`, () => {
        const store = new HistoryStore(root);
        const { records, tailTruncated } = store.readPreview(s.kind, s.id);
        const lines = readFileSync(s.file, "utf8").split("\n").filter(Boolean);
        expect(tailTruncated).toBeUndefined();
        expect(records).toHaveLength(lines.length);
        records?.forEach((r, i) => {
          expect(r.revision).toBe(i + 1);
          // the stored hash is exactly what the TypeScript algorithm computes
          expect(historyRecordHash(r)).toBe(r.recordHash as string);
          if (i > 0) expect(r.prevRecordHash).toBe(records[i - 1]?.recordHash as string);
        });
        const history =
          s.kind === "task"
            ? taskHistoryFromRecords(s.id, records ?? [])
            : docHistoryFromRecords(s.id, records ?? []);
        expect(history.versions).toHaveLength(lines.length);
        expect(history.currentVersion).toBe(lines.length);
      });
    }
  }

  test("a record Go wrote re-serializes to the same bytes when its payloads are sorted", () => {
    const root = join(fixtureRoot("full"), ".knowns");
    for (const s of streams(root)) {
      for (const line of readFileSync(s.file, "utf8").split("\n").filter(Boolean)) {
        const record = decodeRecord(JSON.parse(line));
        // Changes keep struct order in the file; checkpoint payloads are sorted maps. Hashing
        // sorts both, so the record hash is stable either way.
        expect(marshalRecordLine(record, false)).toBe(line);
      }
    }
  });

  test("tampering with any byte of a record fails closed", async () => {
    const { dir, root } = copyFixture("full");
    try {
      const file = join(root, "history", "tasks", "FX-3VT2SR.jsonl");
      const text = readFileSync(file, "utf8");
      writeFileSync(file, text.replace('"in-progress"', '"in-progres5"'));
      const store = new HistoryStore(root);
      expect(() => store.readPreview("task", "FX-3VT2SR")).toThrow(HistoryCorruptError);
      let caught: unknown;
      try {
        await store.read("task", "FX-3VT2SR");
      } catch (e) {
        caught = e;
      }
      expect(isHistoryCorrupt(caught)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

describe("hash primitives", () => {
  test("timestamps normalize to the form Go marshals", () => {
    expect(goTime("2026-11-03T13:37:35.100Z")).toBe("2026-11-03T13:37:35.1Z");
    expect(goTime("2026-11-03T13:37:35.000Z")).toBe("2026-11-03T13:37:35Z");
    expect(goTime("2026-11-03T13:37:35+00:00")).toBe("2026-11-03T13:37:35Z");
    expect(goTime("2026-11-03T13:37:35.123456789+07:00")).toBe(
      "2026-11-03T13:37:35.123456789+07:00",
    );
  });
});
