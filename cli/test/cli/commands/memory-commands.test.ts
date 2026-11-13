// Golden differential tests for `knowns memory ...`: every subcommand and flag runs against the Go
// 0.34.1 binary and the TypeScript CLI in two copies of the same fixture project, and stdout,
// stderr, exit code and the resulting file tree must be identical. Needs KNOWNS_GO_BIN.
//
// Masked, because Go itself makes them nondeterministic: wall-clock timestamps, the random base36
// ids of new memories (replaced by creation order), the minute prefix of decision ids made now, the
// order of `matchedBy` reasons and of a memory's `metadata:` lines (both come from Go map
// iteration), and the order of a list of memories with generated ids (Go sorts by file name).
// HOME is isolated per world; ~/.knowns/logs/mcp.log (created empty by the Go binary at startup)
// and the runtime queue (KNOWNS_RUNTIME_INLINE=1) are out of scope here.
import { afterAll, describe, expect, test } from "bun:test";
import {
  cleanupWorlds,
  expectParity,
  hasGoBin,
  makePair,
  writeBoth,
} from "./memory-diff-helpers.ts";

afterAll(cleanupWorlds);

const suite = hasGoBin ? describe : describe.skip;

const old = (id: string, title: string, status: string, created: string, layer = "project") => `---
id: ${id}
title: ${title}
layer: ${layer}
category: pattern
status: ${status}
confidence: high
lastVerified: '${created}'
tags:
  - old
createdAt: '${created}'
updatedAt: '${created}'
---

Old content for ${id}.
`;

suite("memory read commands", () => {
  const pair = makePair();
  const steps: string[][] = [
    ["memory"],
    ["memory", "--help"],
    ["memory", "list"],
    ["memory", "list", "--plain"],
    ["memory", "list", "--json"],
    ["memory", "list", "--all-statuses"],
    ["memory", "list", "--all-statuses", "--json"],
    ["memory", "list", "--layer", "global"],
    ["memory", "list", "--layer", "project", "--plain"],
    ["memory", "list", "--category", "pattern", "--all-statuses", "--plain"],
    ["memory", "list", "--tag", "style", "--plain"],
    ["memory", "list", "--status", "proposed", "--plain"],
    ["memory", "list", "--tag", "nomatch", "--json"],
    ["memory", "list", "--tag", "nomatch"],
    ["memory", "list", "--plain", "--page", "1", "--page-size", "1"],
    ["memory", "list", "--plain", "--page", "9", "--page-size", "1"],
    ["memory", "list", "--layer", "working"],
    ["memory", "list", "--status", "bogus"],
    ["memory", "rrvcia"],
    ["memory", "rrvcia", "--plain"],
    ["memory", "view", "rrvcia"],
    ["memory", "view", "kunv9q", "--json"],
    ["memory", "view", "nr44bw", "--plain"],
    ["memory", "view", "missing"],
    ["memory", "view"],
    ["memory", "view", "a", "b"],
    ["memory", "migrate"],
    ["memory", "migrate", "--json"],
    ["memory", "migrate", "--all-statuses"],
    ["memory", "migrate", "--all-statuses", "--layer", "global"],
    ["memory", "migrate", "--layer", "nope"],
    ["memory", "migrate", "--help"],
    ["memory", "cleanup"],
    ["memory", "cleanup", "--layer", "global", "--json"],
    ["memory", "cleanup", "--layer", "bad"],
    ["memory", "bogus-flag", "--nope"],
  ];
  for (const args of steps) {
    test(args.join(" "), () => {
      expectParity(pair, args);
    });
  }
});

suite("memory cleanup candidates", () => {
  const pair = makePair();
  writeBoth(pair, {
    "project/.knowns/memory/memory-oldact.md": old(
      "oldact",
      "Old active",
      "active",
      "2026-01-01T00:00:00Z",
    ),
    "project/.knowns/memory/memory-oldprop.md": old(
      "oldprop",
      "Old proposal",
      "proposed",
      "2026-09-10T00:00:00Z",
    ),
    "project/.knowns/memory/memory-oldnew.md": old(
      "oldnew",
      "Newer",
      "active",
      "2026-10-30T00:00:00Z",
    ),
    "home/.knowns/memory/memory-oldglob.md": old(
      "oldglob",
      "Old global",
      "active",
      "2026-02-02T00:00:00Z",
      "global",
    ),
  });
  for (const args of [
    ["memory", "cleanup"],
    ["memory", "cleanup", "--plain"],
    ["memory", "cleanup", "--json"],
    ["memory", "cleanup", "--older-than", "400", "--json"],
    ["memory", "cleanup", "--older-than", "1", "--limit", "1", "--plain"],
    [
      "memory",
      "cleanup",
      "--older-than",
      "1",
      "--limit",
      "1",
      "--plain",
      "--page",
      "1",
      "--page-size",
      "3",
    ],
    ["memory", "cleanup", "--layer", "global"],
    ["memory", "cleanup", "--layer", "global", "--plain"],
    ["memory", "cleanup", "--older-than", "-5", "--limit", "-1", "--json"],
  ]) {
    test(args.join(" "), () => {
      const out = expectParity(pair, args);
      expect(out.code).toBe(0);
    });
  }
});

