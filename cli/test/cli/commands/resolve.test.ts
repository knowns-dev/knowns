// resolve against the Go 0.34.1 oracle: plain semantic resolution and structural traversal.
import { describe, test } from "bun:test";
import { hasGoBin, writeFixtureText } from "./search-harness.ts";
import { expectParity } from "./search-parity.ts";

const cases = hasGoBin ? describe : describe.skip;

/**
 * The one legitimate source of nondeterminism in Go's structural output: the task list that feeds
 * edge collection is built from a map (internal/storage/task_store.go ListAll, lines 78-91), and
 * deduplicateRawEdges keeps first-seen order, so edges that tie on every sort key, and the
 * unresolved references, come out in a different order on each run.
 *
 * Everything else is compared exactly: the edge count, the index numbers, the order of the groups
 * (all depth-1 edges before depth-2, the outbound block before the inbound block for
 * --direction both). Only the edges inside one run of equal depth and direction may permute, and
 * the unresolved list is compared as a set.
 */
const EDGE_LINE = /^ {2}\[(\d+)\] (.*\(depth=(\d+), origin=[^,]*, dir=(\w+)\))$/;

/**
 * Depth 1 starts from the single root, so its outbound block precedes its inbound block and the
 * two stay in order. From depth 2 each frontier node contributes its own blocks, and the frontier
 * order itself comes from the tied depth-1 edges, so only the depth is a fixed group there.
 */
function groupOf(depth: number, direction: string): string {
  return depth === 1 ? `1/${direction}` : String(depth);
}

function sortedRuns<T>(items: T[], group: (t: T) => string, key: (t: T) => string): T[] {
  const out: T[] = [];
  let run: T[] = [];
  let current = "";
  const flush = () => {
    out.push(...run.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0)));
    run = [];
  };
  for (const it of items) {
    const g = group(it);
    if (run.length > 0 && g !== current) flush();
    current = g;
    run.push(it);
  }
  flush();
  return out;
}

function asSets(text: string): string {
  try {
    const j = JSON.parse(text) as {
      edges?: { depth: number; direction: string }[];
      unresolved?: unknown[];
    };
    if (Array.isArray(j.edges)) {
      j.edges = sortedRuns(
        j.edges,
        (e) => groupOf(e.depth, e.direction),
        (e) => JSON.stringify(e),
      );
    }
    if (Array.isArray(j.unresolved))
      j.unresolved = j.unresolved.map((e) => JSON.stringify(e)).sort();
    return JSON.stringify(j);
  } catch {
    const lines = text.split("\n");
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] as string;
      if (EDGE_LINE.test(line)) {
        const block: string[] = [];
        while (i < lines.length && EDGE_LINE.test(lines[i] as string))
          block.push(lines[i++] as string);
        const bodies = block.map((l) => {
          const m = EDGE_LINE.exec(l) as RegExpExecArray;
          return {
            idx: m[1] as string,
            body: m[2] as string,
            group: groupOf(Number(m[3]), m[4] as string),
          };
        });
        const sorted = sortedRuns(
          bodies,
          (b) => b.group,
          (b) => b.body,
        );
        // The index numbers stay in their original positions.
        for (const [n, b] of sorted.entries()) {
          out.push(`  [${(bodies[n] as { idx: string }).idx}] ${b.body}`);
        }
      } else if (/^ {2}- @/.test(line)) {
        const block: string[] = [];
        while (i < lines.length && /^ {2}- @/.test(lines[i] as string))
          block.push(lines[i++] as string);
        out.push(...block.sort());
      } else {
        out.push(line);
        i++;
      }
    }
    return out.join("\n");
  }
}

/** Adds a spec doc, a task that implements it and a doc that links back, for edge traversal. */
function graph(dir: string): void {
  writeFixtureText(
    dir,
    ".knowns/docs/specs/login.md",
    `---
id: doc-22222222222222222222222222222222
title: Login spec
description: Login requirements
createdAt: '2026-11-03T13:37:36.502Z'
updatedAt: '2026-11-03T13:37:36.502Z'
tags:
  - spec
  - approved
---

# Login spec

Implemented by @task-FX-3VT2SR, designed in @doc/architecture{depends}. Missing: @doc/nope and @task-ZZ-NOPE.
`,
  );
}

const refs = [
  "@task-FX-3VT2SR",
  "@task/FX-3VT2SR",
  "@task-FX-NOPE",
  "@doc/architecture",
  "@doc/guides/setup-guide#Install",
  "@doc/architecture:3",
  "@doc/architecture:1-4",
  "@doc/nope",
  "@memory-rrvcia",
  "@memory/nr44bw",
  "@decision/20261103-1337-use-bun-for-everything",
  "@template/component",
  "@doc/architecture{implements}",
  "@doc/architecture{bogus}",
  "not a ref",
  "@task-",
];

cases("resolve: simple resolution matches Go", () => {
  for (const ref of refs) {
    test(ref, async () => {
      await expectParity("full", [
        ["resolve", ref],
        ["resolve", ref, "--plain"],
        ["resolve", ref, "--json"],
      ]);
    });
  }

  test("usage errors", async () => {
    await expectParity("full", [
      ["resolve"],
      ["resolve", "a", "b"],
      ["resolve", "--bogus", "@task-x"],
      ["resolve", "@task-x", "--depth", "abc"],
      ["resolve", "--help"],
      ["help", "resolve"],
    ]);
    await expectParity("", [
      ["resolve", "@task-x"],
      ["resolve", "@task-x", "--json"],
    ]);
  });
});

cases("resolve: structural traversal matches Go", () => {
  const flags: string[][] = [
    ["--direction", "outbound"],
    ["--direction", "inbound"],
    ["--direction", "both"],
    ["--direction", "sideways"],
    ["--depth", "1"],
    ["--depth", "2", "--direction", "both"],
    ["--depth", "9", "--direction", "both"],
    ["--depth", "-1"],
    ["--relation", "spec"],
    ["--relation", " spec , parent ,"],
    ["--direction", "inbound", "--relation", "implements"],
    ["--type", "task"],
    ["--type", "doc,decision", "--direction", "both"],
    ["--direction", "both", "--depth", "3", "--relation", "references,spec,depends"],
  ];
  const roots = [
    "@task-FX-3VT2SR",
    "@doc/specs/login",
    "@doc/architecture",
    "@task-FX-65T7HG",
    "@decision/20261103-1337-use-bun-for-everything",
    "@memory-rrvcia",
    "@task-FX-NOPE",
    "@doc/nope",
    "nonsense",
  ];
  for (const root of roots) {
    test(root, async () => {
      for (const f of flags) {
        await expectParity(
          "full",
          [
            ["resolve", root, ...f],
            ["resolve", root, ...f, "--plain"],
            ["resolve", root, ...f, "--json"],
          ],
          { setup: graph, map: asSets },
        );
      }
    });
  }

  test("project without any link", async () => {
    await expectParity("empty", [["resolve", "@task-A", "--direction", "both", "--json"]]);
  });
});
