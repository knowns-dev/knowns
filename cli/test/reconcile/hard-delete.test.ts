// `doc hard-delete` and `task hard-delete` against the Go 0.34.1 oracle: output and the complete
// `.knowns` tree (purge markers, manifest, history, tombstones, the remaining files).
import { afterEach, describe, expect, test } from "bun:test";
import {
  disposePair,
  hasGoBin,
  makePair,
  type Pair,
  runBothCli,
  tree,
  treeDiff,
} from "./harness.ts";

const cases = hasGoBin ? describe : describe.skip;
const pairs: Pair[] = [];
afterEach(() => {
  for (const p of pairs.splice(0)) disposePair(p);
});

cases("hard-delete parity with Go", () => {
  test("doc hard-delete removes the doc, its history and leaves a purge marker", async () => {
    const pair = makePair("full");
    pairs.push(pair);
    const r = await runBothCli(pair, [
      "doc",
      "hard-delete",
      "architecture",
      "--allow-hard-delete",
      "--yes",
      "--reason",
      "r",
    ]);
    expect(r.ts).toEqual(r.go);
    expect(r.go.code).toBe(0);
    expect(treeDiff(tree(pair.go), tree(pair.ts))).toEqual([]);
  });

  test("doc hard-delete of a nested doc", async () => {
    const pair = makePair("full");
    pairs.push(pair);
    const r = await runBothCli(pair, [
      "doc",
      "hard-delete",
      "guides/deep/er/nested-doc",
      "--allow-hard-delete",
      "--yes",
      "--reason",
      "cleanup",
    ]);
    expect(r.ts).toEqual(r.go);
    expect(treeDiff(tree(pair.go), tree(pair.ts))).toEqual([]);
  });

  test("doc hard-delete with a wrong expected hash fails the same way", async () => {
    const pair = makePair("full");
    pairs.push(pair);
    const r = await runBothCli(pair, [
      "doc",
      "hard-delete",
      "architecture",
      "--allow-hard-delete",
      "--yes",
      "--reason",
      "r",
      "--expected-hash",
      "bad",
    ]);
    expect(r.ts).toEqual(r.go);
    expect(r.go.code).not.toBe(0);
    expect(treeDiff(tree(pair.go), tree(pair.ts))).toEqual([]);
  });

  test("task hard-delete purges the task and its history", async () => {
    const pair = makePair("full");
    pairs.push(pair);
    const r = await runBothCli(pair, [
      "task",
      "hard-delete",
      "FX-19XJKQ",
      "--allow-hard-delete",
      "--yes",
      "--reason",
      "r",
    ]);
    expect(r.ts).toEqual(r.go);
    expect(r.go.code).toBe(0);
    expect(treeDiff(tree(pair.go), tree(pair.ts))).toEqual([]);
  });

  test("task hard-delete of an archived task", async () => {
    const pair = makePair("full");
    pairs.push(pair);
    const r = await runBothCli(pair, [
      "task",
      "hard-delete",
      "FX-3GCY37",
      "--allow-hard-delete",
      "--yes",
      "--reason",
      "r",
    ]);
    expect(r.ts).toEqual(r.go);
    expect(treeDiff(tree(pair.go), tree(pair.ts))).toEqual([]);
  });
});
