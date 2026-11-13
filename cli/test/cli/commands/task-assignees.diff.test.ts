// D13 (TSR-ZSSFVJ): `task list --unassigned`, `task assignees` and trimmed assignee matching,
// ported from contributor PR #156. Their oracle is a Go build of the PR head (2b3f88d), not the
// 0.34.1 baseline, so this file needs KNOWNS_GO_PR156_BIN and skips without it:
//   git fetch origin pull/156/head:refs/pr/156 && git worktree add <dir> refs/pr/156
//   (cd <dir> && cp -R <repo>/ui/dist ui/ && CGO_ENABLED=1 go build -o <bin> ./cmd/knowns)
// The fixture is built with the baseline oracle (KNOWNS_GO_BIN), whose data format is the same.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { hasGoBin } from "../oracle.ts";
import {
  goInTemplate,
  makeSandbox,
  runOracleIn,
  runTsIn,
  type Sandbox,
} from "./subprocess-diff.ts";

const PR_BIN = process.env.KNOWNS_GO_PR156_BIN;
const hasPrBin = hasGoBin && PR_BIN !== undefined && existsSync(PR_BIN);

let box: Sandbox;

describe.skipIf(!hasPrBin)("tasks by assignee match the PR #156 Go build", () => {
  beforeAll(() => {
    box = makeSandbox("knowns-assignees-");
    mkdirSync(box.home, { recursive: true });
    mkdirSync(box.proj, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: box.proj });
    goInTemplate(box, ["init", "assignees", "--no-wizard"]);
    const task = (title: string, ...flags: string[]) =>
      goInTemplate(box, ["task", "create", title, ...flags]);
    task("Alice todo", "-a", "@alice", "--priority", "high", "-l", "api");
    task("Alice doing", "-a", "@alice", "-l", "api");
    task("Alice padded", "-a", " @alice ");
    task("Bob one", "-a", "@bob", "--priority", "high");
    task("Bob two", "-a", "@bob");
    task("Zed upper", "-a", "@Zed");
    task("Pair string", "-a", "@a, @b");
    task("Unicode owner", "-a", "@Đức");
    task("Literal me", "-a", "@me");
    task("Whitespace only", "-a", "   ");
    task("Nobody one", "-l", "api");
    task("Nobody two");
    // Statuses: a mix, including one outside the ranked set, and an archived task.
    const ids = goInTemplate(box, ["task", "list", "--plain"])
      .split("\n")
      .filter((l) => /^\S+-\S+ /.test(l))
      .map((l) => l.split(/\s+/));
    const idOf = (title: string) =>
      ids.find((cols) => cols.slice(4).join(" ") === title)?.[0] as string;
    goInTemplate(box, ["task", "edit", idOf("Alice doing"), "-s", "in-progress"]);
    goInTemplate(box, ["task", "edit", idOf("Bob two"), "-s", "done"]);
    goInTemplate(box, ["task", "edit", idOf("Zed upper"), "-s", "on-hold"]);
    goInTemplate(box, ["task", "edit", idOf("Nobody two"), "-s", "done"]);
    goInTemplate(box, ["task", "archive", idOf("Nobody two"), "--yes"]);
  }, 120_000);

  afterAll(() => {
    if (box) rmSync(box.root, { recursive: true, force: true });
  });

  const modes = [[], ["--plain"], ["--json"]];
  const cases: string[][] = [
    ...modes.map((m) => ["task", "assignees", ...m]),
    ...modes.map((m) => ["task", "assignees", "--status", "todo", ...m]),
    ...modes.map((m) => ["task", "assignees", "--status", "nope", ...m]),
    ...modes.map((m) => ["task", "assignees", "--include-historical", ...m]),
    ["task", "assignees", "--assignee", "@alice", "--plain"],
    ["task", "assignees", "--assignee", "  @alice  ", "--json"],
    ["task", "assignees", "--unassigned", "--plain"],
    ["task", "assignees", "--label", "api", "--plain"],
    ["task", "assignees", "--priority", "high", "--json"],
    ["task", "assignees", "--unassigned", "--assignee", "@bob"],
    ["task", "assignees", "extra-arg"],
    ["task", "assignees", "--help"],
    ...modes.map((m) => ["task", "list", "--unassigned", ...m]),
    ["task", "list", "--unassigned", "--include-historical", "--plain"],
    ["task", "list", "--unassigned", "--assignee", "@bob"],
    ["task", "list", "--unassigned", "--assignee", "@bob", "--json"],
    ["task", "list", "--assignee", "@alice", "--plain"],
    ["task", "list", "--assignee", " @alice ", "--json"],
    ["task", "list", "--assignee", "@ALICE", "--plain"],
    ["task", "list", "--help"],
    ["task", "--help"],
    ["__complete", "task", ""],
    ["__completeNoDesc", "task", ""],
    ["__complete", "task", "list", "--"],
    ["__complete", "task", "assignees", "--"],
    ["__completeNoDesc", "task", "assignees", "--un"],
  ];

  for (const args of cases) {
    test(args.join(" "), async () => {
      const [go, ts] = await Promise.all([
        runOracleIn(PR_BIN as string, box, args),
        runTsIn(box, args),
      ]);
      expect({ args, ...ts }).toEqual({ args, ...go });
    });
  }
});
