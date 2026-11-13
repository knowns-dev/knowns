// `knowns task` write paths against the Go 0.34.1 binary: create, edit, the archive lifecycle and
// hard-delete, comparing output, exit codes and the whole .knowns tree after each scenario.
// Skipped without KNOWNS_GO_BIN. See harness.ts for what is normalised and why.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasGoBin, makePair, normalized, type Pair, runBoth, treesOf } from "./harness.ts";

async function step(pair: Pair, args: string[]): Promise<{ code: number; stdout: string }> {
  const run = await runBoth(pair, args);
  const n = normalized(pair, run);
  expect({ args, ...n.ts }).toEqual({ args, ...n.go });
  return run.ts;
}

function sameTree(pair: Pair): void {
  const trees = treesOf(pair);
  expect(Object.keys(trees.ts)).toEqual(Object.keys(trees.go));
  expect(trees.ts).toEqual(trees.go);
}

const T = "FX-60REC2"; // a plain todo task in the "full" fixture
const DONE = "FX-3VT2SR";
const ARCHIVED = "FX-3GCY37";

describe.skipIf(!hasGoBin)("task create", () => {
  test("flags, defaults, prefixes and the resulting files", async () => {
    const pair = makePair("empty");
    await step(pair, [
      "task",
      "create",
      "First task",
      "-d",
      "a description",
      "--ac",
      "Criterion A",
      "--ac",
      "Criterion B",
      "-l",
      "x",
      "-l",
      "y",
      "--priority",
      "high",
      "-a",
      "@me",
      "--plan",
      "the plan",
      "--notes",
      "the notes",
      "--spec",
      "specs/x",
      "--fulfills",
      "AC-1",
      "--fulfills",
      "AC-2",
    ]);
    await step(pair, ["task", "create", "Born", "done", "-s", "done"]);
    await step(pair, ["task", "create", "Child", "--parent", "<ID1>"]);
    await step(pair, ["task", "create", "Prefixed", "--prefix", "ABCD"]);
    await step(pair, [
      "task",
      "create",
      'Unicode 日本語 "quoted": & <tag>',
      "-d",
      "line1\nline2 \\n literal",
    ]);
    await step(pair, ["task", "create"]);
    await step(pair, ["task", "create", "Lowercase prefix", "--prefix", "abcd"]);
    await step(pair, ["task", "create", "Digits prefix", "--prefix", "ab12"]);
    await step(pair, ["task", "create", "Long prefix", "--prefix", "ABCDEFGHI"]);
    await step(pair, ["task", "create", "Bad prefix", "--prefix", "a"]);
    await step(pair, ["task", "create", "Bad prefix", "--prefix", "has space!"]);
    await step(pair, ["task", "list", "--plain"]);
    await step(pair, ["task", "list", "--json"]);
    await step(pair, ["task", "<ID1>", "--plain"]);
    await step(pair, ["task", "<ID1>", "--json"]);
    await step(pair, ["task", "history", "<ID1>", "--plain"]);
    await step(pair, ["task", "history", "<ID1>", "--json"]);
    sameTree(pair);
  });

  test("the project's defaultTaskIdPrefix applies unless --prefix overrides it", async () => {
    const pair = makePair("empty");
    for (const side of [pair.go, pair.ts]) {
      const path = join(side.dir, ".knowns", "config.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      config.settings = { ...config.settings, defaultTaskIdPrefix: "proj" };
      writeFileSync(path, JSON.stringify(config, null, 2));
    }
    await step(pair, ["task", "create", "Uses default"]);
    await step(pair, ["task", "create", "Overrides", "--prefix", "zz"]);
    await step(pair, ["task", "list", "--plain"]);
    sameTree(pair);
  });

  test("project defaults (priority and assignee) apply", async () => {
    const pair = makePair("full");
    for (const side of [pair.go, pair.ts]) {
      const path = join(side.dir, ".knowns", "config.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      config.settings = { ...config.settings, defaultPriority: "high", defaultAssignee: "@robot" };
      writeFileSync(path, JSON.stringify(config, null, 2));
    }
    await step(pair, ["task", "create", "Defaults"]);
    await step(pair, ["task", "<ID1>", "--plain"]);
    sameTree(pair);
  });
});

describe.skipIf(!hasGoBin)("task edit", () => {
  test("every flag, in sequence", async () => {
    const pair = makePair("full");
    const steps: string[][] = [
      ["task", "edit", T, "-s", "in-progress", "-a", "@me"],
      ["task", "edit", T, "-t", "Renamed title", "-d", "New description"],
      ["task", "edit", T, "--priority", "high", "--labels", "a, b ,,c"],
      ["task", "edit", T, "--ac", "First", "--ac", "Second", "--ac", "Third"],
      ["task", "edit", T, "--check-ac", "1", "--check-ac", "3"],
      ["task", "edit", T, "--check-ac", "2,3"],
      ["task", "edit", T, "--uncheck-ac", "1"],
      ["task", "edit", T, "--remove-ac", "1", "--remove-ac", "3"],
      ["task", "edit", T, "--plan", "1. one\n2. two"],
      ["task", "edit", T, "--notes", "first notes"],
      ["task", "edit", T, "--append-notes", "second"],
      ["task", "edit", T, "--append-notes", "third"],
      [
        "task",
        "edit",
        T,
        "--spec",
        "specs/s",
        "--parent",
        "FX-65T7HG",
        "--fulfills",
        "AC-1",
        "--order",
        "5",
      ],
      ["task", "edit", T, "--order", "0"],
      ["task", "edit", T, "-d", "", "-a", "", "--labels", ""],
      ["task", "edit", T, "--notes", ""],
      ["task", "edit", T, "-s", "done"],
      ["task", T, "--plain"],
      ["task", "edit", T, "-s", "done"],
      ["task", "edit", T, "-s", "todo"],
      ["task", T, "--json"],
      ["task", "history", T, "--plain"],
      ["task", "history", T, "--json"],
      ["task", "list", "--plain"],
    ];
    for (const args of steps) await step(pair, args);
    sameTree(pair);
  });

  test("literal backslash sequences are stored verbatim", async () => {
    const pair = makePair("full");
    await step(pair, ["task", "edit", T, "--notes", "a\\nb\\tc"]);
    await step(pair, ["task", "edit", T, "--append-notes", "x\\n"]);
    await step(pair, ["task", T, "--plain"]);
    sameTree(pair);
  });

  test("errors leave the task unchanged", async () => {
    const pair = makePair("full");
    await step(pair, ["task", "edit", T, "--ac", "only one"]);
    await step(pair, ["task", "edit", T, "--check-ac", "2"]);
    await step(pair, ["task", "edit", T, "--check-ac", "0"]);
    await step(pair, ["task", "edit", T, "--uncheck-ac", "9"]);
    await step(pair, ["task", "edit", T, "--remove-ac", "1", "--remove-ac", "1"]);
    await step(pair, ["task", "edit", "nope", "-s", "done"]);
    await step(pair, ["task", "edit", ARCHIVED, "-s", "todo"]);
    await step(pair, ["task", "edit", T, "--expected-hash", "deadbeef", "-s", "done"]);
    await step(pair, ["task", T, "--plain"]);
    sameTree(pair);
  });
});

describe.skipIf(!hasGoBin)("task archive lifecycle", () => {
  test("preview and execute archive, then unarchive", async () => {
    const pair = makePair("full");
    const steps: string[][] = [
      ["task", "archive", DONE],
      ["task", "archive", DONE, "--json"],
      ["task", "archive", T],
      ["task", "archive", T, "--yes"],
      ["task", "archive", T, "--yes", "--json"],
      ["task", "archive", "nope"],
      ["task", "archive", "nope", "--yes"],
      ["task", "archive", DONE, "--yes"],
      ["task", "archive", DONE, "--yes"],
      ["task", DONE, "--plain"],
      ["task", "unarchive", DONE],
      ["task", "unarchive", DONE, "--yes"],
      ["task", DONE, "--json"],
      ["task", "unarchive", DONE, "--yes"],
      ["task", "unarchive", ARCHIVED, "--yes", "--json"],
      ["task", "unarchive", "nope", "--yes"],
      ["task", "history", DONE, "--plain"],
      ["task", "history", ARCHIVED, "--json"],
      ["task", "archive", ARCHIVED, "--yes"],
      ["task", "archive", DONE, "--expected-hash", "deadbeef", "--yes"],
      ["task", "list", "--include-historical", "--plain"],
    ];
    for (const args of steps) await step(pair, args);
    sameTree(pair);
  });

  test("unfinished descendants and active timers block archive", async () => {
    const pair = makePair("full");
    await step(pair, ["task", "edit", DONE, "-s", "todo"]);
    await step(pair, ["task", "create", "Kid", "--parent", DONE]);
    await step(pair, ["task", "edit", DONE, "-s", "done"]);
    await step(pair, ["task", "archive", DONE]);
    await step(pair, ["task", "archive", DONE, "--yes"]);
    await step(pair, ["task", "edit", "<ID1>", "-s", "done"]);
    await step(pair, ["time", "start", DONE]);
    await step(pair, ["task", "archive", DONE, "--yes"]);
    await step(pair, ["time", "stop"]);
    sameTree(pair);
  });

  test("batch archive and unarchive", async () => {
    const pair = makePair("full");
    const steps: string[][] = [
      ["task", "batch-archive"],
      ["task", "batch-archive", "--json"],
      ["task", "batch-archive", DONE, T, "nope"],
      ["task", "batch-archive", DONE, T, "--yes"],
      ["task", "batch-archive", "--yes"],
      ["task", "batch-unarchive"],
      ["task", "batch-unarchive", DONE, ARCHIVED, "FX-7TGPH1"],
      ["task", "batch-unarchive", DONE, ARCHIVED, "FX-7TGPH1", "--json"],
      ["task", "batch-unarchive", DONE, ARCHIVED, "nope", "--yes"],
      ["task", "batch-unarchive", DONE, ARCHIVED, "FX-7TGPH1", "--yes"],
      ["task", "list", "--plain"],
    ];
    for (const args of steps) await step(pair, args);
    sameTree(pair);
  });

  test("auto-archive thresholds do not apply to manual archive", async () => {
    const pair = makePair("full");
    await step(pair, ["task", "archive", DONE, "--yes"]);
    await step(pair, ["task", DONE, "--json"]);
    sameTree(pair);
  });
});

describe.skipIf(!hasGoBin)("task hard-delete requests that never reach the purge", () => {
  test("missing confirmation, reason or capability", async () => {
    const pair = makePair("full");
    const steps: string[][] = [
      ["task", "hard-delete", T],
      ["task", "hard-delete", T, "--json"],
      ["task", "hard-delete", T, "--reason", "because"],
      ["task", "hard-delete", T, "--reason", "because", "--yes"],
      ["task", "hard-delete", T, "--reason", "because", "--allow-hard-delete"],
      ["task", "hard-delete", T, "--allow-hard-delete", "--yes"],
      ["task", "delete", T, "--allow-hard-delete", "--yes", "--json"],
      ["task", "hard-delete", "nope", "--reason", "r", "--yes", "--allow-hard-delete"],
      ["task", T, "--plain"],
    ];
    for (const args of steps) await step(pair, args);
    sameTree(pair);
  });
});
