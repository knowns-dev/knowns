// `search --reindex` with the deterministic embedder (KNOWNS_EMBED_MOCK): the legacy SQLite index
// this build writes holds exactly the rows, vectors, hashes and metadata Go writes, and the
// command prints the same lines.
import { describe, expect, test } from "bun:test";
import type { Pair } from "../cli/commands/harness.ts";
import { sqliteIndexDump as dump, hasGoBin, INLINE, makePair, mask, runSide } from "./helpers.ts";

const suite = hasGoBin ? describe : describe.skip;
const MOCK = { ...INLINE, KNOWNS_EMBED_MOCK: "1" };

async function setup(): Promise<Pair> {
  const pair = makePair("full");
  for (const [k, v] of [
    ["settings.semanticSearch.enabled", "true"],
    ["settings.semanticSearch.model", "all-minilm"],
  ]) {
    for (const side of ["go", "ts"] as const) {
      const r = await runSide(
        pair,
        side,
        ["config", "set", k as string, v as string, "--plain"],
        MOCK,
      );
      expect(r.code, r.stderr).toBe(0);
    }
  }
  return pair;
}

suite("search --reindex (mock embedder) equals Go", () => {
  test("first build and an incremental rebuild", async () => {
    const pair = await setup();
    for (let round = 0; round < 2; round++) {
      const go = await runSide(pair, "go", ["search", "--reindex", "--plain"], MOCK);
      const ts = await runSide(pair, "ts", ["search", "--reindex", "--plain"], MOCK);
      expect(ts.code).toBe(go.code);
      expect(mask(pair, "ts", ts.stdout)).toBe(mask(pair, "go", go.stdout));
      expect(mask(pair, "ts", ts.stderr)).toBe(mask(pair, "go", go.stderr));
      expect(go.stdout).toContain("Project semantic index rebuilt");
      expect(dump(pair, "ts")).toBe(dump(pair, "go"));
    }
  }, 120_000);

  test("a changed task is re-embedded on the next rebuild", async () => {
    const pair = await setup();
    await runSide(pair, "go", ["search", "--reindex", "--plain"], MOCK);
    await runSide(pair, "ts", ["search", "--reindex", "--plain"], MOCK);
    const create = ["task", "create", "Brand new", "-d", "fresh content"];
    await runSide(pair, "go", create, MOCK);
    await runSide(pair, "ts", create, MOCK);
    await runSide(pair, "go", ["search", "--reindex", "--plain"], MOCK);
    await runSide(pair, "ts", ["search", "--reindex", "--plain"], MOCK);
    const norm = (side: "go" | "ts") => dump(pair, side);
    expect(norm("ts")).toBe(norm("go"));
  }, 120_000);

  test("semantic search not configured prints the keyword-only guidance", async () => {
    const pair = makePair("full");
    const go = await runSide(pair, "go", ["search", "--reindex", "--plain"], MOCK);
    const ts = await runSide(pair, "ts", ["search", "--reindex", "--plain"], MOCK);
    expect(ts.code).toBe(go.code);
    expect(mask(pair, "ts", ts.stdout)).toBe(mask(pair, "go", go.stdout));
  });
});
