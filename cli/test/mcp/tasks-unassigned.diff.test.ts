// D13 (TSR-ZSSFVJ): the tasks list `unassigned` parameter and trimmed assignee matching, ported
// from contributor PR #156. The oracle is a Go build of the PR head (2b3f88d), so this file needs
// KNOWNS_GO_PR156_BIN (see test/cli/commands/task-assignees.diff.test.ts) and skips without it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstDiff, GO_BIN, hasGoBin, runDiff, type Step } from "./harness.ts";

const PR_BIN = process.env.KNOWNS_GO_PR156_BIN;
const hasPrBin = hasGoBin && PR_BIN !== undefined && existsSync(PR_BIN);

let template = "";

function cli(dir: string, home: string, args: string[]): void {
  const r = Bun.spawnSync([GO_BIN as string, ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      NO_UPDATE_CHECK: "1",
      CI: "1",
      KNOWNS_RUNTIME_INLINE: "1",
      KNOWN_LSP_AUTO_INSTALL: "0",
    },
  });
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")}: ${r.stderr.toString()}`);
}

// The ids are generated once, in the template, so both servers list the same tasks.
const sortById = (text: string): string => {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) v.sort((a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1));
    return JSON.stringify(v, null, 2);
  } catch {
    return text;
  }
};

const steps: Step[] = [
  { tool: "tasks", args: { action: "list", unassigned: true }, normalize: sortById },
  {
    tool: "tasks",
    args: { action: "list", unassigned: true, status: "todo" },
    normalize: sortById,
  },
  {
    tool: "tasks",
    args: { action: "list", unassigned: true, includeHistorical: true },
    normalize: sortById,
  },
  { tool: "tasks", args: { action: "list", unassigned: true, label: "nope" } },
  { tool: "tasks", args: { action: "list", unassigned: true, assignee: "@bob" } },
  {
    tool: "tasks",
    args: { action: "list", unassigned: true, assignee: "   " },
    normalize: sortById,
  },
  { tool: "tasks", args: { action: "list", assignee: "@alice" }, normalize: sortById },
  { tool: "tasks", args: { action: "list", assignee: " @alice " }, normalize: sortById },
  { tool: "tasks", args: { action: "list", unassigned: false }, normalize: sortById },
  { tool: "help", args: { queries: ["tasks.list"] } },
];

describe.skipIf(!hasPrBin)("tasks list unassigned matches the PR #156 Go build", () => {
  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), "knowns-mcp-unassigned-"));
    template = join(root, "project");
    const home = join(root, "home");
    mkdirSync(template, { recursive: true });
    mkdirSync(home, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: template });
    cli(template, home, ["init", "unassigned", "--no-wizard"]);
    for (const [title, assignee] of [
      ["Alice", "@alice"],
      ["Alice padded", " @alice "],
      ["Bob", "@bob"],
      ["Whitespace", "   "],
      ["Nobody", ""],
    ] as const) {
      cli(template, home, ["task", "create", title, ...(assignee ? ["-a", assignee] : [])]);
    }
  }, 120_000);

  afterAll(() => {
    if (template) rmSync(join(template, ".."), { recursive: true, force: true });
  });

  test("same responses", async () => {
    const run = await runDiff(undefined, steps, {
      goBin: PR_BIN as string,
      setup: (dir) => cpSync(template, dir, { recursive: true }),
    });
    try {
      for (const r of run.results) {
        expect({ step: r.label, text: r.tsMasked }, firstDiff(r.goMasked, r.tsMasked)).toEqual({
          step: r.label,
          text: r.goMasked,
        });
      }
      // Not vacuous: the unassigned list holds exactly the two tasks without an assignee.
      const first = JSON.parse(run.results[0]?.tsMasked ?? "[]") as { title: string }[];
      expect(first.map((t) => t.title).sort()).toEqual(["Nobody", "Whitespace"]);
    } finally {
      await run.close();
    }
  }, 120_000);
});
