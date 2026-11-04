// `knowns task` read paths against the Go 0.34.1 binary: list, view, history, help, argument errors.
// Skipped without KNOWNS_GO_BIN.
import { beforeAll, describe, expect, test } from "bun:test";
import { hasGoBin, makePair, normalized, type Pair, runBoth, treesOf } from "./harness.ts";

const FX = {
  rich: "FX-3VT2SR",
  parent: "FX-65T7HG",
  child: "FX-3GCY37",
  unicode: "FX-P6DXEY",
  plain: "FX-60REC2",
  urgent: "FX-19XJKQ",
};

describe.skipIf(!hasGoBin)("task read commands match Go", () => {
  let pair: Pair;
  beforeAll(() => {
    pair = makePair("full");
  });

  async function parity(args: string[]): Promise<void> {
    const run = await runBoth(pair, args);
    const n = normalized(pair, run);
    expect({ args, ...n.ts }).toEqual({ args, ...n.go });
  }

  const cases: Record<string, string[][]> = {
    list: [
      ["task", "list"],
      ["task", "list", "--plain"],
      ["task", "list", "--json"],
      ["task", "list", "--json", "--plain"],
      ["task", "list", "--tree"],
      ["task", "list", "--tree", "--plain"],
      ["task", "list", "--status", "todo"],
      ["task", "list", "--status", "todo", "--plain"],
      ["task", "list", "--status", "nope"],
      ["task", "list", "--status", "nope", "--json"],
      ["task", "list", "--assignee", "@fixture", "--priority", "high", "--plain"],
      ["task", "list", "--label", "does-not-exist"],
      ["task", "list", "--include-historical"],
      ["task", "list", "--include-historical", "--plain"],
      ["task", "list", "--plain", "--page", "1"],
      ["task", "list", "--plain", "--page", "2", "--page-size", "3"],
      ["task", "list", "--plain", "--page", "9"],
      ["task", "list", "--plain", "--page-size", "2"],
      ["task", "list", "--tree", "--plain", "--page", "1", "--page-size", "2"],
    ],
    view: [
      ["task", FX.rich],
      ["task", FX.rich, "--plain"],
      ["task", FX.rich, "--json"],
      ["task", "view", FX.rich],
      ["task", "view", FX.rich, "--plain", "--page", "1", "--page-size", "5"],
      ["task", FX.parent, "--plain"],
      ["task", FX.parent, "--json"],
      ["task", FX.child, "--plain"],
      ["task", FX.unicode],
      ["task", FX.unicode, "--plain"],
      ["task", FX.unicode, "--json"],
      ["task", FX.urgent, "--json"],
      ["task", "nope"],
      ["task", "nope", "--json"],
      ["task", "view", "nope"],
      ["task", "view"],
      ["task", "view", "a", "b"],
    ],
    history: [
      ["task", "history", FX.rich],
      ["task", "history", FX.rich, "--plain"],
      ["task", "history", FX.rich, "--json"],
      ["task", "history", FX.rich, "--metadata"],
      ["task", "history", FX.rich, "--metadata", "--json"],
      ["task", "history", FX.rich, "--limit", "2", "--offset", "1"],
      ["task", "history", FX.rich, "--limit", "2", "--offset", "1", "--json"],
      ["task", "history", FX.rich, "--revision", "v1"],
      ["task", "history", FX.rich, "--revision", "v1", "--plain"],
      ["task", "history", FX.rich, "--revision", "3", "--json"],
      ["task", "history", FX.rich, "--revision", "v99"],
      ["task", "history", FX.parent],
      ["task", "history", FX.parent, "--plain"],
      ["task", "history", "nothere"],
      ["task", "history", "nothere", "--json"],
      ["task", "history", "nothere", "--metadata", "--json"],
      ["task", "history"],
    ],
    help: [
      ["task"],
      ["task", "--help"],
      ["task", "-h"],
      ["help", "task"],
      ["task", "create", "--help"],
      ["task", "list", "--help"],
      ["task", "view", "--help"],
      ["task", "edit", "--help"],
      ["task", "hard-delete", "--help"],
      ["task", "delete", "--help"],
      ["task", "archive", "--help"],
      ["task", "unarchive", "--help"],
      ["task", "batch-archive", "--help"],
      ["task", "batch-unarchive", "--help"],
      ["task", "history", "--help"],
      ["help", "task", "edit"],
      ["help", "task", "nope"],
    ],
    "argument errors": [
      ["task", "create"],
      ["task", "edit"],
      ["task", "edit", FX.plain, "--nope"],
      ["task", "edit", FX.plain, "--check-ac", "abc"],
      ["task", "edit", FX.plain, "--order", "x"],
      ["task", "list", "--tree=maybe"],
      ["task", "archive"],
      ["task", "hard-delete"],
      ["task", "history", FX.rich, "--limit", "x"],
      ["task", "lst"],
    ],
  };

  for (const [group, list] of Object.entries(cases)) {
    describe(group, () => {
      for (const args of list) test(args.join(" "), () => parity(args));
    });
  }

  // ListAll builds each parent's subtasks by iterating a Go map, so their order is random in Go.
  // Everything else must match; only the order inside "subtasks" and among tree children is free.
  test("task list --include-historical --json (subtask order is free)", async () => {
    const run = await runBoth(pair, ["task", "list", "--include-historical", "--json"]);
    const n = normalized(pair, run);
    const canon = (text: string) =>
      (JSON.parse(text) as { subtasks?: string[] }[]).map((t) => ({
        ...t,
        ...(t.subtasks && { subtasks: [...t.subtasks].sort() }),
      }));
    expect(n.ts.code).toBe(n.go.code);
    expect(canon(n.ts.stdout)).toEqual(canon(n.go.stdout));
  });

  test("task list --include-historical --tree (child order is free)", async () => {
    const run = await runBoth(pair, ["task", "list", "--include-historical", "--tree", "--plain"]);
    const n = normalized(pair, run);
    const canon = (text: string) => text.split("\n").sort();
    expect(canon(n.ts.stdout)).toEqual(canon(n.go.stdout));
  });

  // The table sizes its columns from the terminal width ($COLUMNS when stdout is not a terminal).
  for (const columns of ["40", "60", "200", "0", "wide"]) {
    test(`task list with COLUMNS=${columns}`, async () => {
      const run = await runBoth(pair, ["task", "list"], { env: { COLUMNS: columns } });
      const n = normalized(pair, run);
      expect(n.ts).toEqual(n.go);
    });
  }

  test("read commands leave the tree untouched", () => {
    const trees = treesOf(pair);
    expect(trees.ts).toEqual(trees.go);
  });
});