suite("memory write commands", () => {
  const pair = makePair();
  test("create variants", () => {
    expectParity(pair, [
      "memory",
      "create",
      "Prefer tabs for makefiles",
      "-c",
      "Use tabs.\n\nSecond para",
      "--category",
      "convention",
      "-t",
      "a",
      "-t",
      "b",
    ]);
    expectParity(pair, ["memory", "create", "multi", "word", "title", "-c", "joined"]);
    expectParity(pair, ["memory", "create", "No content"]);
    expectParity(pair, [
      "memory",
      "create",
      "Glob",
      "--layer",
      "global",
      "-c",
      "x",
      "--status",
      "active",
    ]);
    expectParity(pair, ["memory", "create", "Forced", "--create-anyway", "--status", "stale"]);
    expectParity(pair, ["memory", "create", "Forced default", "--create-anyway"]);
    expectParity(pair, ["memory", "list", "--all-statuses", "--plain"], { unordered: true });
  });
  test("create rejects bad input identically", () => {
    expectParity(pair, ["memory", "create", "Odd", "--category", "decision"]);
    expectParity(pair, ["memory", "create", "Bad", "--status", "nope"]);
    expectParity(pair, ["memory", "create", "x", "--layer", "working"]);
    expectParity(pair, ["memory", "create"]);
  });
  test("create against an active duplicate asks for review", () => {
    const text = expectParity(pair, [
      "memory",
      "create",
      "Prefer hyphens",
      "-c",
      "Use plain hyphens.\n\n**Why:** reads as machine-written otherwise.",
    ]);
    expect(text.stdout).toContain("Memory review required");
    const json = expectParity(pair, [
      "memory",
      "create",
      "Prefer hyphens",
      "-c",
      "Use plain hyphens.",
      "--json",
      "--category",
      "preference",
    ]);
    expect(JSON.parse(json.stdout).status).toBe("review_required");
    expectParity(pair, [
      "memory",
      "create",
      "Prefer hyphens",
      "-c",
      "Use plain hyphens.",
      "--plain",
    ]);
    expectParity(pair, [
      "memory",
      "create",
      "Prefer hyphens",
      "-c",
      "Use plain hyphens.",
      "--create-anyway",
    ]);
  });
  test("edit", () => {
    expectParity(pair, [
      "memory",
      "edit",
      "rrvcia",
      "-t",
      "New title",
      "--append",
      "more text",
      "--tag",
      "x",
      "--tag",
      "y",
    ]);
    expectParity(pair, ["memory", "edit", "rrvcia", "--content", "replaced"]);
    expectParity(pair, ["memory", "edit", "rrvcia", "-a", "tail"]);
    expectParity(pair, ["memory", "edit", "nr44bw", "--category", "failure"]);
    expectParity(pair, ["memory", "edit", "rrvcia", "--category", "decision"]);
    expectParity(pair, ["memory", "edit", "nope", "-t", "x"]);
    expectParity(pair, ["memory", "edit"]);
  });
  test("promote and demote", () => {
    expectParity(pair, ["memory", "promote", "rrvcia"]);
    expectParity(pair, ["memory", "promote", "rrvcia"]);
    expectParity(pair, ["memory", "demote", "rrvcia"]);
    expectParity(pair, ["memory", "demote", "rrvcia"]);
    expectParity(pair, ["memory", "promote", "nope"]);
  });
  test("delete: dry run, prompt answers, force", () => {
    expectParity(pair, ["memory", "delete", "kunv9q", "--dry-run"]);
    expectParity(pair, ["memory", "delete", "kunv9q"], { stdin: "" });
    expectParity(pair, ["memory", "delete", "kunv9q"], { stdin: "n\n" });
    expectParity(pair, ["memory", "delete", "kunv9q"], { stdin: "maybe\n" });
    expectParity(pair, ["memory", "delete", "kunv9q"], { stdin: "y\n" });
    expectParity(pair, ["memory", "delete", "nr44bw"], { stdin: "yes\n" });
    expectParity(pair, ["memory", "delete", "kunv9q", "--force"]);
    expectParity(pair, ["memory", "delete", "rrvcia", "--force"]);
  });
});

suite("memory migrate --write", () => {
  // A fresh world: listings order by file name, i.e. by Go's random ids, once memories are created.
  const pair = makePair();
  test("freezes the claim boundary once and keeps the timestamp", () => {
    expectParity(pair, ["memory", "migrate", "--all-statuses"]);
    expectParity(pair, ["memory", "migrate", "--all-statuses", "--json"]);
    expectParity(pair, ["memory", "migrate", "--write", "--all-statuses"]);
    expectParity(pair, ["memory", "migrate", "--write", "--all-statuses", "--json"]);
    expectParity(pair, ["memory", "view", "kunv9q", "--json"]);
    expectParity(pair, ["memory", "view", "rrvcia", "--plain"]);
  });
  test("--layer limits the scan and global entries are migrated too", () => {
    const p = makePair();
    writeBoth(p, {
      "home/.knowns/memory/memory-glob1.md": old(
        "glob1",
        "Global two paragraphs",
        "active",
        "2026-10-01T00:00:00Z",
        "global",
      ).replace("Old content for glob1.", "First paragraph.\n\nSecond paragraph."),
    });
    expectParity(p, ["memory", "migrate", "--layer", "global", "--json"]);
    expectParity(p, ["memory", "migrate", "--layer", "project", "--all-statuses"]);
    expectParity(p, ["memory", "migrate", "--write", "--layer", "global"]);
    expectParity(p, ["memory", "migrate"]);
  });
});
