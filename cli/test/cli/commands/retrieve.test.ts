// retrieve against the Go 0.34.1 oracle: candidates, context pack, citations, reference expansion.
import { describe, test } from "bun:test";
import { hasGoBin, writeFixtureText } from "./search-harness.ts";
import { expectParity } from "./search-parity.ts";

const cases = hasGoBin ? describe : describe.skip;

/** Docs, a task and a memory that point at each other, so --expand-references has work to do. */
function linked(dir: string): void {
  writeFixtureText(
    dir,
    ".knowns/docs/specs/login.md",
    `---
id: doc-11111111111111111111111111111111
title: Login spec
description: Login requirements
createdAt: '2026-11-03T13:37:36.502Z'
updatedAt: '2026-11-03T13:37:36.502Z'
tags:
  - spec
---

# Login spec

See @doc/architecture and @task-FX-3VT2SR for context. Also @doc/guides/setup-guide#Install.
`,
  );
}

cases("retrieve: output matches Go", () => {
  const modes = [["--keyword"], ["--keyword", "--plain"], ["--keyword", "--json"]];
  for (const mode of modes) {
    test(`login ${mode.join(" ")}`, async () => {
      await expectParity("full", [["retrieve", "login", ...mode]]);
    });
  }

  test("no results", async () => {
    await expectParity("full", [
      ["retrieve", "zzzqq", "--keyword"],
      ["retrieve", "zzzqq", "--keyword", "--plain"],
      ["retrieve", "zzzqq", "--keyword", "--json"],
    ]);
  });

  test("source types, filters and limit", async () => {
    await expectParity("full", [
      ["retrieve", "a", "--keyword", "--source-types", "doc", "--plain"],
      ["retrieve", "a", "--keyword", "--source-types", "task,decision", "--plain"],
      ["retrieve", "a", "--keyword", "--source-types", " doc , memory ,", "--json"],
      ["retrieve", "a", "--keyword", "--source-types", "bogus", "--json"],
      ["retrieve", "a", "--keyword", "--status", "done", "--plain"],
      ["retrieve", "a", "--keyword", "--priority", "high", "--plain"],
      ["retrieve", "a", "--keyword", "--label", "auth", "--plain"],
      ["retrieve", "a", "--keyword", "--tag", "guide", "--plain"],
      ["retrieve", "a", "--keyword", "--assignee", "@fixture", "--plain"],
      ["retrieve", "a", "--keyword", "--include-historical", "--json"],
      ["retrieve", "a", "--keyword", "--limit", "1", "--json"],
      ["retrieve", "a", "--keyword", "--limit", "0", "--plain"],
    ]);
  });

  test("--expand-references follows inline references", async () => {
    await expectParity(
      "full",
      [
        ["retrieve", "login", "--keyword", "--expand-references", "--json"],
        ["retrieve", "login", "--keyword", "--expand-references", "--plain"],
        ["retrieve", "login", "--keyword", "--expand-references"],
        ["retrieve", "spec", "--keyword", "--expand-references", "--source-types", "doc", "--json"],
        ["retrieve", "login", "--keyword", "--json"],
      ],
      { setup: linked },
    );
  });

  test("hybrid falls back to keyword with the runtime notice", async () => {
    await expectParity("full", [
      ["retrieve", "auth"],
      ["retrieve", "auth", "--plain"],
      ["retrieve", "auth", "--json"],
      ["retrieve", "zzzqq"],
      ["retrieve", "zzzqq", "--json"],
    ]);
  });

  test("NO_COLOR keeps only the badge colours", async () => {
    await expectParity("full", [
      { args: ["retrieve", "login", "--keyword"], env: { NO_COLOR: "1" } },
      { args: ["retrieve", "auth"], env: { NO_COLOR: "1" } },
    ]);
  });

  test("paging a plain result", async () => {
    await expectParity("full", [
      ["retrieve", "a", "--keyword", "--plain", "--page", "1", "--page-size", "6"],
      ["retrieve", "a", "--keyword", "--plain", "--page", "3", "--page-size", "6"],
    ]);
  });

  test("usage errors", async () => {
    await expectParity("full", [
      ["retrieve"],
      ["retrieve", "--bogus"],
      ["retrieve", "x", "--limit", "abc"],
      ["retrieve", "--help"],
      ["help", "retrieve"],
    ]);
    await expectParity("", [["retrieve", "x"]]);
  });
});
